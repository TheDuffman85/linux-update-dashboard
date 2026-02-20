import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import { mkdirSync } from "fs";
import { dirname } from "path";
import * as schema from "./schema";

let _db: BunSQLiteDatabase<typeof schema> | null = null;
let _sqlite: Database | null = null;

const DEFAULT_SETTINGS = [
  {
    key: "cache_duration_hours",
    value: "12",
    description: "How long to cache update check results (hours)",
  },
  {
    key: "concurrent_connections",
    value: "5",
    description: "Max simultaneous SSH connections",
  },
  {
    key: "ssh_timeout_seconds",
    value: "30",
    description: "SSH connection timeout (seconds)",
  },
  {
    key: "cmd_timeout_seconds",
    value: "120",
    description: "SSH command execution timeout (seconds)",
  },
  {
    key: "check_flatpak",
    value: "0",
    description: "Check for Flatpak updates (0=no, 1=yes)",
  },
  {
    key: "check_snap",
    value: "0",
    description: "Check for Snap updates (0=no, 1=yes)",
  },
  {
    key: "oidc_issuer",
    value: "",
    description: "OIDC provider issuer URL",
  },
  {
    key: "oidc_client_id",
    value: "",
    description: "OIDC client ID",
  },
  {
    key: "oidc_client_secret",
    value: "",
    description: "OIDC client secret (encrypted)",
  },
];

export function initDatabase(dbPath: string): BunSQLiteDatabase<typeof schema> {
  mkdirSync(dirname(dbPath), { recursive: true });

  _sqlite = new Database(dbPath);
  _sqlite.exec("PRAGMA journal_mode=WAL");
  _sqlite.exec("PRAGMA foreign_keys=ON");

  _db = drizzle(_sqlite, { schema });

  // Create tables
  _db.run(sql`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _db.run(sql`CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _db.run(sql`CREATE TABLE IF NOT EXISTS systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    auth_type TEXT NOT NULL DEFAULT 'password',
    username TEXT NOT NULL,
    encrypted_password TEXT,
    encrypted_private_key TEXT,
    encrypted_key_passphrase TEXT,
    pkg_manager TEXT,
    os_name TEXT,
    os_version TEXT,
    kernel TEXT,
    hostname_remote TEXT,
    uptime TEXT,
    arch TEXT,
    cpu_cores TEXT,
    memory TEXT,
    disk TEXT,
    system_info_updated_at TEXT,
    is_reachable INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(hostname, port, username)
  )`);

  _db.run(sql`CREATE TABLE IF NOT EXISTS update_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    pkg_manager TEXT NOT NULL,
    package_name TEXT NOT NULL,
    current_version TEXT,
    new_version TEXT NOT NULL,
    architecture TEXT,
    repository TEXT,
    is_security INTEGER NOT NULL DEFAULT 0,
    cached_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(system_id, pkg_manager, package_name)
  )`);

  _db.run(sql`CREATE TABLE IF NOT EXISTS update_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    pkg_manager TEXT NOT NULL,
    package_count INTEGER,
    packages TEXT,
    status TEXT NOT NULL,
    output TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`);

  _db.run(sql`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Seed default settings
  for (const s of DEFAULT_SETTINGS) {
    _db.run(
      sql`INSERT OR IGNORE INTO settings (key, value, description) VALUES (${s.key}, ${s.value}, ${s.description})`
    );
  }

  return _db;
}

export function getDb(): BunSQLiteDatabase<typeof schema> {
  if (!_db) throw new Error("Database not initialized");
  return _db;
}

export function closeDatabase(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
