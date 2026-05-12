import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, users } from "../../server/db/schema";
import scriptsRoutes from "../../server/routes/scripts";
import { authMiddleware } from "../../server/middleware/auth";
import { hashToken } from "../../server/auth/api-token";
import { initEncryptor } from "../../server/security";
import { createApp } from "../../server/app";

describe("scripts routes security", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-scripts-routes-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createBearerToken(): Promise<string> {
    const token = `ludash_${randomBytes(32).toString("hex")}`;
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
    return token;
  }

  test("direct route usage still lists scripts for session-authenticated callers", async () => {
    const app = new Hono();
    app.route("/api/scripts", scriptsRoutes);

    const res = await app.request("/api/scripts");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scripts.some((script: { id: string }) => script.id === "builtin:apt:check_updates")).toBe(true);
  });

  test("full app stack blocks unauthenticated script access", async () => {
    getDb().insert(users).values({
      username: "browser-user",
      passwordHash: "unused",
      isAdmin: 1,
    }).run();

    const res = await createApp().request("/api/scripts");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  test("bearer tokens cannot access scripts endpoints", async () => {
    const token = await createBearerToken();
    const app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/scripts", scriptsRoutes);
    const headers = {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const incoming = {
      socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 12345,
        remoteFamily: "IPv4",
      },
    };

    const requests = [
      app.request("/api/scripts", { headers }, { incoming }),
      app.request("/api/scripts", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }, { incoming }),
      app.request("/api/scripts/custom:1", {
        method: "PUT",
        headers,
        body: JSON.stringify({}),
      }, { incoming }),
      app.request("/api/scripts/custom:1", { method: "DELETE", headers }, { incoming }),
      app.request("/api/scripts/format", {
        method: "POST",
        headers,
        body: JSON.stringify({ command: "echo ok" }),
      }, { incoming }),
      app.request("/api/scripts/validate-parser", {
        method: "POST",
        headers,
        body: JSON.stringify({ output: "", parserConfig: {} }),
      }, { incoming }),
    ];

    for (const res of await Promise.all(requests)) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "API tokens cannot access management endpoints",
      });
    }
  });
});
