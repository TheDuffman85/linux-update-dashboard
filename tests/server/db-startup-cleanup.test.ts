import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
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
        exclude_from_upgrade_all, hidden, needs_reboot, is_reachable
      ) VALUES (
        0, 'Legacy Debian', 'legacy.local', 22, 'password', 'root',
        'apt', '["apt"]', 1,
        1, 0, 1, 1
      );
    `);
    sqlite.close();

    initDatabase(dbPath);

    const restartedSqlite = new Database(dbPath, { readonly: true });
    const columns = restartedSqlite
      .query("PRAGMA table_info(systems)")
      .all() as Array<{ name?: string }>;
    restartedSqlite.close();
    expect(columns.some((column) => column.name === "ignore_kept_back_packages")).toBe(false);
    expect(columns.some((column) => column.name === "auto_hide_kept_back_updates")).toBe(true);

    const restarted = listSystems();
    expect(restarted).toHaveLength(1);
    expect(restarted[0].name).toBe("Legacy Debian");
    expect(restarted[0].pkgManager).toBe("apt");
    expect(restarted[0].autoHideKeptBackUpdates).toBe(1);
    expect(restarted[0].excludeFromUpgradeAll).toBe(1);
    expect(restarted[0].needsReboot).toBe(1);
    expect(restarted[0].isReachable).toBe(1);
  });

  test("creates the hidden_updates table on startup", () => {
    const sqlite = new Database(dbPath, { readonly: true });
    const tables = sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hidden_updates'")
      .all() as Array<{ name?: string }>;
    sqlite.close();

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe("hidden_updates");
  });
});
