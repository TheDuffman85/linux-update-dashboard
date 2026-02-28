import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import { updateCache, updateHistory } from "../db/schema";
import { getSSHManager, EXIT_MONITORING_LOST, EXIT_FILES_GONE, type PersistentCommandInfo } from "../ssh/connection";
import { getParser, type ParsedUpdate } from "../ssh/parsers";
import { sudo } from "../ssh/parsers/types";
import * as cacheService from "./cache-service";
import * as systemService from "./system-service";
import * as outputStream from "./output-stream";
import { sanitizeOutput, sanitizeCommand } from "../utils/sanitize";

// Active operation tracking (visible to the API)
export interface ActiveOperation {
  type: "check" | "upgrade_all" | "full_upgrade_all" | "upgrade_package" | "reboot";
  startedAt: string;
  packageName?: string;
  remotePid?: number;
  remoteLogFile?: string;
  remoteExitFile?: string;
}

const activeOperations = new Map<number, ActiveOperation>();

export function getActiveOperation(systemId: number): ActiveOperation | null {
  return activeOperations.get(systemId) ?? null;
}

export function getAllActiveOperations(): ReadonlyMap<number, ActiveOperation> {
  return activeOperations;
}

// Per-system locks using a simple promise-based mutex
const systemLocks = new Map<number, Promise<void>>();

async function withLock<T>(
  systemId: number,
  fn: () => Promise<T>
): Promise<T> {
  // Wait for any existing lock
  while (systemLocks.has(systemId)) {
    await systemLocks.get(systemId);
  }

  let resolve: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  systemLocks.set(systemId, lock);

  try {
    return await fn();
  } finally {
    systemLocks.delete(systemId);
    resolve!();
  }
}

// Reconnection settings for when SSH drops during an upgrade
const RECONNECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const RECONNECT_INTERVAL_MS = 15 * 1000;     // retry every 15 seconds

interface ReconnectionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  serverRebooted: boolean;
}

/**
 * When SSH monitoring is lost during an upgrade (e.g. server rebooted),
 * attempt to reconnect and determine the actual result.
 */
async function attemptReconnection(
  systemId: number,
  persistentInfo: PersistentCommandInfo,
  preUpgradeUpdateCount: number,
  onData: (chunk: string, stream: "stdout" | "stderr") => void,
): Promise<ReconnectionResult> {
  const system = systemService.getSystem(systemId);
  if (!system) {
    return { exitCode: -1, stdout: "", stderr: "System not found during reconnection", serverRebooted: false };
  }

  const sshManager = getSSHManager();

  outputStream.publish(systemId, {
    type: "warning",
    message: "SSH connection lost. Attempting to reconnect...",
  });
  outputStream.publish(systemId, { type: "phase", phase: "reconnecting" });

  const startTime = Date.now();
  let attempt = 0;
  const maxAttempts = Math.ceil(RECONNECT_TIMEOUT_MS / RECONNECT_INTERVAL_MS);

  while (Date.now() - startTime < RECONNECT_TIMEOUT_MS) {
    attempt++;
    await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    outputStream.publish(systemId, {
      type: "output",
      data: `Reconnection attempt ${attempt}/${maxAttempts}... (${elapsed}s elapsed)\n`,
      stream: "stderr",
    });

    let conn;
    try {
      conn = await sshManager.connect(system as Record<string, unknown>);
    } catch {
      // Connection failed — server still down, keep retrying
      continue;
    }

    try {
      const result = await sshManager.resumePersistentCommand(
        conn,
        persistentInfo,
        3600,
        onData,
      );

      if (result.exitCode === EXIT_FILES_GONE) {
        // Server rebooted — /tmp was cleared. Infer result from update count.
        outputStream.publish(systemId, {
          type: "warning",
          message: "Server appears to have rebooted (temp files cleared). Checking upgrade result...",
        });

        sshManager.disconnect(conn);
        conn = null;

        // Run a fresh update check to see what's still pending.
        // The server may not be fully ready yet (SSH accepts connections
        // before all services are up), so retry a few times.
        const CHECK_RETRIES = 3;
        const CHECK_RETRY_DELAY_MS = 10_000;
        let checkSucceeded = false;

        for (let i = 0; i < CHECK_RETRIES; i++) {
          if (i > 0) {
            outputStream.publish(systemId, {
              type: "output",
              data: `Update check failed, retrying in ${CHECK_RETRY_DELAY_MS / 1000}s...\n`,
              stream: "stderr",
            });
            await new Promise((r) => setTimeout(r, CHECK_RETRY_DELAY_MS));
          }
          await checkUpdatesUnlocked(systemId, true);
          // checkUpdatesUnlocked sets isReachable=1 on success, -1 on failure
          const updated = systemService.getSystem(systemId);
          if (updated?.isReachable === 1) {
            checkSucceeded = true;
            break;
          }
        }

        if (!checkSucceeded) {
          outputStream.publish(systemId, {
            type: "warning",
            message: "Could not verify upgrade result — update check failed after reconnection.",
          });
          return {
            exitCode: -1,
            stdout: "",
            stderr: "Could not verify upgrade result after reconnection",
            serverRebooted: true,
          };
        }

        const db = getDb();
        const newCount = db
          .select()
          .from(updateCache)
          .where(eq(updateCache.systemId, systemId))
          .all().length;

        const success = newCount < preUpgradeUpdateCount;
        const message = success
          ? `Server rebooted during upgrade. Post-reboot check: ${preUpgradeUpdateCount} updates before, ${newCount} after. Upgrade appears successful.`
          : `Server rebooted during upgrade. Post-reboot check: ${preUpgradeUpdateCount} updates before, ${newCount} after. Upgrade may not have completed.`;

        outputStream.publish(systemId, {
          type: "warning",
          message,
        });

        return {
          exitCode: success ? 0 : -1,
          stdout: message,
          stderr: success ? "" : message,
          serverRebooted: true,
        };
      }

      // Files existed — we got an actual result
      sshManager.disconnect(conn);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        serverRebooted: false,
      };
    } catch (e) {
      if (conn) {
        try { sshManager.disconnect(conn); } catch {}
      }
      // Reconnected but something failed — keep retrying
      continue;
    }
  }

  // Timeout — could not reconnect
  outputStream.publish(systemId, {
    type: "warning",
    message: `Reconnection timed out after ${Math.round(RECONNECT_TIMEOUT_MS / 1000)}s. The upgrade process may still be running on the remote system.`,
  });

  return {
    exitCode: -1,
    stdout: "",
    stderr: `Reconnection timed out after ${Math.round(RECONNECT_TIMEOUT_MS / 1000)}s`,
    serverRebooted: false,
  };
}

function storeUpdates(systemId: number, updates: ParsedUpdate[]): void {
  if (!updates.length) return;
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  for (const u of updates) {
    db.insert(updateCache)
      .values({
        systemId,
        pkgManager: u.pkgManager,
        packageName: u.packageName,
        currentVersion: u.currentVersion,
        newVersion: u.newVersion ?? "",
        architecture: u.architecture,
        repository: u.repository,
        isSecurity: u.isSecurity ? 1 : 0,
        cachedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          updateCache.systemId,
          updateCache.pkgManager,
          updateCache.packageName,
        ],
        set: {
          currentVersion: u.currentVersion,
          newVersion: u.newVersion ?? "",
          architecture: u.architecture,
          repository: u.repository,
          isSecurity: u.isSecurity ? 1 : 0,
          cachedAt: now,
        },
      })
      .run();
  }
}

function logHistory(
  systemId: number,
  action: string,
  pkgManager: string,
  status: string,
  opts?: {
    packageCount?: number;
    packages?: string;
    command?: string;
    output?: string;
    error?: string;
  }
): void {
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const completedAt =
    status === "success" || status === "failed" || status === "warning" ? now : null;

  db.insert(updateHistory)
    .values({
      systemId,
      action,
      pkgManager,
      status,
      packageCount: opts?.packageCount ?? null,
      packages: opts?.packages ?? null,
      command: opts?.command ? sanitizeCommand(opts.command) : null,
      output: opts?.output ? sanitizeOutput(opts.output) : null,
      error: opts?.error ? sanitizeOutput(opts.error) : null,
      completedAt,
    })
    .run();
}

/** Insert a "started" history row and return its ID. */
function insertStartedEntry(
  systemId: number,
  action: string,
  pkgManager: string,
  command: string
): number {
  const db = getDb();
  const result = db
    .insert(updateHistory)
    .values({
      systemId,
      action,
      pkgManager,
      status: "started",
      command: sanitizeCommand(command),
      completedAt: null,
    })
    .returning({ id: updateHistory.id })
    .get();
  return result.id;
}

/** Update an existing history row to its final status. */
function finishEntry(
  id: number,
  status: "success" | "failed" | "warning",
  opts?: {
    packageCount?: number;
    packages?: string;
    output?: string;
    error?: string;
  }
): void {
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.update(updateHistory)
    .set({
      status,
      packageCount: opts?.packageCount ?? null,
      packages: opts?.packages ?? null,
      output: opts?.output ? sanitizeOutput(opts.output) : null,
      error: opts?.error ? sanitizeOutput(opts.error) : null,
      completedAt: now,
    })
    .where(eq(updateHistory.id, id))
    .run();
}

async function checkUpdatesUnlocked(
  systemId: number,
  silent = false
): Promise<ParsedUpdate[]> {
  const pub = silent
    ? (_msg: outputStream.WsMessage) => {}
    : (msg: outputStream.WsMessage) => outputStream.publish(systemId, msg);

  const system = systemService.getSystem(systemId);
  if (!system) return [];

  const sshManager = getSSHManager();
  const allUpdates: ParsedUpdate[] = [];
  const allCommands: string[] = [];
  let checkOutput = "";

  let conn;
  let pkgManagers: string[] = [];
  try {
    conn = await sshManager.connect(system as Record<string, unknown>);

    // Update system info
    await systemService.updateSystemInfo(
      systemId,
      sshManager,
      conn
    );

    // Detect package managers if not yet detected
    if (!system.detectedPkgManagers) {
      await systemService.detectAndStorePkgManager(systemId, sshManager, conn);
      // Re-read system to get updated detected list
      const updated = systemService.getSystem(systemId);
      if (updated) {
        pkgManagers = systemService.getActivePkgManagers(updated);
      }
    } else {
      pkgManagers = systemService.getActivePkgManagers(system);
    }

    if (!pkgManagers.length) return [];

    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);

    // Run check for each package manager

    for (const pmName of pkgManagers) {
      try {
        const parser = getParser(pmName);
        if (!parser) continue;

        const commands = parser.getCheckCommands();
        const labels = parser.getCheckCommandLabels?.() ?? [];
        allCommands.push(...commands);
        let lastStdout = "";
        let lastStderr = "";
        let lastExitCode = 0;

        for (let i = 0; i < commands.length; i++) {
          const label = labels[i] ?? (commands.length > 1 ? `Step ${i + 1}/${commands.length}…` : "Checking for updates…");
          pub({ type: "started", command: commands[i], pkgManager: pmName });
          pub({ type: "phase", phase: label });
          const result = await sshManager.runCommand(
            conn,
            commands[i],
            undefined,
            sudoPassword,
            (chunk, stream) => {
              pub({ type: "output", data: chunk, stream });
            }
          );
          checkOutput += result.stdout;
          lastStdout = result.stdout;
          lastStderr = result.stderr;
          lastExitCode = result.exitCode;
        }

        const updates = parser.parseCheckOutput(lastStdout, lastStderr, lastExitCode);
        allUpdates.push(...updates);
        pub({ type: "done", success: true });
      } catch (e) {
        console.error(`System ${systemId} [${pmName}]: check failed:`, sanitizeOutput(String(e)));
        pub({ type: "done", success: false });
      }
    }
  } catch (e) {
    console.error(`System ${systemId}: connection failed:`, sanitizeOutput(String(e)));
    systemService.markUnreachable(systemId);
    pub({ type: "done", success: false });
    if (!silent) {
      logHistory(systemId, "check", system.pkgManager || "unknown", "failed", {
        error: String(e),
      });
    }
    return [];
  } finally {
    if (conn) sshManager.disconnect(conn);
  }

  // Store in cache
  cacheService.invalidateCache(systemId);
  storeUpdates(systemId, allUpdates);

  // Log history (skip when silent — e.g. called from reconnection context)
  if (!silent) {
    logHistory(
      systemId,
      "check",
      allUpdates.length > 0
        ? [...new Set(allUpdates.map((u) => u.pkgManager))].join(",")
        : pkgManagers.join(","),
      "success",
      {
        packageCount: allUpdates.length,
        command: allCommands.join(" && "),
        output: checkOutput.slice(0, 5000) || undefined,
      }
    );
  }

  return allUpdates;
}

export async function checkUpdates(
  systemId: number
): Promise<ParsedUpdate[]> {
  return withLock(systemId, async () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    activeOperations.set(systemId, { type: "check", startedAt: now });
    outputStream.resetStream(systemId);
    try {
      return await checkUpdatesUnlocked(systemId);
    } finally {
      activeOperations.delete(systemId);
    }
  });
}

export async function applyUpgradeAll(
  systemId: number
): Promise<{ success: boolean; output: string; warning?: boolean }> {
  return withLock(systemId, async () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    activeOperations.set(systemId, { type: "upgrade_all", startedAt: now });
    outputStream.resetStream(systemId);
    try {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }

    // Collect all distinct package managers from the cached updates
    const db = getDb();
    const cachedManagers = db
      .selectDistinct({ pkgManager: updateCache.pkgManager })
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all()
      .map((r) => r.pkgManager);

    // Fall back to stored primary manager if cache is empty
    const pkgManagers =
      cachedManagers.length > 0
        ? cachedManagers
        : system.pkgManager
          ? [system.pkgManager]
          : [];

    if (!pkgManagers.length) {
      return { success: false, output: "No package manager detected" };
    }

    const allCommands: string[] = [];
    const allOutputs: string[] = [];
    let overallSuccess = true;
    let reconnectionUsed = false;

    const sshManager = getSSHManager();
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    try {
      conn = await sshManager.connect(system as Record<string, unknown>);

      for (const pmName of pkgManagers) {
        const parser = getParser(pmName);
        if (!parser) continue;

        const cmd = parser.getUpgradeAllCommand();
        allCommands.push(cmd);
        const histId = insertStartedEntry(systemId, "upgrade_all", pmName, cmd);
        outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName });

        const onDataCb = (chunk: string, stream: "stdout" | "stderr") => {
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        };

        const result = await sshManager.runPersistentCommand(
          conn!,
          cmd,
          3600,
          sudoPassword,
          onDataCb,
        );

        let { stdout, stderr, exitCode } = result;

        if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
          // Connection lost — attempt reconnection
          try { sshManager.disconnect(conn!); } catch {}
          conn = undefined;

          const preCount = db
            .select()
            .from(updateCache)
            .where(eq(updateCache.systemId, systemId))
            .all().length;

          const reconResult = await attemptReconnection(
            systemId,
            result.persistentInfo,
            preCount,
            onDataCb,
          );

          stdout = reconResult.stdout || stdout;
          stderr = reconResult.stderr;
          exitCode = reconResult.exitCode;
          reconnectionUsed = true;
        }

        const success = exitCode === 0;
        if (!success) overallSuccess = false;
        allOutputs.push(`[${pmName}] ${success ? stdout : stderr || stdout}`);

        const histStatus = reconnectionUsed && success ? "warning" : success ? "success" : "failed";
        finishEntry(histId, histStatus, {
          output: stdout.slice(0, 5000),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        });

        // If connection was lost, can't continue with remaining package managers
        if (reconnectionUsed) break;
      }

      // Re-check after upgrade (skip if reconnection already ran one)
      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      if (!reconnectionUsed) {
        outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
        await checkUpdatesUnlocked(systemId, true);
      }

      const combinedOutput = allOutputs.join("\n\n");
      outputStream.publish(systemId, { type: "done", success: overallSuccess });
      return { success: overallSuccess, output: combinedOutput, warning: reconnectionUsed && overallSuccess };
    } catch (e) {
      logHistory(
        systemId,
        "upgrade_all",
        pkgManagers.join(","),
        "failed",
        {
          command: allCommands.join(" && "),
          error: String(e),
        }
      );
      outputStream.publish(systemId, { type: "error", message: String(e) });
      outputStream.publish(systemId, { type: "done", success: false });
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
    }
    } finally {
      activeOperations.delete(systemId);
    }
  });
}

export function supportsFullUpgrade(systemId: number): boolean {
  const system = systemService.getSystem(systemId);
  if (!system) return false;
  const pkgManagers = systemService.getActivePkgManagers(system);
  return pkgManagers.some((pmName) => {
    const parser = getParser(pmName);
    return parser?.getFullUpgradeAllCommand() != null;
  });
}

export async function applyFullUpgradeAll(
  systemId: number
): Promise<{ success: boolean; output: string; warning?: boolean }> {
  return withLock(systemId, async () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    activeOperations.set(systemId, { type: "full_upgrade_all", startedAt: now });
    outputStream.resetStream(systemId);
    try {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }

    const db = getDb();
    const cachedManagers = db
      .selectDistinct({ pkgManager: updateCache.pkgManager })
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all()
      .map((r) => r.pkgManager);

    const pkgManagers =
      cachedManagers.length > 0
        ? cachedManagers
        : system.pkgManager
          ? [system.pkgManager]
          : [];

    if (!pkgManagers.length) {
      return { success: false, output: "No package manager detected" };
    }

    const allCommands: string[] = [];
    const allOutputs: string[] = [];
    let overallSuccess = true;
    let reconnectionUsed = false;

    const sshManager = getSSHManager();
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    try {
      conn = await sshManager.connect(system as Record<string, unknown>);

      for (const pmName of pkgManagers) {
        const parser = getParser(pmName);
        if (!parser) continue;

        const cmd = parser.getFullUpgradeAllCommand() ?? parser.getUpgradeAllCommand();
        allCommands.push(cmd);
        const histId = insertStartedEntry(systemId, "full_upgrade_all", pmName, cmd);
        outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName });

        const onDataCb = (chunk: string, stream: "stdout" | "stderr") => {
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        };

        const result = await sshManager.runPersistentCommand(
          conn!,
          cmd,
          3600,
          sudoPassword,
          onDataCb,
        );

        let { stdout, stderr, exitCode } = result;

        if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
          try { sshManager.disconnect(conn!); } catch {}
          conn = undefined;

          const preCount = db
            .select()
            .from(updateCache)
            .where(eq(updateCache.systemId, systemId))
            .all().length;

          const reconResult = await attemptReconnection(
            systemId,
            result.persistentInfo,
            preCount,
            onDataCb,
          );

          stdout = reconResult.stdout || stdout;
          stderr = reconResult.stderr;
          exitCode = reconResult.exitCode;
          reconnectionUsed = true;
        }

        const success = exitCode === 0;
        if (!success) overallSuccess = false;
        allOutputs.push(`[${pmName}] ${success ? stdout : stderr || stdout}`);

        const histStatus = reconnectionUsed && success ? "warning" : success ? "success" : "failed";
        finishEntry(histId, histStatus, {
          output: stdout.slice(0, 5000),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        });

        // If connection was lost, can't continue with remaining package managers
        if (reconnectionUsed) break;
      }

      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      if (!reconnectionUsed) {
        outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
        await checkUpdatesUnlocked(systemId, true);
      }

      const combinedOutput = allOutputs.join("\n\n");
      outputStream.publish(systemId, { type: "done", success: overallSuccess });
      return { success: overallSuccess, output: combinedOutput, warning: reconnectionUsed && overallSuccess };
    } catch (e) {
      logHistory(
        systemId,
        "full_upgrade_all",
        pkgManagers.join(","),
        "failed",
        {
          command: allCommands.join(" && "),
          error: String(e),
        }
      );
      outputStream.publish(systemId, { type: "error", message: String(e) });
      outputStream.publish(systemId, { type: "done", success: false });
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
    }
    } finally {
      activeOperations.delete(systemId);
    }
  });
}

export async function applyUpgradePackage(
  systemId: number,
  packageName: string
): Promise<{ success: boolean; output: string; warning?: boolean }> {
  return withLock(systemId, async () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    activeOperations.set(systemId, { type: "upgrade_package", startedAt: now, packageName });
    outputStream.resetStream(systemId);
    try {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }

    // Look up the package manager from the cache for this specific package
    const db = getDb();
    const cached = db
      .select({ pkgManager: updateCache.pkgManager })
      .from(updateCache)
      .where(
        sql`${updateCache.systemId} = ${systemId} AND ${updateCache.packageName} = ${packageName}`
      )
      .get();

    const pmName = cached?.pkgManager || system.pkgManager;
    if (!pmName) {
      return { success: false, output: "No package manager detected" };
    }

    const parser = getParser(pmName);
    if (!parser) return { success: false, output: "Unknown package manager" };

    const cmd = parser.getUpgradePackageCommand(packageName);
    const sshManager = getSSHManager();
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    let reconnectionUsed = false;

    const histId = insertStartedEntry(systemId, "upgrade_package", pmName, cmd);
    outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName });

    try {
      conn = await sshManager.connect(system as Record<string, unknown>);
      const onDataCb = (chunk: string, stream: "stdout" | "stderr") => {
        outputStream.publish(systemId, { type: "output", data: chunk, stream });
      };

      const result = await sshManager.runPersistentCommand(
        conn,
        cmd,
        300,
        sudoPassword,
        onDataCb,
      );

      let { stdout, stderr, exitCode } = result;

      if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
        try { sshManager.disconnect(conn); } catch {}
        conn = null;

        // For single package, pre-upgrade count is 1
        const reconResult = await attemptReconnection(
          systemId,
          result.persistentInfo,
          1,
          onDataCb,
        );

        stdout = reconResult.stdout || stdout;
        stderr = reconResult.stderr;
        exitCode = reconResult.exitCode;
        reconnectionUsed = true;
      }

      const success = exitCode === 0;
      const histStatus = reconnectionUsed && success ? "warning" : success ? "success" : "failed";
      finishEntry(histId, histStatus, {
        packageCount: 1,
        packages: JSON.stringify([packageName]),
        output: stdout.slice(0, 5000),
        error: success ? undefined : (stderr || stdout).slice(0, 2000),
      });

      // Always re-check after upgrade to reflect the actual package state,
      // even if the upgrade reported a non-zero exit code (e.g. flatpak in
      // Docker reports exit 1 due to cross-device hardlink errors despite the
      // update succeeding).
      if (conn) {
        sshManager.disconnect(conn);
        conn = null;
      }
      if (!reconnectionUsed) {
        outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
        await checkUpdatesUnlocked(systemId, true);
      }

      outputStream.publish(systemId, { type: "done", success });
      return { success, output: success ? stdout : stderr || stdout, warning: reconnectionUsed && success };
    } catch (e) {
      finishEntry(histId, "failed", {
        error: String(e),
      });
      outputStream.publish(systemId, { type: "error", message: String(e) });
      outputStream.publish(systemId, { type: "done", success: false });
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
    }
    } finally {
      activeOperations.delete(systemId);
    }
  });
}

export async function rebootSystem(
  systemId: number
): Promise<{ success: boolean; message: string }> {
  return withLock(systemId, async () => {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    activeOperations.set(systemId, { type: "reboot", startedAt: now });
    outputStream.resetStream(systemId);
    try {
      const system = systemService.getSystem(systemId);
      if (!system) return { success: false, message: "System not found" };

      const sshManager = getSSHManager();
      const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
      const cmd = sudo("reboot");
      const histId = insertStartedEntry(systemId, "reboot", "system", cmd);
      outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: "system" });

      let conn;
      try {
        conn = await sshManager.connect(system as Record<string, unknown>);
        const result = await sshManager.runCommand(conn, cmd, 30, sudoPassword, (chunk, stream) => {
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        });

        // Reboot succeeded or the connection was dropped (expected)
        systemService.markUnreachable(systemId);
        finishEntry(histId, "success", { output: result.stdout || "Reboot command sent" });
        outputStream.publish(systemId, { type: "done", success: true });
        return { success: true, message: "Reboot command sent" };
      } catch (e) {
        const errMsg = String(e);
        // A closed connection after reboot is expected
        if (errMsg.includes("ECONNRESET") || errMsg.includes("closed") || errMsg.includes("end")) {
          systemService.markUnreachable(systemId);
          finishEntry(histId, "success", { output: "Reboot command sent (connection closed)" });
          outputStream.publish(systemId, { type: "done", success: true });
          return { success: true, message: "Reboot command sent" };
        }
        finishEntry(histId, "failed", { error: errMsg });
        outputStream.publish(systemId, { type: "error", message: errMsg });
        outputStream.publish(systemId, { type: "done", success: false });
        return { success: false, message: `Reboot failed: ${errMsg}` };
      } finally {
        if (conn) {
          try { sshManager.disconnect(conn); } catch {}
        }
      }
    } finally {
      activeOperations.delete(systemId);
    }
  });
}

export async function checkAllSystems(): Promise<void> {
  const allSystems = systemService.listSystems();
  await Promise.allSettled(allSystems.map((s) => checkUpdates(s.id)));
}

export function getHistory(systemId: number, limit = 50) {
  const db = getDb();
  return db
    .select()
    .from(updateHistory)
    .where(eq(updateHistory.systemId, systemId))
    .orderBy(desc(updateHistory.startedAt))
    .limit(limit)
    .all();
}
