import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { updateCache, settings, systems } from "../db/schema";

function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get();
  return row?.value;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function getCacheDurationHours(): number {
  return parseNonNegativeInt(getSetting("cache_duration_hours"), 12);
}

export function getCheckIntervalMinutes(): number {
  return parseNonNegativeInt(getSetting("check_interval_minutes"), 15);
}

export function getCachedUpdates(systemId: number) {
  const db = getDb();
  return db
    .select()
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .orderBy(updateCache.packageName)
    .all();
}

export function getCacheTimestamp(systemId: number): string | null {
  const db = getDb();
  const row = db
    .select({
      maxCachedAt: sql<string>`max(${updateCache.cachedAt})`,
      lastSeenAt: systems.lastSeenAt,
    })
    .from(systems)
    .leftJoin(updateCache, eq(updateCache.systemId, systems.id))
    .where(eq(systems.id, systemId))
    .groupBy(systems.id, systems.lastSeenAt)
    .get();

  return row?.maxCachedAt || row?.lastSeenAt || null;
}

export function isCacheStale(systemId: number): boolean {
  const cacheHours = getCacheDurationHours();
  if (cacheHours === 0) return true;
  const lastCached = getCacheTimestamp(systemId);
  if (!lastCached) return true;

  try {
    const cachedDate = new Date(lastCached + "Z");
    const threshold = new Date(Date.now() - cacheHours * 60 * 60 * 1000);
    return cachedDate < threshold;
  } catch {
    return true;
  }
}

export function getCacheAge(systemId: number): string | null {
  const lastCached = getCacheTimestamp(systemId);
  if (!lastCached) return null;

  try {
    const cachedDate = new Date(lastCached + "Z");
    const diffMs = Date.now() - cachedDate.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return null;
  }
}

export function invalidateCache(systemId?: number): void {
  const db = getDb();
  if (systemId) {
    db.delete(updateCache).where(eq(updateCache.systemId, systemId)).run();
  } else {
    db.delete(updateCache).run();
  }
}

export function getAllSystemIds(): number[] {
  const db = getDb();
  return db
    .select({ id: systems.id })
    .from(systems)
    .all()
    .map((r) => r.id);
}

export function getStaleSystemIds(): number[] {
  const cacheHours = getCacheDurationHours();
  if (cacheHours === 0) return getAllSystemIds();
  const threshold = new Date(
    Date.now() - cacheHours * 60 * 60 * 1000
  ).toISOString().replace("T", " ").slice(0, 19);

  const db = getDb();
  const freshnessRows = db
    .select({
      id: systems.id,
      maxCachedAt: sql<string>`max(${updateCache.cachedAt})`,
      lastSeenAt: systems.lastSeenAt,
    })
    .from(systems)
    .leftJoin(updateCache, eq(updateCache.systemId, systems.id))
    .groupBy(systems.id, systems.lastSeenAt)
    .all();

  return freshnessRows
    .filter((row) => {
      const lastCheckedAt = row.maxCachedAt || row.lastSeenAt;
      return !lastCheckedAt || lastCheckedAt <= threshold;
    })
    .map((row) => row.id);
}
