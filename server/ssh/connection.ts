import { Client } from "ssh2";
import type { CredentialEncryptor } from "../security";

// Non-interactive SSH sessions often have a minimal PATH; force C locale so
// package-manager output is always in English for reliable parsing.
const PATH_PREFIX =
  "export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";

/** Sentinel exit code: SSH monitoring was lost but the nohup process likely continues on the remote. */
export const EXIT_MONITORING_LOST = -2;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
   * Falls back to direct `runCommand` if the nohup setup fails.
   */
  async runPersistentCommand(
    conn: Client,
    command: string,
    timeout?: number,
    sudoPassword?: string,
    onData?: (chunk: string, stream: "stdout" | "stderr") => void
  ): Promise<CommandResult> {
    const cmdTimeout = timeout || this.defaultCmdTimeout;

    // Phase 1: Cache sudo credentials so the nohup'd process can use them
    if (sudoPassword) {
      await this.cacheSudoCredentials(conn, sudoPassword);
    }

    // Phase 2: Start the command in background via nohup
    const base64Cmd = Buffer.from(command).toString("base64");
    // The nohup line ends with & which is already a command separator,
    // so we use { ...; } grouping to keep it in the && chain.
    const setupCmd = [
      'SCRIPT=$(mktemp /tmp/ludash_XXXXXX.sh)',
      `printf '%s' '${base64Cmd}' | base64 -d > "$SCRIPT"`,
      'LOGFILE="${SCRIPT%.sh}.log"',
      'EXITFILE="${SCRIPT%.sh}.exit"',
    ].join(" && ") +
      ` && { nohup sh -c 'sh "$0"; echo $? > "$1"; rm -f "$0"' "$SCRIPT" "$EXITFILE" > "$LOGFILE" 2>&1 & echo "LUDASH_BG PID=$! LOG=$LOGFILE EXIT=$EXITFILE"; }`;

    const setupResult = await this.runCommand(conn, setupCmd, 30);
    const info = this.parseNohupOutput(setupResult.stdout);

    if (!info || setupResult.exitCode !== 0) {
      console.warn(
        "[SSH] nohup setup failed, falling back to direct execution:",
        setupResult.stderr || setupResult.stdout
      );
      return this.runCommand(conn, command, timeout, sudoPassword, onData);
    }

    // Phase 3: Monitor via tail --pid
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
      };
    }

    // Phase 4: Read exit code from the exit file
    const exitResult = await this.runCommand(
      conn,
      `cat "${info.exitFile}" 2>/dev/null`,
      10
    );
    const exitCode = parseInt(exitResult.stdout.trim(), 10);

    // Phase 5: Cleanup temp files
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

  private async cacheSudoCredentials(
    conn: Client,
    sudoPassword: string
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 10_000);
      conn.exec(PATH_PREFIX + "sudo -S -v 2>/dev/null", (err, stream) => {
        if (err) {
          clearTimeout(timer);
          resolve();
          return;
        }
        stream.write(sudoPassword + "\n");
        stream.end();
        stream.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    });
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
