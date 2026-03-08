import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, notifications, systems } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";

describe("legacy credential migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-credential-migration-"));
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
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_on TEXT NOT NULL DEFAULT '["updates"]',
        system_ids TEXT,
        config TEXT NOT NULL,
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
        command TEXT,
        status TEXT NOT NULL,
        output TEXT,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
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

    const encryptor = getEncryptor();
    sqlite.query(
      "INSERT INTO systems (name, hostname, port, auth_type, username, encrypted_password) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "Primary",
      "alpha.local",
      22,
      "password",
      "root",
      encryptor.encrypt("ssh-secret")
    );
    sqlite.query(
      "INSERT INTO notifications (name, type, enabled, notify_on, system_ids, config) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "Ops Email",
      "email",
      1,
      '["updates"]',
      null,
      JSON.stringify({
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpSecure: "true",
        smtpUser: "mailer",
        smtpPassword: encryptor.encrypt("smtp-secret"),
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
      })
    );
    sqlite.close();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("migrates legacy system and notification secrets into credential records", () => {
    initDatabase(dbPath);

    const db = getDb();
    const migratedCredentials = db.select().from(credentials).all();
    expect(migratedCredentials).toHaveLength(2);

    const migratedSystem = db.select().from(systems).get();
    expect(migratedSystem?.credentialId).toBeTruthy();
    expect(migratedSystem?.encryptedPassword).toBeNull();

    const migratedNotification = db.select().from(notifications).get();
    expect(migratedNotification?.credentialId).toBeTruthy();
    expect(migratedNotification?.config).not.toContain("smtpPassword");
    expect(migratedNotification?.config).not.toContain("smtpUser");
    const smtpCredential = migratedCredentials.find((credential) => credential.kind === "emailSmtp");
    expect(smtpCredential).toBeTruthy();
  });
});
