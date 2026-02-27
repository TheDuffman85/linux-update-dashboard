import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";

export interface Config {
  dbPath: string;
  encryptionKey: string;
  secretKey: string;
  logLevel: string;
  host: string;
  port: number;
  defaultCacheHours: number;
  defaultSshTimeout: number;
  defaultCmdTimeout: number;
  maxConcurrentConnections: number;
  baseUrl: string;
  trustProxy: boolean;
}

function getSecretKey(dbPath: string, envKey?: string): string {
  if (envKey) return envKey;

  const keyFile = join(dirname(dbPath), ".secret_key");
  if (existsSync(keyFile)) {
    return readFileSync(keyFile, "utf-8").trim();
  }

  const key = randomBytes(32).toString("hex");
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, key);
  try { chmodSync(keyFile, 0o600); } catch { /* Windows doesn't support chmod */ }
  return key;
}

function getEncryptionKey(): string {
  const key = process.env.LUDASH_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "LUDASH_ENCRYPTION_KEY environment variable is required.\n" +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return key;
}

/**
 * Get or generate a per-instance encryption salt for PBKDF2 key derivation.
 * Returns null if the encryption key is a raw base64 key (salt not needed).
 */
export function getEncryptionSalt(dbPath: string, rawKey: string): Buffer | null {
  // Base64 keys are used directly — no PBKDF2, no salt needed
  if (rawKey.length === 44 && rawKey.endsWith("=")) return null;

  const saltFile = join(dirname(dbPath), ".encryption_salt");
  if (existsSync(saltFile)) {
    return Buffer.from(readFileSync(saltFile, "utf-8").trim(), "hex");
  }

  // First run — generate a random salt
  const salt = randomBytes(16);
  mkdirSync(dirname(saltFile), { recursive: true });
  writeFileSync(saltFile, salt.toString("hex"));
  try { chmodSync(saltFile, 0o600); } catch { /* Windows */ }
  return salt;
}

function loadConfig(): Config {
  const dbPath = process.env.LUDASH_DB_PATH || "./data/dashboard.db";

  return {
    dbPath,
    encryptionKey: getEncryptionKey(),
    secretKey: getSecretKey(dbPath, process.env.LUDASH_SECRET_KEY),
    logLevel: process.env.LUDASH_LOG_LEVEL || "info",
    host: process.env.LUDASH_HOST || "0.0.0.0",
    port: parseInt(process.env.LUDASH_PORT || "3001", 10),
    defaultCacheHours: parseInt(
      process.env.LUDASH_DEFAULT_CACHE_HOURS || "12",
      10
    ),
    defaultSshTimeout: parseInt(
      process.env.LUDASH_DEFAULT_SSH_TIMEOUT || "30",
      10
    ),
    defaultCmdTimeout: parseInt(
      process.env.LUDASH_DEFAULT_CMD_TIMEOUT || "120",
      10
    ),
    maxConcurrentConnections: parseInt(
      process.env.LUDASH_MAX_CONCURRENT_CONNECTIONS || "5",
      10
    ),
    baseUrl: process.env.LUDASH_BASE_URL || "http://localhost:3001",
    trustProxy: process.env.LUDASH_TRUST_PROXY === "true",
  };
}

export const config = loadConfig();
