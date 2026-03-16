import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { getSSHManager } from "../../server/ssh/connection";
import { syncSSHManagerWithSettings } from "../../server/services/settings-service";

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
});
