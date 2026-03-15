import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { rebootSystem } from "../../server/services/update-service";

describe("rebootSystem", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-reboot-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns failure when reboot command exits non-zero", async () => {
    const db = getDb();
    const encryptor = getEncryptor();
    const inserted = db.insert(systems).values({
      name: "CentOS",
      hostname: "localhost",
      port: 2003,
      authType: "password",
      username: "testuser",
      encryptedPassword: encryptor.encrypt("testpass"),
    }).returning({ id: systems.id }).get();

    const sshManager = initSSHManager(1, 1, 1, encryptor);
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async () => ({
      stdout: "",
      stderr: "Failed to talk to init daemon.\n",
      exitCode: 1,
    });

    const result = await rebootSystem(inserted.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to talk to init daemon");

    const system = db.select().from(systems).where(eq(systems.id, inserted.id)).get();
    expect(system?.isReachable).toBe(0);

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, inserted.id))
      .all()
      .at(-1);
    expect(JSON.parse(history?.steps || "[]")).toMatchObject([
      {
        pkgManager: "system",
        status: "failed",
        command: expect.stringContaining("reboot"),
        error: "Failed to talk to init daemon.\n",
      },
    ]);
  });
});
