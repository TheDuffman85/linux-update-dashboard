import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
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
  return key;
}

function loadConfig(): Config {
  const dbPath = process.env.LUDASH_DB_PATH || "./data/dashboard.db";

  return {
    dbPath,
    encryptionKey: process.env.LUDASH_ENCRYPTION_KEY || "",
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
  };
}

export const config = loadConfig();
