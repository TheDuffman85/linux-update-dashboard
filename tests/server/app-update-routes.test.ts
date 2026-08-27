import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hashToken } from "../../server/auth/api-token";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, users } from "../../server/db/schema";
import { authMiddleware } from "../../server/middleware/auth";
import appUpdateRoutes from "../../server/routes/app-update";
import { resetAppUpdateStatusCache } from "../../server/services/app-update-service";
import { initEncryptor } from "../../server/security";

describe("app update routes", () => {
  let tempDir: string;
  let envSnapshot: NodeJS.ProcessEnv;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    tempDir = mkdtempSync(join(tmpdir(), "ludash-app-update-routes-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "app-update.db"));
    resetAppUpdateStatusCache();

    process.env.LUDASH_APP_REPOSITORY = "TheDuffman85/linux-update-dashboard";
    process.env.LUDASH_APP_BRANCH = "main";
    process.env.LUDASH_APP_VERSION = "2026.8.27";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "2026.8.28",
          html_url:
            "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.8.28",
        }),
        { status: 200 },
      )) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetAppUpdateStatusCache();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });

    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("allows read-only API tokens to read application update status", async () => {
    const token = `ludash_${randomBytes(32).toString("hex")}`;
    const user = getDb()
      .insert(users)
      .values({
        username: "api-user",
        passwordHash: "unused",
        isAdmin: 1,
      })
      .returning({ id: users.id })
      .get();
    getDb()
      .insert(apiTokens)
      .values({
        userId: user.id,
        name: "read-only app update status",
        tokenHash: await hashToken(token),
        readOnly: 1,
      })
      .run();

    const app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/app-update", appUpdateRoutes);

    const response = await app.request(
      "/api/app-update",
      {
        headers: { Authorization: `Bearer ${token}` },
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

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      updateAvailable: true,
      currentVersion: "2026.8.27",
      currentBranch: "main",
      remoteVersion: "2026.8.28",
      releaseUrl:
        "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.8.28",
      repoUrl: "https://github.com/TheDuffman85/linux-update-dashboard",
    });
  });

  test("requires authentication", async () => {
    getDb()
      .insert(users)
      .values({
        username: "admin",
        passwordHash: "unused",
        isAdmin: 1,
      })
      .run();

    const app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/app-update", appUpdateRoutes);

    const response = await app.request("/api/app-update");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
