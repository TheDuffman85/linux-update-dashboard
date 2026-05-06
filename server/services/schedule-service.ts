import { asc, eq, inArray } from "drizzle-orm";
import { Cron } from "croner";
import { getDb } from "../db";
import { notifications, schedules, systems } from "../db/schema";
import * as cacheService from "./cache-service";
import * as systemService from "./system-service";

export type ScheduleType = "refresh" | "update" | "notification_digest";
export type ScheduleRunStatus = "success" | "warning" | "failed";

export interface RefreshScheduleConfig {
  cron: string;
  cacheDurationHours: number;
}

export interface UpdateScheduleConfig {
  cron: string;
}

export interface NotificationScheduleConfig {
  cron: string;
  notificationIds: number[];
}

export type ScheduleConfig = RefreshScheduleConfig | UpdateScheduleConfig | NotificationScheduleConfig;

export interface SerializedSchedule {
  id: number;
  name: string;
  type: ScheduleType;
  enabled: boolean;
  systemIds: number[] | null;
  config: ScheduleConfig;
  lastStartedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

const VALID_TYPES: ScheduleType[] = ["refresh", "update", "notification_digest"];
const MAX_NAME_LENGTH = 100;
const MAX_RUN_MESSAGE_LENGTH = 500;
const DEFAULT_REFRESH_CONFIG: RefreshScheduleConfig = {
  cron: "*/15 * * * *",
  cacheDurationHours: 12,
};
const DEFAULT_UPDATE_CONFIG: UpdateScheduleConfig = {
  cron: "0 3 * * 0",
};
const DEFAULT_NOTIFICATION_SCHEDULE_CONFIG: NotificationScheduleConfig = {
  cron: "0 9 * * 1",
  notificationIds: [],
};

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

function normalizeInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function legacyIntervalMinutesToCron(intervalMinutes: number): string {
  if (intervalMinutes <= 59) return `*/${intervalMinutes} * * * *`;
  if (intervalMinutes === 1440) return "0 0 * * *";
  if (intervalMinutes % 60 === 0) {
    const hours = Math.min(23, Math.max(1, intervalMinutes / 60));
    return `0 */${hours} * * *`;
  }

  const roundedHours = Math.min(23, Math.max(1, Math.round(intervalMinutes / 60)));
  return `0 */${roundedHours} * * *`;
}

function parseConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(configJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseSystemIds(raw: string | null): number[] | null {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed === null) return null;
    return Array.isArray(parsed)
      ? parsed.map((value) => Number(value)).filter(Number.isInteger)
      : null;
  } catch {
    return null;
  }
}

function normalizePositiveIntegerArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0),
    ),
  );
}

function normalizeScheduleConfig(
  type: ScheduleType,
  config: unknown,
): ScheduleConfig {
  const source =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};

  if (type === "refresh") {
    const cron =
      typeof source.cron === "string" && source.cron.trim()
        ? source.cron.trim()
        : legacyIntervalMinutesToCron(
            normalizeInteger(
              source.intervalMinutes,
              5,
              1440,
              15,
            ),
          );
    return {
      cron,
      cacheDurationHours: normalizeInteger(
        source.cacheDurationHours,
        0,
        168,
        DEFAULT_REFRESH_CONFIG.cacheDurationHours,
      ),
    };
  }

  const cron = typeof source.cron === "string" ? source.cron.trim() : "";

  if (type === "notification_digest") {
    return {
      cron: cron || DEFAULT_NOTIFICATION_SCHEDULE_CONFIG.cron,
      notificationIds: normalizePositiveIntegerArray(source.notificationIds),
    };
  }

  return { cron: cron || DEFAULT_UPDATE_CONFIG.cron };
}

function serializeSchedule(row: typeof schedules.$inferSelect): SerializedSchedule {
  const type = VALID_TYPES.includes(row.type as ScheduleType)
    ? (row.type as ScheduleType)
    : "refresh";
  const config = normalizeScheduleConfig(type, parseConfig(row.config));
  const serializedConfig = JSON.stringify(config);

  if (serializedConfig !== row.config) {
    getDb()
      .update(schedules)
      .set({ config: serializedConfig })
      .where(eq(schedules.id, row.id))
      .run();
  }

  return {
    id: row.id,
    name: row.name,
    type,
    enabled: row.enabled === 1,
    systemIds: parseSystemIds(row.systemIds),
    config,
    lastStartedAt: row.lastStartedAt || null,
    lastRunAt: row.lastRunAt || null,
    lastRunStatus: row.lastRunStatus || null,
    lastRunMessage: row.lastRunMessage || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function truncateRunMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > MAX_RUN_MESSAGE_LENGTH
    ? compact.slice(0, MAX_RUN_MESSAGE_LENGTH - 1)
    : compact;
}

export function getValidScheduleTypes(): ScheduleType[] {
  return [...VALID_TYPES];
}

export function validateScheduleName(name: unknown): string | null {
  if (typeof name !== "string" || !name.trim() || name.length > MAX_NAME_LENGTH) {
    return "name is required and must be 1-100 characters";
  }
  return null;
}

export function validateScheduleType(type: unknown): type is ScheduleType {
  return typeof type === "string" && VALID_TYPES.includes(type as ScheduleType);
}

export function validateSystemIds(systemIds: unknown): string | null {
  if (systemIds === undefined || systemIds === null) return null;
  if (
    !Array.isArray(systemIds) ||
    !systemIds.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
  ) {
    return "systemIds must be null or an array of positive integers";
  }
  return null;
}

export function validateScheduleConfig(type: ScheduleType, config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "config must be an object";
  }

  const cron = (config as Record<string, unknown>).cron;
  if (typeof cron !== "string" || !cron.trim()) {
    return `${type} schedules require a cron expression`;
  }
  try {
    new Cron(cron);
  } catch {
    return "cron must be a valid cron expression";
  }

  if (type === "notification_digest") {
    const notificationIds = (config as Record<string, unknown>).notificationIds;
    if (
      !Array.isArray(notificationIds) ||
      !notificationIds.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
    ) {
      return "notification schedules require notificationIds as an array of positive integers";
    }
  }

  return null;
}

function getExistingNotificationIds(ids: number[]): Set<number> {
  if (ids.length === 0) return new Set();
  const allIds = new Set(
    getDb()
      .select({ id: notifications.id })
      .from(notifications)
      .all()
      .map((row) => row.id),
  );
  return new Set(ids.filter((id) => allIds.has(id)));
}

function getScheduleNotificationIds(config: ScheduleConfig): number[] {
  return "notificationIds" in config ? config.notificationIds : [];
}

function validateNotificationScheduleTargets(
  notificationIds: number[],
): string | null {
  const uniqueIds = Array.from(new Set(notificationIds));
  if (uniqueIds.length !== notificationIds.length) {
    return "notificationIds must not contain duplicates";
  }

  const existingIds = getExistingNotificationIds(uniqueIds);
  const missing = uniqueIds.filter((id) => !existingIds.has(id));
  if (missing.length > 0) {
    return `notificationIds include unknown notification channel IDs: ${missing.join(", ")}`;
  }

  return null;
}

export function listSchedules(): SerializedSchedule[] {
  const rows = getDb()
    .select()
    .from(schedules)
    .orderBy(asc(schedules.sortOrder), asc(schedules.name), asc(schedules.id))
    .all();
  return rows.map(serializeSchedule);
}

export function getSchedule(id: number): SerializedSchedule | null {
  const row = getDb().select().from(schedules).where(eq(schedules.id, id)).get();
  return row ? serializeSchedule(row) : null;
}

export function createSchedule(data: {
  name: string;
  type: ScheduleType;
  enabled?: boolean;
  systemIds?: number[] | null;
  config: unknown;
}): number {
  const db = getDb();
  const nextSortOrder =
    db
      .select({ sortOrder: schedules.sortOrder })
      .from(schedules)
      .orderBy(asc(schedules.sortOrder), asc(schedules.id))
      .all()
      .at(-1)?.sortOrder ?? -1;
  const config = normalizeScheduleConfig(data.type, data.config);
  if (data.type === "notification_digest") {
    const targetError = validateNotificationScheduleTargets(getScheduleNotificationIds(config));
    if (targetError) throw new Error(targetError);
  }
  const result = db.insert(schedules).values({
    sortOrder: nextSortOrder + 1,
    name: data.name,
    type: data.type,
    enabled: data.enabled !== false ? 1 : 0,
    systemIds: data.type === "notification_digest" ? null : data.systemIds ? JSON.stringify(data.systemIds) : null,
    config: JSON.stringify(config),
  }).returning({ id: schedules.id }).get();
  return result.id;
}

export function updateSchedule(
  id: number,
  data: {
    name?: string;
    type?: ScheduleType;
    enabled?: boolean;
    systemIds?: number[] | null;
    config?: unknown;
  },
): boolean {
  const db = getDb();
  const existing = db.select().from(schedules).where(eq(schedules.id, id)).get();
  if (!existing) return false;

  const type = data.type ?? (existing.type as ScheduleType);
  const configSource = data.config ?? (data.type ? {} : parseConfig(existing.config));
  const nextConfig = normalizeScheduleConfig(type, configSource);
  if (type === "notification_digest") {
    const targetError = validateNotificationScheduleTargets(getScheduleNotificationIds(nextConfig));
    if (targetError) throw new Error(targetError);
  }
  const updates: Record<string, unknown> = {
    updatedAt: nowSql(),
  };

  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.enabled !== undefined) updates.enabled = data.enabled ? 1 : 0;
  if (data.systemIds !== undefined) {
    updates.systemIds = type === "notification_digest" ? null : data.systemIds ? JSON.stringify(data.systemIds) : null;
  }
  if (data.type !== undefined || data.config !== undefined) {
    updates.config = JSON.stringify(nextConfig);
    if (type === "notification_digest") updates.systemIds = null;
  }

  db.update(schedules).set(updates).where(eq(schedules.id, id)).run();
  return true;
}

export function deleteSchedule(id: number): boolean {
  const existing = getSchedule(id);
  if (existing?.type === "notification_digest" && "notificationIds" in existing.config) {
    if (existing.config.notificationIds.length > 0) {
      getDb()
        .update(notifications)
        .set({ pendingEvents: null, lastSentAt: null, updatedAt: nowSql() })
        .where(inArray(notifications.id, existing.config.notificationIds))
        .run();
    }
  }
  const result = getDb().delete(schedules).where(eq(schedules.id, id)).run();
  return result.changes > 0;
}

export function reorderSchedules(scheduleIds: number[]): void {
  const db = getDb();
  const existingIds = db
    .select({ id: schedules.id })
    .from(schedules)
    .orderBy(asc(schedules.sortOrder), asc(schedules.id))
    .all()
    .map((row) => row.id);

  const sortedExisting = [...existingIds].sort((a, b) => a - b);
  const sortedIncoming = [...scheduleIds].sort((a, b) => a - b);
  if (
    existingIds.length !== scheduleIds.length ||
    sortedExisting.some((id, index) => id !== sortedIncoming[index])
  ) {
    throw new Error("scheduleIds must include every schedule exactly once");
  }

  const now = nowSql();
  for (const [index, id] of scheduleIds.entries()) {
    db.update(schedules)
      .set({ sortOrder: index, updatedAt: now })
      .where(eq(schedules.id, id))
      .run();
  }
}

export function listEnabledSchedulesByType(type: ScheduleType): SerializedSchedule[] {
  const rows = getDb()
    .select()
    .from(schedules)
    .where(eq(schedules.enabled, 1))
    .orderBy(asc(schedules.sortOrder), asc(schedules.id))
    .all()
    .filter((row) => row.type === type);
  return rows.map(serializeSchedule);
}

export function listNotificationSchedules(enabledOnly = false): SerializedSchedule[] {
  return listSchedules().filter(
    (schedule) => schedule.type === "notification_digest" && (!enabledOnly || schedule.enabled),
  );
}

export function getNotificationScheduleAssignments(notificationId: number): Array<{
  id: number;
  name: string;
  cron: string;
  enabled: boolean;
}> {
  const assignments: Array<{
    id: number;
    name: string;
    cron: string;
    enabled: boolean;
  }> = [];

  for (const schedule of listNotificationSchedules()) {
    if (!("notificationIds" in schedule.config)) continue;
    if (!schedule.config.notificationIds.includes(notificationId)) continue;
    assignments.push({
      id: schedule.id,
      name: schedule.name,
      cron: schedule.config.cron,
      enabled: schedule.enabled,
    });
  }
  return assignments;
}

export function getNotificationScheduleAssignment(notificationId: number): {
  id: number;
  name: string;
  cron: string;
  enabled: boolean;
} | null {
  return getNotificationScheduleAssignments(notificationId)[0] ?? null;
}

export function getEnabledScheduledNotificationIds(): Set<number> {
  return new Set(
    listNotificationSchedules(true).flatMap((schedule) =>
      "notificationIds" in schedule.config ? schedule.config.notificationIds : [],
    ),
  );
}

export function updateNotificationScheduleAssignment(
  notificationId: number,
  scheduleId: number | null,
): void {
  updateNotificationScheduleAssignments(
    notificationId,
    scheduleId === null ? [] : [scheduleId],
  );
}

export function updateNotificationScheduleAssignments(
  notificationId: number,
  scheduleIds: number[],
): void {
  const db = getDb();
  const notification = db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.id, notificationId))
    .get();
  if (!notification) throw new Error("Notification channel not found");

  const targetIds = new Set(
    scheduleIds.filter((id) => Number.isInteger(id) && id > 0),
  );
  const rows = db.select().from(schedules).all();
  const notificationScheduleRows = rows.filter((row) => {
    const type = VALID_TYPES.includes(row.type as ScheduleType)
      ? (row.type as ScheduleType)
      : "refresh";
    return type === "notification_digest";
  });
  const existingScheduleIds = new Set(notificationScheduleRows.map((row) => row.id));
  const missingIds = Array.from(targetIds).filter((id) => !existingScheduleIds.has(id));
  if (missingIds.length > 0) {
    throw new Error(`Schedule not found: ${missingIds.join(", ")}`);
  }

  const now = nowSql();
  for (const row of notificationScheduleRows) {
    const config = normalizeScheduleConfig("notification_digest", parseConfig(row.config));
    if (!("notificationIds" in config)) continue;

    const ids = config.notificationIds.filter((id) => id !== notificationId);
    if (targetIds.has(row.id)) ids.push(notificationId);

    const nextConfig: NotificationScheduleConfig = {
      cron: config.cron,
      notificationIds: Array.from(new Set(ids)),
    };

    if (JSON.stringify(nextConfig) === row.config) continue;

    db.update(schedules)
      .set({ config: JSON.stringify(nextConfig), updatedAt: now })
      .where(eq(schedules.id, row.id))
      .run();
  }
}

export function getScopedSystemIds(systemIds: number[] | null): number[] {
  if (systemIds !== null) return systemIds;
  return getDb()
    .select({ id: systems.id })
    .from(systems)
    .all()
    .map((row) => row.id);
}

export function isSystemCacheStale(systemId: number, cacheDurationHours: number): boolean {
  if (cacheDurationHours === 0) return true;
  const lastCheckedAt = cacheService.getCacheTimestamp(systemId);
  if (!lastCheckedAt) return true;

  try {
    const cachedDate = new Date(`${lastCheckedAt}Z`);
    const threshold = new Date(Date.now() - cacheDurationHours * 60 * 60 * 1000);
    return cachedDate < threshold;
  } catch {
    return true;
  }
}

export function getKnownSystemIds(): Set<number> {
  return new Set(systemService.listSystems().map((system) => system.id));
}

export function markScheduleStarted(id: number): void {
  getDb()
    .update(schedules)
    .set({ lastStartedAt: nowSql(), updatedAt: nowSql() })
    .where(eq(schedules.id, id))
    .run();
}

export function markScheduleFinished(
  id: number,
  status: ScheduleRunStatus,
  message: string,
): void {
  const now = nowSql();
  getDb()
    .update(schedules)
    .set({
      lastRunAt: now,
      lastRunStatus: status,
      lastRunMessage: truncateRunMessage(message),
      updatedAt: now,
    })
    .where(eq(schedules.id, id))
    .run();
}
