import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";

describe("ProxyJump host-key migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-proxyjump-migration-"));
    dbPath = join(tempDir, "dashboard.db");
    initEncryptor(randomBytes(32).toString("base64"));

    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE systems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        credential_id INTEGER,
        auth_type TEXT NOT NULL DEFAULT 'password',
        username TEXT NOT NULL,
        encrypted_password TEXT,
        encrypted_private_key TEXT,
        encrypted_key_passphrase TEXT,
        encrypted_sudo_password TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(hostname, port, username)
      );
      CREATE TABLE credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_on TEXT NOT NULL DEFAULT '["updates","appUpdates"]',
        config TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE webauthn_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0,
        transports TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE update_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        pkg_manager TEXT NOT NULL,
        package_name TEXT NOT NULL,
        new_version TEXT NOT NULL
      );
      CREATE TABLE update_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        pkg_manager TEXT NOT NULL,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now'))
        ,
        completed_at TEXT
      );
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        read_only INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    sqlite.query(
      "INSERT INTO systems (name, hostname, port, auth_type, username) VALUES (?, ?, ?, ?, ?)"
    ).run("Legacy", "legacy.local", 22, "password", "root");
    sqlite.close();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("backfills migrated systems with host-key verification disabled", () => {
    initDatabase(dbPath);

    const db = getDb();
    const migrated = db.select().from(systems).get();
    expect(migrated?.hostKeyVerificationEnabled).toBe(0);
    expect(migrated?.proxyJumpSystemId).toBeNull();
    expect(migrated?.trustedHostKey).toBeNull();

    const columns = db.all(sql`PRAGMA table_info(systems)`) as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "proxy_jump_system_id")).toBe(true);
    expect(columns.some((column) => column.name === "host_key_verification_enabled")).toBe(true);
    expect(columns.some((column) => column.name === "trusted_host_key")).toBe(true);
  });
});
