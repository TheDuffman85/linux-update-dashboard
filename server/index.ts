import { mkdirSync, chmodSync } from "fs";
import { dirname } from "path";
import { eq } from "drizzle-orm";
import { config, getEncryptionSalt } from "./config";
import { initDatabase, closeDatabase, getDb } from "./db";
import { settings } from "./db/schema";
import { initEncryptor, getEncryptor } from "./security";
import { initSSHManager } from "./ssh/connection";
import { initSession } from "./auth/session";
import { configureOidc } from "./auth/oidc";
import * as scheduler from "./services/scheduler";
import { createApp, websocket } from "./app";
import { setRequestIp } from "./request-ip-store";
import { logger } from "./logger";
import * as telegramBot from "./services/telegram-bot";
import { migrateEncryptionSalt, migrateLegacyAuthTags } from "./encryption-migration";

// Ensure data directory exists with restrictive permissions
mkdirSync(dirname(config.dbPath), { recursive: true });
try { chmodSync(dirname(config.dbPath), 0o700); } catch { /* Windows */ }

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
initSSHManager(
  config.maxConcurrentConnections,
  config.defaultSshTimeout,
  config.defaultCmdTimeout,
  getEncryptor()
);

// Initialize OIDC from database settings
{
  const dbInstance = getDb();
  const oidcIssuer = dbInstance.select().from(settings).where(eq(settings.key, "oidc_issuer")).get();
  const oidcClientId = dbInstance.select().from(settings).where(eq(settings.key, "oidc_client_id")).get();
  const oidcClientSecret = dbInstance.select().from(settings).where(eq(settings.key, "oidc_client_secret")).get();

  if (oidcIssuer?.value && oidcClientId?.value) {
    logger.info("Initializing OIDC");
    const encryptor = getEncryptor();
    const decryptedSecret = oidcClientSecret?.value
      ? encryptor.decrypt(oidcClientSecret.value)
      : "";

    configureOidc(
      oidcIssuer.value,
      oidcClientId.value,
      decryptedSecret,
    );
  }
}

// Start background scheduler
logger.info("Starting update scheduler");
scheduler.start();

// Create and start Hono app
const app = createApp();

logger.info("Server starting", {
  host: config.host,
  port: config.port,
  logLevel: config.logLevel,
});

const server = Bun.serve({
  fetch(req, server) {
    const ip = server.requestIP(req);
    if (ip) setRequestIp(req, ip.address);
    return app.fetch(req, server);
  },
  hostname: config.host,
  port: config.port,
  websocket,
});

logger.info("Starting Telegram bot polling");
telegramBot.start().catch((error) => {
  logger.error("Telegram bot service failed to start", { error: String(error) });
});

// Graceful shutdown
process.on("SIGINT", () => {
  logger.info("Shutting down");
  scheduler.stop();
  telegramBot.stop();
  closeDatabase();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  scheduler.stop();
  telegramBot.stop();
  closeDatabase();
  server.stop();
  process.exit(0);
});
