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
      name: "SMTP",
      kind: "emailSmtp",
      payload: JSON.stringify({
        username: "mailer",
        password: "encrypted-password",
      }),
    }).returning({ id: credentials.id }).get();

    const res = await app.request(`/api/credentials/${inserted.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.credential.payload.username).toBe("mailer");
    expect(body.credential.payload.password).toBe("(stored)");
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
});
