import { mkdirSync, chmodSync } from "fs";
import { dirname } from "path";
import { eq } from "drizzle-orm";
import { config, getEncryptionSalt } from "./config";
import { initDatabase, closeDatabase, getDb } from "./db";
import { credentials, settings, systems, notifications } from "./db/schema";
import { CredentialEncryptor, isPassphraseKey, initEncryptor, getEncryptor } from "./security";
import { initSSHManager } from "./ssh/connection";
import { initSession } from "./auth/session";
import { configureOidc } from "./auth/oidc";
import * as scheduler from "./services/scheduler";
import { createApp, websocket } from "./app";
import { setRequestIp } from "./request-ip-store";
import { logger } from "./logger";
import * as telegramBot from "./services/telegram-bot";

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

// --- Encryption salt migration ---
// Re-encrypts all data from the legacy hardcoded salt to the per-instance salt.
// Only runs for passphrase-derived keys when a new salt file was just created.
function migrateEncryptionSalt(rawKey: string, newSalt: Buffer | null): void {
  if (!newSalt || !isPassphraseKey(rawKey)) return;

  // Check if there's any encrypted data that was encrypted with the old salt.
  // If the DB is empty (fresh install), the new salt was just written and there's nothing to migrate.
  const dbInstance = getDb();
  const anySystem = dbInstance.select({ id: systems.id }).from(systems).limit(1).get();
  const anyEncryptedSetting = dbInstance
    .select()
    .from(settings)
    .where(eq(settings.key, "oidc_client_secret"))
    .get();
  const anyCredential = dbInstance
    .select({ id: credentials.id })
    .from(credentials)
    .limit(1)
    .get();

  const hasEncryptedData =
    anySystem ||
    anyCredential ||
    (anyEncryptedSetting?.value && anyEncryptedSetting.value.length > 0);

  if (!hasEncryptedData) return;

  // Try to decrypt with OLD (legacy) encryptor to see if migration is needed
  const oldEncryptor = new CredentialEncryptor(rawKey); // uses LEGACY_SALT
  const newEncryptor = new CredentialEncryptor(rawKey, newSalt);

  logger.info("Migrating encrypted data to per-instance salt");

  // Helper: re-encrypt a single value
  function reEncrypt(value: string | null): string | null {
    if (!value) return null;
    try {
      const plaintext = oldEncryptor.decrypt(value);
      return newEncryptor.encrypt(plaintext);
    } catch {
      // Already migrated or invalid — leave as-is
      return value;
    }
  }

  // Migrate systems table
  const allSystems = dbInstance.select().from(systems).all();
  for (const sys of allSystems) {
    const updates: Record<string, string | null> = {};
    let changed = false;

    for (const col of [
      "encryptedPassword",
      "encryptedPrivateKey",
      "encryptedKeyPassphrase",
      "encryptedSudoPassword",
    ] as const) {
      const val = sys[col];
      if (val) {
        const reEncrypted = reEncrypt(val);
        if (reEncrypted !== val) {
          updates[col] = reEncrypted;
          changed = true;
        }
      }
    }

    if (changed) {
      dbInstance
        .update(systems)
        .set(updates as any)
        .where(eq(systems.id, sys.id))
        .run();
    }
  }

  // Migrate oidc_client_secret in settings
  if (anyEncryptedSetting?.value) {
    const reEncrypted = reEncrypt(anyEncryptedSetting.value);
    if (reEncrypted !== anyEncryptedSetting.value) {
      dbInstance
        .update(settings)
        .set({ value: reEncrypted! })
        .where(eq(settings.key, "oidc_client_secret"))
        .run();
    }
  }

  const CREDENTIAL_SECRET_FIELDS: Record<string, string[]> = {
    usernamePassword: ["password"],
    sshKey: ["privateKey", "passphrase"],
    certificate: ["certificatePem", "privateKeyPem", "privateKeyPassword"],
  };

  const allCredentials = dbInstance.select().from(credentials).all();
  for (const credential of allCredentials) {
    try {
      const payload = JSON.parse(credential.payload);
      const secretFields = CREDENTIAL_SECRET_FIELDS[credential.kind] || [];
      let changed = false;

      for (const field of secretFields) {
        if (payload[field] && payload[field] !== "(stored)") {
          const reEncrypted = reEncrypt(payload[field]);
          if (reEncrypted !== payload[field]) {
            payload[field] = reEncrypted;
            changed = true;
          }
        }
      }

      if (changed) {
        dbInstance
          .update(credentials)
          .set({ payload: JSON.stringify(payload) })
          .where(eq(credentials.id, credential.id))
          .run();
      }
    } catch {
      // Invalid JSON payload — skip
    }
  }

  // Migrate sensitive fields in notifications config
  const SENSITIVE_KEYS: Record<string, string[]> = {
    email: ["smtpPassword"],
    gotify: ["gotifyToken"],
    ntfy: ["ntfyToken"],
    telegram: ["telegramBotToken", "commandApiTokenEncrypted"],
  };

  const allNotifications = dbInstance.select().from(notifications).all();
  for (const notif of allNotifications) {
    const sensitiveFields = SENSITIVE_KEYS[notif.type] || [];
    if (sensitiveFields.length === 0) continue;

    try {
      const config = JSON.parse(notif.config);
      let changed = false;

      for (const field of sensitiveFields) {
        if (config[field] && config[field] !== "(stored)") {
          const reEncrypted = reEncrypt(config[field]);
          if (reEncrypted !== config[field]) {
            config[field] = reEncrypted;
            changed = true;
          }
        }
      }

      if (changed) {
        dbInstance
          .update(notifications)
          .set({ config: JSON.stringify(config) })
          .where(eq(notifications.id, notif.id))
          .run();
      }
    } catch {
      // Invalid JSON config — skip
    }
  }

  logger.info("Encryption migration complete");
}
