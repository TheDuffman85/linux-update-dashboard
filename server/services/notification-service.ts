import { eq, and, isNotNull, asc, inArray } from "drizzle-orm";
import { createHash } from "crypto";
import { Cron } from "croner";
import { getDb } from "../db";
import { notificationDeliveredUpdates, notifications, systems } from "../db/schema";
import {
  getProvider,
  type AppUpdateEvent,
  type CheckResult,
  type NotificationConfig,
  type NotificationEventData,
  type NotificationEventType,
  type NotificationPayload,
  type NotificationPriority,
  type NotificationResult,
} from "./notifications";
import { formatUpdateLine } from "./notifications/presentation";
import { sanitizeOutput } from "../utils/sanitize";
import { getAppUpdateStatus } from "./app-update-service";
import { requestNotificationRuntimeAppUpdateSync } from "./notification-runtime-events";
import { migrateLegacyMqttDeviceName } from "./notifications/mqtt-shared";
import * as hiddenUpdateService from "./hidden-update-service";
import * as systemService from "./system-service";

const DEFAULT_NOTIFY_ON = ["updates", "appUpdates"] as const;
const DEFAULT_NOTIFY_ON_JSON = JSON.stringify(DEFAULT_NOTIFY_ON);
const DIAGNOSTIC_MESSAGE_LIMIT = 500;
const STORED_SENTINEL = "(stored)";

function getProviderOrThrow(type: string) {
  const provider = getProvider(type);
  if (!provider) {
    throw new Error(`Unknown notification provider: ${type}`);
  }
  return provider;
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseConfig(configJson: string): NotificationConfig {
  try {
    const parsed = JSON.parse(configJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function sanitizeNotificationConfig(
  type: string,
  config: NotificationConfig,
): NotificationConfig {
  return getProviderOrThrow(type).sanitizeConfig(config);
}

export function mergeStoredSensitiveConfig(
  type: string,
  storedConfig: NotificationConfig,
  incomingConfig: NotificationConfig,
): NotificationConfig {
  const provider = getProviderOrThrow(type);
  return provider.mergeConfig(provider.sanitizeConfig(storedConfig), incomingConfig);
}

function prepareConfigForStorage(
  type: string,
  config: NotificationConfig,
): NotificationConfig {
  const provider = getProviderOrThrow(type);
  return provider.prepareConfigForStorage(provider.sanitizeConfig(config));
}

function loadSanitizedConfig(row: { id: number; type: string; name: string; config: string }): NotificationConfig {
  const provider = getProvider(row.type);
  const parsed = row.type === "mqtt"
    ? migrateLegacyMqttDeviceName(parseConfig(row.config), row.name)
    : parseConfig(row.config);
  if (!provider) return parsed;

  const sanitized = provider.sanitizeConfig(parsed);

  if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
    getDb()
      .update(notifications)
      .set({ config: JSON.stringify(sanitized) })
      .where(eq(notifications.id, row.id))
      .run();
  }

  return sanitized;
}

function maskConfig(type: string, config: NotificationConfig): NotificationConfig {
  const provider = getProvider(type);
  return provider ? provider.maskConfig(config) : config;
}

function isScheduled(schedule: string | null): boolean {
  return schedule !== null && schedule !== "immediate";
}

function getDefaultNotifyOn(): string[] {
  return [...DEFAULT_NOTIFY_ON];
}

function parseNotifyOn(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || DEFAULT_NOTIFY_ON_JSON);
    return Array.isArray(parsed) ? parsed.map(String) : getDefaultNotifyOn();
  } catch {
    return getDefaultNotifyOn();
  }
}

function parseSystemIds(raw: string | null): number[] | null {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed === null) return null;
    return Array.isArray(parsed) ? parsed.map((value) => Number(value)).filter(Number.isInteger) : null;
  } catch {
    return null;
  }
}

function truncateDiagnosticMessage(value: string | undefined): string | null {
  if (!value) return null;
  const sanitized = sanitizeOutput(value);
  if (!sanitized) return null;
  return sanitized.length > DIAGNOSTIC_MESSAGE_LIMIT
    ? `${sanitized.slice(0, DIAGNOSTIC_MESSAGE_LIMIT - 1)}…`
    : sanitized;
}

function serializeNotification(row: typeof notifications.$inferSelect) {
  const config = loadSanitizedConfig(row);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    enabled: row.enabled === 1,
    notifyOn: parseNotifyOn(row.notifyOn),
    systemIds: parseSystemIds(row.systemIds),
    config: maskConfig(row.type, config),
    schedule: row.schedule || null,
    lastSentAt: row.lastSentAt || null,
    lastAppVersionNotified: row.lastAppVersionNotified || null,
    lastDeliveryStatus: row.lastDeliveryStatus || null,
    lastDeliveryAt: row.lastDeliveryAt || null,
    lastDeliveryCode: row.lastDeliveryCode ?? null,
    lastDeliveryMessage: row.lastDeliveryMessage || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listNotifications() {
  const db = getDb();
  const rows = db
    .select()
    .from(notifications)
    .orderBy(asc(notifications.sortOrder), asc(notifications.name), asc(notifications.id))
    .all();
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
  config: NotificationConfig;
  schedule?: string | null;
}) {
  const db = getDb();
  const nextSortOrder =
    db
      .select({ sortOrder: notifications.sortOrder })
      .from(notifications)
      .orderBy(asc(notifications.sortOrder), asc(notifications.id))
      .all()
      .at(-1)?.sortOrder ?? -1;
  const encConfig = prepareConfigForStorage(data.type, data.config);
  const schedule = data.schedule === "immediate" ? null : (data.schedule || null);
  const now = nowSql();
  const result = db.insert(notifications).values({
    sortOrder: nextSortOrder + 1,
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
    config?: NotificationConfig;
    schedule?: string | null;
  }
) {
  const db = getDb();
  const existing = db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!existing) return false;

  const updates: Record<string, unknown> = {
    updatedAt: nowSql(),
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
    if (newSchedule !== oldSchedule) {
      updates.pendingEvents = null;
      updates.lastSentAt = newSchedule ? nowSql() : null;
    }
  }

  if (data.config) {
    const type = data.type || existing.type;
    const existingConfig = type === existing.type ? loadSanitizedConfig(existing) : {};
    const mergedConfig = mergeStoredSensitiveConfig(type, existingConfig, data.config);
    updates.config = JSON.stringify(prepareConfigForStorage(type, mergedConfig));
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

export function resetNotificationUpdateDedupe(id: number): boolean {
  const db = getDb();
  const existing = db.select({ id: notifications.id }).from(notifications).where(eq(notifications.id, id)).get();
  if (!existing) return false;

  db.delete(notificationDeliveredUpdates)
    .where(eq(notificationDeliveredUpdates.notificationId, id))
    .run();

  return true;
}

export function reorderNotifications(notificationIds: number[]): void {
  const db = getDb();
  const existingNotifications = db
    .select({ id: notifications.id })
    .from(notifications)
    .orderBy(asc(notifications.sortOrder), asc(notifications.name), asc(notifications.id))
    .all();
  const existingIds = existingNotifications.map((notification) => notification.id);

  if (notificationIds.length !== existingIds.length) {
    throw new Error("Notification order must include every notification exactly once");
  }
  if (new Set(notificationIds).size !== notificationIds.length) {
    throw new Error("Notification order contains duplicate IDs");
  }
  if (!existingIds.every((rowId) => notificationIds.includes(rowId))) {
    throw new Error("Notification order contains unknown IDs");
  }

  for (const [sortOrder, notificationId] of notificationIds.entries()) {
    db.update(notifications)
      .set({ sortOrder })
      .where(eq(notifications.id, notificationId))
      .run();
  }
}

function buildTestPayload(name?: string): NotificationPayload {
  const sentAt = nowIso();
  const event: NotificationEventData = {
    title: "Test Notification",
    body: `This is a test notification from Linux Update Dashboard.${name ? `\nChannel: ${name}` : ""}`,
    priority: "default",
    tags: ["white_check_mark"],
    sentAt,
    eventTypes: [],
    totals: {
      systemsWithUpdates: 0,
      totalUpdates: 0,
      totalSecurity: 0,
      totalKeptBack: 0,
      unreachableSystems: 0,
    },
    updates: [],
    unreachable: [],
    appUpdate: null,
  };

  return {
    title: event.title,
    body: event.body,
    priority: event.priority,
    tags: event.tags,
    event,
    channelName: name ?? null,
  };
}

export async function testNotification(id: number): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const row = db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!row) return { success: false, error: "Notification not found" };
  if (row.type === "mqtt" && row.enabled !== 1) {
    return { success: false, error: "MQTT notification is disabled" };
  }

  const config = loadSanitizedConfig(row);
  const provider = getProvider(row.type);
  if (!provider) return { success: false, error: `Unknown provider: ${row.type}` };

  const sanitizedConfig = provider.sanitizeConfig(config);
  const configError = provider.validateConfig(sanitizedConfig);
  if (configError) return { success: false, error: configError };

  try {
    return await provider.send(
      {
        ...buildTestPayload(row.name),
        channelId: row.id,
        channelName: row.name,
        systemIds: parseSystemIds(row.systemIds),
        schedule: row.schedule || null,
      },
      sanitizedConfig,
    );
  } catch (error) {
    return { success: false, error: sanitizeOutput(String(error)) };
  }
}

export async function testNotificationConfig(
  type: string,
  config: NotificationConfig,
  name?: string,
): Promise<{ success: boolean; error?: string }> {
  const provider = getProvider(type);
  if (!provider) return { success: false, error: `Unknown provider: ${type}` };

  const sanitizedConfig = provider.sanitizeConfig(config);
  const configError = provider.validateConfig(sanitizedConfig);
  if (configError) return { success: false, error: configError };

  try {
    return await provider.send(buildTestPayload(name), sanitizedConfig);
  } catch (error) {
    return { success: false, error: sanitizeOutput(String(error)) };
  }
}

function computeUpdateHash(systemId: number): string {
  const updates = hiddenUpdateService.getVisibleCachedUpdates(systemId);

  if (updates.length === 0) return "empty";

  const packageStates = updates
    .map((u) => `${u.packageName}:${u.newVersion}:${u.isSecurity}:${u.isKeptBack}`)
    .sort();
  const securityCount = updates.filter((u) => u.isSecurity).length;
  const keptBackCount = updates.filter((u) => u.isKeptBack).length;
  const raw = `${updates.length}:${securityCount}:${keptBackCount}:${packageStates.join(",")}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function syncSystemNotificationHash(systemId: number): void {
  getDb().update(systems)
    .set({ lastNotifiedHash: computeUpdateHash(systemId) })
    .where(eq(systems.id, systemId))
    .run();
}

interface DeliveredUpdateVersion {
  systemId: number;
  pkgManager: string;
  packageName: string;
  newVersion: string;
}

interface PendingUpdateResult extends CheckResult {
  packageVersions: DeliveredUpdateVersion[];
}

interface PendingEvents {
  updates: PendingUpdateResult[];
  unreachable: CheckResult[];
  appUpdate: AppUpdateEvent | null;
}

function deliveredUpdateVersionKey(
  value: Pick<DeliveredUpdateVersion, "systemId" | "pkgManager" | "packageName" | "newVersion">,
): string {
  return `${value.systemId}\u0000${value.pkgManager}\u0000${value.packageName}\u0000${value.newVersion}`;
}

function listVisibleScopedSystems(scopedSystemIds: number[] | null): Array<{ id: number; name: string }> {
  if (scopedSystemIds === null) {
    return systemService.listVisibleSystems().map((system) => ({
      id: system.id,
      name: system.name,
    }));
  }

  return systemService.filterVisibleSystemIds(scopedSystemIds)
    .map((systemId) => systemService.getSystem(systemId))
    .filter((system): system is NonNullable<typeof system> => !!system && system.hidden === 0)
    .map((system) => ({
      id: system.id,
      name: system.name,
    }));
}

function getVisibleDeliveredUpdateVersions(systemId: number): DeliveredUpdateVersion[] {
  return hiddenUpdateService.getVisibleCachedUpdates(systemId).map((update) => ({
    systemId,
    pkgManager: update.pkgManager,
    packageName: update.packageName,
    newVersion: update.newVersion,
  }));
}

function buildPendingUpdateResult(result: CheckResult): PendingUpdateResult {
  return {
    ...result,
    packageVersions: getVisibleDeliveredUpdateVersions(result.systemId),
  };
}

function getCurrentScopedUpdateResults(scopedSystemIds: number[] | null): PendingUpdateResult[] {
  return listVisibleScopedSystems(scopedSystemIds)
    .map((system) => {
      const summary = hiddenUpdateService.getVisibleUpdateSummary(system.id);
      return {
        systemId: system.id,
        systemName: system.name,
        updateCount: summary.updateCount,
        securityCount: summary.securityCount,
        keptBackCount: summary.keptBackCount,
        previouslyReachable: true,
        nowUnreachable: false,
        packageVersions: getVisibleDeliveredUpdateVersions(system.id),
      };
    })
    .filter((result) => result.updateCount > 0 && result.packageVersions.length > 0);
}

function toCheckResult(result: PendingUpdateResult): CheckResult {
  return {
    systemId: result.systemId,
    systemName: result.systemName,
    updateCount: result.updateCount,
    securityCount: result.securityCount,
    keptBackCount: result.keptBackCount,
    previouslyReachable: result.previouslyReachable,
    nowUnreachable: result.nowUnreachable,
  };
}

function flattenDeliveredUpdateVersions(updateResults: PendingUpdateResult[]): DeliveredUpdateVersion[] {
  const seen = new Set<string>();
  const values: DeliveredUpdateVersion[] = [];

  for (const result of updateResults) {
    for (const version of result.packageVersions) {
      const key = deliveredUpdateVersionKey(version);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(version);
    }
  }

  return values;
}

function loadDeliveredUpdateVersionKeys(channelId: number, systemIds: number[]): Set<string> {
  const uniqueSystemIds = Array.from(new Set(systemIds.filter((systemId) => Number.isInteger(systemId) && systemId > 0)));
  if (uniqueSystemIds.length === 0) return new Set();

  const rows = getDb()
    .select({
      systemId: notificationDeliveredUpdates.systemId,
      pkgManager: notificationDeliveredUpdates.pkgManager,
      packageName: notificationDeliveredUpdates.packageName,
      newVersion: notificationDeliveredUpdates.newVersion,
    })
    .from(notificationDeliveredUpdates)
    .where(
      and(
        eq(notificationDeliveredUpdates.notificationId, channelId),
        inArray(notificationDeliveredUpdates.systemId, uniqueSystemIds),
      ),
    )
    .all();

  return new Set(rows.map((row) => deliveredUpdateVersionKey(row)));
}

function hasUndeliveredUpdateVersions(
  channelId: number,
  updateResults: PendingUpdateResult[],
): boolean {
  if (updateResults.length === 0) return false;

  const deliveredKeys = loadDeliveredUpdateVersionKeys(
    channelId,
    updateResults.map((result) => result.systemId),
  );

  return updateResults.some((result) =>
    result.packageVersions.some((version) => !deliveredKeys.has(deliveredUpdateVersionKey(version))),
  );
}

function markDeliveredUpdateVersions(
  channelId: number,
  updateResults: PendingUpdateResult[],
): void {
  const values = flattenDeliveredUpdateVersions(updateResults);
  if (values.length === 0) return;

  getDb()
    .insert(notificationDeliveredUpdates)
    .values(
      values.map((value) => ({
        notificationId: channelId,
        systemId: value.systemId,
        pkgManager: value.pkgManager,
        packageName: value.packageName,
        newVersion: value.newVersion,
        deliveredAt: nowSql(),
      })),
    )
    .onConflictDoNothing({
      target: [
        notificationDeliveredUpdates.notificationId,
        notificationDeliveredUpdates.systemId,
        notificationDeliveredUpdates.pkgManager,
        notificationDeliveredUpdates.packageName,
        notificationDeliveredUpdates.newVersion,
      ],
    })
    .run();
}

export async function processScheduledResults(
  results: CheckResult[]
): Promise<void> {
  const db = getDb();
  const channels = db
    .select()
    .from(notifications)
    .where(eq(notifications.enabled, 1))
    .all();

  if (channels.length === 0) return;

  const visibleResults = systemService.filterVisibleSystemItems(results);
  if (visibleResults.length === 0) return;

  for (const channel of channels) {
    const notifyOn = parseNotifyOn(channel.notifyOn);
    const scopedSystemIds = parseSystemIds(channel.systemIds);
    const filterByScope = (result: CheckResult) =>
      scopedSystemIds === null || scopedSystemIds.includes(result.systemId);

    const scopedResults = visibleResults.filter(filterByScope);
    const checkedUpdateResults = notifyOn.includes("updates")
      ? scopedResults
        .filter((result) => result.updateCount > 0)
        .map(buildPendingUpdateResult)
        .filter((result) => result.packageVersions.length > 0)
      : [];
    const channelUpdates = checkedUpdateResults.length > 0 && hasUndeliveredUpdateVersions(channel.id, checkedUpdateResults)
      ? getCurrentScopedUpdateResults(scopedSystemIds)
      : [];
    const channelUnreachable = notifyOn.includes("unreachable")
      ? scopedResults.filter((result) => result.nowUnreachable && result.previouslyReachable)
      : [];

    if (channelUpdates.length === 0 && channelUnreachable.length === 0) continue;

    if (isScheduled(channel.schedule)) {
      appendPendingEvents(channel.id, channelUpdates, channelUnreachable);
      continue;
    }

    const sent = await sendChannelNotification(
      channel,
      channelUpdates.map(toCheckResult),
      channelUnreachable,
    );
    if (!sent) continue;

    markDeliveredUpdateVersions(channel.id, channelUpdates);
  }
}

export async function processAppUpdateNotifications(): Promise<void> {
  const db = getDb();
  const channels = db
    .select()
    .from(notifications)
    .where(eq(notifications.enabled, 1))
    .all();

  if (channels.length === 0) {
    await requestNotificationRuntimeAppUpdateSync();
    return;
  }

  const subscribedChannels = channels.filter((channel) => parseNotifyOn(channel.notifyOn).includes("appUpdates"));
  if (subscribedChannels.length === 0) {
    await requestNotificationRuntimeAppUpdateSync();
    return;
  }

  const status = await getAppUpdateStatus();
  if (!status.updateAvailable || !status.remoteVersion) {
    await requestNotificationRuntimeAppUpdateSync();
    return;
  }

  const event: AppUpdateEvent = {
    currentVersion: status.currentVersion,
    currentBranch: status.currentBranch,
    remoteVersion: status.remoteVersion,
    releaseUrl: status.releaseUrl,
    repoUrl: status.repoUrl,
  };

  for (const channel of subscribedChannels) {
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
        updatedAt: nowSql(),
      })
      .where(eq(notifications.id, channel.id))
      .run();
  }

  await requestNotificationRuntimeAppUpdateSync();
}

function getWebhookRetryPolicy(config: NotificationConfig): { attempts: number; delayMs: number } {
  const retryAttempts = typeof config.retryAttempts === "number" ? config.retryAttempts : 0;
  const retryDelayMs = typeof config.retryDelayMs === "number" ? config.retryDelayMs : 0;

  return {
    attempts: Math.max(0, Math.min(5, Math.trunc(retryAttempts))),
    delayMs: Math.max(0, Math.min(300_000, Math.trunc(retryDelayMs))),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeResult(result: NotificationResult): string | null {
  return truncateDiagnosticMessage(result.summary || result.error);
}

function updateDeliveryDiagnostics(
  channelId: number,
  result: NotificationResult,
): void {
  getDb().update(notifications)
    .set({
      lastDeliveryStatus: result.success ? "success" : "failed",
      lastDeliveryAt: nowSql(),
      lastDeliveryCode: result.statusCode ?? null,
      lastDeliveryMessage: summarizeResult(result),
      updatedAt: nowSql(),
    })
    .where(eq(notifications.id, channelId))
    .run();
}

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
  const payload = {
    ...buildBatchPayload(updateResults, unreachableResults, appUpdate),
    channelId: channel.id,
    channelName: channel.name,
    systemIds: parseSystemIds("systemIds" in channel ? (channel as { systemIds?: string | null }).systemIds ?? null : null),
    schedule: "schedule" in channel ? (channel as { schedule?: string | null }).schedule ?? null : null,
  };
  const provider = getProvider(channel.type);
  if (!provider) return false;

  const config = loadSanitizedConfig(channel);
  const configError = provider.validateConfig(config);
  if (configError) {
    const result: NotificationResult = {
      success: false,
      error: configError,
      summary: configError,
    };
    updateDeliveryDiagnostics(channel.id, result);
    console.warn(`Notification [${channel.name}]: skipped - ${sanitizeOutput(configError)}`);
    return false;
  }

  const retryPolicy = channel.type === "webhook"
    ? getWebhookRetryPolicy(config)
    : { attempts: 0, delayMs: 0 };

  let lastResult: NotificationResult = {
    success: false,
    error: "Notification delivery failed",
  };

  for (let attempt = 0; attempt <= retryPolicy.attempts; attempt += 1) {
    try {
      lastResult = await provider.send(payload, config);
    } catch (error) {
      lastResult = {
        success: false,
        error: sanitizeOutput(String(error)),
      };
    }

    if (lastResult.success) {
      updateDeliveryDiagnostics(channel.id, lastResult);
      return true;
    }

    if (attempt < retryPolicy.attempts && retryPolicy.delayMs > 0) {
      await sleep(retryPolicy.delayMs);
    }
  }

  updateDeliveryDiagnostics(channel.id, lastResult);
  console.error(`Notification [${channel.name}] failed:`, summarizeResult(lastResult) || "unknown error");
  return false;
}

function parsePendingEvents(json: string | null): PendingEvents {
  if (!json) return { updates: [], unreachable: [], appUpdate: null };
  try {
    const parsed = JSON.parse(json);
    const updates = Array.isArray(parsed.updates)
      ? parsed.updates
        .map((value: unknown): PendingUpdateResult | null => {
          if (!value || typeof value !== "object") return null;

          const systemId = Number((value as { systemId?: unknown }).systemId);
          if (!Number.isInteger(systemId) || systemId <= 0) return null;

          const summary = hiddenUpdateService.getVisibleUpdateSummary(systemId);
          const packageVersions = Array.isArray((value as { packageVersions?: unknown[] }).packageVersions)
            ? (value as { packageVersions: unknown[] }).packageVersions
              .map((entry): DeliveredUpdateVersion | null => {
                if (!entry || typeof entry !== "object") return null;
                const systemIdValue = Number((entry as { systemId?: unknown }).systemId ?? systemId);
                const pkgManager = typeof (entry as { pkgManager?: unknown }).pkgManager === "string"
                  ? (entry as { pkgManager: string }).pkgManager
                  : null;
                const packageName = typeof (entry as { packageName?: unknown }).packageName === "string"
                  ? (entry as { packageName: string }).packageName
                  : null;
                const newVersion = typeof (entry as { newVersion?: unknown }).newVersion === "string"
                  ? (entry as { newVersion: string }).newVersion
                  : null;

                if (!Number.isInteger(systemIdValue) || systemIdValue <= 0 || !pkgManager || !packageName || !newVersion) {
                  return null;
                }

                return {
                  systemId: systemIdValue,
                  pkgManager,
                  packageName,
                  newVersion,
                };
              })
              .filter((entry): entry is DeliveredUpdateVersion => entry !== null)
            : getVisibleDeliveredUpdateVersions(systemId);

          const system = systemService.getSystem(systemId);
          return {
            systemId,
            systemName:
              typeof (value as { systemName?: unknown }).systemName === "string"
                ? (value as { systemName: string }).systemName
                : system?.name || `System #${systemId}`,
            updateCount:
              typeof (value as { updateCount?: unknown }).updateCount === "number"
                ? (value as { updateCount: number }).updateCount
                : summary.updateCount,
            securityCount:
              typeof (value as { securityCount?: unknown }).securityCount === "number"
                ? (value as { securityCount: number }).securityCount
                : summary.securityCount,
            keptBackCount:
              typeof (value as { keptBackCount?: unknown }).keptBackCount === "number"
                ? (value as { keptBackCount: number }).keptBackCount
                : summary.keptBackCount,
            previouslyReachable:
              typeof (value as { previouslyReachable?: unknown }).previouslyReachable === "boolean"
                ? (value as { previouslyReachable: boolean }).previouslyReachable
                : true,
            nowUnreachable:
              typeof (value as { nowUnreachable?: unknown }).nowUnreachable === "boolean"
                ? (value as { nowUnreachable: boolean }).nowUnreachable
                : false,
            packageVersions,
          };
        })
        .filter((value: PendingUpdateResult | null): value is PendingUpdateResult => value !== null)
      : [];

    return {
      updates,
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
  for (const result of existing) map.set(result.systemId, result);
  for (const result of incoming) {
    const previous = map.get(result.systemId);
    if (
      !previous ||
      result.updateCount > previous.updateCount ||
      result.securityCount > previous.securityCount ||
      result.keptBackCount > previous.keptBackCount
    ) {
      map.set(result.systemId, result);
    }
  }
  return Array.from(map.values());
}

function mergePendingUpdateResults(
  existing: PendingUpdateResult[],
  incoming: PendingUpdateResult[],
): PendingUpdateResult[] {
  const map = new Map<number, PendingUpdateResult>();

  for (const result of existing) {
    map.set(result.systemId, {
      ...result,
      packageVersions: [...result.packageVersions],
    });
  }

  for (const result of incoming) {
    const previous = map.get(result.systemId);
    if (!previous) {
      map.set(result.systemId, {
        ...result,
        packageVersions: [...result.packageVersions],
      });
      continue;
    }

    const packageVersions = new Map<string, DeliveredUpdateVersion>();
    for (const value of previous.packageVersions) {
      packageVersions.set(deliveredUpdateVersionKey(value), value);
    }
    for (const value of result.packageVersions) {
      packageVersions.set(deliveredUpdateVersionKey(value), value);
    }

    map.set(result.systemId, {
      ...previous,
      systemName: result.systemName,
      updateCount: Math.max(previous.updateCount, result.updateCount),
      securityCount: Math.max(previous.securityCount, result.securityCount),
      keptBackCount: Math.max(previous.keptBackCount, result.keptBackCount),
      previouslyReachable: previous.previouslyReachable || result.previouslyReachable,
      nowUnreachable: previous.nowUnreachable || result.nowUnreachable,
      packageVersions: Array.from(packageVersions.values()),
    });
  }

  return Array.from(map.values());
}

function appendPendingEvents(
  channelId: number,
  updateResults: PendingUpdateResult[],
  unreachableResults: CheckResult[],
): void {
  const db = getDb();
  const row = db
    .select({ pendingEvents: notifications.pendingEvents })
    .from(notifications)
    .where(eq(notifications.id, channelId))
    .get();

  const pending = parsePendingEvents(row?.pendingEvents ?? null);
  pending.updates = mergePendingUpdateResults(pending.updates, updateResults);
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
    const visibleUpdates = systemService.filterVisibleSystemItems(pending.updates);
    const visibleUnreachable = systemService.filterVisibleSystemItems(pending.unreachable);
    const deliverableUpdates = hasUndeliveredUpdateVersions(channel.id, visibleUpdates)
      ? visibleUpdates
      : [];

    if (
      visibleUpdates.length !== pending.updates.length ||
      deliverableUpdates.length !== visibleUpdates.length ||
      visibleUnreachable.length !== pending.unreachable.length
    ) {
      db.update(notifications)
        .set({
          pendingEvents:
            deliverableUpdates.length === 0 &&
            visibleUnreachable.length === 0 &&
            !pending.appUpdate
              ? null
              : JSON.stringify({
                  updates: deliverableUpdates,
                  unreachable: visibleUnreachable,
                  appUpdate: pending.appUpdate,
                }),
        })
        .where(eq(notifications.id, channel.id))
        .run();
    }

    if (
      deliverableUpdates.length === 0 &&
      visibleUnreachable.length === 0 &&
      !pending.appUpdate
    ) continue;

    if (!shouldSendNow(channel.schedule, channel.lastSentAt)) continue;

    const sent = await sendChannelNotification(
      channel,
      deliverableUpdates.map(toCheckResult),
      visibleUnreachable,
      pending.appUpdate
    );
    if (!sent) continue;

    markDeliveredUpdateVersions(channel.id, deliverableUpdates);

    db.update(notifications)
      .set({
        pendingEvents: null,
        lastSentAt: nowSql(),
        lastAppVersionNotified:
          pending.appUpdate?.remoteVersion ?? channel.lastAppVersionNotified,
      })
      .where(eq(notifications.id, channel.id))
      .run();
  }
}

function buildEventTypes(
  updateResults: CheckResult[],
  unreachableResults: CheckResult[],
  appUpdate: AppUpdateEvent | null,
): NotificationEventType[] {
  const eventTypes: NotificationEventType[] = [];
  if (updateResults.length > 0) eventTypes.push("updates");
  if (unreachableResults.length > 0) eventTypes.push("unreachable");
  if (appUpdate) eventTypes.push("appUpdates");
  return eventTypes;
}

function hasSpecialUpdateCounts(totalSecurity: number, totalKeptBack: number): boolean {
  return totalSecurity > 0 || totalKeptBack > 0;
}

function resolvePriority(totalSecurity: number, totalKeptBack: number): NotificationPriority {
  return hasSpecialUpdateCounts(totalSecurity, totalKeptBack) ? "high" : "default";
}

function buildBatchPayload(
  updateResults: CheckResult[],
  unreachableResults: CheckResult[],
  appUpdate: AppUpdateEvent | null = null,
): NotificationPayload {
  const totalUpdates = updateResults.reduce((sum, result) => sum + result.updateCount, 0);
  const totalSecurity = updateResults.reduce((sum, result) => sum + result.securityCount, 0);
  const totalKeptBack = updateResults.reduce((sum, result) => sum + result.keptBackCount, 0);
  const sentAt = nowIso();

  let title = "";
  let body = "";
  const tags: string[] = [];

  if (updateResults.length > 0) {
    title = `${totalUpdates} update${totalUpdates !== 1 ? "s" : ""} available`;
    const titleDetails: string[] = [];
    if (totalSecurity > 0) {
      titleDetails.push(`${totalSecurity} security`);
    }
    if (totalKeptBack > 0) {
      titleDetails.push(`${totalKeptBack} kept back`);
    }
    if (hasSpecialUpdateCounts(totalSecurity, totalKeptBack)) {
      tags.push("warning");
    }
    if (titleDetails.length > 0) {
      title += ` (${titleDetails.join(", ")})`;
    }
    if (!hasSpecialUpdateCounts(totalSecurity, totalKeptBack)) {
      tags.push("package");
    }

    body = updateResults
      .map((result) => formatUpdateLine(result))
      .join("\n");
  }

  if (unreachableResults.length > 0) {
    tags.push("skull");
    const lines = unreachableResults
      .map((result) => `${result.systemName}: unreachable`)
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
    const lines = [`Linux Update Dashboard: ${currentVersion} -> ${remoteVersion}`];

    if (body) body += "\n\n";
    body += lines.join("\n");
    if (!title) title = "Application update available";
  }

  const event: NotificationEventData = {
    title,
    body,
    priority: resolvePriority(totalSecurity, totalKeptBack),
    tags,
    sentAt,
    eventTypes: buildEventTypes(updateResults, unreachableResults, appUpdate),
    totals: {
      systemsWithUpdates: updateResults.length,
      totalUpdates,
      totalSecurity,
      totalKeptBack,
      unreachableSystems: unreachableResults.length,
    },
    updates: updateResults,
    unreachable: unreachableResults.map((result) => ({
      systemId: result.systemId,
      systemName: result.systemName,
    })),
    appUpdate,
  };

  return {
    title,
    body,
    priority: event.priority,
    tags,
    event,
  };
}

export type { CheckResult, AppUpdateEvent } from "./notifications";
