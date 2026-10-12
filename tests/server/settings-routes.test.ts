import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono as BaseHono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings, systems, updateHistory } from "../../server/db/schema";
import { authMiddleware } from "../../server/middleware/auth";
import settingsRoutes from "../../server/routes/settings";
import { getEncryptor, initEncryptor } from "../../server/security";
import { getSSHManager, initSSHManager } from "../../server/ssh/connection";
import { getAppLogoJpeg } from "../../server/services/branding-service";

const Hono = BaseHono<{ Variables: { user: { userId: number; username: string; isAdmin: boolean } } }>;

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

  test("returns only public settings without requiring an authenticated user", async () => {
    const db = getDb();
    db.update(settings).set({ value: "de" }).where(eq(settings.key, "language")).run();
    db.update(settings).set({ value: "super-secret" }).where(eq(settings.key, "oidc_client_secret")).run();

    const app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/settings", settingsRoutes);

    const res = await app.request("/api/settings/public");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      settings: { language: "de" },
      branding: { appName: "Linux Update Dashboard", logoUrl: null },
    });
    expect(JSON.stringify(body)).not.toContain("super-secret");
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

  test("persists newly introduced settings that do not already have a row", async () => {
    const db = getDb();
    db.delete(settings).where(eq(settings.key, "language")).run();
    db.delete(settings).where(eq(settings.key, "time_format")).run();

    const app = new Hono();
    app.use("/api/settings/*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin", isAdmin: true });
      await next();
    });
    app.route("/api/settings", settingsRoutes);

    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: "de", time_format: "24h" }),
    });

    expect(res.status).toBe(200);
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "language")).get()?.value,
    ).toBe("de");
    expect(
      db.select({ value: settings.value }).from(settings).where(eq(settings.key, "time_format")).get()?.value,
    ).toBe("24h");
  });

  test("returns configured timeout bounds with settings", async () => {
    const previousSshMax = process.env.LUDASH_MAX_SSH_TIMEOUT;
    const previousCmdMax = process.env.LUDASH_MAX_CMD_TIMEOUT;
    process.env.LUDASH_MAX_SSH_TIMEOUT = "240";
    process.env.LUDASH_MAX_CMD_TIMEOUT = "900";

    try {
      const app = new Hono();
      app.use("/api/settings/*", async (c, next) => {
        c.set("user", { userId: 1, username: "admin", isAdmin: true });
        await next();
      });
      app.route("/api/settings", settingsRoutes);
      const db = getDb();
      db.update(settings).set({ value: "300" }).where(eq(settings.key, "ssh_timeout_seconds")).run();
      db.update(settings).set({ value: "1200" }).where(eq(settings.key, "cmd_timeout_seconds")).run();

      const res = await app.request("/api/settings");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.settings.ssh_timeout_seconds).toBe("240");
      expect(body.settings.cmd_timeout_seconds).toBe("900");
      expect(body.numericSettingRules.ssh_timeout_seconds).toMatchObject({
        min: 5,
        max: 240,
        fallback: 30,
      });
      expect(body.numericSettingRules.cmd_timeout_seconds).toMatchObject({
        min: 10,
        max: 900,
        fallback: 120,
      });
    } finally {
      if (previousSshMax === undefined) delete process.env.LUDASH_MAX_SSH_TIMEOUT;
      else process.env.LUDASH_MAX_SSH_TIMEOUT = previousSshMax;
      if (previousCmdMax === undefined) delete process.env.LUDASH_MAX_CMD_TIMEOUT;
      else process.env.LUDASH_MAX_CMD_TIMEOUT = previousCmdMax;
    }
  });

  test("returns the server timezone with settings", async () => {
    const previousTimeZone = process.env.TZ;
    process.env.TZ = "Europe/Berlin";

    try {
      const app = new Hono();
      app.use("/api/settings/*", async (c, next) => {
        c.set("user", { userId: 1, username: "admin", isAdmin: true });
        await next();
      });
      app.route("/api/settings", settingsRoutes);

      const res = await app.request("/api/settings");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.timeZone).toBe("Europe/Berlin");
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimeZone;
    }
  });

  test("uses configured timeout maximums when storing settings", async () => {
    const previousSshMax = process.env.LUDASH_MAX_SSH_TIMEOUT;
    const previousCmdMax = process.env.LUDASH_MAX_CMD_TIMEOUT;
    process.env.LUDASH_MAX_SSH_TIMEOUT = "45";
    process.env.LUDASH_MAX_CMD_TIMEOUT = "90";

    try {
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
          ssh_timeout_seconds: "999",
          cmd_timeout_seconds: "999",
        }),
      });

      expect(res.status).toBe(200);

      const db = getDb();
      expect(
        db.select({ value: settings.value }).from(settings).where(eq(settings.key, "ssh_timeout_seconds")).get()?.value,
      ).toBe("45");
      expect(
        db.select({ value: settings.value }).from(settings).where(eq(settings.key, "cmd_timeout_seconds")).get()?.value,
      ).toBe("90");
    } finally {
      if (previousSshMax === undefined) delete process.env.LUDASH_MAX_SSH_TIMEOUT;
      else process.env.LUDASH_MAX_SSH_TIMEOUT = previousSshMax;
      if (previousCmdMax === undefined) delete process.env.LUDASH_MAX_CMD_TIMEOUT;
      else process.env.LUDASH_MAX_CMD_TIMEOUT = previousCmdMax;
    }
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

  describe("branding", () => {
    const PNG_BYTES = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const pngDataUrl = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

    function createAdminApp() {
      const app = new Hono();
      app.use("/api/settings/*", async (c, next) => {
        c.set("user", { userId: 1, username: "admin", isAdmin: true });
        await next();
      });
      app.route("/api/settings", settingsRoutes);
      return app;
    }

    function uploadLogo(app: ReturnType<typeof createAdminApp>, dataUrl: unknown) {
      return app.request("/api/settings/branding/logo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
    }

    test("normalizes the application name and exposes it publicly", async () => {
      const app = createAdminApp();

      const res = await app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_name: "  Acme\n  Patch   Center " }),
      });
      expect(res.status).toBe(200);

      const publicRes = await app.request("/api/settings/public");
      const body = await publicRes.json();
      expect(body.branding).toEqual({ appName: "Acme Patch Center", logoUrl: null });
    });

    test("falls back to the default name when the application name is cleared", async () => {
      const app = createAdminApp();
      await app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_name: "Acme" }),
      });
      await app.request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_name: "   " }),
      });

      const body = await (await app.request("/api/settings/public")).json();
      expect(body.branding.appName).toBe("Linux Update Dashboard");
    });

    test("rejects overly long application names", async () => {
      const res = await createAdminApp().request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_name: "x".repeat(61) }),
      });

      expect(res.status).toBe(400);
    });

    test("does not allow the logo to be written through the generic settings endpoint", async () => {
      const res = await createAdminApp().request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ app_logo: pngDataUrl }),
      });

      expect(res.status).toBe(400);
      expect(
        getDb().select().from(settings).where(eq(settings.key, "app_logo")).get(),
      ).toBeUndefined();
    });

    test("stores an uploaded logo and serves it publicly with a versioned URL", async () => {
      const app = createAdminApp();

      const uploadRes = await uploadLogo(app, pngDataUrl);
      expect(uploadRes.status).toBe(200);
      const uploadBody = await uploadRes.json();
      expect(uploadBody.branding.logoUrl).toMatch(
        /^\/api\/settings\/public\/logo\?v=[0-9a-f]{16}$/,
      );

      const publicApp = new Hono();
      publicApp.use("/api/*", authMiddleware);
      publicApp.route("/api/settings", settingsRoutes);

      const publicBody = await (await publicApp.request("/api/settings/public")).json();
      expect(publicBody.branding.logoUrl).toBe(uploadBody.branding.logoUrl);

      const logoRes = await publicApp.request(uploadBody.branding.logoUrl);
      expect(logoRes.status).toBe(200);
      expect(logoRes.headers.get("content-type")).toBe("image/png");
      expect(logoRes.headers.get("cache-control")).toContain("immutable");
      expect(Buffer.from(await logoRes.arrayBuffer())).toEqual(PNG_BYTES);

      const unversioned = await publicApp.request("/api/settings/public/logo");
      expect(unversioned.headers.get("cache-control")).toBe("no-cache");
    });

    test("detects the logo type from its content instead of the declared type", async () => {
      const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      const app = createAdminApp();

      const res = await uploadLogo(app, `data:image/png;base64,${svg.toString("base64")}`);
      expect(res.status).toBe(200);

      const logoRes = await app.request("/api/settings/public/logo");
      expect(logoRes.headers.get("content-type")).toBe("image/svg+xml");
      expect(logoRes.headers.get("content-security-policy")).toContain("sandbox");
    });

    test("rejects logos that are not supported images", async () => {
      const app = createAdminApp();
      const html = Buffer.from("<html><script>alert(1)</script></html>").toString("base64");

      expect((await uploadLogo(app, `data:image/png;base64,${html}`)).status).toBe(400);
      expect((await uploadLogo(app, "not a data url")).status).toBe(400);
      expect((await uploadLogo(app, 42)).status).toBe(400);
    });

    test("rejects logos larger than the size limit", async () => {
      const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(512 * 1024)]);

      const res = await uploadLogo(
        createAdminApp(),
        `data:image/png;base64,${oversized.toString("base64")}`,
      );

      expect(res.status).toBe(400);
    });

    test("stores a validated JPEG rendition alongside the logo", async () => {
      const app = createAdminApp();
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

      const invalid = await app.request("/api/settings/branding/logo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataUrl: pngDataUrl, jpegDataUrl: pngDataUrl }),
      });
      expect(invalid.status).toBe(400);

      const res = await app.request("/api/settings/branding/logo", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dataUrl: pngDataUrl,
          jpegDataUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        }),
      });
      expect(res.status).toBe(200);
      expect(getAppLogoJpeg()?.data).toEqual(jpeg);

      const settingsBody = await (await app.request("/api/settings")).json();
      expect(settingsBody.settings).not.toHaveProperty("app_logo_jpeg");

      await app.request("/api/settings/branding/logo", { method: "DELETE" });
      expect(getAppLogoJpeg()).toBeNull();
    });

    test("removes the custom logo and hides it from the settings list", async () => {
      const app = createAdminApp();
      await uploadLogo(app, pngDataUrl);

      const settingsBody = await (await app.request("/api/settings")).json();
      expect(settingsBody.settings).not.toHaveProperty("app_logo");

      const deleteRes = await app.request("/api/settings/branding/logo", { method: "DELETE" });
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()).branding.logoUrl).toBeNull();
      expect((await app.request("/api/settings/public/logo")).status).toBe(404);
    });
  });
});
