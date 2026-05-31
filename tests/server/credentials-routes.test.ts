import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, credentials, systems, users } from "../../server/db/schema";
import credentialsRoutes from "../../server/routes/credentials";
import { hashToken } from "../../server/auth/api-token";
import { createSession, initSession } from "../../server/auth/session";
import { authMiddleware } from "../../server/middleware/auth";
import { initEncryptor } from "../../server/security";
import { listCredentials } from "../../server/services/credential-service";

describe("credentials routes", () => {
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-credentials-routes-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    app = new Hono();
    app.route("/api/credentials", credentialsRoutes);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function createBearerToken(readOnly: boolean): Promise<string> {
    const token = `ludash_${randomBytes(32).toString("hex")}`;
    const user = getDb().insert(users).values({
      username: `api-user-${randomBytes(4).toString("hex")}`,
      passwordHash: "unused",
      isAdmin: 1,
    }).returning({ id: users.id }).get();
    getDb().insert(apiTokens).values({
      userId: user.id,
      name: readOnly ? "reader" : "writer",
      tokenHash: await hashToken(token),
      readOnly: readOnly ? 1 : 0,
    }).run();
    return token;
  }

  function createProtectedApp(): Hono {
    const protectedApp = new Hono();
    protectedApp.use("/api/*", authMiddleware);
    protectedApp.route("/api/credentials", credentialsRoutes);
    return protectedApp;
  }

  async function createSessionCookie(): Promise<string> {
    const user = getDb().insert(users).values({
      username: "browser-user",
      passwordHash: "unused",
      isAdmin: 1,
    }).returning({ id: users.id }).get();
    initSession("credentials-routes-test-session-secret");
    const sessionApp = new Hono();
    sessionApp.get("/", async (c) => {
      await createSession(c, user.id, user.username);
      return c.json({ ok: true });
    });
    const res = await sessionApp.request("/");
    const cookie = res.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Expected session cookie");
    return cookie;
  }

  test("blocks read-only and write-capable bearer tokens from credential management", async () => {
    const protectedApp = createProtectedApp();
    const incoming = {
      socket: {
        remoteAddress: "127.0.0.1",
        remotePort: 12345,
        remoteFamily: "IPv4",
      },
    };
    const requests = [
      { path: "/api/credentials", method: "GET" },
      { path: "/api/credentials/1", method: "GET" },
      { path: "/api/credentials", method: "POST" },
      { path: "/api/credentials/1", method: "PUT" },
      { path: "/api/credentials/reorder", method: "PUT" },
      { path: "/api/credentials/1", method: "DELETE" },
    ];

    for (const readOnly of [true, false]) {
      const token = await createBearerToken(readOnly);
      for (const request of requests) {
        const res = await protectedApp.request(request.path, {
          method: request.method,
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: request.method === "POST" || request.method === "PUT"
            ? JSON.stringify({})
            : undefined,
        }, { incoming });

        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({
          error: "API tokens cannot access management endpoints",
        });
      }
    }
  });

  test("allows session-authenticated callers to manage credentials", async () => {
    const protectedApp = createProtectedApp();
    const cookie = await createSessionCookie();
    const headers = {
      "Cookie": cookie,
      "Content-Type": "application/json",
    };
    const createCredential = async (name: string, username: string) => {
      const res = await protectedApp.request("/api/credentials", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          kind: "usernamePassword",
          payload: { username, password: "test-password" },
        }),
      });
      expect(res.status).toBe(201);
      return (await res.json()).id as number;
    };

    const firstId = await createCredential("Alpha", "alpha");
    const secondId = await createCredential("Bravo", "bravo");

    const listRes = await protectedApp.request("/api/credentials", { headers });
    expect(listRes.status).toBe(200);
    expect((await listRes.json()).credentials).toHaveLength(2);

    const detailRes = await protectedApp.request(`/api/credentials/${firstId}`, { headers });
    expect(detailRes.status).toBe(200);
    expect((await detailRes.json()).credential.payload.password).toBe("(stored)");

    const updateRes = await protectedApp.request(`/api/credentials/${firstId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        name: "Alpha updated",
        payload: { username: "alpha", password: "(stored)" },
      }),
    });
    expect(updateRes.status).toBe(200);

    const reorderRes = await protectedApp.request("/api/credentials/reorder", {
      method: "PUT",
      headers,
      body: JSON.stringify({ credentialIds: [secondId, firstId] }),
    });
    expect(reorderRes.status).toBe(200);
    expect(listCredentials().map((credential) => credential.id)).toEqual([secondId, firstId]);

    const deleteRes = await protectedApp.request(`/api/credentials/${firstId}`, {
      method: "DELETE",
      headers,
    });
    expect(deleteRes.status).toBe(200);
  });

  test("creates and filters credentials by kind", async () => {
    const res = await app.request("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops SSH",
        kind: "sshKey",
        payload: {
          username: "ops",
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
        },
      }),
    });

    expect(res.status).toBe(201);

    const listRes = await app.request("/api/credentials?kind=sshKey");
    expect(listRes.status).toBe(200);
    const body = await listRes.json();
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0].summary).toContain("ops");
  });

  test("returns masked payload fields for credential details", async () => {
    const inserted = getDb().insert(credentials).values({
      name: "SSH",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "root",
        password: "encrypted-password",
      }),
    }).returning({ id: credentials.id }).get();

    const res = await app.request(`/api/credentials/${inserted.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credential.payload.username).toBe("root");
    expect(body.credential.payload.password).toBe("(stored)");
  });

  test("rejects notification-only credential kinds", async () => {
    const res = await app.request("/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "SMTP",
        kind: "emailSmtp",
        payload: {
          username: "mailer",
          password: "secret",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("invalid credential kind");
  });

  test("blocks deleting credentials that are still referenced", async () => {
    const credentialId = getDb().insert(credentials).values({
      name: "SSH",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "root",
        password: "encrypted-password",
      }),
    }).returning({ id: credentials.id }).get().id;

    getDb().insert(systems).values({
      name: "Alpha",
      hostname: "alpha.local",
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
    }).run();

    const res = await app.request(`/api/credentials/${credentialId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("in use");
    expect(body.references[0].name).toBe("Alpha");
  });

  test("reorders credentials when given a complete ordered ID list", async () => {
    const inserted = getDb().insert(credentials).values([
      {
        sortOrder: 0,
        name: "Alpha",
        kind: "usernamePassword",
        payload: JSON.stringify({ username: "alpha", password: "secret-a" }),
      },
      {
        sortOrder: 1,
        name: "Bravo",
        kind: "usernamePassword",
        payload: JSON.stringify({ username: "bravo", password: "secret-b" }),
      },
      {
        sortOrder: 2,
        name: "Charlie",
        kind: "usernamePassword",
        payload: JSON.stringify({ username: "charlie", password: "secret-c" }),
      },
    ]).returning({ id: credentials.id }).all();

    const res = await app.request("/api/credentials/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialIds: [inserted[2].id, inserted[0].id, inserted[1].id],
      }),
    });

    expect(res.status).toBe(200);
    expect(listCredentials().map((credential) => credential.name)).toEqual([
      "Charlie",
      "Alpha",
      "Bravo",
    ]);
  });

  test("rejects credential reorder payloads that omit credentials", async () => {
    const inserted = getDb().insert(credentials).values([
      {
        name: "Alpha",
        kind: "usernamePassword",
        payload: JSON.stringify({ username: "alpha", password: "secret-a" }),
      },
      {
        name: "Bravo",
        kind: "usernamePassword",
        payload: JSON.stringify({ username: "bravo", password: "secret-b" }),
      },
    ]).returning({ id: credentials.id }).all();

    const res = await app.request("/api/credentials/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentialIds: [inserted[0].id],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("include every credential exactly once");
  });
});
