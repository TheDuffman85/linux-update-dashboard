import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import { updateCache, updateHistory } from "../db/schema";
import { getSSHManager } from "../ssh/connection";
import { getParser, type ParsedUpdate } from "../ssh/parsers";
import * as cacheService from "./cache-service";
import * as systemService from "./system-service";

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

async function checkUpdatesUnlocked(
  systemId: number
): Promise<ParsedUpdate[]> {
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
        allCommands.push(...commands);
        let stdout = "";
        let stderr = "";
        let exitCode = 0;

        for (let i = 0; i < commands.length; i++) {
          const result = await sshManager.runCommand(conn, commands[i], undefined, sudoPassword);
          stdout = result.stdout;
          stderr = result.stderr;
          exitCode = result.exitCode;
        }

        checkOutput += stdout;
        const updates = parser.parseCheckOutput(stdout, stderr, exitCode);
        allUpdates.push(...updates);
      } catch (e) {
        console.error(`System ${systemId} [${pmName}]: check failed:`, e);
      }
    }
  } catch (e) {
    console.error(`System ${systemId}: connection failed:`, e);
    systemService.markUnreachable(systemId);
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
  return withLock(systemId, () => checkUpdatesUnlocked(systemId));
}

export async function applyUpgradeAll(
  systemId: number
): Promise<{ success: boolean; output: string }> {
  return withLock(systemId, async () => {
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
        logHistory(systemId, "upgrade_all", pmName, "started", { command: cmd });

        const { stdout, stderr, exitCode } = await sshManager.runCommand(
          conn,
          cmd,
          600,
          sudoPassword
        );

        const success = exitCode === 0;
        if (!success) overallSuccess = false;
        allOutputs.push(`[${pmName}] ${success ? stdout : stderr || stdout}`);

        logHistory(
          systemId,
          "upgrade_all",
          pmName,
          success ? "success" : "failed",
          {
            command: cmd,
            output: stdout.slice(0, 5000),
            error: success ? undefined : (stderr || stdout).slice(0, 2000),
          }
        );
      }

      // Re-check after upgrade
      sshManager.disconnect(conn);
      conn = null;
      await checkUpdatesUnlocked(systemId);

      const combinedOutput = allOutputs.join("\n\n");
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
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
    }
  });
}

export async function applyUpgradePackage(
  systemId: number,
  packageName: string
): Promise<{ success: boolean; output: string }> {
  return withLock(systemId, async () => {
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

    try {
      conn = await sshManager.connect(system as Record<string, unknown>);
      const { stdout, stderr, exitCode } = await sshManager.runCommand(
        conn,
        cmd,
        300,
        sudoPassword
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
        await checkUpdatesUnlocked(systemId);
      }

      return { success, output: success ? stdout : stderr || stdout };
    } catch (e) {
      logHistory(systemId, "upgrade_package", pmName, "failed", {
        command: cmd,
        error: String(e),
      });
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
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
