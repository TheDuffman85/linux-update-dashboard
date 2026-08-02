import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import {
  customPackageManagers,
  customScripts,
  dashboardGroups,
  hiddenUpdates,
  systems,
  updateHistory,
  upgradeBatchItems,
  upgradeBatches,
} from "../../server/db/schema";
import { listSystems } from "../../server/services/system-service";

describe("database startup cleanup", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-db-cleanup-test-"));
    dbPath = join(tempDir, "dashboard.db");
    initDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("marks orphaned SSH-safe maintenance rows as warning after restart", () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get();

    const history = db.insert(updateHistory).values([
      {
        systemId: inserted.id,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "started",
        command: "sudo apt-get upgrade -y",
      },
      {
        systemId: inserted.id,
        action: "autoremove",
        pkgManager: "apt",
        status: "started",
        command: "sudo apt-get autoremove -y",
      },
    ]).returning({ id: updateHistory.id }).all();

    closeDatabase();
    initDatabase(dbPath);

    const restartedDb = getDb();
    const rows = restartedDb
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, inserted.id))
      .all();

    expect(history).toHaveLength(2);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("warning");
      expect(row.output).toBe("Server restarted while operation was in progress");
      expect(row.error).toBeNull();
      expect(row.completedAt).not.toBeNull();
    }
  });

  test("marks orphaned non-SSH-safe rows as failed after restart", () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get();

    const history = db.insert(updateHistory).values({
      systemId: inserted.id,
      action: "check",
      pkgManager: "apt",
      status: "started",
      command: "apt-get update",
    }).returning({ id: updateHistory.id }).get();

    closeDatabase();
    initDatabase(dbPath);

    const restartedDb = getDb();
    const row = restartedDb
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.id, history.id))
      .get();

    expect(row?.status).toBe("failed");
    expect(row?.output).toBeNull();
    expect(row?.error).toBe("Server restarted while operation was in progress");
    expect(row?.completedAt).not.toBeNull();
  });

  test("adds the steps column for legacy update history tables", () => {
    closeDatabase();
    unlinkSync(dbPath);

    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE update_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        pkg_manager TEXT NOT NULL,
        package_count INTEGER,
        packages TEXT,
        command TEXT,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
    `);
    sqlite.exec(`
      INSERT INTO update_history (system_id, action, pkg_manager, command, status, output)
      VALUES (1, 'check', 'apt', 'apt-get update', 'success', 'ok')
    `);
    sqlite.close();

    initDatabase(dbPath);

    const restartedDb = getDb();
    const columns = restartedDb.all(sql`PRAGMA table_info(update_history)`) as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "steps")).toBe(true);

    const row = restartedDb.select().from(updateHistory).get();
    expect(row?.command).toBe("apt-get update");
    expect(row?.steps).toBeNull();
  });

  test("assigns alphabetical sort order when existing systems all use the default order", () => {
    const db = getDb();
    db.insert(systems).values([
      {
        name: "Zulu",
        hostname: "zulu.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        name: "Mike",
        hostname: "mike.local",
        port: 22,
        authType: "password",
        username: "root",
      },
    ]).run();

    closeDatabase();
    initDatabase(dbPath);

    expect(listSystems().map((system) => system.name)).toEqual([
      "Alpha",
      "Mike",
      "Zulu",
    ]);
  });

  test("preserves a custom sort order on restart", () => {
    const db = getDb();
    db.insert(systems).values([
      {
        sortOrder: 2,
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        sortOrder: 0,
        name: "Zulu",
        hostname: "zulu.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        sortOrder: 1,
        name: "Mike",
        hostname: "mike.local",
        port: 22,
        authType: "password",
        username: "root",
      },
    ]).run();

    closeDatabase();
    initDatabase(dbPath);

    expect(listSystems().map((system) => system.name)).toEqual([
      "Zulu",
      "Mike",
      "Alpha",
    ]);
  });

  test("migrates the legacy kept-back column into the per-system auto-hide flag", () => {
    closeDatabase();
    unlinkSync(dbPath);

    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE systems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        credential_id INTEGER,
        proxy_jump_system_id INTEGER,
        auth_type TEXT NOT NULL DEFAULT 'password',
        username TEXT NOT NULL,
        encrypted_password TEXT,
        encrypted_private_key TEXT,
        encrypted_key_passphrase TEXT,
        encrypted_sudo_password TEXT,
        host_key_verification_enabled INTEGER NOT NULL DEFAULT 1,
        trusted_host_key TEXT,
        trusted_host_key_algorithm TEXT,
        trusted_host_key_fingerprint_sha256 TEXT,
        host_key_trusted_at TEXT,
        pkg_manager TEXT,
        detected_pkg_managers TEXT,
        disabled_pkg_managers TEXT,
        os_name TEXT,
        os_version TEXT,
        kernel TEXT,
        hostname_remote TEXT,
        uptime TEXT,
        arch TEXT,
        cpu_cores TEXT,
        memory TEXT,
        disk TEXT,
        ignore_kept_back_packages INTEGER NOT NULL DEFAULT 0,
        exclude_from_upgrade_all INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        needs_reboot INTEGER NOT NULL DEFAULT 0,
        boot_id TEXT,
        system_info_updated_at TEXT,
        is_reachable INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_notified_hash TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    sqlite.exec(`
      INSERT INTO systems (
        sort_order, name, hostname, port, auth_type, username,
        pkg_manager, detected_pkg_managers, ignore_kept_back_packages,
        exclude_from_upgrade_all, hidden, needs_reboot, boot_id, is_reachable
      ) VALUES (
        0, 'Legacy Debian', 'legacy.local', 22, 'password', 'root',
        'apt', '["apt"]', 1,
        1, 0, 1, 'boot-legacy', 1
      );
    `);
    sqlite.exec(`
      CREATE TABLE hidden_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
        pkg_manager TEXT NOT NULL,
        package_name TEXT NOT NULL,
        current_version TEXT,
        new_version TEXT NOT NULL,
        architecture TEXT,
        repository TEXT,
        is_security INTEGER NOT NULL DEFAULT 0,
        is_kept_back INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        last_matched_at TEXT NOT NULL DEFAULT (datetime('now')),
        inactive_since TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(system_id, pkg_manager, package_name, new_version)
      );
      INSERT INTO hidden_updates (
        system_id, pkg_manager, package_name, current_version, new_version,
        is_kept_back, active
      ) VALUES (
        1, 'apt', 'legacy-held', '1.0', '2.0', 0, 1
      );
    `);
    sqlite.close();

    initDatabase(dbPath);

    const restartedSqlite = new Database(dbPath, { readonly: true });
    const columns = restartedSqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    const hiddenColumns = restartedSqlite
      .prepare("PRAGMA table_info(hidden_updates)")
      .all() as Array<{ name?: string }>;
    restartedSqlite.close();
    expect(columns.some((column) => column.name === "ignore_kept_back_packages")).toBe(false);
    expect(columns.some((column) => column.name === "auto_hide_kept_back_updates")).toBe(true);
    expect(columns.some((column) => column.name === "upgrade_order")).toBe(false);
    expect(columns.some((column) => column.name === "uptime_seconds")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_boot_id")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_uptime_seconds")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_at")).toBe(true);
    expect(columns.some((column) => column.name === "dashboard_group_id")).toBe(true);
    expect(columns.some((column) => column.name === "dashboard_order")).toBe(true);

    expect(hiddenColumns.some((column) => column.name === "hide_reason")).toBe(true);

    const restarted = listSystems();
    expect(restarted).toHaveLength(1);
    expect(restarted[0].name).toBe("Legacy Debian");
    expect(restarted[0].pkgManager).toBe("apt");
    expect(restarted[0].autoHideKeptBackUpdates).toBe(1);
    expect(restarted[0].dashboardGroupId).toBeNull();
    expect(restarted[0].dashboardOrder).toBe(0);
    expect(restarted[0].pkgManagerConfigs).toBe(JSON.stringify({
      apt: {
        autoHideKeptBackUpdates: true,
      },
    }));
    expect(restarted[0].excludeFromUpgradeAll).toBe(1);
    expect(restarted[0].needsReboot).toBe(1);
    expect(restarted[0].bootId).toBe("boot-legacy");
    expect(restarted[0].uptimeSeconds).toBeNull();
    expect(restarted[0].rebootDismissedBootId).toBeNull();
    expect(restarted[0].rebootDismissedUptimeSeconds).toBeNull();
    expect(restarted[0].rebootDismissedAt).toBeNull();
    expect(restarted[0].isReachable).toBe(1);

    const migratedHidden = getDb()
      .select()
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.packageName, "legacy-held"))
      .get();
    expect(migratedHidden?.hideReason).toBe("kept_back");

    getDb().insert(hiddenUpdates).values({
      systemId: restarted[0].id,
      pkgManager: "apt",
      packageName: "manual-hide",
      currentVersion: "1.0",
      newVersion: "2.0",
      hideReason: "manual",
    }).run();

    closeDatabase();
    initDatabase(dbPath);

    const hiddenAfterRestart = getDb()
      .select({
        packageName: hiddenUpdates.packageName,
        hideReason: hiddenUpdates.hideReason,
      })
      .from(hiddenUpdates)
      .all()
      .sort((left, right) => left.packageName.localeCompare(right.packageName));
    expect(hiddenAfterRestart).toEqual([
      { packageName: "legacy-held", hideReason: "kept_back" },
      { packageName: "manual-hide", hideReason: "manual" },
    ]);
  });

  test("migrates legacy Upgrade All groups over conflicting dashboard data", () => {
    const db = getDb();
    const dashboardConflict = db.insert(dashboardGroups).values({
      id: 7,
      name: "Dashboard layout",
      sortOrder: 0,
      createdAt: "2020-01-01 00:00:00",
      updatedAt: "2020-01-02 00:00:00",
    }).returning({ id: dashboardGroups.id }).get();
    const system = db.insert(systems).values({
      name: "Migrated host",
      hostname: "migrated.local",
      port: 22,
      authType: "password",
      username: "root",
      dashboardGroupId: dashboardConflict.id,
      dashboardOrder: 99,
    }).returning({ id: systems.id }).get();
    const batch = db.insert(upgradeBatches).values({ status: "queued" }).returning({ id: upgradeBatches.id }).get();
    db.insert(upgradeBatchItems).values({
      batchId: batch.id,
      systemId: system.id,
      groupId: dashboardConflict.id,
      groupSortOrder: 0,
      systemSortOrder: 99,
      pkgManager: "apt",
      status: "running",
    }).run();

    closeDatabase();
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE upgrade_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO upgrade_groups (id, name, sort_order, created_at, updated_at)
      VALUES
        (7, 'Legacy Wave', 4, '2019-03-04 05:06:07', '2019-03-05 06:07:08'),
        (8, 'Legacy Final', 5, '2019-04-04 05:06:07', '2019-04-05 06:07:08');
      ALTER TABLE systems ADD COLUMN upgrade_group_id INTEGER;
      ALTER TABLE systems ADD COLUMN upgrade_order INTEGER;
      UPDATE systems SET upgrade_group_id = 7, upgrade_order = 3 WHERE id = ${system.id};
      INSERT INTO settings (key, value, description)
      VALUES ('upgrade_ungrouped_sort_order', '1', 'legacy Ungrouped position');
    `);
    sqlite.close();

    initDatabase(dbPath);

    const migratedSqlite = new Database(dbPath, { readonly: true });
    const migratedTables = migratedSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('upgrade_groups', 'dashboard_groups') ORDER BY name")
      .all() as Array<{ name: string }>;
    const systemColumns = migratedSqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    migratedSqlite.close();

    expect(migratedTables).toEqual([{ name: "dashboard_groups" }]);
    expect(systemColumns.some((column) => column.name === "upgrade_group_id")).toBe(false);
    expect(systemColumns.some((column) => column.name === "upgrade_order")).toBe(false);

    const migratedGroups = getDb()
      .select()
      .from(dashboardGroups)
      .orderBy(dashboardGroups.sortOrder)
      .all();
    expect(migratedGroups.map((group) => ({
      id: group.id,
      name: group.name,
      sortOrder: group.sortOrder,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    }))).toEqual([
      { id: 7, name: "Legacy Wave", sortOrder: 4, createdAt: "2019-03-04 05:06:07", updatedAt: "2019-03-05 06:07:08" },
      { id: 8, name: "Legacy Final", sortOrder: 5, createdAt: "2019-04-04 05:06:07", updatedAt: "2019-04-05 06:07:08" },
    ]);
    const migratedSystem = getDb().select().from(systems).where(eq(systems.id, system.id)).get();
    expect(migratedSystem?.dashboardGroupId).toBe(7);
    expect(migratedSystem?.dashboardOrder).toBe(3);
    const migratedItem = getDb().select().from(upgradeBatchItems).where(eq(upgradeBatchItems.batchId, batch.id)).get();
    expect(migratedItem?.groupId).toBe(7);
    expect(migratedItem?.status).toBe("running");
    const settingsRows = getDb().all(sql`SELECT key, value FROM settings WHERE key LIKE '%ungrouped_sort_order'`) as Array<{ key: string; value: string }>;
    expect(settingsRows).toEqual([{ key: "dashboard_ungrouped_sort_order", value: "1" }]);

    closeDatabase();
    initDatabase(dbPath);
    expect(getDb().select().from(dashboardGroups).all().map((group) => group.id)).toEqual([7, 8]);
    expect(getDb().insert(dashboardGroups).values({ name: "After migration", sortOrder: 3 }).returning({ id: dashboardGroups.id }).get().id).toBe(9);
  });

  test("keeps custom package manager config keys manager-local during startup migration", () => {
    const db = getDb();
    db.insert(customPackageManagers).values({
      name: "hermes",
      label: "Hermes Agent",
      configEntries: JSON.stringify([
        { key: "agentPath", defaultValue: "/opt/hermes/bin/hermes", description: "Agent path" },
      ]),
    }).run();
    const system = db.insert(systems).values({
      name: "Hermes host",
      hostname: "hermes.local",
      port: 22,
      authType: "password",
      username: "root",
      pkgManagerConfigs: JSON.stringify({
        hermes: {
          agentPath: "/srv/hermes/bin/hermes",
        },
      }),
    }).returning({ id: systems.id }).get();
    const script = db.insert(customScripts).values({
      name: "Detect Hermes Agent",
      type: "package_manager",
      operation: "detect",
      pkgManager: "hermes",
      steps: JSON.stringify([
        { label: "Detect", command: "test -x {{config.agentPath}}" },
      ]),
    }).returning({ id: customScripts.id }).get();

    closeDatabase();
    initDatabase(dbPath);

    const restartedDb = getDb();
    const manager = restartedDb
      .select()
      .from(customPackageManagers)
      .where(eq(customPackageManagers.name, "hermes"))
      .get();
    const restartedSystem = restartedDb
      .select()
      .from(systems)
      .where(eq(systems.id, system.id))
      .get();
    const restartedScript = restartedDb
      .select()
      .from(customScripts)
      .where(eq(customScripts.id, script.id))
      .get();

    expect(JSON.parse(manager?.configEntries ?? "[]")).toEqual([
      { key: "agentPath", defaultValue: "/opt/hermes/bin/hermes", description: "Agent path" },
    ]);
    expect(JSON.parse(restartedSystem?.pkgManagerConfigs ?? "{}")).toEqual({
      hermes: {
        agentPath: "/srv/hermes/bin/hermes",
      },
    });
    expect(JSON.parse(restartedScript?.steps ?? "[]")).toEqual([
      { label: "Detect", command: "test -x {{config.agentPath}}" },
    ]);
  });

  test("creates the hidden_updates table on startup", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hidden_updates'")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("hidden_updates");
  });

  test("creates the installed package cache table on startup", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(installed_package_cache)")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(columns.some((column) => column.name === "pkg_manager")).toBe(true);
    expect(columns.some((column) => column.name === "package_name")).toBe(true);
    expect(columns.some((column) => column.name === "current_version")).toBe(true);
    expect(columns.some((column) => column.name === "architecture")).toBe(true);
    expect(columns.some((column) => column.name === "repository")).toBe(true);
    expect(columns.some((column) => column.name === "cached_at")).toBe(true);
  });

  test("adds the pkg_manager_configs column for systems", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(columns.some((column) => column.name === "pkg_manager_configs")).toBe(true);
  });

  test("adds reboot dismissal tracking columns for systems", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(columns.some((column) => column.name === "uptime_seconds")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_boot_id")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_uptime_seconds")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_at")).toBe(true);
  });

  test("adds the root user banner dismissal columns for systems", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(columns.some((column) => column.name === "root_user_banner_dismissed")).toBe(true);
    expect(columns.some((column) => column.name === "root_user_banner_dismissed_host_key_fingerprint_sha256")).toBe(true);
  });

  test("creates package manager issue tracking table", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(package_manager_issues)")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(columns.some((column) => column.name === "issue_key")).toBe(true);
    expect(columns.some((column) => column.name === "dismissed_boot_id")).toBe(true);
    expect(columns.some((column) => column.name === "resolved_at")).toBe(true);
  });

  test("creates only dashboard grouping columns for systems", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    const legacyTables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'upgrade_groups'")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(columns.some((column) => column.name === "dashboard_group_id")).toBe(true);
    expect(columns.some((column) => column.name === "dashboard_order")).toBe(true);
    expect(columns.some((column) => column.name === "upgrade_group_id")).toBe(false);
    expect(columns.some((column) => column.name === "upgrade_order")).toBe(false);
    expect(legacyTables).toHaveLength(0);
  });
});
