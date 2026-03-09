import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, systems } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import systemsRoutes from "../../server/routes/systems";

describe("systems test-connection trust flow", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-system-test-connection-trust-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns a trust challenge and persists approved host keys on retry", async () => {
    const db = getDb();
    const credentialId = db.insert(credentials).values({
      name: "Ops password",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "ops",
        password: "encrypted-password",
      }),
    }).returning({ id: credentials.id }).get().id;
    const systemId = db.insert(systems).values({
      name: "Ops",
      hostname: "host.example",
      port: 22,
      credentialId,
      authType: "password",
      username: "ops",
      hostKeyVerificationEnabled: 1,
    }).returning({ id: systems.id }).get().id;

    const challenge = {
      systemId,
      role: "target" as const,
      host: "host.example",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:test-fingerprint",
      rawKey: "ZmFrZS1ob3N0LWtleQ==",
    };

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).testConnection = async (_system: unknown, context: { approvedHostKeys?: unknown[] }) => {
      if (context.approvedHostKeys?.length) {
        return {
          success: true,
          message: "Connection successful",
        };
      }
      return {
        success: false,
        message: "SSH host key approval required",
        hostKeyChallenges: [challenge],
      };
    };
    (sshManager as any).connect = async () => {
      throw new Error("skip detection");
    };

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const firstRes = await app.request("/api/systems/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "host.example",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: true,
        systemId,
      }),
    });

    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.hostKeyChallenges).toEqual([challenge]);
    expect(firstBody.trustChallengeToken).toEqual(expect.any(String));

    const secondRes = await app.request("/api/systems/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "host.example",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: true,
        systemId,
        trustChallengeToken: firstBody.trustChallengeToken,
        approvedHostKeys: [challenge],
      }),
    });

    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody.success).toBe(true);
    expect(secondBody.validatedConfigToken).toEqual(expect.any(String));

    const updatedSystem = db.select().from(systems).where(eq(systems.id, systemId)).get();
    expect(updatedSystem?.trustedHostKeyFingerprintSha256).toBe(
      challenge.fingerprintSha256
    );
    expect(updatedSystem?.trustedHostKeyAlgorithm).toBe(challenge.algorithm);
  });
});
