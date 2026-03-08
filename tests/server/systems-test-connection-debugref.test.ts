import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import systemsRoutes from "../../server/routes/systems";

describe("systems test-connection route", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-system-test-connection-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns a debug reference on connection failure", async () => {
    const credentialId = getDb().insert(credentials).values({
      name: "Ops password",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "ops",
        password: "encrypted-password",
      }),
    }).returning({ id: credentials.id }).get().id;
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).testConnection = async () => ({
      success: false,
      message: "Permission denied (check credentials)",
      debugRef: "attempt-123",
    });

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "host.example",
        port: 22,
        credentialId,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: false,
      message: "Permission denied (check credentials)",
      debugRef: "attempt-123",
    });
  });
});
