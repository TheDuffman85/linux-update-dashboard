import { mkdirSync, chmodSync } from "fs";
import { dirname } from "path";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { config, getEncryptionSalt, hasConfiguredBaseUrl } from "./config";
import { initDatabase, closeDatabase, getDb } from "./db";
import { users } from "./db/schema";
import { initEncryptor } from "./security";
import { initSession } from "./auth/session";
import { configureOidcFromSettings, getOidcPolicy } from "./auth/oidc";
import {
  getManagedAuthSettings,
  getOidcAutoLoginState,
  getPasswordLoginState,
  hasOidcSettings,
  initAuthConfig,
} from "./auth/auth-config";
import * as scheduler from "./services/scheduler";
import { createApp } from "./app";
import { logger } from "./logger";
import * as notificationRuntime from "./services/notification-runtime";
import * as upgradeBatchService from "./services/upgrade-batch-service";
import { migrateEncryptionSalt, migrateLegacyAuthTags } from "./encryption-migration";
import { syncSSHManagerWithSettings } from "./services/settings-service";

// Ensure data directory exists with restrictive permissions
mkdirSync(dirname(config.dbPath), { recursive: true });
try { chmodSync(dirname(config.dbPath), 0o700); } catch { /* Windows */ }

if (!hasConfiguredBaseUrl()) {
  logger.warn("LUDASH_BASE_URL is not set; falling back to the default base URL", {
    baseUrl: config.baseUrl,
  });
}

// Validate deployment-managed auth settings before touching any state.
initAuthConfig();
{
  const managedAuthSettings = Object.values(getManagedAuthSettings());
  if (managedAuthSettings.length > 0) {
    logger.info("Auth settings managed by environment", {
      variables: managedAuthSettings.join(", "),
    });
  }
}

logger.info("Initializing encryption");
const salt = getEncryptionSalt(config.dbPath, config.encryptionKey);
initEncryptor(config.encryptionKey, salt);

// Initialize core systems
logger.info("Initializing database");
const db = initDatabase(config.dbPath);
try { chmodSync(config.dbPath, 0o600); } catch { /* Windows */ }
migrateEncryptionSalt(config.encryptionKey, salt);
migrateLegacyAuthTags();

logger.info("Initializing session management");
initSession(config.secretKey);

logger.info("Initializing SSH connection manager");
syncSSHManagerWithSettings();

// Initialize OIDC from environment and database settings
if (hasOidcSettings()) {
  logger.info("Initializing OIDC");
  void configureOidcFromSettings();
}
// Surface a lockout fallback at startup instead of on the first login attempt.
if (getPasswordLoginState().disabled) {
  // Without password setup, only an OIDC admin role can create the first administrator.
  const policy = getOidcPolicy();
  const hasUsers = !!getDb().select({ id: users.id }).from(users).limit(1).get();
  if (!hasUsers && policy.adminGroups.length === 0 && policy.unmatchedRole !== "admin") {
    logger.warn(
      "Password login is disabled and no users exist, but no OIDC admin groups are configured; no one can sign in as administrator.",
    );
  }
}

// Surface an enabled but inactive OIDC auto-login at startup.
getOidcAutoLoginState();

// Start background scheduler
logger.info("Starting update scheduler");
scheduler.start();
upgradeBatchService.resumeUpgradeBatches();

// Create and start Hono app
const app = createApp();
const wss = new WebSocketServer({ noServer: true });

logger.info("Server starting", {
  host: config.host,
  port: config.port,
  logLevel: config.logLevel,
});

const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
  websocket: {
    server: wss,
  },
});

logger.info("Starting notification runtimes");
notificationRuntime.start().catch((error) => {
  logger.error("Notification runtime failed to start", { error: String(error) });
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down");
  scheduler.stop();
  notificationRuntime.stop().catch(() => {});
  closeDatabase();
  server.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  scheduler.stop();
  notificationRuntime.stop().catch(() => {});
  closeDatabase();
  server.close();
  process.exit(0);
});
