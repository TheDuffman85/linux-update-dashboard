import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { updateHistory } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { createSystem } from "../../server/services/system-service";
import { applyUpgradeAll, checkUpdates } from "../../server/services/update-service";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const alpineHost = process.env.LUDASH_APK_TEST_HOST ?? "127.0.0.1";
const alpinePort = Number(process.env.LUDASH_APK_TEST_PORT ?? "2010");

describe("APK upgrade integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-apk-upgrade-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    initSSHManager(2, 10, 180, getEncryptor());
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  integrationTest("runs upgrade-all successfully against the Alpine SSH test system", async () => {
    const systemId = createSystem({
      name: "Alpine",
      hostname: alpineHost,
      port: alpinePort,
      authType: "password",
      username: "testuser",
      password: "testpass",
    });

    await checkUpdates(systemId);

    const result = await applyUpgradeAll(systemId);

    expect(result.success).toBe(true);
    expect(result.output).toContain("[apk]");
    expect(result.output.replace("[apk]", "").trim().length).toBeGreaterThan(0);

    const row = getDb()
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .find((entry) => entry.action === "upgrade_all");

    expect(row).toBeDefined();
    expect(row?.pkgManager).toBe("apk");
    expect(row?.status).toBe("success");
    expect(row?.command).toContain("apk upgrade");
  });
});
