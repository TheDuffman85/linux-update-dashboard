import { afterEach, beforeEach, describe, expect, test } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { schedules, settings } from "../../server/db/schema";
import schedulesRoutes from "../../server/routes/schedules";
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
});
