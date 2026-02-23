import {
  sqliteTable,
  text,
  integer,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash"),
  isAdmin: integer("is_admin").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const webauthnCredentials = sqliteTable("webauthn_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  signCount: integer("sign_count").notNull().default(0),
  transports: text("transports"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const systems = sqliteTable(
  "systems",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    port: integer("port").notNull().default(22),
    authType: text("auth_type").notNull().default("password"),
    username: text("username").notNull(),
    encryptedPassword: text("encrypted_password"),
    encryptedPrivateKey: text("encrypted_private_key"),
    encryptedKeyPassphrase: text("encrypted_key_passphrase"),
    encryptedSudoPassword: text("encrypted_sudo_password"),
    pkgManager: text("pkg_manager"),
    detectedPkgManagers: text("detected_pkg_managers"),
    disabledPkgManagers: text("disabled_pkg_managers"),
    osName: text("os_name"),
    osVersion: text("os_version"),
    kernel: text("kernel"),
    hostnameRemote: text("hostname_remote"),
    uptime: text("uptime"),
    arch: text("arch"),
    cpuCores: text("cpu_cores"),
    memory: text("memory"),
    disk: text("disk"),
    needsReboot: integer("needs_reboot").notNull().default(0),
    systemInfoUpdatedAt: text("system_info_updated_at"),
    isReachable: integer("is_reachable").notNull().default(0),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    lastNotifiedHash: text("last_notified_hash"),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [unique().on(table.hostname, table.port, table.username)]
);

export const updateCache = sqliteTable(
  "update_cache",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pkgManager: text("pkg_manager").notNull(),
    packageName: text("package_name").notNull(),
    currentVersion: text("current_version"),
    newVersion: text("new_version").notNull(),
    architecture: text("architecture"),
    repository: text("repository"),
    isSecurity: integer("is_security").notNull().default(0),
    cachedAt: text("cached_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique().on(table.systemId, table.pkgManager, table.packageName),
  ]
);

export const updateHistory = sqliteTable("update_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  systemId: integer("system_id")
    .notNull()
    .references(() => systems.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  pkgManager: text("pkg_manager").notNull(),
  packageCount: integer("package_count"),
  packages: text("packages"),
  command: text("command"),
  status: text("status").notNull(),
  output: text("output"),
  error: text("error"),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  description: text("description"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled").notNull().default(1),
  notifyOn: text("notify_on")
    .notNull()
    .default('["updates"]'),
  systemIds: text("system_ids"),
  config: text("config").notNull(),
  schedule: text("schedule"),
  pendingEvents: text("pending_events"),
  lastSentAt: text("last_sent_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});
