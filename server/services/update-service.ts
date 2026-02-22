import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import { updateCache, updateHistory } from "../db/schema";
import { getSSHManager } from "../ssh/connection";
import { getParser, type ParsedUpdate } from "../ssh/parsers";
import * as cacheService from "./cache-service";
import * as systemService from "./system-service";
import * as outputStream from "./output-stream";

// Active operation tracking (visible to the API)
export interface ActiveOperation {
  type: "check" | "upgrade_all" | "full_upgrade_all" | "upgrade_package";
  startedAt: string;
  packageName?: string;
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

function storeUpdates(systemId: number, updates: ParsedUpdate[]): void {
  if (!updates.length) return;
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  for (const u of updates) {
    db.run(
      sql`INSERT OR REPLACE INTO update_cache (system_id, pkg_manager, package_name, current_version, new_version, architecture, repository, is_security, cached_at)
          VALUES (${systemId}, ${u.pkgManager}, ${u.packageName}, ${u.currentVersion}, ${u.newVersion}, ${u.architecture}, ${u.repository}, ${u.isSecurity ? 1 : 0}, ${now})`
    );
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
    status === "success" || status === "failed" ? now : null;

  db.insert(updateHistory)
    .values({
      systemId,
      action,
      pkgManager,
      status,
      packageCount: opts?.packageCount ?? null,
      packages: opts?.packages ?? null,
      command: opts?.command ?? null,
      output: opts?.output ?? null,
      error: opts?.error ?? null,
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
      command,
      completedAt: null,
    })
    .returning({ id: updateHistory.id })
    .get();
  return result.id;
}

/** Update an existing history row to its final status. */
function finishEntry(
  id: number,
  status: "success" | "failed",
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
      output: opts?.output ?? null,
      error: opts?.error ?? null,
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
        console.error(`System ${systemId} [${pmName}]: check failed:`, e);
        pub({ type: "done", success: false });
      }
    }
  } catch (e) {
    console.error(`System ${systemId}: connection failed:`, e);
    systemService.markUnreachable(systemId);
    pub({ type: "done", success: false });
    logHistory(systemId, "check", system.pkgManager || "unknown", "failed", {
      error: String(e),
    });
    return [];
  } finally {
    if (conn) sshManager.disconnect(conn);
  }

  // Store in cache
  cacheService.invalidateCache(systemId);
  storeUpdates(systemId, allUpdates);

  // Log history
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
): Promise<{ success: boolean; output: string }> {
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

        const { stdout, stderr, exitCode } = await sshManager.runCommand(
          conn,
          cmd,
          3600,
          sudoPassword,
          (chunk, stream) => {
            outputStream.publish(systemId, { type: "output", data: chunk, stream });
          }
        );

        const success = exitCode === 0;
        if (!success) overallSuccess = false;
        allOutputs.push(`[${pmName}] ${success ? stdout : stderr || stdout}`);

        finishEntry(histId, success ? "success" : "failed", {
          output: stdout.slice(0, 5000),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        });
      }

      // Re-check after upgrade
      sshManager.disconnect(conn);
      conn = null;
      outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
      await checkUpdatesUnlocked(systemId, true);

      const combinedOutput = allOutputs.join("\n\n");
      outputStream.publish(systemId, { type: "done", success: overallSuccess });
      return { success: overallSuccess, output: combinedOutput };
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
): Promise<{ success: boolean; output: string }> {
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

        const { stdout, stderr, exitCode } = await sshManager.runCommand(
          conn,
          cmd,
          3600,
          sudoPassword,
          (chunk, stream) => {
            outputStream.publish(systemId, { type: "output", data: chunk, stream });
          }
        );

        const success = exitCode === 0;
        if (!success) overallSuccess = false;
        allOutputs.push(`[${pmName}] ${success ? stdout : stderr || stdout}`);

        finishEntry(histId, success ? "success" : "failed", {
          output: stdout.slice(0, 5000),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        });
      }

      sshManager.disconnect(conn);
      conn = null;
      outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
      await checkUpdatesUnlocked(systemId, true);

      const combinedOutput = allOutputs.join("\n\n");
      outputStream.publish(systemId, { type: "done", success: overallSuccess });
      return { success: overallSuccess, output: combinedOutput };
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
): Promise<{ success: boolean; output: string }> {
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

    outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName });

    try {
      conn = await sshManager.connect(system as Record<string, unknown>);
      const { stdout, stderr, exitCode } = await sshManager.runCommand(
        conn,
        cmd,
        300,
        sudoPassword,
        (chunk, stream) => {
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        }
      );

      const success = exitCode === 0;
      logHistory(
        systemId,
        "upgrade_package",
        pmName,
        success ? "success" : "failed",
        {
          packageCount: 1,
          packages: JSON.stringify([packageName]),
          command: cmd,
          output: stdout.slice(0, 5000),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        }
      );

      if (success) {
        sshManager.disconnect(conn);
        conn = null;
        outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
        await checkUpdatesUnlocked(systemId, true);
      }

      outputStream.publish(systemId, { type: "done", success });
      return { success, output: success ? stdout : stderr || stdout };
    } catch (e) {
      logHistory(systemId, "upgrade_package", pmName, "failed", {
        command: cmd,
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
