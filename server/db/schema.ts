import {
  type AnySQLiteColumn,
  sqliteTable,
  text,
  integer,
  real,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash"),
  totpSecret: text("totp_secret"),
  totpEnabled: integer("totp_enabled").notNull().default(0),
  lastTotpStep: integer("last_totp_step"),
  sessionVersion: integer("session_version").notNull().default(0),
  authProvider: text("auth_provider").notNull().default("password"),
  oidcIssuer: text("oidc_issuer"),
  oidcSubject: text("oidc_subject"),
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
  name: text("name"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const credentials = sqliteTable("credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sortOrder: integer("sort_order").notNull().default(0),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const systems = sqliteTable("systems", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sortOrder: integer("sort_order").notNull().default(0),
  name: text("name").notNull(),
  hostname: text("hostname").notNull(),
  port: integer("port").notNull().default(22),
  credentialId: integer("credential_id").references(() => credentials.id, {
    onDelete: "restrict",
  }),
  proxyJumpSystemId: integer("proxy_jump_system_id").references(
    (): AnySQLiteColumn => systems.id,
    {
      onDelete: "restrict",
    },
  ),
  authType: text("auth_type").notNull().default("password"),
  username: text("username").notNull(),
  encryptedPassword: text("encrypted_password"),
  encryptedPrivateKey: text("encrypted_private_key"),
  encryptedKeyPassphrase: text("encrypted_key_passphrase"),
  encryptedSudoPassword: text("encrypted_sudo_password"),
  hostKeyVerificationEnabled: integer("host_key_verification_enabled")
    .notNull()
    .default(1),
  trustedHostKey: text("trusted_host_key"),
  trustedHostKeyAlgorithm: text("trusted_host_key_algorithm"),
  trustedHostKeyFingerprintSha256: text("trusted_host_key_fingerprint_sha256"),
  hostKeyTrustedAt: text("host_key_trusted_at"),
  pkgManager: text("pkg_manager"),
  detectedPkgManagers: text("detected_pkg_managers"),
  disabledPkgManagers: text("disabled_pkg_managers"),
  pkgManagerConfigs: text("pkg_manager_configs"),
  autoHideKeptBackUpdates: integer("auto_hide_kept_back_updates")
    .notNull()
    .default(0),
  osId: text("os_id"),
  osIdLike: text("os_id_like"),
  osName: text("os_name"),
  osVersion: text("os_version"),
  osVersionCodename: text("os_version_codename"),
  kernel: text("kernel"),
  hostnameRemote: text("hostname_remote"),
  uptime: text("uptime"),
  uptimeSeconds: real("uptime_seconds"),
  arch: text("arch"),
  cpuCores: text("cpu_cores"),
  memory: text("memory"),
  disk: text("disk"),
  bootId: text("boot_id"),
  rebootDismissedBootId: text("reboot_dismissed_boot_id"),
  rebootDismissedUptimeSeconds: real("reboot_dismissed_uptime_seconds"),
  rebootDismissedAt: text("reboot_dismissed_at"),
  osLifecycleDismissedKey: text("os_lifecycle_dismissed_key"),
  osLifecycleDismissedAt: text("os_lifecycle_dismissed_at"),
  rootUserBannerDismissed: integer("root_user_banner_dismissed")
    .notNull()
    .default(0),
  rootUserBannerDismissedHostKeyFingerprintSha256: text(
    "root_user_banner_dismissed_host_key_fingerprint_sha256",
  ),
  excludeFromUpgradeAll: integer("exclude_from_upgrade_all")
    .notNull()
    .default(0),
  upgradeGroupId: integer("upgrade_group_id").references(
    (): AnySQLiteColumn => upgradeGroups.id,
    { onDelete: "set null" },
  ),
  upgradeOrder: integer("upgrade_order").notNull().default(1),
  hidden: integer("hidden").notNull().default(0),
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
});

export const upgradeGroups = sqliteTable("upgrade_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

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
    isKeptBack: integer("is_kept_back").notNull().default(0),
    cachedAt: text("cached_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [unique().on(table.systemId, table.pkgManager, table.packageName)],
);

export const installedPackageCache = sqliteTable(
  "installed_package_cache",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pkgManager: text("pkg_manager").notNull(),
    packageName: text("package_name").notNull(),
    currentVersion: text("current_version").notNull(),
    architecture: text("architecture"),
    repository: text("repository"),
    cachedAt: text("cached_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique().on(
      table.systemId,
      table.pkgManager,
      table.packageName,
      table.architecture,
    ),
  ],
);

export const hiddenUpdates = sqliteTable(
  "hidden_updates",
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
    isKeptBack: integer("is_kept_back").notNull().default(0),
    hideReason: text("hide_reason", { enum: ["manual", "kept_back"] })
      .notNull()
      .default("manual"),
    active: integer("active").notNull().default(1),
    lastMatchedAt: text("last_matched_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    inactiveSince: text("inactive_since"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique().on(
      table.systemId,
      table.pkgManager,
      table.packageName,
      table.newVersion,
    ),
  ],
);

export const packageManagerIssues = sqliteTable(
  "package_manager_issues",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pkgManager: text("pkg_manager").notNull(),
    issueKey: text("issue_key").notNull(),
    title: text("title").notNull(),
    message: text("message").notNull(),
    repairCommand: text("repair_command"),
    active: integer("active").notNull().default(1),
    dismissedBootId: text("dismissed_boot_id"),
    dismissedUptimeSeconds: real("dismissed_uptime_seconds"),
    dismissedAt: text("dismissed_at"),
    detectedAt: text("detected_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    lastSeenAt: text("last_seen_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [unique().on(table.systemId, table.pkgManager, table.issueKey)],
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
  steps: text("steps"),
  status: text("status").notNull(),
  output: text("output"),
  error: text("error"),
  startedAt: text("started_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  completedAt: text("completed_at"),
});

export const upgradeBatches = sqliteTable("upgrade_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status").notNull().default("queued"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

export const upgradeBatchItems = sqliteTable("upgrade_batch_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id")
    .notNull()
    .references(() => upgradeBatches.id, { onDelete: "cascade" }),
  systemId: integer("system_id")
    .notNull()
    .references(() => systems.id, { onDelete: "cascade" }),
  groupId: integer("group_id").references(() => upgradeGroups.id, {
    onDelete: "set null",
  }),
  groupSortOrder: integer("group_sort_order").notNull().default(0),
  systemSortOrder: integer("system_sort_order").notNull().default(0),
  defaultUpgradeModeOverride: text("default_upgrade_mode_override"),
  status: text("status").notNull().default("queued"),
  command: text("command"),
  pkgManager: text("pkg_manager").notNull().default("system"),
  historyId: integer("history_id").references(() => updateHistory.id, {
    onDelete: "set null",
  }),
  currentPkgManager: text("current_pkg_manager"),
  currentCommand: text("current_command"),
  remotePid: integer("remote_pid"),
  remoteLogFile: text("remote_log_file"),
  remoteExitFile: text("remote_exit_file"),
  remoteScriptFile: text("remote_script_file"),
  preUpgradeUpdateCount: integer("pre_upgrade_update_count"),
  error: text("error"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  startedAt: text("started_at"),
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

export const schedules = sqliteTable("schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sortOrder: integer("sort_order").notNull().default(0),
  name: text("name").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled").notNull().default(1),
  systemIds: text("system_ids"),
  config: text("config").notNull(),
  lastStartedAt: text("last_started_at"),
  lastRunAt: text("last_run_at"),
  lastRunStatus: text("last_run_status"),
  lastRunMessage: text("last_run_message"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const customPackageManagers = sqliteTable("custom_package_managers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  label: text("label").notNull(),
  parserConfig: text("parser_config"),
  configEntries: text("config_entries"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const customScripts = sqliteTable("custom_scripts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(),
  operation: text("operation").notNull(),
  pkgManager: text("pkg_manager"),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  steps: text("steps").notNull(),
  parserConfig: text("parser_config"),
  systemInfoConfig: text("system_info_config"),
  sourceScriptId: text("source_script_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const systemScriptOverrides = sqliteTable(
  "system_script_overrides",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    operationKey: text("operation_key").notNull(),
    scriptId: text("script_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [unique().on(table.systemId, table.operationKey)],
);

export const apiTokens = sqliteTable("api_tokens", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name"),
  tokenHash: text("token_hash").notNull().unique(),
  readOnly: integer("read_only").notNull().default(1),
  expiresAt: text("expires_at"),
  lastUsedAt: text("last_used_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sortOrder: integer("sort_order").notNull().default(0),
  name: text("name").notNull(),
  type: text("type").notNull(),
  enabled: integer("enabled").notNull().default(1),
  notifyOn: text("notify_on").notNull().default('["updates","appUpdates"]'),
  systemIds: text("system_ids"),
  config: text("config").notNull(),
  schedule: text("schedule"),
  pendingEvents: text("pending_events"),
  lastSentAt: text("last_sent_at"),
  lastAppVersionNotified: text("last_app_version_notified"),
  lastDeliveryStatus: text("last_delivery_status"),
  lastDeliveryAt: text("last_delivery_at"),
  lastDeliveryCode: integer("last_delivery_code"),
  lastDeliveryMessage: text("last_delivery_message"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const notificationDeliveredUpdates = sqliteTable(
  "notification_delivered_updates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    notificationId: integer("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    systemId: integer("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    pkgManager: text("pkg_manager").notNull(),
    packageName: text("package_name").notNull(),
    newVersion: text("new_version").notNull(),
    deliveredAt: text("delivered_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    unique().on(
      table.notificationId,
      table.systemId,
      table.pkgManager,
      table.packageName,
      table.newVersion,
    ),
  ],
);
