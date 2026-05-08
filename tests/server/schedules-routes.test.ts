import { afterEach, beforeEach, describe, expect, test } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, notifications, schedules, settings, users } from "../../server/db/schema";
import schedulesRoutes from "../../server/routes/schedules";
import { authMiddleware } from "../../server/middleware/auth";
import { hashToken } from "../../server/auth/api-token";
import * as scheduler from "../../server/services/scheduler";
import { initEncryptor } from "../../server/security";

describe("schedules routes and migration", () => {
  let tempDir: string;
  let dbPath: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-schedules-routes-"));
    dbPath = join(tempDir, "dashboard.db");
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(dbPath);

    app = new Hono();
    app.route("/api/schedules", schedulesRoutes);
  });

  afterEach(() => {
    scheduler.stop();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates a default refresh schedule from existing settings once", () => {
    const row = getDb().select().from(schedules).get();

    expect(row?.name).toBe("Default refresh");
    expect(row?.type).toBe("refresh");
    expect(row?.enabled).toBe(1);
    expect(JSON.parse(row?.config || "{}")).toEqual({
      cron: "*/15 * * * *",
      cacheDurationHours: 12,
    });
    expect(
      getDb()
        .select()
        .from(settings)
        .where(eq(settings.key, "schedules_refresh_migrated"))
        .get()?.value,
    ).toBe("true");
  });

  test("uses legacy refresh settings when migrating the default schedule", () => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), "ludash-schedules-routes-legacy-"));
    dbPath = join(tempDir, "dashboard.db");

    const sqlite = new BetterSqlite3(dbPath);
    sqlite.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO settings (key, value, description) VALUES
        ('check_interval_minutes', '30', ''),
        ('cache_duration_hours', '6', '');
    `);
    sqlite.close();

    initDatabase(dbPath);

    const row = getDb().select().from(schedules).get();
    expect(JSON.parse(row?.config || "{}")).toEqual({
      cron: "*/30 * * * *",
      cacheDurationHours: 6,
    });
  });

  test("does not recreate the migrated default schedule after all schedules are deleted", () => {
    getDb().delete(schedules).run();
    closeDatabase();
    initDatabase(dbPath);

    expect(getDb().select().from(schedules).all()).toHaveLength(0);
  });

  test("migrates legacy notification cron values into notification schedules", () => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), "ludash-schedules-routes-notification-legacy-"));
    dbPath = join(tempDir, "dashboard.db");

    const sqlite = new BetterSqlite3(dbPath);
    sqlite.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO settings (key, value, description) VALUES
        ('schedules_refresh_migrated', 'true', '');

      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_on TEXT NOT NULL DEFAULT '["updates","appUpdates"]',
        system_ids TEXT,
        config TEXT NOT NULL,
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
      INSERT INTO notifications (name, type, enabled, notify_on, system_ids, config, schedule)
        VALUES ('Ops email', 'email', 1, '["updates"]', NULL, '{}', '0 9 * * 1');
    `);
    sqlite.close();

    initDatabase(dbPath);

    const notificationSchedule = getDb()
      .select()
      .from(schedules)
      .where(eq(schedules.type, "notification_digest"))
      .get();
    const notification = getDb().select().from(notifications).get();

    expect(notificationSchedule?.name).toBe("Notification - At 09:00, only on Monday");
    expect(JSON.parse(notificationSchedule?.config || "{}")).toEqual({
      cron: "0 9 * * 1",
      notificationIds: [notification?.id],
    });
    expect(notification?.schedule).toBeNull();
  });

  test("migrates legacy notification cron values even when the migration marker already exists", () => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), "ludash-schedules-routes-notification-marker-"));
    dbPath = join(tempDir, "dashboard.db");

    const sqlite = new BetterSqlite3(dbPath);
    sqlite.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO settings (key, value, description) VALUES
        ('schedules_refresh_migrated', 'true', ''),
        ('notification_digest_schedules_migrated', 'true', '');

      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_on TEXT NOT NULL DEFAULT '["updates","appUpdates"]',
        system_ids TEXT,
        config TEXT NOT NULL,
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
      INSERT INTO notifications (name, type, enabled, notify_on, system_ids, config, schedule)
        VALUES ('Ops email', 'email', 1, '["updates"]', NULL, '{}', '0 10 * * 1');
    `);
    sqlite.close();

    initDatabase(dbPath);

    const notificationSchedule = getDb()
      .select()
      .from(schedules)
      .where(eq(schedules.type, "notification_digest"))
      .get();
    const notification = getDb().select().from(notifications).get();

    expect(JSON.parse(notificationSchedule?.config || "{}")).toEqual({
      cron: "0 10 * * 1",
      notificationIds: [notification?.id],
    });
    expect(notification?.schedule).toBeNull();
  });

  test("adds legacy notification cron targets to an existing matching unified schedule", () => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), "ludash-schedules-routes-notification-merge-"));
    dbPath = join(tempDir, "dashboard.db");

    const sqlite = new BetterSqlite3(dbPath);
    sqlite.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO settings (key, value, description) VALUES
        ('schedules_refresh_migrated', 'true', ''),
        ('notification_digest_schedules_migrated', 'true', '');

      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        notify_on TEXT NOT NULL DEFAULT '["updates","appUpdates"]',
        system_ids TEXT,
        config TEXT NOT NULL,
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
      INSERT INTO notifications (name, type, enabled, notify_on, system_ids, config, schedule)
        VALUES ('Ops email', 'email', 1, '["updates"]', NULL, '{}', '0 9 * * 1');

      CREATE TABLE schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        system_ids TEXT,
        config TEXT NOT NULL,
        last_started_at TEXT,
        last_run_at TEXT,
        last_run_status TEXT,
        last_run_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO schedules (name, type, enabled, system_ids, config)
        VALUES ('Morning notifications', 'notification_digest', 1, NULL, '{"cron":"0 9 * * 1","notificationIds":[]}');
    `);
    sqlite.close();

    initDatabase(dbPath);

    const notification = getDb().select().from(notifications).get();
    const notificationSchedules = getDb()
      .select()
      .from(schedules)
      .where(eq(schedules.type, "notification_digest"))
      .all();

    expect(notificationSchedules).toHaveLength(1);
    expect(notificationSchedules[0]?.name).toBe("Morning notifications");
    expect(JSON.parse(notificationSchedules[0]?.config || "{}")).toEqual({
      cron: "0 9 * * 1",
      notificationIds: [notification?.id],
    });
    expect(notification?.schedule).toBeNull();
  });

  test("creates update schedules with selected system scope", async () => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Weekly updates",
        type: "update",
        enabled: true,
        systemIds: [1, 2],
        config: { cron: "0 3 * * 0" },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const row = getDb().select().from(schedules).where(eq(schedules.id, body.id)).get();
    expect(row?.type).toBe("update");
    expect(row?.systemIds).toBe("[1,2]");
    expect(JSON.parse(row?.config || "{}")).toEqual({ cron: "0 3 * * 0" });
  });

  test("creates refresh schedules with cron and cache settings", async () => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Frequent refresh",
        type: "refresh",
        enabled: true,
        systemIds: null,
        config: { cron: "*/30 * * * *", cacheDurationHours: 2 },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const row = getDb().select().from(schedules).where(eq(schedules.id, body.id)).get();
    expect(JSON.parse(row?.config || "{}")).toEqual({
      cron: "*/30 * * * *",
      cacheDurationHours: 2,
    });
  });

  test("creates notification schedules with notification targets", async () => {
    const notification = getDb().insert(notifications).values({
      name: "Ops webhook",
      type: "webhook",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: null,
      config: "{}",
    }).returning({ id: notifications.id }).get();

    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Morning schedule",
        type: "notification_digest",
        enabled: true,
        systemIds: [1],
        config: { cron: "0 9 * * 1", notificationIds: [notification.id] },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const row = getDb().select().from(schedules).where(eq(schedules.id, body.id)).get();
    expect(row?.type).toBe("notification_digest");
    expect(row?.systemIds).toBeNull();
    expect(JSON.parse(row?.config || "{}")).toEqual({
      cron: "0 9 * * 1",
      notificationIds: [notification.id],
    });
  });

  test("allows assigning one notification channel to multiple schedules", async () => {
    const notification = getDb().insert(notifications).values({
      name: "Ops webhook",
      type: "webhook",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: null,
      config: "{}",
    }).returning({ id: notifications.id }).get();

    const first = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Morning schedule",
        type: "notification_digest",
        enabled: true,
        systemIds: null,
        config: { cron: "0 9 * * 1", notificationIds: [notification.id] },
      }),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Evening schedule",
        type: "notification_digest",
        enabled: true,
        systemIds: null,
        config: { cron: "0 18 * * 1", notificationIds: [notification.id] },
      }),
    });

    expect(second.status).toBe(201);

    const scheduleConfigs = getDb()
      .select()
      .from(schedules)
      .where(eq(schedules.type, "notification_digest"))
      .all()
      .map((schedule) => JSON.parse(schedule.config));
    expect(scheduleConfigs.map((config) => config.notificationIds)).toEqual([
      [notification.id],
      [notification.id],
    ]);
  });

  test("rejects invalid refresh cron expressions", async () => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad refresh cron",
        type: "refresh",
        enabled: true,
        systemIds: null,
        config: { cron: "nope", cacheDurationHours: 2 },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cron must be a valid cron expression" });
  });

  test("rejects invalid update cron expressions", async () => {
    const res = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad cron",
        type: "update",
        enabled: true,
        systemIds: null,
        config: { cron: "not a cron" },
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cron must be a valid cron expression" });
  });

  test("rejects schedules below the default minimum interval", async () => {
    const previous = process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES;
    delete process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES;
    try {
      const res = await app.request("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Too frequent",
          type: "refresh",
          enabled: true,
          systemIds: null,
          config: { cron: "* * * * *", cacheDurationHours: 2 },
        }),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "cron must not run more often than every 5 minutes",
      });
    } finally {
      if (previous === undefined) delete process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES;
      else process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES = previous;
    }
  });

  test("uses LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES for minimum interval validation", async () => {
    const previous = process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES;
    process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES = "1";
    try {
      const res = await app.request("/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Every minute",
          type: "refresh",
          enabled: true,
          systemIds: null,
          config: { cron: "* * * * *", cacheDurationHours: 2 },
        }),
      });

      expect(res.status).toBe(201);
    } finally {
      if (previous === undefined) delete process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES;
      else process.env.LUDASH_MIN_SCHEDULE_INTERVAL_MINUTES = previous;
    }
  });

  test("reorders schedules when given every schedule ID exactly once", async () => {
    const first = getDb().select().from(schedules).get();
    const createRes = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Daily updates",
        type: "update",
        enabled: true,
        systemIds: null,
        config: { cron: "0 3 * * *" },
      }),
    });
    const second = await createRes.json() as { id: number };

    const reorderRes = await app.request("/api/schedules/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduleIds: [second.id, first?.id] }),
    });

    expect(reorderRes.status).toBe(200);
    const listRes = await app.request("/api/schedules");
    const body = await listRes.json() as { schedules: Array<{ id: number }> };
    expect(body.schedules.map((schedule) => schedule.id)).toEqual([second.id, first?.id]);
  });

  test("rejects reorder payloads that omit schedules", async () => {
    const row = getDb().select().from(schedules).get();
    const res = await app.request("/api/schedules/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduleIds: row ? [row.id, 9999] : [9999] }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("include every schedule exactly once");
  });

  test("blocks bearer tokens from managing schedules", async () => {
    const token = "ludash_schedule_management_test";
    const user = getDb().insert(users).values({
      username: "api-user",
      passwordHash: "unused",
      isAdmin: 1,
    }).returning({ id: users.id }).get();
    getDb().insert(apiTokens).values({
      userId: user.id,
      name: "writer",
      tokenHash: await hashToken(token),
      readOnly: 0,
    }).run();

    const protectedApp = new Hono();
    protectedApp.use("/api/*", authMiddleware);
    protectedApp.route("/api/schedules", schedulesRoutes);

    const res = await protectedApp.request(
      "/api/schedules",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Blocked schedule",
          type: "update",
          enabled: true,
          systemIds: null,
          config: { cron: "0 3 * * *" },
        }),
      },
      {
        incoming: {
          socket: {
            remoteAddress: "127.0.0.1",
            remotePort: 12345,
            remoteFamily: "IPv4",
          },
        },
      },
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "API tokens cannot access management endpoints",
    });
  });
});
