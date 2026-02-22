import { Client } from "ssh2";
import type { CredentialEncryptor } from "../security";

// Non-interactive SSH sessions often have a minimal PATH
const PATH_PREFIX =
  "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; ";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
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
