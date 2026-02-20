import { mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "./config";
import { initDatabase, closeDatabase } from "./db";
import { initEncryptor, getEncryptor } from "./security";
import { initSSHManager } from "./ssh/connection";
import { initSession } from "./auth/session";
import { setRpId } from "./auth/webauthn";
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

// Set WebAuthn RP ID from base URL
try {
  const url = new URL(config.baseUrl);
  setRpId(url.hostname);
} catch {
  // Keep default "localhost"
}

console.log("Initializing SSH connection manager...");
initSSHManager(
  config.maxConcurrentConnections,
  config.defaultSshTimeout,
  config.defaultCmdTimeout,
  getEncryptor()
);

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
