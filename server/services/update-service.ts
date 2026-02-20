import { eq, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import { updateCache, updateHistory, settings } from "../db/schema";
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

  let conn;
  try {
    conn = await sshManager.connect(system as Record<string, unknown>);

    // Update system info
    await systemService.updateSystemInfo(
      systemId,
      sshManager,
      conn
    );

    // Detect package managers if not set
    let pkgManagers: string[] = [];
    if (system.pkgManager) {
      pkgManagers = [system.pkgManager];
    } else {
      pkgManagers = await systemService.detectAndStorePkgManager(
        systemId,
        sshManager,
        conn
      );
    }

    if (!pkgManagers.length) return [];

    // Check optional managers
    const db = getDb();
    const checkFlatpak =
      (db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "check_flatpak"))
        .get()?.value || "0") === "1";
    const checkSnap =
      (db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "check_snap"))
        .get()?.value || "0") === "1";

    if (checkFlatpak && !pkgManagers.includes("flatpak")) {
      const { stdout, exitCode } = await sshManager.runCommand(
        conn,
        "which flatpak 2>/dev/null && echo 'found'",
        10
      );
      if (exitCode === 0 && stdout.includes("found"))
        pkgManagers.push("flatpak");
    }
    if (checkSnap && !pkgManagers.includes("snap")) {
      const { stdout, exitCode } = await sshManager.runCommand(
        conn,
        "which snap 2>/dev/null && echo 'found'",
        10
      );
      if (exitCode === 0 && stdout.includes("found"))
        pkgManagers.push("snap");
    }

    // Run check for each package manager
    for (const pmName of pkgManagers) {
      try {
        const parser = getParser(pmName);
        if (!parser) continue;

        const commands = parser.getCheckCommands();
        let stdout = "";
        let stderr = "";
        let exitCode = 0;

        for (let i = 0; i < commands.length; i++) {
          const result = await sshManager.runCommand(conn, commands[i]);
          stdout = result.stdout;
          stderr = result.stderr;
          exitCode = result.exitCode;
        }

        const updates = parser.parseCheckOutput(stdout, stderr, exitCode);
        allUpdates.push(...updates);
      } catch (e) {
        console.error(`System ${systemId} [${pmName}]: check failed:`, e);
      }
    }
  } catch (e) {
    console.error(`System ${systemId}: connection failed:`, e);
    systemService.markUnreachable(systemId);
    logHistory(systemId, "check", "unknown", "failed", {
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
      : "unknown",
    "success",
    { packageCount: allUpdates.length }
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
    if (!system?.pkgManager) {
      return {
        success: false,
        output: "System not found or no package manager detected",
      };
    }

    const parser = getParser(system.pkgManager);
    if (!parser) return { success: false, output: "Unknown package manager" };

    const cmd = parser.getUpgradeAllCommand();
    logHistory(systemId, "upgrade_all", system.pkgManager, "started");

    const sshManager = getSSHManager();
    let conn;
    try {
      conn = await sshManager.connect(system as Record<string, unknown>);
      const { stdout, stderr, exitCode } = await sshManager.runCommand(
        conn,
        cmd,
        600
      );

      const success = exitCode === 0;
      logHistory(
        systemId,
        "upgrade_all",
        system.pkgManager,
        success ? "success" : "failed",
        {
          output: stdout.slice(0, 5000),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        }
      );

      // Re-check after upgrade
      if (success) {
        sshManager.disconnect(conn);
        conn = null;
        await checkUpdatesUnlocked(systemId);
      }

      return { success, output: success ? stdout : stderr || stdout };
    } catch (e) {
      logHistory(systemId, "upgrade_all", system.pkgManager, "failed", {
        error: String(e),
      });
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
    if (!system?.pkgManager) {
      return {
        success: false,
        output: "System not found or no package manager detected",
      };
    }

    const parser = getParser(system.pkgManager);
    if (!parser) return { success: false, output: "Unknown package manager" };

    const cmd = parser.getUpgradePackageCommand(packageName);
    const sshManager = getSSHManager();
    let conn;

    try {
      conn = await sshManager.connect(system as Record<string, unknown>);
      const { stdout, stderr, exitCode } = await sshManager.runCommand(
        conn,
        cmd,
        300
      );

      const success = exitCode === 0;
      logHistory(
        systemId,
        "upgrade_package",
        system.pkgManager,
        success ? "success" : "failed",
        {
          packageCount: 1,
          packages: JSON.stringify([packageName]),
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
      logHistory(systemId, "upgrade_package", system.pkgManager, "failed", {
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
