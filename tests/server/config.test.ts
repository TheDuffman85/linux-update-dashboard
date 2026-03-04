import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { tmpdir } from "os";

let envSnapshot: NodeJS.ProcessEnv;
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ludash-config-test-"));
  tempDirs.push(dir);
  return dir;
}

function createTempFile(dir: string, name: string, value: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, value, "utf8");
  return filePath;
}

function resetLudashEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("LUDASH_")) delete process.env[key];
  }
}

async function importFreshConfig() {
  const cacheBust = `${Date.now()}-${Math.random()}`;
  return await import(`../../server/config.ts?test=${cacheBust}`);
}

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("config secret env loading", () => {
  test("loads encryption key from LUDASH_ENCRYPTION_KEY_FILE", async () => {
    const dir = createTempDir();
    const key = randomBytes(32).toString("base64");
    const keyFile = createTempFile(dir, "encryption.key", `${key}\n`);

    resetLudashEnv();
    process.env.LUDASH_DB_PATH = join(dir, "dashboard.db");
    process.env.LUDASH_ENCRYPTION_KEY_FILE = keyFile;

    const { config } = await importFreshConfig();
    expect(config.encryptionKey).toBe(key);
  });

  test("loads session key from LUDASH_SECRET_KEY_FILE", async () => {
    const dir = createTempDir();
    const sessionKey = "session-secret-from-file";
    const sessionKeyFile = createTempFile(dir, "session.key", `${sessionKey}\n`);

    resetLudashEnv();
    process.env.LUDASH_DB_PATH = join(dir, "dashboard.db");
    process.env.LUDASH_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.LUDASH_SECRET_KEY_FILE = sessionKeyFile;

    const { config } = await importFreshConfig();
    expect(config.secretKey).toBe(sessionKey);
  });

  test("throws when encryption key is missing", async () => {
    const dir = createTempDir();

    resetLudashEnv();
    process.env.LUDASH_DB_PATH = join(dir, "dashboard.db");

    await expect(importFreshConfig()).rejects.toThrow("LUDASH_ENCRYPTION_KEY is required");
  });

  test("throws when encryption env and _FILE are both set", async () => {
    const dir = createTempDir();
    const keyFile = createTempFile(dir, "encryption.key", randomBytes(32).toString("base64"));

    resetLudashEnv();
    process.env.LUDASH_DB_PATH = join(dir, "dashboard.db");
    process.env.LUDASH_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.LUDASH_ENCRYPTION_KEY_FILE = keyFile;

    await expect(importFreshConfig()).rejects.toThrow("both LUDASH_ENCRYPTION_KEY and LUDASH_ENCRYPTION_KEY_FILE are set");
  });

  test("auto-generates session key when no session key env is provided", async () => {
    const dir = createTempDir();
    const dbPath = join(dir, "dashboard.db");

    resetLudashEnv();
    process.env.LUDASH_DB_PATH = dbPath;
    process.env.LUDASH_ENCRYPTION_KEY = randomBytes(32).toString("base64");

    const { config } = await importFreshConfig();
    expect(config.secretKey.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, ".secret_key"))).toBe(true);
  });
});
