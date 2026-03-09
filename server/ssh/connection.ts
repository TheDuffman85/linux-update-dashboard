import { createHash, randomUUID } from "crypto";
import { Client, utils, type ClientChannel } from "ssh2";
import type { CredentialEncryptor } from "../security";
import { logger } from "../logger";
import { sanitizeOutput } from "../utils/sanitize";
import {
  buildSSHAttemptLogMeta,
  createSafeSshDebugHook,
  type SSHConnectContext,
} from "./diagnostics";
import type { PublicKeyAuthMethod } from "ssh2";
import {
  buildSshCertificateParsedKey,
  resolveSystemCredential,
} from "../services/credential-service";
import {
  MAX_PROXY_JUMP_DEPTH,
  getSystem,
} from "../services/system-service";
import type { ApprovedHostKeyInput } from "../services/system-connection-validation";

// Non-interactive SSH sessions often have a minimal PATH; force C locale so
// package-manager output is always in English for reliable parsing.
const PATH_PREFIX =
  "export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";

const SUDO_STDIN_PATTERN = /\bsudo -S(?: -p ''| -p "")?(?=\s)/g;

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function wrapRemoteCommand(command: string): string {
  // Avoid `sh -l`: login shells source profile files, and user dotfiles often
  // contain bash/zsh-specific init that breaks under /bin/sh during SSH exec.
  return `sh -c ${shellSingleQuote(PATH_PREFIX + command)}`;
}

/**
 * For nohup/background execution, there is no interactive stdin channel.
 * Convert stdin-driven sudo invocations to `sudo -n` for systems where
 * elevation is already available non-interactively (root or passwordless sudo).
 */
export function preparePersistentSudoCommand(command: string): string {
  if (!command.includes("sudo -S")) return command;
  return command.replace(SUDO_STDIN_PATTERN, "sudo -n");
}

export function buildPersistentSetupCommand(
  command: string,
  sudoPasswordProvided: boolean
): { setupCmd: string; useSudoLaunch: boolean } {
  const needsSudoStdin = command.includes("sudo -S");
  const useSudoLaunch = needsSudoStdin && sudoPasswordProvided;
  const persistentCommand = useSudoLaunch
    ? command
    : needsSudoStdin
      ? preparePersistentSudoCommand(command)
      : command;

  const scriptBody = [
    "#!/bin/sh",
    persistentCommand,
    "RC=$?",
    'printf "%s" "$RC" > "$1"',
    'rm -f "$0"',
    'exit "$RC"',
    "",
  ].join("\n");
  const base64Cmd = Buffer.from(scriptBody).toString("base64");
  const setupCmdParts = [
    'BASE=$(mktemp /tmp/ludash_XXXXXX)',
    'SCRIPT="${BASE}.sh"',
    'LOGFILE="${BASE}.log"',
    'EXITFILE="${BASE}.exit"',
    'rm -f "$BASE"',
    `printf '%s' '${base64Cmd}' | base64 -d > "$SCRIPT"`,
    'chmod 700 "$SCRIPT"',
  ];
  const launchInnerCmd = [
    'nohup sh "$1" "$2" > "$3" 2>&1 < /dev/null &',
    'echo "LUDASH_BG PID=$! LOG=$3 EXIT=$2"',
  ].join("\n");
  const launchCmd =
    `sh -c ${shellSingleQuote(launchInnerCmd)} _ "$SCRIPT" "$EXITFILE" "$LOGFILE"`;
  const rootLaunchCmd = useSudoLaunch
    ? `if [ "$(id -u)" = "0" ]; then ${launchCmd}; elif command -v sudo >/dev/null 2>&1; then sudo -S -p '' ${launchCmd}; else ${launchCmd}; fi`
    : launchCmd;

  return {
    setupCmd: setupCmdParts.join(" && ") + ` && ${rootLaunchCmd}`,
    useSudoLaunch,
  };
}

export function buildTailMonitorCommand(logFile: string, pid: number): string {
  const monitorInner = [
    'LOGFILE="$1"',
    'PID="$2"',
    'tail -F "$LOGFILE" 2>/dev/null &',
    'TAILPID=$!',
    'while [ -d "/proc/$PID" ]; do sleep 1; done',
    'sleep 1',
    'kill "$TAILPID" 2>/dev/null || true',
    'wait "$TAILPID" 2>/dev/null || true',
  ].join("\n");
  return `sh -c ${shellSingleQuote(monitorInner)} -- ${shellSingleQuote(logFile)} ${shellSingleQuote(String(pid))}`;
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

interface SSHConnectionError extends Error {
  level?: string;
  description?: string;
  debugRef?: string;
}

export interface TestConnectionResult {
  success: boolean;
  message: string;
  debugRef?: string;
  hostKeyChallenges?: ApprovedHostKeyInput[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackHost(hostname: unknown): hostname is string {
  return typeof hostname === "string" && LOOPBACK_HOSTS.has(hostname.trim().toLowerCase());
}

export function buildTestConnectionFailureMessage(
  system: Record<string, unknown>,
  err: SSHConnectionError
): string {
  const baseMessage = `Connection failed: ${sanitizeOutput(err.message || String(err))}`;
  const hasProxyJump = typeof system.proxyJumpSystemId === "number";
  if (!hasProxyJump || !isLoopbackHost(system.hostname)) {
    return baseMessage;
  }

  const rawMessage = err.message || String(err);
  if (!/channel open failure/i.test(rawMessage)) {
    return baseMessage;
  }

  return `${baseMessage}. With Proxy Jump enabled, ${system.hostname} is resolved from the jump host. Use a host or IP that the jump host can reach instead of loopback.`;
}

interface ResolvedSSHHop extends Record<string, unknown> {
  systemId?: number;
  role: "jump" | "target";
  name?: string;
  hostname: string;
  port: number;
  username: string;
  authType: "password" | "key";
  credentialId?: number;
  hostKeyVerificationEnabled: boolean;
  trustedHostKey?: string | null;
}

class HostKeyVerificationError extends Error {
  challenges: ApprovedHostKeyInput[];

  constructor(challenges: ApprovedHostKeyInput[]) {
    super(
      challenges.some((challenge) => challenge.fingerprintSha256)
        ? "SSH host key approval required"
        : "SSH host key verification failed"
    );
    this.name = "HostKeyVerificationError";
    this.challenges = challenges;
  }
}

export class SSHConnectionManager {
  private maxConcurrent: number;
  private currentConnections = 0;
  private queue: Array<() => void> = [];
  private defaultTimeout: number;
  private defaultCmdTimeout: number;
  private encryptor: CredentialEncryptor;
  private chainedConnections = new WeakMap<Client, Client[]>();

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

  async connect(
    system: Record<string, unknown>,
    context: SSHConnectContext = {}
  ): Promise<Client> {
    await this.acquireSemaphore();

    const chain = this.resolveChain(system, context);
    const clients: Client[] = [];

    try {
      let forwardClient: Client | null = null;

      for (const [index, hop] of chain.entries()) {
        const sock = forwardClient
          ? await this.openForwardStream(forwardClient, hop.hostname, hop.port)
          : undefined;
        const client = await this.connectSingleHop(
          hop,
          index,
          chain.length,
          context,
          sock
        );
        clients.push(client);
        forwardClient = client;
      }

      const leaf = clients.at(-1);
      if (!leaf) {
        throw new Error("SSH connection chain resolved to no hops");
      }
      this.chainedConnections.set(leaf, clients);
      return leaf;
    } catch (error) {
      for (const client of clients.reverse()) {
        try {
          client.end();
        } catch {}
      }
      this.releaseSemaphore();
      throw error;
    }
  }

  private resolveChain(
    system: Record<string, unknown>,
    context: SSHConnectContext
  ): ResolvedSSHHop[] {
    const chain: ResolvedSSHHop[] = [];
    const seen = new Set<number>();
    if (context.systemId) seen.add(context.systemId);

    const target: ResolvedSSHHop = {
      ...system,
      systemId: context.systemId ?? (typeof system.id === "number" ? system.id : undefined),
      role: "target",
      hostname: String(system.hostname || ""),
      port:
        typeof system.port === "number" && Number.isInteger(system.port) && system.port > 0
          ? system.port
          : 22,
      username: String(system.username || ""),
      authType: system.authType === "key" ? "key" : "password",
      credentialId:
        typeof system.credentialId === "number" ? system.credentialId : undefined,
      hostKeyVerificationEnabled:
        system.hostKeyVerificationEnabled === undefined
          ? true
          : system.hostKeyVerificationEnabled === true ||
            system.hostKeyVerificationEnabled === 1,
      trustedHostKey:
        typeof system.trustedHostKey === "string" ? system.trustedHostKey : null,
    };
    chain.push(target);

    let currentProxyJumpId =
      typeof system.proxyJumpSystemId === "number"
        ? system.proxyJumpSystemId
        : null;

    while (currentProxyJumpId) {
      if (seen.has(currentProxyJumpId)) {
        throw new Error("ProxyJump configuration contains a cycle.");
      }
      if (chain.length >= MAX_PROXY_JUMP_DEPTH) {
        throw new Error(
          `ProxyJump chain exceeds the maximum depth of ${MAX_PROXY_JUMP_DEPTH}.`
        );
      }
      seen.add(currentProxyJumpId);

      const hop = getSystem(currentProxyJumpId);
      if (!hop) {
        throw new Error("Selected ProxyJump system does not exist.");
      }

      chain.push({
        ...hop,
        systemId: hop.id,
        role: "jump",
        hostname: hop.hostname,
        port: hop.port,
        username: hop.username,
        authType: hop.authType === "key" ? "key" : "password",
        credentialId: hop.credentialId ?? undefined,
        hostKeyVerificationEnabled: hop.hostKeyVerificationEnabled === 1,
        trustedHostKey: hop.trustedHostKey,
      });
      currentProxyJumpId = hop.proxyJumpSystemId ?? null;
    }

    return chain.reverse().map((hop, index, hops) => ({
      ...hop,
      role: index === hops.length - 1 ? "target" : "jump",
    }));
  }

  private buildConnectionConfig(hop: ResolvedSSHHop): Record<string, unknown> {
    const connectConfig: Record<string, unknown> = {
      host: hop.hostname,
      port: hop.port,
      username: hop.username,
      readyTimeout: this.defaultTimeout * 1000,
    };

    if (hop.authType === "password" && hop.encryptedPassword) {
      connectConfig.password = this.encryptor.decrypt(hop.encryptedPassword as string);
    } else if (hop.authType === "password" && hop.credentialId) {
      const credential = resolveSystemCredential(Number(hop.credentialId));
      if (credential?.encryptedPassword) {
        connectConfig.password = this.encryptor.decrypt(credential.encryptedPassword);
      }
    } else if (hop.authType === "key" && hop.encryptedPrivateKey) {
      connectConfig.privateKey = this.encryptor.decrypt(
        hop.encryptedPrivateKey as string
      );
      if (hop.encryptedKeyPassphrase) {
        connectConfig.passphrase = this.encryptor.decrypt(
          hop.encryptedKeyPassphrase as string
        );
      }
    } else if (hop.authType === "key" && hop.credentialId) {
      const credential = resolveSystemCredential(Number(hop.credentialId));
      if (credential?.kind === "certificate") {
        const parsedKey = buildSshCertificateParsedKey(credential);
        if (parsedKey) {
          connectConfig.authHandler = [
            {
              type: "publickey",
              username: credential.username,
              key: parsedKey,
            } satisfies PublicKeyAuthMethod,
          ];
        }
      } else if (credential?.encryptedPrivateKey) {
        connectConfig.privateKey = this.encryptor.decrypt(
          credential.encryptedPrivateKey
        );
      }
      if (credential?.encryptedKeyPassphrase) {
        connectConfig.passphrase = this.encryptor.decrypt(
          credential.encryptedKeyPassphrase
        );
      }
    }

    return connectConfig;
  }

  private findApprovedHostKey(
    hop: ResolvedSSHHop,
    context: SSHConnectContext
  ): ApprovedHostKeyInput | undefined {
    return context.approvedHostKeys?.find((approvedHostKey) =>
      approvedHostKey.role === hop.role &&
      approvedHostKey.host === hop.hostname &&
      approvedHostKey.port === hop.port &&
      (approvedHostKey.systemId ?? null) === (hop.systemId ?? null)
    );
  }

  private createHostKeyChallenge(
    hop: ResolvedSSHHop,
    key: Buffer,
    reason: "missing" | "mismatch"
  ): ApprovedHostKeyInput {
    const parsedKey = utils.parseKey(key);
    const algorithm =
      parsedKey instanceof Error ? "unknown" : parsedKey.type;
    const fingerprintSha256 = `SHA256:${createHash("sha256")
      .update(key)
      .digest("base64")
      .replace(/=+$/g, "")}`;

    return {
      systemId: hop.systemId,
      role: hop.role,
      host: hop.hostname,
      port: hop.port,
      algorithm,
      fingerprintSha256,
      rawKey: key.toString("base64"),
    };
  }

  private async connectSingleHop(
    hop: ResolvedSSHHop,
    hopIndex: number,
    hopCount: number,
    context: SSHConnectContext,
    sock?: ClientChannel
  ): Promise<Client> {
    const attemptId = randomUUID();
    const startedAt = Date.now();
    const meta = buildSSHAttemptLogMeta(hop, context);
    const conn = new Client();
    const connectConfig = this.buildConnectionConfig(hop);
    const approvedHostKey = this.findApprovedHostKey(hop, context);
    let hostKeyError: HostKeyVerificationError | null = null;

    connectConfig.readyTimeout = this.defaultTimeout * 1000;
    if (sock) {
      connectConfig.sock = sock;
    }

    connectConfig.hostVerifier = (key: Buffer) => {
      if (!hop.hostKeyVerificationEnabled) return true;

      const currentKey = key.toString("base64");
      const expectedKey = approvedHostKey?.rawKey || hop.trustedHostKey;
      if (expectedKey && expectedKey === currentKey) return true;

      hostKeyError = new HostKeyVerificationError([
        this.createHostKeyChallenge(
          hop,
          key,
          expectedKey ? "mismatch" : "missing"
        ),
      ]);
      return false;
    };

    const debugHook = createSafeSshDebugHook(logger, attemptId);
    if (debugHook) {
      connectConfig.debug = debugHook;
    }

    logger.debug("SSH connect attempt started", {
      attemptId,
      hopIndex: hopIndex + 1,
      hopCount,
      hopRole: hop.role,
      ...meta,
    });

    return new Promise<Client>((resolve, reject) => {
      const onReady = () => {
        conn.removeListener("error", onError);
        logger.debug("SSH connect attempt succeeded", {
          attemptId,
          hopIndex: hopIndex + 1,
          hopCount,
          hopRole: hop.role,
          elapsedMs: Date.now() - startedAt,
          ...meta,
        });
        resolve(conn);
      };

      const onError = (err: SSHConnectionError) => {
        conn.removeListener("ready", onReady);
        err.debugRef = attemptId;
        logger.warn("SSH connect attempt failed", {
          attemptId,
          hopIndex: hopIndex + 1,
          hopCount,
          hopRole: hop.role,
          elapsedMs: Date.now() - startedAt,
          ...meta,
          errorLevel: err.level,
          errorDescription: err.description
            ? sanitizeOutput(err.description)
            : undefined,
          error: sanitizeOutput(err.message || String(err)),
        });
        reject(hostKeyError ?? err);
      };

      conn.once("ready", onReady);
      conn.once("error", onError);
      conn.connect(connectConfig as Parameters<Client["connect"]>[0]);
    });
  }

  private openForwardStream(
    conn: Client,
    host: string,
    port: number
  ): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      conn.forwardOut("127.0.0.1", 0, host, port, (err, stream) => {
        if (err || !stream) {
          reject(err ?? new Error("Failed to open ProxyJump forward stream"));
          return;
        }
        resolve(stream);
      });
    });
  }

  disconnect(conn: Client): void {
    const chain = this.chainedConnections.get(conn) ?? [conn];
    this.chainedConnections.delete(conn);
    for (const client of [...chain].reverse()) {
      try {
        client.end();
      } catch {}
    }
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
    const wrappedCommand = wrapRemoteCommand(command);

    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          stdout: "",
          stderr: `Command timed out after ${cmdTimeout}s`,
          exitCode: -1,
        });
      }, cmdTimeout * 1000);

      conn.exec(wrappedCommand, (err, stream) => {
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
   * Output is streamed from a remote log file using a BusyBox-compatible
   * tail/kill loop, so it works on Alpine as well as GNU coreutils systems.
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
    const { setupCmd, useSudoLaunch } = buildPersistentSetupCommand(
      command,
      !!sudoPassword
    );

    const setupResult = await this.runCommand(
      conn,
      setupCmd,
      30,
      useSudoLaunch ? sudoPassword : undefined
    );
    const info = this.parseNohupOutput(setupResult.stdout);

    if (!info || setupResult.exitCode !== 0) {
      logger.warn("SSH nohup setup failed", {
        error: sanitizeOutput(setupResult.stderr || setupResult.stdout),
      });
      return {
        stdout: setupResult.stdout,
        stderr:
          setupResult.stderr ||
          "Failed to start SSH-safe background command",
        exitCode: setupResult.exitCode || -1,
      };
    }

    const tailResult = await this.runTailMonitor(
      conn,
      info.logFile,
      info.pid,
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
    logFile: string,
    pid: number,
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

      const tailCommand = buildTailMonitorCommand(logFile, pid);
      conn.exec(wrapRemoteCommand(tailCommand), (err, stream) => {
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
      `[ -d "/proc/${info.pid}" ] && echo "alive" || echo "dead"`,
      10
    );

    if (pidCheck.stdout.trim() === "alive") {
      // Re-attach tail monitor
      const tailResult = await this.runTailMonitor(
        conn,
        info.logFile,
        info.pid,
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
    system: Record<string, unknown>,
    context: SSHConnectContext = {}
  ): Promise<TestConnectionResult> {
    let conn: Client | null = null;
    try {
      conn = await this.connect(system, context);
      const result = await this.runCommand(conn, "echo ok", 10);
      if (result.exitCode === 0 && result.stdout.includes("ok")) {
        return { success: true, message: "Connection successful" };
      }
      return {
        success: false,
        message: `Unexpected response: ${result.stderr || result.stdout}`,
      };
    } catch (e: unknown) {
      if (e instanceof HostKeyVerificationError) {
        return {
          success: false,
          message: e.challenges.some((challenge) => challenge.rawKey)
            ? "SSH host key approval required"
            : "SSH host key verification failed",
          hostKeyChallenges: e.challenges,
        };
      }
      const err = e as SSHConnectionError;
      if (err.level === "client-authentication") {
        return {
          success: false,
          message: "Permission denied (check credentials)",
          debugRef: err.debugRef,
        };
      }
      return {
        success: false,
        message: buildTestConnectionFailureMessage(system, err),
        debugRef: err.debugRef,
      };
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
