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
import { createCustomPackageManager, createScript } from "../../server/services/script-service";

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
    expect(body.operationProfiles).toContainEqual(expect.objectContaining({
      operation: "check_updates",
      outputConsumer: expect.stringContaining("custom parsers read one selected step"),
    }));
  });

  test("package manager export response normalizes parser config to each script operation", async () => {
    createCustomPackageManager({ name: "hermes", label: "Hermes Agent" });
    createScript({
      name: "Check Hermes Agent Updates",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "hermes",
      steps: [{ label: "Checking Hermes release manifest", command: "echo hermes-agent 1.0 -> 1.1" }],
      parserConfig: {
        updateRegex: "^(?<packageName>hermes-agent)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$",
        installedPackageRegex: "^(?<packageName>hermes-agent)\\s+(?<currentVersion>\\S+)$",
        successExitCodes: [0],
      },
    });
    createScript({
      name: "List Installed Hermes Agent",
      type: "package_manager",
      operation: "list_installed_packages",
      pkgManager: "hermes",
      steps: [{ label: "Listing installed Hermes agent", command: "echo hermes-agent 1.0" }],
      parserConfig: {
        updateRegex: "^(?<packageName>hermes-agent)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$",
        installedPackageRegex: "^(?<packageName>hermes-agent)\\s+(?<currentVersion>\\S+)$",
        successExitCodes: [0],
      },
    });
    const app = new Hono();
    app.route("/api/scripts", scriptsRoutes);

    const res = await app.request("/api/scripts/package-managers/hermes/export");

    expect(res.status).toBe(200);
    const body = await res.json();
    const checkScript = body.scripts.find((script: { operation: string }) => script.operation === "check_updates");
    const listScript = body.scripts.find((script: { operation: string }) => script.operation === "list_installed_packages");
    expect(checkScript.parserConfig).toEqual({
      updateRegex: "^(?<packageName>hermes-agent)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$",
      successExitCodes: [0],
    });
    expect(listScript.parserConfig).toEqual({
      installedPackageRegex: "^(?<packageName>hermes-agent)\\s+(?<currentVersion>\\S+)$",
      successExitCodes: [0],
    });
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
      app.request("/api/scripts/package-managers/brewlinux/export", { headers }, { incoming }),
      app.request("/api/scripts/package-managers/import", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
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
