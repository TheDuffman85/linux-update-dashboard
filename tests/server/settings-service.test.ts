import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { getSSHManager } from "../../server/ssh/connection";
import { getNumericSettingRules, syncSSHManagerWithSettings } from "../../server/services/settings-service";

describe("settings service", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-settings-service-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "settings.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("initializes the SSH manager from persisted settings", () => {
    const db = getDb();

    db.update(settings).set({ value: "22" }).where(eq(settings.key, "ssh_timeout_seconds")).run();
    db.update(settings).set({ value: "30" }).where(eq(settings.key, "cmd_timeout_seconds")).run();
    db.update(settings).set({ value: "9" }).where(eq(settings.key, "concurrent_connections")).run();

    syncSSHManagerWithSettings();

    expect(getSSHManager().getRuntimeConfig()).toEqual({
      maxConcurrent: 9,
      defaultTimeout: 22,
      defaultCmdTimeout: 30,
    });
  });

  test("uses environment-configured timeout maximums for runtime settings", () => {
    const previousSshMax = process.env.LUDASH_MAX_SSH_TIMEOUT;
    const previousCmdMax = process.env.LUDASH_MAX_CMD_TIMEOUT;
    process.env.LUDASH_MAX_SSH_TIMEOUT = "20";
    process.env.LUDASH_MAX_CMD_TIMEOUT = "40";

    try {
      const db = getDb();
      db.update(settings).set({ value: "120" }).where(eq(settings.key, "ssh_timeout_seconds")).run();
      db.update(settings).set({ value: "600" }).where(eq(settings.key, "cmd_timeout_seconds")).run();

      expect(getNumericSettingRules().ssh_timeout_seconds.max).toBe(20);
      expect(getNumericSettingRules().cmd_timeout_seconds.max).toBe(40);

      syncSSHManagerWithSettings();

      expect(getSSHManager().getRuntimeConfig()).toMatchObject({
        defaultTimeout: 20,
        defaultCmdTimeout: 40,
      });
    } finally {
      if (previousSshMax === undefined) delete process.env.LUDASH_MAX_SSH_TIMEOUT;
      else process.env.LUDASH_MAX_SSH_TIMEOUT = previousSshMax;
      if (previousCmdMax === undefined) delete process.env.LUDASH_MAX_CMD_TIMEOUT;
      else process.env.LUDASH_MAX_CMD_TIMEOUT = previousCmdMax;
    }
  });
});
