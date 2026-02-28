import { Client } from "ssh2";
import type { CredentialEncryptor } from "../security";
import { sanitizeOutput } from "../utils/sanitize";

// Non-interactive SSH sessions often have a minimal PATH; force C locale so
// package-manager output is always in English for reliable parsing.
const PATH_PREFIX =
  "export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";

const SUDO_STDIN_PATTERN = /\bsudo -S(?=\s)/g;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * For nohup/background execution, there is no interactive stdin channel.
 * Convert `sudo -S` calls to `sudo -n` for systems where elevation is already
 * available non-interactively (root or passwordless sudo).
 */
export function preparePersistentSudoCommand(command: string): string {
  if (!command.includes("sudo -S")) return command;
  return command.replace(SUDO_STDIN_PATTERN, "sudo -n");
}

/** Sentinel exit code: SSH monitoring was lost but the nohup process likely continues on the remote. */
export const EXIT_MONITORING_LOST = -2;

/** Sentinel exit code: remote temp files are gone (e.g. server rebooted and /tmp was cleared). */
export const EXIT_FILES_GONE = -3;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PersistentCommandResult extends CommandResult {
  /** Set when exitCode === EXIT_MONITORING_LOST; contains remote process info for reconnection. */
  persistentInfo?: PersistentCommandInfo;
}

export interface PersistentCommandInfo {
  pid: number;
  logFile: string;
  exitFile: string;
}

export class SSHConnectionManager {
  private maxConcurrent: number;
  private currentConnections = 0;
  private queue: Array<() => void> = [];
  private defaultTimeout: number;
  private defaultCmdTimeout: number;
  private encryptor: CredentialEncryptor;

  constructor(
    maxConcurrent: number,
    defaultTimeout: number,
    defaultCmdTimeout: number,
    encryptor: CredentialEncryptor
  ) {
    this.maxConcurrent = maxConcurrent;
    this.defaultTimeout = defaultTimeout;
    this.defaultCmdTimeout = defaultCmdTimeout;
    this.encryptor = encryptor;
  }

  private async acquireSemaphore(): Promise<void> {
    if (this.currentConnections < this.maxConcurrent) {
      this.currentConnections++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.currentConnections++;
        resolve();
      });
    });
  }

  private releaseSemaphore(): void {
    this.currentConnections--;
    const next = this.queue.shift();
    if (next) next();
  }

  async connect(system: Record<string, unknown>): Promise<Client> {
    await this.acquireSemaphore();

    const conn = new Client();
    const connectConfig: Record<string, unknown> = {
      host: system.hostname as string,
      port: (system.port as number) || 22,
      username: system.username as string,
      readyTimeout: this.defaultTimeout * 1000,
    };

    const authType = (system.authType as string) || "password";
    if (authType === "password" && system.encryptedPassword) {
      connectConfig.password = this.encryptor.decrypt(
        system.encryptedPassword as string
      );
    } else if (authType === "key" && system.encryptedPrivateKey) {
      connectConfig.privateKey = this.encryptor.decrypt(
        system.encryptedPrivateKey as string
      );
      if (system.encryptedKeyPassphrase) {
        connectConfig.passphrase = this.encryptor.decrypt(
          system.encryptedKeyPassphrase as string
        );
      }
    }

    return new Promise<Client>((resolve, reject) => {
      conn.on("ready", () => resolve(conn));
      conn.on("error", (err) => {
        this.releaseSemaphore();
        reject(err);
      });
      conn.connect(connectConfig as Parameters<Client["connect"]>[0]);
    });
  }

  disconnect(conn: Client): void {
    conn.end();
    this.releaseSemaphore();
  }

  async runCommand(
    conn: Client,
    command: string,
    timeout?: number,
    sudoPassword?: string,
    onData?: (chunk: string, stream: "stdout" | "stderr") => void
  ): Promise<CommandResult> {
    const cmdTimeout = timeout || this.defaultCmdTimeout;
    const fullCommand = PATH_PREFIX + command;

    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          stdout: "",
          stderr: `Command timed out after ${cmdTimeout}s`,
          exitCode: -1,
        });
      }, cmdTimeout * 1000);

      conn.exec(fullCommand, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          resolve({ stdout: "", stderr: String(err), exitCode: -1 });
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (data: Buffer) => {
          const text = data.toString();
          stdout += text;
          onData?.(text, "stdout");
        });
        stream.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          stderr += text;
          onData?.(text, "stderr");
        });
        stream.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? 0 });
        });

        // Pipe sudo password via stdin if provided (for sudo -S)
        if (sudoPassword) {
          stream.write(sudoPassword + "\n");
          stream.end();
        }
      });
    });
  }

  /**
   * Run a command via nohup so it survives SSH disconnection.
   * Output is streamed via `tail --pid` on a remote log file.
   * Fails fast if nohup setup cannot be started.
   */
  async runPersistentCommand(
    conn: Client,
    command: string,
    timeout?: number,
    sudoPassword?: string,
    onData?: (chunk: string, stream: "stdout" | "stderr") => void
  ): Promise<PersistentCommandResult> {
    const cmdTimeout = timeout || this.defaultCmdTimeout;
    const needsSudoStdin = command.includes("sudo -S");
    const useSudoLaunch = needsSudoStdin && !!sudoPassword;
    const persistentCommand = useSudoLaunch
      ? command
      : needsSudoStdin
      ? preparePersistentSudoCommand(command)
      : command;

    // Phase 1: Start the command in background via nohup.
    const base64Cmd = Buffer.from(persistentCommand).toString("base64");
    // The nohup line ends with & which is already a command separator,
    // so we use { ...; } grouping to keep it in the && chain.
    const setupCmdParts = [
      'SCRIPT=$(mktemp /tmp/ludash_XXXXXX.sh)',
      `printf '%s' '${base64Cmd}' | base64 -d > "$SCRIPT"`,
      'LOGFILE="${SCRIPT%.sh}.log"',
      'EXITFILE="${SCRIPT%.sh}.exit"',
    ];
    const launchInnerCmd =
      `nohup sh -c 'sh "$0"; echo $? > "$1"; rm -f "$0"' "$1" "$2" > "$3" 2>&1 & ` +
      `echo "LUDASH_BG PID=$! LOG=$3 EXIT=$2"`;
    const launchCmd =
      `sh -c ${shellSingleQuote(launchInnerCmd)} -- "$SCRIPT" "$EXITFILE" "$LOGFILE"`;
    const rootLaunchCmd = useSudoLaunch
      ? `if [ "$(id -u)" = "0" ]; then ${launchCmd}; elif command -v sudo >/dev/null 2>&1; then sudo -S -p '' ${launchCmd}; else ${launchCmd}; fi`
      : launchCmd;
    const setupCmd = setupCmdParts.join(" && ") + ` && ${rootLaunchCmd}`;

    const setupResult = await this.runCommand(
      conn,
      setupCmd,
      30,
      useSudoLaunch ? sudoPassword : undefined
    );
    const info = this.parseNohupOutput(setupResult.stdout);

    if (!info || setupResult.exitCode !== 0) {
      console.warn(
        "[SSH] nohup setup failed:",
        sanitizeOutput(setupResult.stderr || setupResult.stdout)
      );
      return {
        stdout: setupResult.stdout,
        stderr:
          setupResult.stderr ||
          "Failed to start SSH-safe background command",
        exitCode: setupResult.exitCode || -1,
      };
    }

    // Phase 2: Monitor via tail --pid
    const tailCmd =
      PATH_PREFIX + `tail --pid=${info.pid} -f "${info.logFile}" 2>/dev/null`;
    const tailResult = await this.runTailMonitor(
      conn,
      tailCmd,
      cmdTimeout,
      onData
    );

    if (tailResult.monitoringLost) {
      return {
        stdout: tailResult.stdout,
        stderr:
          "SSH connection lost during monitoring. The upgrade process continues on the remote system under nohup.",
        exitCode: EXIT_MONITORING_LOST,
        persistentInfo: info,
      };
    }

    // Phase 3: Read exit code from the exit file
    const exitResult = await this.runCommand(
      conn,
      `cat "${info.exitFile}" 2>/dev/null`,
      10
    );
    const exitCode = parseInt(exitResult.stdout.trim(), 10);

    // Phase 4: Cleanup temp files
    this.runCommand(
      conn,
      `rm -f "${info.logFile}" "${info.exitFile}"`,
      10
    ).catch(() => {});

    return {
      stdout: tailResult.stdout,
      stderr: "",
      exitCode: isNaN(exitCode) ? -1 : exitCode,
    };
  }

  private parseNohupOutput(stdout: string): PersistentCommandInfo | null {
    const match = stdout.match(
      /LUDASH_BG PID=(\d+) LOG=(\S+) EXIT=(\S+)/
    );
    if (!match) return null;
    return {
      pid: parseInt(match[1], 10),
      logFile: match[2],
      exitFile: match[3],
    };
  }

  private runTailMonitor(
    conn: Client,
    tailCommand: string,
    timeout: number,
    onData?: (chunk: string, stream: "stdout" | "stderr") => void
  ): Promise<{ stdout: string; monitoringLost: boolean }> {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (stdout: string, lost: boolean) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve({ stdout, monitoringLost: lost });
      };

      const timer = setTimeout(() => {
        finish("", true);
      }, timeout * 1000);

      // If the connection itself drops, the process still runs under nohup
      const onConnError = () => finish(stdout, true);
      const onConnClose = () => finish(stdout, true);
      conn.once("error", onConnError);
      conn.once("close", onConnClose);

      let stdout = "";

      conn.exec(tailCommand, (err, stream) => {
        if (err) {
          conn.removeListener("error", onConnError);
          conn.removeListener("close", onConnClose);
          finish("", true);
          return;
        }

        stream.on("data", (data: Buffer) => {
          const text = data.toString();
          stdout += text;
          onData?.(text, "stdout");
        });
        stream.stderr.on("data", (data: Buffer) => {
          const text = data.toString();
          onData?.(text, "stderr");
        });
        stream.on("close", () => {
          conn.removeListener("error", onConnError);
          conn.removeListener("close", onConnClose);
          finish(stdout, false);
        });
        stream.on("error", () => {
          conn.removeListener("error", onConnError);
          conn.removeListener("close", onConnClose);
          finish(stdout, true);
        });
      });
    });
  }

  /**
   * Resume monitoring a previously-launched persistent command after reconnection.
   * Checks if the remote temp files still exist and either reads the result
   * or re-attaches the tail monitor if the process is still running.
   */
  async resumePersistentCommand(
    conn: Client,
    info: PersistentCommandInfo,
    timeout?: number,
    onData?: (chunk: string, stream: "stdout" | "stderr") => void
  ): Promise<PersistentCommandResult> {
    const cmdTimeout = timeout || this.defaultCmdTimeout;

    // Check if the log file still exists (it won't if the server rebooted and /tmp was cleared)
    const checkLog = await this.runCommand(
      conn,
      `test -f "${info.logFile}" && echo "exists" || echo "gone"`,
      10
    );
    if (checkLog.stdout.trim() === "gone") {
      return {
        stdout: "",
        stderr: "Remote temp files no longer exist (server likely rebooted).",
        exitCode: EXIT_FILES_GONE,
      };
    }

    // Check if the exit file exists (process finished)
    const checkExit = await this.runCommand(
      conn,
      `test -f "${info.exitFile}" && echo "exists" || echo "gone"`,
      10
    );

    if (checkExit.stdout.trim() === "exists") {
      // Process finished — read exit code and remaining output
      const exitResult = await this.runCommand(
        conn,
        `cat "${info.exitFile}" 2>/dev/null`,
        10
      );
      const exitCode = parseInt(exitResult.stdout.trim(), 10);

      const logResult = await this.runCommand(
        conn,
        `cat "${info.logFile}" 2>/dev/null`,
        30
      );

      // Cleanup temp files
      this.runCommand(
        conn,
        `rm -f "${info.logFile}" "${info.exitFile}"`,
        10
      ).catch(() => {});

      return {
        stdout: logResult.stdout,
        stderr: "",
        exitCode: isNaN(exitCode) ? -1 : exitCode,
      };
    }

    // Process may still be running — check if PID is alive
    const pidCheck = await this.runCommand(
      conn,
      `kill -0 ${info.pid} 2>/dev/null && echo "alive" || echo "dead"`,
      10
    );

    if (pidCheck.stdout.trim() === "alive") {
      // Re-attach tail monitor
      const tailCmd =
        PATH_PREFIX + `tail --pid=${info.pid} -f "${info.logFile}" 2>/dev/null`;
      const tailResult = await this.runTailMonitor(
        conn,
        tailCmd,
        cmdTimeout,
        onData
      );

      if (tailResult.monitoringLost) {
        return {
          stdout: tailResult.stdout,
          stderr: "SSH connection lost again during monitoring.",
          exitCode: EXIT_MONITORING_LOST,
          persistentInfo: info,
        };
      }

      // Process finished — read exit code
      const exitResult = await this.runCommand(
        conn,
        `cat "${info.exitFile}" 2>/dev/null`,
        10
      );
      const exitCode = parseInt(exitResult.stdout.trim(), 10);

      // Cleanup
      this.runCommand(
        conn,
        `rm -f "${info.logFile}" "${info.exitFile}"`,
        10
      ).catch(() => {});

      return {
        stdout: tailResult.stdout,
        stderr: "",
        exitCode: isNaN(exitCode) ? -1 : exitCode,
      };
    }

    // PID is dead but no exit file — the process was likely killed during
    // a system shutdown/reboot before it could write the exit code.
    // Treat the same as EXIT_FILES_GONE so the caller infers from update count.

    // Cleanup
    this.runCommand(
      conn,
      `rm -f "${info.logFile}" "${info.exitFile}"`,
      10
    ).catch(() => {});

    return {
      stdout: "",
      stderr: "Process was terminated without writing exit code (likely killed during reboot).",
      exitCode: EXIT_FILES_GONE,
    };
  }

  async testConnection(
    system: Record<string, unknown>
  ): Promise<{ success: boolean; message: string }> {
    let conn: Client | null = null;
    try {
      conn = await this.connect(system);
      const result = await this.runCommand(conn, "echo ok", 10);
      if (result.exitCode === 0 && result.stdout.includes("ok")) {
        return { success: true, message: "Connection successful" };
      }
      return {
        success: false,
        message: `Unexpected response: ${result.stderr || result.stdout}`,
      };
    } catch (e: unknown) {
      const err = e as Error & { level?: string };
      if (err.level === "client-authentication") {
        return {
          success: false,
          message: "Permission denied (check credentials)",
        };
      }
      return { success: false, message: `Connection failed: ${err.message}` };
    } finally {
      if (conn) this.disconnect(conn);
    }
  }
}

let _sshManager: SSHConnectionManager | null = null;

export function initSSHManager(
  maxConcurrent: number,
  defaultTimeout: number,
  defaultCmdTimeout: number,
  encryptor: CredentialEncryptor
): SSHConnectionManager {
  _sshManager = new SSHConnectionManager(
    maxConcurrent,
    defaultTimeout,
    defaultCmdTimeout,
    encryptor
  );
  return _sshManager;
}

export function getSSHManager(): SSHConnectionManager {
  if (!_sshManager) throw new Error("SSH manager not initialized");
  return _sshManager;
}
