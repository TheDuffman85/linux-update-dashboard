import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { hiddenUpdates, systems, updateCache } from "../db/schema";
import type { ParsedUpdate } from "../ssh/parsers";

type CachedUpdateRow = typeof updateCache.$inferSelect;
type HiddenUpdateRow = typeof hiddenUpdates.$inferSelect;
type HiddenUpdateInsert = typeof hiddenUpdates.$inferInsert;

export const HIDDEN_UPDATE_RETENTION_DAYS = 30;
const HIDDEN_UPDATE_RETENTION_MS =
  HIDDEN_UPDATE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

interface UpdateIdentity {
  pkgManager: string;
  packageName: string;
  newVersion: string | null;
}

interface UpdateShape extends UpdateIdentity {
  currentVersion?: string | null;
  architecture?: string | null;
  repository?: string | null;
  isSecurity?: boolean | number;
  isKeptBack?: boolean | number;
}

function nowSql(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function identityKey(update: UpdateIdentity): string {
  return `${update.pkgManager}\u0000${update.packageName}\u0000${update.newVersion ?? ""}`;
}

function isPastRetentionWindow(value: string | null): boolean {
  if (!value) return false;
  const parsed = new Date(`${value}Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return Date.now() - parsed.getTime() >= HIDDEN_UPDATE_RETENTION_MS;
}

function toHiddenUpdateValues(
  systemId: number,
  update: UpdateShape,
  timestamp: string,
): HiddenUpdateInsert {
  return {
    systemId,
    pkgManager: update.pkgManager,
    packageName: update.packageName,
    currentVersion: update.currentVersion ?? null,
    newVersion: update.newVersion ?? "",
    architecture: update.architecture ?? null,
    repository: update.repository ?? null,
    isSecurity: update.isSecurity ? 1 : 0,
    isKeptBack: update.isKeptBack ? 1 : 0,
    active: 1,
    lastMatchedAt: timestamp,
    inactiveSince: null,
    updatedAt: timestamp,
  };
}

function buildActiveHiddenKeySet(rows: HiddenUpdateRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.active === 1)
      .map((row) => identityKey(row)),
  );
}

function filterVisibleUpdates(
  updates: CachedUpdateRow[],
  activeHiddenRows: HiddenUpdateRow[],
): CachedUpdateRow[] {
  const hiddenKeys = buildActiveHiddenKeySet(activeHiddenRows);
  return updates.filter((update) => !hiddenKeys.has(identityKey(update)));
}

export function listActiveHiddenUpdates(systemId: number): HiddenUpdateRow[] {
  return getDb()
    .select()
    .from(hiddenUpdates)
    .where(and(eq(hiddenUpdates.systemId, systemId), eq(hiddenUpdates.active, 1)))
    .orderBy(
      asc(hiddenUpdates.packageName),
      asc(hiddenUpdates.newVersion),
      asc(hiddenUpdates.pkgManager),
      asc(hiddenUpdates.id),
    )
    .all();
}

export function getVisibleCachedUpdates(systemId: number): CachedUpdateRow[] {
  const db = getDb();
  const updates = db
    .select()
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .orderBy(updateCache.packageName)
    .all();

  if (updates.length === 0) return [];
  return filterVisibleUpdates(updates, listActiveHiddenUpdates(systemId));
}

export function shouldAutoHideKeptBackUpdates(systemId: number): boolean {
  const row = getDb()
    .select({ autoHideKeptBackUpdates: systems.autoHideKeptBackUpdates })
    .from(systems)
    .where(eq(systems.id, systemId))
    .get();
  return row?.autoHideKeptBackUpdates === 1;
}

export function getVisibleUpdateSummary(systemId: number): {
  updateCount: number;
  securityCount: number;
  keptBackCount: number;
} {
  const visibleUpdates = getVisibleCachedUpdates(systemId);
  return {
    updateCount: visibleUpdates.length,
    securityCount: visibleUpdates.filter((update) => update.isSecurity === 1).length,
    keptBackCount: visibleUpdates.filter((update) => update.isKeptBack === 1).length,
  };
}

export function getVisibleUpdateSummaries(systemIds: number[]): Map<number, {
  updateCount: number;
  securityCount: number;
  keptBackCount: number;
}> {
  const uniqueIds = Array.from(new Set(systemIds.filter((id) => Number.isInteger(id) && id > 0)));
  const summaries = new Map<number, { updateCount: number; securityCount: number; keptBackCount: number }>();

  for (const systemId of uniqueIds) {
    summaries.set(systemId, { updateCount: 0, securityCount: 0, keptBackCount: 0 });
  }
  if (uniqueIds.length === 0) return summaries;

  const db = getDb();
  const updates = db
    .select()
    .from(updateCache)
    .where(inArray(updateCache.systemId, uniqueIds))
    .all();
  const activeHiddenRows = db
    .select()
    .from(hiddenUpdates)
    .where(
      and(
        inArray(hiddenUpdates.systemId, uniqueIds),
        eq(hiddenUpdates.active, 1),
      ),
    )
    .all();

  const hiddenBySystem = new Map<number, Set<string>>();
  for (const row of activeHiddenRows) {
    const keys = hiddenBySystem.get(row.systemId) ?? new Set<string>();
    keys.add(identityKey(row));
    hiddenBySystem.set(row.systemId, keys);
  }

  for (const update of updates) {
    const hiddenKeys = hiddenBySystem.get(update.systemId);
    if (hiddenKeys?.has(identityKey(update))) continue;

    const current = summaries.get(update.systemId) ?? {
      updateCount: 0,
      securityCount: 0,
      keptBackCount: 0,
    };
    current.updateCount += 1;
    if (update.isSecurity === 1) {
      current.securityCount += 1;
    }
    if (update.isKeptBack === 1) {
      current.keptBackCount += 1;
    }
    summaries.set(update.systemId, current);
  }

  return summaries;
}

export function createHiddenUpdate(
  systemId: number,
  input: UpdateIdentity,
): HiddenUpdateRow | null {
  const db = getDb();
  const now = nowSql();
  const cached = db
    .select()
    .from(updateCache)
    .where(
      and(
        eq(updateCache.systemId, systemId),
        eq(updateCache.pkgManager, input.pkgManager),
        eq(updateCache.packageName, input.packageName),
        eq(updateCache.newVersion, input.newVersion ?? ""),
      ),
    )
    .get();

  if (!cached) return null;

  db.insert(hiddenUpdates)
    .values(toHiddenUpdateValues(systemId, cached, now))
    .onConflictDoUpdate({
      target: [
        hiddenUpdates.systemId,
        hiddenUpdates.pkgManager,
        hiddenUpdates.packageName,
        hiddenUpdates.newVersion,
      ],
      set: {
        currentVersion: cached.currentVersion,
        architecture: cached.architecture,
        repository: cached.repository,
        isSecurity: cached.isSecurity,
        isKeptBack: cached.isKeptBack,
        active: 1,
        lastMatchedAt: now,
        inactiveSince: null,
        updatedAt: now,
      },
    })
    .run();

  return db
    .select()
    .from(hiddenUpdates)
    .where(
      and(
        eq(hiddenUpdates.systemId, systemId),
        eq(hiddenUpdates.pkgManager, cached.pkgManager),
        eq(hiddenUpdates.packageName, cached.packageName),
        eq(hiddenUpdates.newVersion, cached.newVersion),
      ),
    )
    .get() ?? null;
}

export function autoHideKeptBackUpdatesForCheck(
  systemId: number,
  updates: ParsedUpdate[],
  successfulPkgManagers: string[],
): void {
  if (!shouldAutoHideKeptBackUpdates(systemId)) return;

  const checkedManagers = new Set(
    successfulPkgManagers.filter((manager) => manager.length > 0),
  );
  if (checkedManagers.size === 0) return;

  for (const update of updates) {
    if (!update.isKeptBack || !checkedManagers.has(update.pkgManager)) continue;
    createHiddenUpdate(systemId, update);
  }
}

export function autoHideCachedKeptBackUpdates(systemId: number): void {
  if (!shouldAutoHideKeptBackUpdates(systemId)) return;

  const keptBackUpdates = getDb()
    .select({
      pkgManager: updateCache.pkgManager,
      packageName: updateCache.packageName,
      newVersion: updateCache.newVersion,
    })
    .from(updateCache)
    .where(
      and(
        eq(updateCache.systemId, systemId),
        eq(updateCache.isKeptBack, 1),
      ),
    )
    .all();

  for (const update of keptBackUpdates) {
    createHiddenUpdate(systemId, update);
  }
}

export function deleteHiddenUpdate(
  systemId: number,
  hiddenUpdateId: number,
): boolean {
  const db = getDb();
  const existing = db
    .select({ id: hiddenUpdates.id })
    .from(hiddenUpdates)
    .where(
      and(
        eq(hiddenUpdates.id, hiddenUpdateId),
        eq(hiddenUpdates.systemId, systemId),
      ),
    )
    .get();

  if (!existing) return false;
  db.delete(hiddenUpdates).where(eq(hiddenUpdates.id, hiddenUpdateId)).run();
  return true;
}

export function syncHiddenUpdatesForCheck(
  systemId: number,
  updates: ParsedUpdate[],
  successfulPkgManagers: string[],
): void {
  const checkedManagers = Array.from(
    new Set(successfulPkgManagers.filter((manager) => manager.length > 0)),
  );
  if (checkedManagers.length === 0) return;

  const db = getDb();
  const now = nowSql();
  const hiddenRows = db
    .select()
    .from(hiddenUpdates)
    .where(
      and(
        eq(hiddenUpdates.systemId, systemId),
        inArray(hiddenUpdates.pkgManager, checkedManagers),
      ),
    )
    .all();

  if (hiddenRows.length === 0) return;

  const matchingUpdates = new Map<string, ParsedUpdate>();
  for (const update of updates) {
    if (!checkedManagers.includes(update.pkgManager)) continue;
    matchingUpdates.set(identityKey(update), update);
  }

  for (const row of hiddenRows) {
    const match = matchingUpdates.get(identityKey(row));
    if (match) {
      db.update(hiddenUpdates)
        .set({
          currentVersion: match.currentVersion,
          architecture: match.architecture,
          repository: match.repository,
          isSecurity: match.isSecurity ? 1 : 0,
          isKeptBack: match.isKeptBack ? 1 : 0,
          active: 1,
          lastMatchedAt: now,
          inactiveSince: null,
          updatedAt: now,
        })
        .where(eq(hiddenUpdates.id, row.id))
        .run();
      continue;
    }

    if (row.inactiveSince && isPastRetentionWindow(row.inactiveSince)) {
      db.delete(hiddenUpdates).where(eq(hiddenUpdates.id, row.id)).run();
      continue;
    }

    db.update(hiddenUpdates)
      .set({
        active: 0,
        inactiveSince: row.inactiveSince ?? now,
        updatedAt: now,
      })
      .where(eq(hiddenUpdates.id, row.id))
      .run();
  }
}
