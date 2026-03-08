import { eq, and, isNotNull } from "drizzle-orm";
import { createHash } from "crypto";
import { Cron } from "croner";
import { getDb } from "../db";
import { notifications, systems, updateCache } from "../db/schema";
import { getProvider, type NotificationPayload } from "./notifications";
import { getEncryptor } from "../security";
import {
  getAppUpdateStatus,
} from "./app-update-service";

const DEFAULT_NOTIFY_ON = ["updates", "appUpdates"] as const;
const DEFAULT_NOTIFY_ON_JSON = JSON.stringify(DEFAULT_NOTIFY_ON);

// Sensitive config keys that need encryption per provider type
const SENSITIVE_KEYS: Record<string, string[]> = {
  email: ["smtpPassword"],
  gotify: ["gotifyToken"],
  ntfy: ["ntfyToken"],
};
const ALLOWED_CONFIG_KEYS: Record<string, string[]> = {
  email: [
    "smtpHost",
    "smtpPort",
    "smtpSecure",
    "smtpUser",
    "smtpPassword",
    "smtpFrom",
    "emailTo",
    "emailImportanceOverride",
  ],
  gotify: [
    "gotifyUrl",
    "gotifyToken",
    "gotifyPriorityOverride",
  ],
  ntfy: [
    "ntfyUrl",
    "ntfyTopic",
    "ntfyToken",
    "ntfyPriorityOverride",
  ],
};

function getSensitiveKeys(type: string): string[] {
  return SENSITIVE_KEYS[type] || [];
}

function parseConfig(configJson: string): Record<string, string> {
  try {
    return JSON.parse(configJson);
  } catch {
    return {};
  }
}

export function sanitizeNotificationConfig(
  type: string,
  config: Record<string, string>
): Record<string, string> {
  const allowedKeys = ALLOWED_CONFIG_KEYS[type];
  if (!allowedKeys) return { ...config };

  return Object.fromEntries(
    Object.entries(config).filter(([key]) => allowedKeys.includes(key))
  );
}

export function mergeStoredSensitiveConfig(
  type: string,
  storedConfig: Record<string, string>,
  incomingConfig: Record<string, string>
): Record<string, string> {
  const sanitizedStored = sanitizeNotificationConfig(type, storedConfig);
  const merged = sanitizeNotificationConfig(type, {
    ...sanitizedStored,
    ...incomingConfig,
  });

  for (const key of getSensitiveKeys(type)) {
    if (merged[key] === "(stored)") {
      merged[key] = sanitizedStored[key] || "";
    }
  }

  return merged;
}

function loadSanitizedConfig(row: { id: number; type: string; config: string }): Record<string, string> {
  const parsed = parseConfig(row.config);
  const sanitized = sanitizeNotificationConfig(row.type, parsed);

  if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
    getDb()
      .update(notifications)
      .set({ config: JSON.stringify(sanitized) })
      .where(eq(notifications.id, row.id))
      .run();
  }

  return sanitized;
}

function maskConfig(type: string, config: Record<string, string>): Record<string, string> {
  const sensitive = SENSITIVE_KEYS[type] || [];
  const masked = { ...config };
  for (const key of sensitive) {
    if (masked[key]) masked[key] = "(stored)";
  }
  return masked;
}

function encryptConfig(type: string, config: Record<string, string>): Record<string, string> {
  const sensitive = SENSITIVE_KEYS[type] || [];
  const encrypted = { ...config };
  const enc = getEncryptor();
  for (const key of sensitive) {
    if (encrypted[key] && encrypted[key] !== "(stored)") {
      encrypted[key] = enc.encrypt(encrypted[key]);
    }
  }
  return encrypted;
}

function isScheduled(schedule: string | null): boolean {
  return schedule !== null && schedule !== "immediate";
}

function getDefaultNotifyOn(): string[] {
  return [...DEFAULT_NOTIFY_ON];
}

function serializeNotification(row: any) {
  const config = loadSanitizedConfig(row);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    notifyOn: JSON.parse(row.notifyOn || DEFAULT_NOTIFY_ON_JSON),
    systemIds: row.systemIds ? JSON.parse(row.systemIds) : null,
    config: maskConfig(row.type, config),
    schedule: row.schedule || null,
    lastSentAt: row.lastSentAt || null,
    lastAppVersionNotified: row.lastAppVersionNotified || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// --- CRUD ---

export function listNotifications() {
  const db = getDb();
  const rows = db.select().from(notifications).all();
  return rows.map(serializeNotification);
}

export function getNotification(id: number) {
  const db = getDb();
  const row = db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!row) return null;
  return serializeNotification(row);
}

export function createNotification(data: {
  name: string;
  type: string;
  enabled?: boolean;
  notifyOn?: string[];
  systemIds?: number[] | null;
  config: Record<string, string>;
  schedule?: string | null;
}) {
  const db = getDb();
  const encConfig = encryptConfig(
    data.type,
    sanitizeNotificationConfig(data.type, data.config)
  );
  const schedule = data.schedule === "immediate" ? null : (data.schedule || null);
  const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  const result = db.insert(notifications).values({
    name: data.name,
    type: data.type,
    enabled: data.enabled !== false ? 1 : 0,
    notifyOn: JSON.stringify(data.notifyOn || getDefaultNotifyOn()),
    systemIds: data.systemIds ? JSON.stringify(data.systemIds) : null,
    config: JSON.stringify(encConfig),
    schedule,
    lastSentAt: schedule ? now : null,
  }).returning({ id: notifications.id }).get();
  return result.id;
}

export function updateNotification(
  id: number,
  data: {
    name?: string;
    type?: string;
    enabled?: boolean;
    notifyOn?: string[];
    systemIds?: number[] | null;
    config?: Record<string, string>;
    schedule?: string | null;
  }
) {
  const db = getDb();
  const existing = db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!existing) return false;

  const updates: Record<string, any> = {
    updatedAt: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""),
  };

  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
  if (data.notifyOn !== undefined) updates.notifyOn = JSON.stringify(data.notifyOn);
  if (data.systemIds !== undefined) updates.systemIds = data.systemIds ? JSON.stringify(data.systemIds) : null;

  if (data.schedule !== undefined) {
    const newSchedule = data.schedule === "immediate" ? null : (data.schedule || null);
    const oldSchedule = existing.schedule;
    updates.schedule = newSchedule;
    // Clear pending events when schedule changes; anchor lastSentAt to now
    // so the first digest waits for the next cron occurrence instead of firing immediately
    if (newSchedule !== oldSchedule) {
      updates.pendingEvents = null;
      updates.lastSentAt = newSchedule
        ? new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "")
        : null;
    }
  }

  if (data.config) {
    const type = data.type || existing.type;
    const existingConfig = sanitizeNotificationConfig(existing.type, parseConfig(existing.config));
    const sensitive = SENSITIVE_KEYS[type] || [];
    const mergedConfig = sanitizeNotificationConfig(type, { ...existingConfig, ...data.config });

    // Encrypt new config values first (skips "(stored)" sentinel)
    const encConfig = encryptConfig(type, mergedConfig);

    // Restore existing encrypted values for unchanged sensitive fields
    for (const key of sensitive) {
      if (mergedConfig[key] === "(stored)") {
        encConfig[key] = existingConfig[key] || "";
      }
    }

    updates.config = JSON.stringify(encConfig);
  }

  db.update(notifications).set(updates).where(eq(notifications.id, id)).run();
  return true;
}

export function deleteNotification(id: number) {
  const db = getDb();
  const existing = db.select({ id: notifications.id }).from(notifications).where(eq(notifications.id, id)).get();
  if (!existing) return false;
  db.delete(notifications).where(eq(notifications.id, id)).run();
  return true;
}

// --- Test notification ---

export async function testNotification(id: number): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const row = db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!row) return { success: false, error: "Notification not found" };

  const config = loadSanitizedConfig(row);
  return testNotificationConfig(row.type, config, row.name);
}

export async function testNotificationConfig(
  type: string,
  config: Record<string, string>,
  name?: string,
): Promise<{ success: boolean; error?: string }> {
  const provider = getProvider(type);
  if (!provider) return { success: false, error: `Unknown provider: ${type}` };

  const configError = provider.validateConfig(config);
  if (configError) return { success: false, error: configError };

  const payload: NotificationPayload = {
    title: "Test Notification",
    body: `This is a test notification from Linux Update Dashboard.${name ? `\nChannel: ${name}` : ""}`,
    priority: "default",
    tags: ["white_check_mark"],
  };

  try {
    return await provider.send(payload, config);
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// --- Hash computation for deduplication ---

function computeUpdateHash(systemId: number): string {
  const db = getDb();
  const updates = db
    .select()
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .orderBy(updateCache.packageName)
    .all();

  if (updates.length === 0) return "empty";

  const packageNames = updates.map((u) => u.packageName).sort();
  const securityCount = updates.filter((u) => u.isSecurity).length;
  const raw = `${updates.length}:${securityCount}:${packageNames.join(",")}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// --- Core: process results after a scheduled check ---

export interface CheckResult {
  systemId: number;
  systemName: string;
  updateCount: number;
  securityCount: number;
  previouslyReachable: boolean;
  nowUnreachable: boolean;
}

export interface AppUpdateEvent {
  currentVersion: string | null;
  currentBranch: string;
  remoteVersion: string;
  releaseUrl: string | null;
  repoUrl: string | null;
}

export async function processScheduledResults(
  results: CheckResult[]
): Promise<void> {
  const db = getDb();

  // Get all enabled notification channels
  const channels = db
    .select()
    .from(notifications)
    .where(eq(notifications.enabled, 1))
    .all();

  if (channels.length === 0) return;

  // Dedup: figure out which systems have changed
  const updatesChanged: CheckResult[] = [];
  const unreachableChanged: CheckResult[] = [];

  for (const result of results) {
    if (result.updateCount > 0) {
      const currentHash = computeUpdateHash(result.systemId);
      const system = db
        .select({ lastNotifiedHash: systems.lastNotifiedHash })
        .from(systems)
        .where(eq(systems.id, result.systemId))
        .get();

      if (currentHash !== system?.lastNotifiedHash) {
        updatesChanged.push(result);
        db.update(systems)
          .set({ lastNotifiedHash: currentHash })
          .where(eq(systems.id, result.systemId))
          .run();
      }
    }

    if (result.nowUnreachable && result.previouslyReachable) {
      unreachableChanged.push(result);
    }
  }

  if (updatesChanged.length === 0 && unreachableChanged.length === 0) return;

  // Dispatch to each enabled notification channel
  for (const channel of channels) {
    const notifyOn: string[] = (() => {
      try { return JSON.parse(channel.notifyOn || JSON.stringify(getDefaultNotifyOn())); } catch { return getDefaultNotifyOn(); }
    })();
    const scopedSystemIds: number[] | null = (() => {
      try { return channel.systemIds ? JSON.parse(channel.systemIds) : null; } catch { return null; }
    })();

    // Filter results by this channel's system scope
    const filterByScope = (r: CheckResult) =>
      scopedSystemIds === null || scopedSystemIds.includes(r.systemId);

    const channelUpdates = notifyOn.includes("updates")
      ? updatesChanged.filter(filterByScope)
      : [];
    const channelUnreachable = notifyOn.includes("unreachable")
      ? unreachableChanged.filter(filterByScope)
      : [];

    if (channelUpdates.length === 0 && channelUnreachable.length === 0) continue;

    // Scheduled channels: buffer events for later digest
    if (isScheduled(channel.schedule)) {
      appendPendingEvents(channel.id, channelUpdates, channelUnreachable);
      continue;
    }

    // Immediate channels: send right away
    await sendChannelNotification(channel, channelUpdates, channelUnreachable);
  }
}

export async function processAppUpdateNotifications(): Promise<void> {
  const db = getDb();
  const channels = db
    .select()
    .from(notifications)
    .where(eq(notifications.enabled, 1))
    .all();

  if (channels.length === 0) return;

  const subscribedChannels = channels.filter((channel) => {
    try {
      const notifyOn = JSON.parse(channel.notifyOn || DEFAULT_NOTIFY_ON_JSON);
      return Array.isArray(notifyOn) && notifyOn.includes("appUpdates");
    } catch {
      return false;
    }
  });

  if (subscribedChannels.length === 0) return;

  const status = await getAppUpdateStatus();
  if (!status.updateAvailable || !status.remoteVersion) return;

  const event: AppUpdateEvent = {
    currentVersion: status.currentVersion,
    currentBranch: status.currentBranch,
    remoteVersion: status.remoteVersion,
    releaseUrl: status.releaseUrl,
    repoUrl: status.repoUrl,
  };

  for (const channel of subscribedChannels) {
    const notifyOn: string[] = (() => {
      try {
        return JSON.parse(channel.notifyOn || JSON.stringify(getDefaultNotifyOn()));
      } catch {
        return getDefaultNotifyOn();
      }
    })();

    if (!notifyOn.includes("appUpdates")) continue;
    if (channel.lastAppVersionNotified === event.remoteVersion) continue;

    const pending = parsePendingEvents(channel.pendingEvents);
    if (pending.appUpdate?.remoteVersion === event.remoteVersion) continue;

    if (isScheduled(channel.schedule)) {
      appendPendingAppUpdate(channel.id, event);
      continue;
    }

    const sent = await sendChannelNotification(channel, [], [], event);
    if (!sent) continue;

    db.update(notifications)
      .set({
        lastAppVersionNotified: event.remoteVersion,
        updatedAt: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""),
      })
      .where(eq(notifications.id, channel.id))
      .run();
  }
}

// --- Send notification for a single channel ---

async function sendChannelNotification(
  channel: {
    id: number;
    name: string;
    type: string;
    config: string;
  },
  updateResults: CheckResult[],
  unreachableResults: CheckResult[],
  appUpdate: AppUpdateEvent | null = null,
): Promise<boolean> {
  const payload = buildBatchPayload(updateResults, unreachableResults, appUpdate);
  const provider = getProvider(channel.type);
  if (!provider) return false;

  const config = loadSanitizedConfig(channel);
  const configError = provider.validateConfig(config);
  if (configError) {
    console.warn(`Notification [${channel.name}]: skipped - ${configError}`);
    return false;
  }

  try {
    const result = await provider.send(payload, config);
    if (!result.success) {
      console.error(`Notification [${channel.name}] failed:`, result.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`Notification [${channel.name}] error:`, e);
    return false;
  }
}

// --- Pending events for scheduled channels ---

interface PendingEvents {
  updates: CheckResult[];
  unreachable: CheckResult[];
  appUpdate: AppUpdateEvent | null;
}

function parsePendingEvents(json: string | null): PendingEvents {
  if (!json) return { updates: [], unreachable: [], appUpdate: null };
  try {
    const parsed = JSON.parse(json);
    return {
      updates: Array.isArray(parsed.updates) ? parsed.updates : [],
      unreachable: Array.isArray(parsed.unreachable) ? parsed.unreachable : [],
      appUpdate:
        parsed.appUpdate &&
        typeof parsed.appUpdate === "object" &&
        typeof parsed.appUpdate.remoteVersion === "string"
          ? parsed.appUpdate
          : null,
    };
  } catch {
    return { updates: [], unreachable: [], appUpdate: null };
  }
}

function mergeCheckResults(existing: CheckResult[], incoming: CheckResult[]): CheckResult[] {
  const map = new Map<number, CheckResult>();
  for (const r of existing) map.set(r.systemId, r);
  for (const r of incoming) {
    const prev = map.get(r.systemId);
    if (!prev || r.updateCount > prev.updateCount || r.securityCount > prev.securityCount) {
      map.set(r.systemId, r);
    }
  }
  return Array.from(map.values());
}

function appendPendingEvents(
  channelId: number,
  updateResults: CheckResult[],
  unreachableResults: CheckResult[],
): void {
  const db = getDb();
  const row = db
    .select({ pendingEvents: notifications.pendingEvents })
    .from(notifications)
    .where(eq(notifications.id, channelId))
    .get();

  const pending = parsePendingEvents(row?.pendingEvents ?? null);
  pending.updates = mergeCheckResults(pending.updates, updateResults);
  pending.unreachable = mergeCheckResults(pending.unreachable, unreachableResults);

  db.update(notifications)
    .set({ pendingEvents: JSON.stringify(pending) })
    .where(eq(notifications.id, channelId))
    .run();
}

function appendPendingAppUpdate(
  channelId: number,
  appUpdate: AppUpdateEvent,
): void {
  const db = getDb();
  const row = db
    .select({ pendingEvents: notifications.pendingEvents })
    .from(notifications)
    .where(eq(notifications.id, channelId))
    .get();

  const pending = parsePendingEvents(row?.pendingEvents ?? null);
  pending.appUpdate = appUpdate;

  db.update(notifications)
    .set({ pendingEvents: JSON.stringify(pending) })
    .where(eq(notifications.id, channelId))
    .run();
}

// --- Scheduled digest processing ---

function shouldSendNow(cronExpr: string, lastSentAt: string | null): boolean {
  try {
    const ref = lastSentAt ? new Date(lastSentAt) : new Date(0);
    const cron = new Cron(cronExpr);
    const next = cron.nextRun(ref);
    if (!next) return false;
    return new Date() >= next;
  } catch {
    return false;
  }
}

export async function processScheduledDigests(): Promise<void> {
  const db = getDb();

  const channels = db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.enabled, 1),
        isNotNull(notifications.schedule),
      )
    )
    .all();

  for (const channel of channels) {
    if (!channel.schedule || channel.schedule === "immediate") continue;

    const pending = parsePendingEvents(channel.pendingEvents);
    if (
      pending.updates.length === 0 &&
      pending.unreachable.length === 0 &&
      !pending.appUpdate
    ) continue;

    if (!shouldSendNow(channel.schedule, channel.lastSentAt)) continue;

    console.log(`Notification [${channel.name}]: sending scheduled digest`);
    const sent = await sendChannelNotification(
      channel,
      pending.updates,
      pending.unreachable,
      pending.appUpdate
    );
    if (!sent) continue;

    const now = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    db.update(notifications)
      .set({
        pendingEvents: null,
        lastSentAt: now,
        lastAppVersionNotified:
          pending.appUpdate?.remoteVersion ?? channel.lastAppVersionNotified,
      })
      .where(eq(notifications.id, channel.id))
      .run();
  }
}

// --- Build a single batched notification ---

function buildBatchPayload(
  updateResults: CheckResult[],
  unreachableResults: CheckResult[],
  appUpdate: AppUpdateEvent | null = null,
): NotificationPayload {
  const totalUpdates = updateResults.reduce((s, r) => s + r.updateCount, 0);
  const totalSecurity = updateResults.reduce((s, r) => s + r.securityCount, 0);

  let title = "";
  let body = "";
  const tags: string[] = [];

  if (updateResults.length > 0) {
    title = `${totalUpdates} update${totalUpdates !== 1 ? "s" : ""} available`;
    if (totalSecurity > 0) {
      title += ` (${totalSecurity} security)`;
      tags.push("warning");
    } else {
      tags.push("package");
    }

    body = updateResults
      .map((r) => {
        let line = `${r.systemName}: ${r.updateCount} update${r.updateCount !== 1 ? "s" : ""}`;
        if (r.securityCount > 0) line += ` (${r.securityCount} security)`;
        return line;
      })
      .join("\n");
  }

  if (unreachableResults.length > 0) {
    tags.push("skull");
    const lines = unreachableResults
      .map((r) => `${r.systemName}: unreachable`)
      .join("\n");
    if (body) body += "\n\n";
    body += lines;
    if (!title) title = "System(s) unreachable";
  }

  if (appUpdate) {
    tags.push("arrow_up");
    const prefix = appUpdate.currentBranch === "dev" ? "dev-" : "v";
    const currentVersion = appUpdate.currentVersion
      ? `${prefix}${appUpdate.currentVersion.replace(/^dev-/, "")}`
      : "current build";
    const remoteVersion = `${prefix}${appUpdate.remoteVersion.replace(/^dev-/, "")}`;
    const lines = [
      `Linux Update Dashboard: ${currentVersion} -> ${remoteVersion}`,
    ];

    if (appUpdate.releaseUrl) {
      lines.push(appUpdate.releaseUrl);
    } else if (appUpdate.repoUrl) {
      lines.push(appUpdate.repoUrl);
    }

    if (body) body += "\n\n";
    body += lines.join("\n");
    if (!title) title = "Application update available";
  }

  return {
    title,
    body,
    priority: totalSecurity > 0 ? "high" : "default",
    tags,
  };
}
