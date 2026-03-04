import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { resolveRequiredSecretEnv, resolveSecretEnv } from "../../server/env-secrets";

const TEST_VAR = "LUDASH_TEST_SECRET";
const TEST_FILE_VAR = `${TEST_VAR}_FILE`;

let envSnapshot: NodeJS.ProcessEnv;
const tempDirs: string[] = [];

function createTempFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ludash-secret-test-"));
  tempDirs.push(dir);
  const filePath = join(dir, "secret.txt");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
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

describe("resolveSecretEnv", () => {
  test("resolves direct env value when set", () => {
    process.env[TEST_VAR] = "direct-value";
    delete process.env[TEST_FILE_VAR];
    expect(resolveSecretEnv(TEST_VAR)).toBe("direct-value");
  });

  test("resolves value from _FILE when direct env is unset", () => {
    delete process.env[TEST_VAR];
    process.env[TEST_FILE_VAR] = createTempFile("file-value");
    expect(resolveSecretEnv(TEST_VAR)).toBe("file-value");
  });

  test("throws when both direct and _FILE variables are set", () => {
    process.env[TEST_VAR] = "direct-value";
    process.env[TEST_FILE_VAR] = createTempFile("file-value");
    expect(() => resolveSecretEnv(TEST_VAR)).toThrow(`both ${TEST_VAR} and ${TEST_FILE_VAR} are set`);
  });

  test("throws when _FILE path cannot be read", () => {
    delete process.env[TEST_VAR];
    process.env[TEST_FILE_VAR] = "/tmp/does-not-exist/ludash-secret.txt";
    expect(() => resolveSecretEnv(TEST_VAR)).toThrow(`failed to read ${TEST_FILE_VAR}`);
  });

  test("strips trailing CR/LF from _FILE values", () => {
    delete process.env[TEST_VAR];
    process.env[TEST_FILE_VAR] = createTempFile("line-with-newline\r\n\r\n");
    expect(resolveSecretEnv(TEST_VAR)).toBe("line-with-newline");
  });
});

describe("resolveRequiredSecretEnv", () => {
  test("throws when resolved value is empty", () => {
    delete process.env[TEST_VAR];
    process.env[TEST_FILE_VAR] = createTempFile("\n");
    expect(() => resolveRequiredSecretEnv(TEST_VAR, "help text")).toThrow(`${TEST_VAR} is required`);
  });
});
