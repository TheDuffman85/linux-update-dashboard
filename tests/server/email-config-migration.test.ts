import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications } from "../../server/db/schema";

describe("email notification config migration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-email-config-migration-"));
    dbPath = join(tempDir, "dashboard.db");

    const sqlite = new Database(dbPath);
    sqlite.exec(`
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_on TEXT NOT NULL DEFAULT '["updates","appUpdates"]',
        system_ids TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        schedule TEXT,
        pending_events TEXT,
        last_sent_at TEXT,
        last_app_version_notified TEXT,
        last_delivery_status TEXT,
        last_delivery_at TEXT,
        last_delivery_code INTEGER,
        last_delivery_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    sqlite.query(
      "INSERT INTO notifications (name, type, enabled, notify_on, config) VALUES (?, ?, ?, ?, ?)"
    ).run(
      "Ops Email",
      "email",
      1,
      '["updates"]',
      JSON.stringify({
        smtpHost: "smtp.example.com",
        smtpPort: "25",
        smtpSecure: "false",
        smtpUser: "mailer",
        smtpPassword: "secret",
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

  test("rewrites legacy smtpSecure configs during database init", () => {
    initDatabase(dbPath);

    const migrated = getDb()
      .select()
      .from(notifications)
      .get();

    expect(migrated?.config).toContain('"smtpTlsMode":"plain"');
    expect(migrated?.config).toContain('"allowInsecureTls":"false"');
    expect(migrated?.config).not.toContain('"smtpSecure"');
  });
});
