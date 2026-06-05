import Database from "better-sqlite3";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_ENCRYPTION_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const dbPath = process.env.LUDASH_DB_PATH || "/tmp/ludash-screenshots/dashboard.db";
const encryptionKey = process.env.LUDASH_ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY;

mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
const encryptionKeyBuffer = Buffer.from(encryptionKey, "base64");

if (encryptionKeyBuffer.length !== 32) {
  throw new Error("LUDASH_ENCRYPTION_KEY must be a base64-encoded 32-byte key for screenshot seeding.");
}

function encryptSecret(plaintext) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", encryptionKeyBuffer, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

const now = "2026-06-05 10:30:00";
const recent = "2026-06-05 10:18:00";
const older = "2026-06-05 08:45:00";

db.pragma("foreign_keys = OFF");

const tables = [
  "system_script_overrides",
  "custom_scripts",
  "custom_package_managers",
  "notification_delivered_updates",
  "notifications",
  "schedules",
  "api_tokens",
  "upgrade_batch_items",
  "upgrade_batches",
  "update_history",
  "package_manager_issues",
  "hidden_updates",
  "installed_package_cache",
  "update_cache",
  "systems",
  "upgrade_groups",
  "credentials",
];

for (const table of tables) {
  db.prepare(`DELETE FROM ${table}`).run();
  db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(table);
}

const insertCredential = db.prepare(`
  INSERT INTO credentials (id, sort_order, name, kind, payload, created_at, updated_at)
  VALUES (@id, @sortOrder, @name, @kind, @payload, @createdAt, @updatedAt)
`);

insertCredential.run({
  id: 1,
  sortOrder: 1,
  name: "Ops SSH Key",
  kind: "sshKey",
  payload: JSON.stringify({
    username: "ops",
    privateKey: encryptSecret("README demo private key"),
    passphrase: encryptSecret("demo-passphrase"),
  }),
  createdAt: older,
  updatedAt: recent,
});
insertCredential.run({
  id: 2,
  sortOrder: 2,
  name: "Root Password Fallback",
  kind: "usernamePassword",
  payload: JSON.stringify({ username: "root", password: encryptSecret("demo-root-password") }),
  createdAt: older,
  updatedAt: recent,
});
insertCredential.run({
  id: 3,
  sortOrder: 3,
  name: "Build Farm Certificate",
  kind: "certificate",
  payload: JSON.stringify({
    username: "deploy",
    certificatePem: encryptSecret("README demo certificate"),
    privateKeyPem: encryptSecret("README demo certificate key"),
  }),
  createdAt: older,
  updatedAt: recent,
});

db.prepare(`
  INSERT INTO upgrade_groups (id, name, sort_order, created_at, updated_at)
  VALUES (1, 'Core Services', 1, @now, @now), (2, 'Edge Nodes', 2, @now, @now)
`).run({ now });

const insertSystem = db.prepare(`
  INSERT INTO systems (
    id, sort_order, name, hostname, port, credential_id, auth_type, username,
    host_key_verification_enabled, trusted_host_key, trusted_host_key_algorithm,
    trusted_host_key_fingerprint_sha256, host_key_trusted_at, pkg_manager,
    detected_pkg_managers, disabled_pkg_managers, pkg_manager_configs,
    auto_hide_kept_back_updates, os_name, os_version, kernel, hostname_remote,
    uptime, uptime_seconds, arch, cpu_cores, memory, disk, boot_id,
    exclude_from_upgrade_all, upgrade_group_id, upgrade_order, hidden,
    needs_reboot, system_info_updated_at, is_reachable, last_seen_at,
    created_at, updated_at
  ) VALUES (
    @id, @sortOrder, @name, @hostname, 22, @credentialId, @authType, @username,
    @hostKeyVerificationEnabled, @trustedHostKey, @trustedHostKeyAlgorithm,
    @trustedHostKeyFingerprintSha256, @hostKeyTrustedAt, @pkgManager,
    @detectedPkgManagers, @disabledPkgManagers, @pkgManagerConfigs,
    @autoHideKeptBackUpdates, @osName, @osVersion, @kernel, @hostnameRemote,
    @uptime, @uptimeSeconds, @arch, @cpuCores, @memory, @disk, @bootId,
    @excludeFromUpgradeAll, @upgradeGroupId, @upgradeOrder, @hidden,
    @needsReboot, @systemInfoUpdatedAt, @isReachable, @lastSeenAt,
    @createdAt, @updatedAt
  )
`);

const hostKey = "AAAAC3NzaC1lZDI1NTE5AAAAIDemoHostKeyForReadmeScreenshotsOnly";
const baseSystem = {
  authType: "key",
  hostKeyVerificationEnabled: 1,
  trustedHostKey: hostKey,
  trustedHostKeyAlgorithm: "ssh-ed25519",
  trustedHostKeyFingerprintSha256: "SHA256:demoReadmeScreenshotFingerprint",
  hostKeyTrustedAt: older,
  disabledPkgManagers: JSON.stringify([]),
  autoHideKeptBackUpdates: 0,
  excludeFromUpgradeAll: 0,
  hidden: 0,
  systemInfoUpdatedAt: recent,
  createdAt: older,
  updatedAt: recent,
};

[
  {
    id: 1,
    sortOrder: 1,
    name: "web-01",
    hostname: "web-01.lan",
    credentialId: 2,
    authType: "password",
    username: "root",
    pkgManager: "apt",
    detectedPkgManagers: JSON.stringify(["apt", "snap"]),
    pkgManagerConfigs: JSON.stringify({ apt: { defaultUpgradeMode: "full-upgrade", autoHideKeptBackUpdates: true } }),
    osName: "Ubuntu",
    osVersion: "24.04 LTS",
    kernel: "6.8.0-55-generic",
    hostnameRemote: "web-01",
    uptime: "18 days, 4 hours",
    uptimeSeconds: 1576800,
    arch: "x86_64",
    cpuCores: "4",
    memory: "7.7 GiB",
    disk: "68% of 120 GiB",
    bootId: "boot-web-01",
    upgradeGroupId: 1,
    upgradeOrder: 1,
    needsReboot: 1,
    isReachable: 1,
    lastSeenAt: recent,
  },
  {
    id: 2,
    sortOrder: 2,
    name: "db-01",
    hostname: "db-01.lan",
    credentialId: 1,
    username: "ops",
    pkgManager: "dnf",
    detectedPkgManagers: JSON.stringify(["dnf", "flatpak"]),
    pkgManagerConfigs: JSON.stringify({ dnf: { defaultUpgradeMode: "distro-sync", refreshMetadataOnCheck: true } }),
    osName: "Fedora Server",
    osVersion: "41",
    kernel: "6.11.7-300.fc41.x86_64",
    hostnameRemote: "db-01",
    uptime: "5 days, 9 hours",
    uptimeSeconds: 464400,
    arch: "x86_64",
    cpuCores: "8",
    memory: "31.2 GiB",
    disk: "41% of 500 GiB",
    bootId: "boot-db-01",
    upgradeGroupId: 1,
    upgradeOrder: 2,
    needsReboot: 0,
    isReachable: 1,
    lastSeenAt: recent,
  },
  {
    id: 3,
    sortOrder: 3,
    name: "edge-arch",
    hostname: "edge-arch.lan",
    credentialId: 3,
    username: "deploy",
    pkgManager: "pacman",
    detectedPkgManagers: JSON.stringify(["pacman"]),
    pkgManagerConfigs: JSON.stringify({ pacman: { refreshDatabasesOnCheck: true } }),
    osName: "Arch Linux",
    osVersion: "rolling",
    kernel: "6.12.8-arch1-1",
    hostnameRemote: "edge-arch",
    uptime: "2 days, 11 hours",
    uptimeSeconds: 212400,
    arch: "x86_64",
    cpuCores: "4",
    memory: "15.5 GiB",
    disk: "53% of 240 GiB",
    bootId: "boot-edge-arch",
    upgradeGroupId: 2,
    upgradeOrder: 1,
    needsReboot: 0,
    isReachable: 1,
    lastSeenAt: recent,
  },
  {
    id: 4,
    sortOrder: 4,
    name: "backup-alpine",
    hostname: "backup-alpine.lan",
    credentialId: 2,
    authType: "password",
    username: "root",
    hostKeyVerificationEnabled: 0,
    trustedHostKey: null,
    trustedHostKeyAlgorithm: null,
    trustedHostKeyFingerprintSha256: null,
    hostKeyTrustedAt: null,
    pkgManager: "apk",
    detectedPkgManagers: JSON.stringify(["apk"]),
    pkgManagerConfigs: JSON.stringify({ apk: { refreshIndexesOnCheck: true } }),
    osName: "Alpine Linux",
    osVersion: "3.21",
    kernel: "6.6.62-0-lts",
    hostnameRemote: "backup-alpine",
    uptime: "42 days, 1 hour",
    uptimeSeconds: 3632400,
    arch: "x86_64",
    cpuCores: "2",
    memory: "3.8 GiB",
    disk: "72% of 80 GiB",
    bootId: "boot-backup",
    upgradeGroupId: 2,
    upgradeOrder: 2,
    needsReboot: 0,
    isReachable: 0,
    lastSeenAt: "2026-06-05 06:40:00",
  },
].forEach((system) => insertSystem.run({ ...baseSystem, ...system }));

const insertUpdate = db.prepare(`
  INSERT INTO update_cache (
    system_id, pkg_manager, package_name, current_version, new_version,
    architecture, repository, is_security, is_kept_back, cached_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

[
  [1, "apt", "openssl", "3.0.13-0ubuntu3.4", "3.0.13-0ubuntu3.5", "amd64", "noble-security", 1, 0, recent],
  [1, "apt", "linux-image-generic", "6.8.0-54.56", "6.8.0-55.57", "amd64", "noble-updates", 0, 0, recent],
  [1, "apt", "containerd.io", "1.7.24-1", "1.7.27-1", "amd64", "docker", 0, 1, recent],
  [1, "snap", "core22", "20250530", "20250602", "amd64", "latest/stable", 0, 0, recent],
  [2, "dnf", "postgresql16-server", "16.8-1.fc41", "16.9-1.fc41", "x86_64", "updates", 0, 0, recent],
  [2, "dnf", "kernel-core", "6.11.7-300.fc41", "6.11.10-300.fc41", "x86_64", "updates", 1, 0, recent],
  [3, "pacman", "systemd", "257.6-1", "257.7-1", "x86_64", "core", 0, 0, recent],
  [3, "pacman", "openssh", "9.9p1-2", "10.0p1-1", "x86_64", "core", 1, 0, recent],
].forEach((row) => insertUpdate.run(...row));

const insertInstalled = db.prepare(`
  INSERT INTO installed_package_cache (
    system_id, pkg_manager, package_name, current_version, architecture, repository, cached_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);
[
  [1, "apt", "nginx", "1.24.0-2ubuntu7.3", "amd64", "noble-updates", recent],
  [1, "apt", "docker-ce", "5:27.5.1-1~ubuntu.24.04~noble", "amd64", "docker", recent],
  [1, "apt", "openssh-server", "1:9.6p1-3ubuntu13.9", "amd64", "noble-security", recent],
  [1, "snap", "lxd", "5.21.3", "amd64", "latest/stable", recent],
  [2, "dnf", "postgresql16-server", "16.8-1.fc41", "x86_64", "updates", recent],
  [2, "dnf", "podman", "5.3.1-1.fc41", "x86_64", "updates", recent],
  [3, "pacman", "linux", "6.12.8.arch1-1", "x86_64", "core", recent],
].forEach((row) => insertInstalled.run(...row));

db.prepare(`
  INSERT INTO hidden_updates (
    system_id, pkg_manager, package_name, current_version, new_version,
    architecture, repository, is_security, is_kept_back, active, last_matched_at,
    created_at, updated_at
  ) VALUES (1, 'apt', 'libreoffice-core', '4:24.2.7-0ubuntu0.24.04.1', '4:24.2.8-0ubuntu0.24.04.1',
    'amd64', 'noble-updates', 0, 1, 1, @recent, @older, @recent)
`).run({ recent, older });

const insertHistory = db.prepare(`
  INSERT INTO update_history (
    system_id, action, pkg_manager, package_count, packages, command, steps,
    status, output, error, started_at, completed_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

insertHistory.run(
  1,
  "check",
  "system",
  4,
  JSON.stringify(["openssl", "linux-image-generic", "containerd.io", "core22"]),
  "ludash refresh",
  JSON.stringify([
    { label: "APT update", pkgManager: "apt", command: "apt-get update", output: "Fetched package indexes", error: null, status: "success", startedAt: "2026-06-05 10:17:12", completedAt: "2026-06-05 10:17:29" },
    { label: "APT list upgrades", pkgManager: "apt", command: "apt list --upgradable", output: "openssl/noble-security ...\nlinux-image-generic/noble-updates ...", error: null, status: "warning", startedAt: "2026-06-05 10:17:30", completedAt: "2026-06-05 10:17:42" },
  ]),
  "success",
  "4 updates found; one kept-back package was hidden.",
  null,
  "2026-06-05 10:17:12",
  "2026-06-05 10:17:42",
);
insertHistory.run(
  2,
  "check",
  "system",
  2,
  JSON.stringify(["postgresql16-server", "kernel-core"]),
  "ludash refresh",
  JSON.stringify([{ label: "DNF check-update", pkgManager: "dnf", command: "dnf check-update", output: "postgresql16-server.x86_64\nkernel-core.x86_64", error: null, status: "success" }]),
  "success",
  "2 updates found.",
  null,
  "2026-06-05 10:12:00",
  "2026-06-05 10:12:18",
);
insertHistory.run(
  4,
  "check",
  "system",
  0,
  JSON.stringify([]),
  "ludash refresh",
  null,
  "failed",
  null,
  "SSH connection timed out after 30 seconds.",
  "2026-06-05 06:39:40",
  "2026-06-05 06:40:10",
);

const insertSchedule = db.prepare(`
  INSERT INTO schedules (
    id, sort_order, name, type, enabled, system_ids, config,
    last_started_at, last_run_at, last_run_status, last_run_message, created_at, updated_at
  ) VALUES (@id, @sortOrder, @name, @type, @enabled, @systemIds, @config,
    @lastStartedAt, @lastRunAt, @lastRunStatus, @lastRunMessage, @createdAt, @updatedAt)
`);

insertSchedule.run({
  id: 1,
  sortOrder: 1,
  name: "Refresh every 30 minutes",
  type: "refresh",
  enabled: 0,
  systemIds: null,
  config: JSON.stringify({ cron: "*/30 * * * *", cacheDurationHours: 6 }),
  lastStartedAt: "2026-06-05 10:00:00",
  lastRunAt: "2026-06-05 10:01:07",
  lastRunStatus: "success",
  lastRunMessage: "Refreshed 4 systems",
  createdAt: older,
  updatedAt: recent,
});
insertSchedule.run({
  id: 2,
  sortOrder: 2,
  name: "Sunday maintenance window",
  type: "update",
  enabled: 1,
  systemIds: JSON.stringify([1, 2, 3]),
  config: JSON.stringify({ cron: "0 3 * * 0" }),
  lastStartedAt: "2026-06-01 03:00:00",
  lastRunAt: "2026-06-01 03:22:10",
  lastRunStatus: "warning",
  lastRunMessage: "web-01 requires reboot",
  createdAt: older,
  updatedAt: recent,
});
insertSchedule.run({
  id: 3,
  sortOrder: 3,
  name: "Monday digest",
  type: "notification_digest",
  enabled: 1,
  systemIds: null,
  config: JSON.stringify({ cron: "0 9 * * 1", notificationIds: [1, 2] }),
  lastStartedAt: "2026-06-01 09:00:00",
  lastRunAt: "2026-06-01 09:00:03",
  lastRunStatus: "success",
  lastRunMessage: "Sent 2 notification digests",
  createdAt: older,
  updatedAt: recent,
});

const insertNotification = db.prepare(`
  INSERT INTO notifications (
    id, sort_order, name, type, enabled, notify_on, system_ids, config, schedule,
    last_sent_at, last_delivery_status, last_delivery_at, last_delivery_code,
    last_delivery_message, created_at, updated_at
  ) VALUES (@id, @sortOrder, @name, @type, @enabled, @notifyOn, @systemIds, @config, @schedule,
    @lastSentAt, @lastDeliveryStatus, @lastDeliveryAt, @lastDeliveryCode,
    @lastDeliveryMessage, @createdAt, @updatedAt)
`);

insertNotification.run({
  id: 1,
  sortOrder: 1,
  name: "Ops Email",
  type: "email",
  enabled: 1,
  notifyOn: JSON.stringify(["updates", "unreachable", "appUpdates"]),
  systemIds: null,
  config: JSON.stringify({ smtpHost: "smtp.example.lan", smtpPort: "587", smtpUser: "ludash", smtpPassword: "(stored)", from: "updates@example.lan", to: "ops@example.lan", smtpTlsMode: "starttls" }),
  schedule: null,
  lastSentAt: "2026-06-05 10:01:08",
  lastDeliveryStatus: "success",
  lastDeliveryAt: "2026-06-05 10:01:09",
  lastDeliveryCode: 250,
  lastDeliveryMessage: "Queued as 7F3B20C",
  createdAt: older,
  updatedAt: recent,
});
insertNotification.run({
  id: 2,
  sortOrder: 2,
  name: "Home Assistant MQTT",
  type: "mqtt",
  enabled: 1,
  notifyOn: JSON.stringify(["updates", "appUpdates"]),
  systemIds: JSON.stringify([1, 2, 3]),
  config: JSON.stringify({ brokerUrl: "mqtt://homeassistant.local:1883", username: "ludash", password: "(stored)", clientId: "ludash", keepaliveSeconds: 60, connectTimeoutMs: 10000, qos: 1, publishEvents: true, topic: "ludash/events", retainEvents: false, homeAssistantEnabled: true, deviceName: "Linux Update Dashboard", discoveryPrefix: "homeassistant", baseTopic: "ludash", publishAppEntity: true, commandsEnabled: true, payloadInstall: "INSTALL" }),
  schedule: null,
  lastSentAt: "2026-06-05 10:01:08",
  lastDeliveryStatus: "success",
  lastDeliveryAt: "2026-06-05 10:01:09",
  lastDeliveryCode: null,
  lastDeliveryMessage: "Published 4 retained discovery entities",
  createdAt: older,
  updatedAt: recent,
});
insertNotification.run({
  id: 3,
  sortOrder: 3,
  name: "Critical Webhook",
  type: "webhook",
  enabled: 0,
  notifyOn: JSON.stringify(["unreachable"]),
  systemIds: JSON.stringify([4]),
  config: JSON.stringify({ preset: "custom", method: "POST", url: "https://hooks.example.lan/ludash", query: [], headers: [], auth: { mode: "bearer", token: "(stored)" }, body: { mode: "json", template: "{\"text\": {{event.titleJson}}}" }, timeoutMs: 10000, retryAttempts: 2, retryDelayMs: 1000, allowInsecureTls: false }),
  schedule: "immediate",
  lastSentAt: null,
  lastDeliveryStatus: "failed",
  lastDeliveryAt: "2026-06-05 06:40:14",
  lastDeliveryCode: 503,
  lastDeliveryMessage: "Service unavailable during maintenance",
  createdAt: older,
  updatedAt: recent,
});

db.prepare(`
  INSERT INTO custom_package_managers (id, name, label, parser_config, config_entries, created_at, updated_at)
  VALUES (
    1,
    'zypper_custom',
    'Zypper Custom',
    @parserConfig,
    @configEntries,
    @older,
    @recent
  )
`).run({
  parserConfig: JSON.stringify({ updateRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$", successExitCodes: [0, 100] }),
  configEntries: JSON.stringify([{ key: "refreshReposOnCheck", label: "Refresh repositories on check", type: "boolean", defaultValue: true }]),
  older,
  recent,
});

db.prepare(`
  INSERT INTO custom_scripts (
    id, name, description, type, operation, pkg_manager, is_default, steps,
    parser_config, system_info_config, source_script_id, created_at, updated_at
  ) VALUES (
    1,
    'APT check with local mirror warmup',
    'Refreshes an internal mirror before parsing APT upgrade output.',
    'package_manager',
    'check_updates',
    'apt',
    0,
    @steps,
    NULL,
    NULL,
    'builtin:apt/check_updates',
    @older,
    @recent
  )
`).run({
  steps: JSON.stringify([
    { label: "Warm mirror", command: "curl -fsS http://apt-cache.lan/prewarm?host={{manager}}" },
    { label: "APT update", command: "{{sudo:apt-get update}} 2>&1" },
    { label: "List upgrades", command: "apt list --upgradable 2>/dev/null" },
  ]),
  older,
  recent,
});

db.prepare(`
  INSERT INTO system_script_overrides (system_id, operation_key, script_id, created_at, updated_at)
  VALUES (1, 'apt/check_updates', 'custom:1', @older, @recent)
`).run({ older, recent });

db.pragma("foreign_keys = ON");
db.close();
