import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { eq, sql } from "drizzle-orm";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { getEncryptor } from "../security";
import * as schema from "./schema";

let _db: BunSQLiteDatabase<typeof schema> | null = null;
let _sqlite: Database | null = null;
const SYSTEMS_CONNECTION_UNIQUE_INDEX = "systems_connection_identity_idx";

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
  {
    key: "disable_password_login",
    value: "false",
    description: "Disable password-based login",
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

  _db.run(sql`CREATE TABLE IF NOT EXISTS credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  migrateCredentialsTable();

  _db.run(sql`CREATE TABLE IF NOT EXISTS systems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    credential_id INTEGER REFERENCES credentials(id) ON DELETE RESTRICT,
    proxy_jump_system_id INTEGER REFERENCES systems(id) ON DELETE RESTRICT,
    auth_type TEXT NOT NULL DEFAULT 'password',
    username TEXT NOT NULL,
    encrypted_password TEXT,
    encrypted_private_key TEXT,
    encrypted_key_passphrase TEXT,
    encrypted_sudo_password TEXT,
    host_key_verification_enabled INTEGER NOT NULL DEFAULT 1,
    trusted_host_key TEXT,
    trusted_host_key_algorithm TEXT,
    trusted_host_key_fingerprint_sha256 TEXT,
    host_key_trusted_at TEXT,
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
    exclude_from_upgrade_all INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    needs_reboot INTEGER NOT NULL DEFAULT 0,
    boot_id TEXT,
    system_info_updated_at TEXT,
    is_reachable INTEGER NOT NULL DEFAULT 0,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_notified_hash TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    notify_on TEXT NOT NULL DEFAULT '["updates","appUpdates"]',
    system_ids TEXT,
    config TEXT NOT NULL,
    schedule TEXT,
    pending_events TEXT,
    last_sent_at TEXT,
    last_app_version_notified TEXT,
    last_delivery_status TEXT,
    last_delivery_at TEXT,
    last_delivery_code INTEGER,
    last_delivery_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  _db.run(sql`CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    read_only INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN credential_id INTEGER REFERENCES credentials(id) ON DELETE RESTRICT`);
  } catch {
    // Column already exists
  }
  const systemColumns = _sqlite
    .query("PRAGMA table_info(systems)")
    .all() as Array<{ name?: string }>;
  const hasProxyJumpSystemId = systemColumns.some((column) => column.name === "proxy_jump_system_id");
  const hasHostKeyVerificationEnabled = systemColumns.some((column) => column.name === "host_key_verification_enabled");
  const hasTrustedHostKey = systemColumns.some((column) => column.name === "trusted_host_key");
  const hasTrustedHostKeyAlgorithm = systemColumns.some((column) => column.name === "trusted_host_key_algorithm");
  const hasTrustedHostKeyFingerprintSha256 = systemColumns.some((column) => column.name === "trusted_host_key_fingerprint_sha256");
  const hasHostKeyTrustedAt = systemColumns.some((column) => column.name === "host_key_trusted_at");

  if (!hasProxyJumpSystemId) {
    _db.run(sql`ALTER TABLE systems ADD COLUMN proxy_jump_system_id INTEGER REFERENCES systems(id) ON DELETE RESTRICT`);
  }
  if (!hasHostKeyVerificationEnabled) {
    _db.run(sql`ALTER TABLE systems ADD COLUMN host_key_verification_enabled INTEGER NOT NULL DEFAULT 1`);
    _db.run(sql`UPDATE systems SET host_key_verification_enabled = 0`);
  }
  if (!hasTrustedHostKey) {
    _db.run(sql`ALTER TABLE systems ADD COLUMN trusted_host_key TEXT`);
  }
  if (!hasTrustedHostKeyAlgorithm) {
    _db.run(sql`ALTER TABLE systems ADD COLUMN trusted_host_key_algorithm TEXT`);
  }
  if (!hasTrustedHostKeyFingerprintSha256) {
    _db.run(sql`ALTER TABLE systems ADD COLUMN trusted_host_key_fingerprint_sha256 TEXT`);
  }
  if (!hasHostKeyTrustedAt) {
    _db.run(sql`ALTER TABLE systems ADD COLUMN host_key_trusted_at TEXT`);
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN pkg_manager TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN os_name TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN os_version TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN kernel TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN hostname_remote TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN uptime TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN arch TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN cpu_cores TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN memory TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN disk TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN system_info_updated_at TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN is_reachable INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN last_seen_at TEXT`);
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
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN boot_id TEXT`);
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
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN last_app_version_notified TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN last_delivery_status TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN last_delivery_at TEXT`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN last_delivery_code INTEGER`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN last_delivery_message TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add passkey name column
  try {
    _db.run(sql`ALTER TABLE webauthn_credentials ADD COLUMN name TEXT`);
  } catch {
    // Column already exists
  }

  // Migration: add persisted credential ordering
  try {
    _db.run(sql`ALTER TABLE credentials ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  _db.run(sql`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) - 1 AS row_num
      FROM credentials
    )
    UPDATE credentials
    SET sort_order = (
      SELECT row_num
      FROM ordered
      WHERE ordered.id = credentials.id
    )
    WHERE sort_order = 0
      AND (SELECT coalesce(max(sort_order), 0) FROM credentials) = 0
      AND (SELECT count(*) FROM credentials) > 1
      AND EXISTS (
        SELECT 1
        FROM ordered
        WHERE ordered.id = credentials.id
          AND ordered.row_num <> 0
      )
  `);

  // Migration: add exclude from upgrade-all flag
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN exclude_from_upgrade_all INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }

  // Migration: add persisted system ordering
  try {
    _db.run(sql`ALTER TABLE systems ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  migrateSystemsConnectionUniqueness();
  _db.run(sql`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) - 1 AS row_num
      FROM systems
    )
    UPDATE systems
    SET sort_order = (
      SELECT row_num
      FROM ordered
      WHERE ordered.id = systems.id
    )
    WHERE sort_order = 0
      AND (SELECT coalesce(max(sort_order), 0) FROM systems) = 0
      AND (SELECT count(*) FROM systems) > 1
      AND EXISTS (
        SELECT 1
        FROM ordered
        WHERE ordered.id = systems.id
          AND ordered.row_num <> 0
      )
  `);

  // Migration: add persisted notification ordering
  try {
    _db.run(sql`ALTER TABLE notifications ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists
  }
  _db.run(sql`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY name, id) - 1 AS row_num
      FROM notifications
    )
    UPDATE notifications
    SET sort_order = (
      SELECT row_num
      FROM ordered
      WHERE ordered.id = notifications.id
    )
    WHERE sort_order = 0
      AND (SELECT coalesce(max(sort_order), 0) FROM notifications) = 0
      AND (SELECT count(*) FROM notifications) > 1
      AND EXISTS (
        SELECT 1
        FROM ordered
        WHERE ordered.id = notifications.id
          AND ordered.row_num <> 0
      )
  `);

  // Migration: strip ntfyPriority from ntfy notification configs (priority is now automatic)
  _db.run(sql`UPDATE notifications SET config = json_remove(config, '$.ntfyPriority')
    WHERE type = 'ntfy' AND json_extract(config, '$.ntfyPriority') IS NOT NULL`);

  // Cleanup: if the dashboard restarted mid-operation, SSH-safe upgrades are
  // expected to continue remotely and should show a warning instead of failure.
  _db.run(sql`UPDATE update_history
    SET status = CASE
      WHEN action IN ('upgrade_all', 'full_upgrade_all', 'upgrade_package') THEN 'warning'
      ELSE 'failed'
    END,
    completed_at = datetime('now'),
    output = CASE
      WHEN action IN ('upgrade_all', 'full_upgrade_all', 'upgrade_package')
        THEN 'Server restarted while operation was in progress'
      ELSE output
    END,
    error = CASE
      WHEN action IN ('upgrade_all', 'full_upgrade_all', 'upgrade_package')
        THEN NULL
      ELSE 'Server restarted while operation was in progress'
    END
    WHERE status = 'started'`);

  // Cleanup: remove obsolete settings
  _db.run(sql`DELETE FROM settings WHERE key IN ('check_flatpak', 'check_snap')`);

  // Migration: migrate old settings-based notifications to notifications table
  migrateNotificationSettings(_db);
  migrateLegacyCredentials(_db);

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

function migrateSystemsConnectionUniqueness(): void {
  if (!_sqlite) return;

  const tableDefinition = _sqlite
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'systems'")
    .get() as { sql?: string } | null;
  const hasLegacyConstraint =
    typeof tableDefinition?.sql === "string" &&
    /UNIQUE\s*\(\s*hostname\s*,\s*port\s*,\s*username\s*\)/i.test(tableDefinition.sql);

  if (hasLegacyConstraint) {
    rebuildSystemsTableWithoutLegacyConstraint(_sqlite);
  }

  _sqlite.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${SYSTEMS_CONNECTION_UNIQUE_INDEX}
     ON systems (hostname, port, username, COALESCE(proxy_jump_system_id, 0))`
  );
}

function rebuildSystemsTableWithoutLegacyConstraint(sqlite: Database): void {
  const systemsTableSql = `
    CREATE TABLE systems__new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      port INTEGER NOT NULL DEFAULT 22,
      credential_id INTEGER REFERENCES credentials(id) ON DELETE RESTRICT,
      proxy_jump_system_id INTEGER REFERENCES systems(id) ON DELETE RESTRICT,
      auth_type TEXT NOT NULL DEFAULT 'password',
      username TEXT NOT NULL,
      encrypted_password TEXT,
      encrypted_private_key TEXT,
      encrypted_key_passphrase TEXT,
      encrypted_sudo_password TEXT,
      host_key_verification_enabled INTEGER NOT NULL DEFAULT 1,
      trusted_host_key TEXT,
      trusted_host_key_algorithm TEXT,
      trusted_host_key_fingerprint_sha256 TEXT,
      host_key_trusted_at TEXT,
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
      exclude_from_upgrade_all INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      needs_reboot INTEGER NOT NULL DEFAULT 0,
      boot_id TEXT,
      system_info_updated_at TEXT,
      is_reachable INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_notified_hash TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `;
  const copiedColumns = [
    "id",
    "sort_order",
    "name",
    "hostname",
    "port",
    "credential_id",
    "proxy_jump_system_id",
    "auth_type",
    "username",
    "encrypted_password",
    "encrypted_private_key",
    "encrypted_key_passphrase",
    "encrypted_sudo_password",
    "host_key_verification_enabled",
    "trusted_host_key",
    "trusted_host_key_algorithm",
    "trusted_host_key_fingerprint_sha256",
    "host_key_trusted_at",
    "pkg_manager",
    "detected_pkg_managers",
    "disabled_pkg_managers",
    "os_name",
    "os_version",
    "kernel",
    "hostname_remote",
    "uptime",
    "arch",
    "cpu_cores",
    "memory",
    "disk",
    "exclude_from_upgrade_all",
    "hidden",
    "needs_reboot",
    "boot_id",
    "system_info_updated_at",
    "is_reachable",
    "last_seen_at",
    "created_at",
    "last_notified_hash",
    "updated_at",
  ].join(", ");

  sqlite.exec("PRAGMA foreign_keys=OFF");
  try {
    sqlite.exec("BEGIN");
    sqlite.exec(systemsTableSql);
    sqlite.exec(
      `INSERT INTO systems__new (${copiedColumns})
       SELECT ${copiedColumns} FROM systems`
    );
    sqlite.exec("DROP TABLE systems");
    sqlite.exec("ALTER TABLE systems__new RENAME TO systems");
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    sqlite.exec("PRAGMA foreign_keys=ON");
  }
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
  notifyOn.push("appUpdates");
  const notifyOnJson = JSON.stringify(Array.from(new Set(notifyOn)));

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

function migrateLegacyCredentials(db: BunSQLiteDatabase<typeof schema>): void {
  const systemRows = db.select().from(schema.systems).all();
  for (const system of systemRows) {
    if (system.credentialId) continue;

    let kind: "usernamePassword" | "sshKey" | null = null;
    const payload: Record<string, string> = {
      username: system.username,
    };

    if (system.authType === "password" && system.encryptedPassword) {
      kind = "usernamePassword";
      payload.password = normalizeSecretValue(system.encryptedPassword);
    } else if (system.authType === "key" && system.encryptedPrivateKey) {
      kind = "sshKey";
      payload.privateKey = normalizeSecretValue(system.encryptedPrivateKey);
      if (system.encryptedKeyPassphrase) {
        payload.passphrase = normalizeSecretValue(system.encryptedKeyPassphrase);
      }
    }

    if (!kind) continue;

    const result = db.insert(schema.credentials).values({
      name: `Migrated SSH credential: ${system.name}`,
      kind,
      payload: JSON.stringify(payload),
    }).returning({ id: schema.credentials.id }).get();

    db.update(schema.systems)
      .set({
        credentialId: result.id,
        encryptedPassword: null,
        encryptedPrivateKey: null,
        encryptedKeyPassphrase: null,
      })
      .where(eq(schema.systems.id, system.id))
      .run();
  }
}

function normalizeSecretValue(value: string): string {
  if (!value) return "";
  let encryptor;
  try {
    encryptor = getEncryptor();
  } catch {
    return value;
  }
  try {
    encryptor.decrypt(value);
    return value;
  } catch {
    return encryptor.encrypt(value);
  }
}

function migrateCredentialsTable(): void {
  if (!_sqlite) return;

  const columns = _sqlite
    .query("PRAGMA table_info(credentials)")
    .all() as Array<{ name?: string }>;

  if (!columns.some((column) => column.name === "usage_scopes")) return;

  _sqlite.exec("PRAGMA foreign_keys=OFF");
  _sqlite.exec(`
    CREATE TABLE credentials_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  _sqlite.exec(`
    INSERT INTO credentials_new (id, sort_order, name, kind, payload, created_at, updated_at)
    SELECT id, 0, name, kind, payload, created_at, updated_at
    FROM credentials
  `);
  _sqlite.exec("DROP TABLE credentials");
  _sqlite.exec("ALTER TABLE credentials_new RENAME TO credentials");
  _sqlite.exec("PRAGMA foreign_keys=ON");
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
