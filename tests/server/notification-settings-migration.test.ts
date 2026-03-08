import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications } from "../../server/db/schema";

describe("legacy notification settings migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-notification-settings-migration-"));
    dbPath = join(tempDir, "dashboard.db");

    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("notifications_enabled", "true");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("notification_methods", '["email"]');
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("notify_on_updates", "true");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("notify_on_unreachable", "false");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("smtp_host", "smtp.example.com");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("smtp_port", "587");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("smtp_secure", "true");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("smtp_user", "mailer");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("smtp_password", "smtp-secret");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("smtp_from", "dashboard@example.com");
    sqlite.query("INSERT INTO settings (key, value) VALUES (?, ?)").run("notification_email_to", "admin@example.com");
    sqlite.close();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("migrates app updates as enabled by default", () => {
    initDatabase(dbPath);

    const migrated = getDb().select().from(notifications).get();
    expect(migrated).toBeTruthy();
    expect(migrated?.notifyOn).toBe('["updates","appUpdates"]');
  });
});
