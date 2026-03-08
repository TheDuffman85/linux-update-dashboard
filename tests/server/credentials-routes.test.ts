import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, systems } from "../../server/db/schema";
import credentialsRoutes from "../../server/routes/credentials";
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
