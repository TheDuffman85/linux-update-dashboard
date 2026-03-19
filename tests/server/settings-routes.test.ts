import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings, systems, updateHistory } from "../../server/db/schema";
import settingsRoutes from "../../server/routes/settings";
import { getEncryptor, initEncryptor } from "../../server/security";
import { getSSHManager, initSSHManager } from "../../server/ssh/connection";

describe("settings routes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-settings-routes-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "settings.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("normalizes bounded numeric settings before storing them", async () => {
    const app = new Hono();
    app.use("/api/settings/*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin", isAdmin: true });
      await next();
    });
    app.route("/api/settings", settingsRoutes);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        check_interval_minutes: "1",
        cache_duration_hours: "999",
        activity_history_limit: "999",
        ssh_timeout_seconds: "2",
        cmd_timeout_seconds: "601",
        concurrent_connections: "0",
      }),
    });

    expect(res.status).toBe(200);

    const db = getDb();
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "check_interval_minutes")).get()?.value,
    ).toBe("5");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "cache_duration_hours")).get()?.value,
    ).toBe("168");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "activity_history_limit")).get()?.value,
    ).toBe("200");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "ssh_timeout_seconds")).get()?.value,
    ).toBe("5");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "cmd_timeout_seconds")).get()?.value,
    ).toBe("600");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "concurrent_connections")).get()?.value,
    ).toBe("1");
  });

  test("falls back to defaults for invalid numeric input", async () => {
    const app = new Hono();
    app.use("/api/settings/*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin", isAdmin: true });
      await next();
    });
    app.route("/api/settings", settingsRoutes);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        check_interval_minutes: "",
        cache_duration_hours: "abc",
        activity_history_limit: "bogus",
      }),
    });

    expect(res.status).toBe(200);

    const db = getDb();
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "check_interval_minutes")).get()?.value,
    ).toBe("15");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "cache_duration_hours")).get()?.value,
    ).toBe("12");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "activity_history_limit")).get()?.value,
    ).toBe("20");
  });

  test("enforces the minimum activity history limit before storing", async () => {
    const app = new Hono();
    app.use("/api/settings/*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin", isAdmin: true });
      await next();
    });
    app.route("/api/settings", settingsRoutes);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activity_history_limit: "1",
      }),
    });

    expect(res.status).toBe(200);

    const db = getDb();
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "activity_history_limit")).get()?.value,
    ).toBe("5");
  });

  test("prunes stored activity history immediately when the limit is lowered", async () => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "History Trim System",
      hostname: "history-trim.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;

    db.insert(updateHistory).values([
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 10:00:00",
        completedAt: "2026-03-19 10:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 11:00:00",
        completedAt: "2026-03-19 11:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 12:00:00",
        completedAt: "2026-03-19 12:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 13:00:00",
        completedAt: "2026-03-19 13:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 14:00:00",
        completedAt: "2026-03-19 14:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 15:00:00",
        completedAt: "2026-03-19 15:00:05",
      },
    ]).run();

    const app = new Hono();
    app.use("/api/settings/*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin", isAdmin: true });
      await next();
    });
    app.route("/api/settings", settingsRoutes);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        activity_history_limit: "5",
      }),
    });

    expect(res.status).toBe(200);

    const remaining = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all();

    expect(remaining).toHaveLength(5);
    expect(remaining.some((entry) => entry.startedAt === "2026-03-19 10:00:00")).toBe(false);
  });

  test("applies SSH runtime setting changes immediately", async () => {
    initSSHManager(5, 30, 120, getEncryptor());

    const app = new Hono();
    app.use("/api/settings/*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin", isAdmin: true });
      await next();
    });
    app.route("/api/settings", settingsRoutes);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ssh_timeout_seconds: "25",
        cmd_timeout_seconds: "30",
        concurrent_connections: "7",
      }),
    });

    expect(res.status).toBe(200);
    expect(getSSHManager().getRuntimeConfig()).toEqual({
      maxConcurrent: 7,
      defaultTimeout: 25,
      defaultCmdTimeout: 30,
    });
  });
});
