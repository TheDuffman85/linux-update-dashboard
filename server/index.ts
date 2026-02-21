import { mkdirSync } from "fs";
import { dirname } from "path";
import { eq } from "drizzle-orm";
import { config } from "./config";
import { initDatabase, closeDatabase, getDb } from "./db";
import { settings } from "./db/schema";
import { initEncryptor, getEncryptor } from "./security";
import { initSSHManager } from "./ssh/connection";
import { initSession } from "./auth/session";
import { configureOidc } from "./auth/oidc";
import * as scheduler from "./services/scheduler";
import { createApp } from "./app";

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

// Initialize core systems
console.log("Initializing database...");
const db = initDatabase(config.dbPath);

console.log("Initializing encryption...");
initEncryptor(config.encryptionKey);

console.log("Initializing session management...");
initSession(config.secretKey);

console.log("Initializing SSH connection manager...");
initSSHManager(
  config.maxConcurrentConnections,
  config.defaultSshTimeout,
  config.defaultCmdTimeout,
  getEncryptor()
);

// Initialize OIDC from database settings
console.log("Initializing OIDC...");
{
  const dbInstance = getDb();
  const oidcIssuer = dbInstance.select().from(settings).where(eq(settings.key, "oidc_issuer")).get();
  const oidcClientId = dbInstance.select().from(settings).where(eq(settings.key, "oidc_client_id")).get();
  const oidcClientSecret = dbInstance.select().from(settings).where(eq(settings.key, "oidc_client_secret")).get();

  const encryptor = getEncryptor();
  const decryptedSecret = oidcClientSecret?.value
    ? encryptor.decrypt(oidcClientSecret.value)
    : "";

  configureOidc(
    oidcIssuer?.value || "",
    oidcClientId?.value || "",
    decryptedSecret,
  ).catch((e) => console.log("OIDC not configured:", (e as Error).message));
}

// Start background scheduler
console.log("Starting update scheduler...");
scheduler.start();

// Create and start Hono app
const app = createApp();

console.log(`Server starting on http://${config.host}:${config.port}`);

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  scheduler.stop();
  closeDatabase();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  scheduler.stop();
  closeDatabase();
  server.stop();
  process.exit(0);
});
