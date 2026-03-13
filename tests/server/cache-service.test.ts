import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings, systems } from "../../server/db/schema";
import {
  getCacheAge,
  getStaleSystemIds,
  isCacheStale,
} from "../../server/services/cache-service";

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

describe("cache-service", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-cache-service-"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSystem(lastSeenAt: string | null, hostSuffix = "1"): number {
    const db = getDb();
    return db
      .insert(systems)
      .values({
        name: "Test System",
        hostname: `127.0.0.${hostSuffix}`,
        username: "root",
        lastSeenAt,
      })
      .returning({ id: systems.id })
      .get().id;
  }

  test("uses the last successful check time when no updates are cached", () => {
    const systemId = createSystem(
      formatTimestamp(new Date(Date.now() - 90 * 60 * 1000))
    );

    expect(isCacheStale(systemId)).toBe(false);
    expect(getStaleSystemIds()).not.toContain(systemId);
    expect(getCacheAge(systemId)).toBe("1h ago");
  });

  test("marks systems stale once the last successful check is older than the cache duration", () => {
    const systemId = createSystem(
      formatTimestamp(new Date(Date.now() - 13 * 60 * 60 * 1000))
    );

    expect(isCacheStale(systemId)).toBe(true);
    expect(getStaleSystemIds()).toContain(systemId);
    expect(getCacheAge(systemId)).toBe("13h ago");
  });

  test("respects the configured cache duration for last successful checks", () => {
    const db = getDb();
    const systemId = createSystem(
      formatTimestamp(new Date(Date.now() - 90 * 60 * 1000))
    );

    db.update(settings)
      .set({ value: "1" })
      .where(eq(settings.key, "cache_duration_hours"))
      .run();

    expect(isCacheStale(systemId)).toBe(true);
    expect(getStaleSystemIds()).toContain(systemId);
  });

  test("treats cache duration 0 as cache disabled", () => {
    const db = getDb();
    const freshSystemId = createSystem(formatTimestamp(new Date()), "1");
    const olderSystemId = createSystem(
      formatTimestamp(new Date(Date.now() - 10 * 60 * 1000)),
      "2"
    );

    db.update(settings)
      .set({ value: "0" })
      .where(eq(settings.key, "cache_duration_hours"))
      .run();

    expect(isCacheStale(freshSystemId)).toBe(true);
    expect(isCacheStale(olderSystemId)).toBe(true);
    expect(getStaleSystemIds()).toEqual([freshSystemId, olderSystemId]);
  });
});
