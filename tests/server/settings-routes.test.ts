import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings } from "../../server/db/schema";
import settingsRoutes from "../../server/routes/settings";
import { initEncryptor } from "../../server/security";

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
  });
});
