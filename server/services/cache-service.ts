import { eq, sql, gt } from "drizzle-orm";
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

export function getCacheDurationHours(): number {
  return parseInt(getSetting("cache_duration_hours") || "12", 10);
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

export function isCacheStale(systemId: number): boolean {
  const cacheHours = getCacheDurationHours();
  const db = getDb();
  const row = db
    .select({ maxCachedAt: sql<string>`max(${updateCache.cachedAt})` })
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .get();

  const lastCached = row?.maxCachedAt;
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
  const db = getDb();
  const row = db
    .select({ maxCachedAt: sql<string>`max(${updateCache.cachedAt})` })
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .get();

  const lastCached = row?.maxCachedAt;
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

export function getStaleSystemIds(): number[] {
  const cacheHours = getCacheDurationHours();
  const threshold = new Date(
    Date.now() - cacheHours * 60 * 60 * 1000
  ).toISOString().replace("T", " ").slice(0, 19);

  const db = getDb();

  const allIds = db
    .select({ id: systems.id })
    .from(systems)
    .all()
    .map((r) => r.id);

  const freshRows = db
    .select({ systemId: updateCache.systemId })
    .from(updateCache)
    .where(gt(updateCache.cachedAt, threshold))
    .groupBy(updateCache.systemId)
    .all();
  const freshIds = new Set(freshRows.map((r) => r.systemId));

  return allIds.filter((id) => !freshIds.has(id));
}
