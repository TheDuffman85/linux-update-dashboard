import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
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

  test("marks orphaned SSH-safe upgrade rows as warning after restart", () => {
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
      action: "upgrade_all",
      pkgManager: "apt",
      status: "started",
      command: "sudo apt-get upgrade -y",
    }).returning({ id: updateHistory.id }).get();

    closeDatabase();
    initDatabase(dbPath);

    const restartedDb = getDb();
    const row = restartedDb
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.id, history.id))
      .get();

    expect(row?.status).toBe("warning");
    expect(row?.output).toBe("Server restarted while operation was in progress");
    expect(row?.error).toBeNull();
    expect(row?.completedAt).not.toBeNull();
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
    sqlite.close();

    initDatabase(dbPath);

    const restartedSqlite = new Database(dbPath, { readonly: true });
    const columns = restartedSqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    restartedSqlite.close();
    expect(columns.some((column) => column.name === "ignore_kept_back_packages")).toBe(false);
    expect(columns.some((column) => column.name === "auto_hide_kept_back_updates")).toBe(true);
    expect(columns.some((column) => column.name === "upgrade_order")).toBe(true);
    expect(columns.some((column) => column.name === "uptime_seconds")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_boot_id")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_uptime_seconds")).toBe(true);
    expect(columns.some((column) => column.name === "reboot_dismissed_at")).toBe(true);

    const restarted = listSystems();
    expect(restarted).toHaveLength(1);
    expect(restarted[0].name).toBe("Legacy Debian");
    expect(restarted[0].pkgManager).toBe("apt");
    expect(restarted[0].autoHideKeptBackUpdates).toBe(1);
    expect(restarted[0].upgradeOrder).toBe(1);
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

  test("adds the upgrade order column for systems", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const columns = sqlite
      .prepare("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(columns.some((column) => column.name === "upgrade_order")).toBe(true);
  });
});
