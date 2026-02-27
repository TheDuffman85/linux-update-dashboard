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
    key: "check_interval_minutes",
    value: "15",
    description: "How often to check for stale systems (minutes)",
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
    encrypted_sudo_password TEXT,
    pkg_manager TEXT,
    detected_pkg_managers TEXT,
    disabled_pkg_managers TEXT,
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
    command TEXT,
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

  _db.run(sql`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    notify_on TEXT NOT NULL DEFAULT '["updates"]',
    system_ids TEXT,
    config TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  // Migration: add command column to existing databases
  try {
    _db.run(sql`ALTER TABLE update_history ADD COLUMN command TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add per-system package manager detection columns
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN detected_pkg_managers TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN disabled_pkg_managers TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add sudo password column
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN encrypted_sudo_password TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add notification tracking column
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN last_notified_hash TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add reboot required tracking column
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN needs_reboot INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Migration: add notification schedule columns
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN schedule TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN pending_events TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN last_sent_at TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add passkey name column
  try {
    _db.run(sql`ALTER TABLE webauthn_credentials ADD COLUMN name TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add exclude from upgrade-all flag
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN exclude_from_upgrade_all INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Migration: strip ntfyPriority from ntfy notification configs (priority is now automatic)
  _db.run(sql`UPDATE notifications SET config = json_remove(config, '$.ntfyPriority')
    WHERE type = 'ntfy' AND json_extract(config, '$.ntfyPriority') IS NOT NULL`);

  // Cleanup: mark any orphaned "started" history rows as failed (from previous crashes/restarts)
  _db.run(sql`UPDATE update_history SET status = 'failed', completed_at = datetime('now'),
    error = 'Server restarted while operation was in progress'
    WHERE status = 'started'`);

  // Cleanup: remove obsolete settings
  _db.run(sql`DELETE FROM settings WHERE key IN ('check_flatpak', 'check_snap')`);

  // Migration: migrate old settings-based notifications to notifications table
  migrateNotificationSettings(_db);

  // Seed default settings
  for (const s of DEFAULT_SETTINGS) {
    _db.run(
      sql`INSERT OR IGNORE INTO settings (key, value, description) VALUES (${s.key}, ${s.value}, ${s.description})`
    );
  }

  // Cleanup: remove obsolete notification settings
  _db.run(sql`DELETE FROM settings WHERE key IN (
    'notifications_enabled', 'notification_methods', 'notify_on_updates', 'notify_on_unreachable',
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from', 'notification_email_to',
    'ntfy_url', 'ntfy_topic', 'ntfy_token', 'ntfy_priority'
  )`);

  return _db;
}

function migrateNotificationSettings(db: BunSQLiteDatabase<typeof schema>): void {
  // Check if there are already rows in the notifications table
  const existing = db.run(sql`SELECT COUNT(*) as count FROM notifications`);
  // If notifications table already has data, skip migration
  const countRow = db.all(sql`SELECT COUNT(*) as count FROM notifications`);
  if (countRow.length > 0 && (countRow[0] as any).count > 0) return;

  // Read old settings
  const rows = db.all(sql`SELECT key, value FROM settings WHERE key IN (
    'notifications_enabled', 'notification_methods', 'notify_on_updates', 'notify_on_unreachable',
    'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from', 'notification_email_to',
    'ntfy_url', 'ntfy_topic', 'ntfy_token', 'ntfy_priority'
  )`);

  if (rows.length === 0) return;

  const s: Record<string, string> = {};
  for (const row of rows) {
    s[(row as any).key] = (row as any).value;
  }

  const enabled = s.notifications_enabled === "true";
  let methods: string[] = [];
  try {
    methods = JSON.parse(s.notification_methods || "[]");
  } catch { /* ignore */ }

  const notifyOn: string[] = [];
  if (s.notify_on_updates !== "false") notifyOn.push("updates");
  if (s.notify_on_unreachable === "true") notifyOn.push("unreachable");
  const notifyOnJson = JSON.stringify(notifyOn.length > 0 ? notifyOn : ["updates"]);

  // Migrate email config if it was configured
  if (methods.includes("email") && s.smtp_host) {
    const config = JSON.stringify({
      smtpHost: s.smtp_host || "",
      smtpPort: s.smtp_port || "587",
      smtpSecure: s.smtp_secure || "true",
      smtpUser: s.smtp_user || "",
      smtpPassword: s.smtp_password || "",
      smtpFrom: s.smtp_from || "",
      emailTo: s.notification_email_to || "",
    });
    db.run(sql`INSERT INTO notifications (name, type, enabled, notify_on, system_ids, config)
      VALUES ('Email', 'email', ${enabled ? 1 : 0}, ${notifyOnJson}, NULL, ${config})`);
  }

  // Migrate ntfy config if it was configured
  if (methods.includes("ntfy") && s.ntfy_topic) {
    const config = JSON.stringify({
      ntfyUrl: s.ntfy_url || "https://ntfy.sh",
      ntfyTopic: s.ntfy_topic || "",
      ntfyToken: s.ntfy_token || "",
    });
    db.run(sql`INSERT INTO notifications (name, type, enabled, notify_on, system_ids, config)
      VALUES ('ntfy', 'ntfy', ${enabled ? 1 : 0}, ${notifyOnJson}, NULL, ${config})`);
  }
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
