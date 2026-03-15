import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { hiddenUpdates, systems, updateCache } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  HIDDEN_UPDATE_RETENTION_DAYS,
  createHiddenUpdate,
  getVisibleCachedUpdates,
  getVisibleUpdateSummary,
  listActiveHiddenUpdates,
  syncHiddenUpdatesForCheck,
} from "../../server/services/hidden-update-service";

describe("hidden update service", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-hidden-updates-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSystem(): number {
    return getDb()
      .insert(systems)
      .values({
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      })
      .returning({ id: systems.id })
      .get().id;
  }

  test("hides only the exact package version from visible update counts", () => {
    const systemId = createSystem();
    getDb().insert(updateCache).values([
      {
        systemId,
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        isSecurity: 1,
      },
      {
        systemId,
        pkgManager: "apt",
        packageName: "curl",
        currentVersion: "8.0",
        newVersion: "8.1",
        isSecurity: 0,
      },
    ]).run();

    createHiddenUpdate(systemId, {
      pkgManager: "apt",
      packageName: "bash",
      newVersion: "5.2",
    });

    const visible = getVisibleCachedUpdates(systemId);
    const summary = getVisibleUpdateSummary(systemId);

    expect(visible.map((update) => update.packageName)).toEqual(["curl"]);
    expect(summary).toEqual({ updateCount: 1, securityCount: 0 });
    expect(listActiveHiddenUpdates(systemId)).toHaveLength(1);
  });

  test("marks hidden updates inactive when the exact version disappears and reactivates them if it returns", () => {
    const systemId = createSystem();
    getDb().insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "bash",
      currentVersion: "5.1",
      newVersion: "5.2",
      isSecurity: 0,
    }).run();

    createHiddenUpdate(systemId, {
      pkgManager: "apt",
      packageName: "bash",
      newVersion: "5.2",
    });

    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "curl",
        currentVersion: "8.0",
        newVersion: "8.1",
        architecture: null,
        repository: "stable",
        isSecurity: false,
      },
    ], ["apt"]);

    expect(listActiveHiddenUpdates(systemId)).toHaveLength(0);
    const inactive = getDb()
      .select()
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.systemId, systemId))
      .get();
    expect(inactive?.active).toBe(0);
    expect(inactive?.inactiveSince).not.toBeNull();

    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        architecture: null,
        repository: "stable",
        isSecurity: false,
      },
    ], ["apt"]);

    const active = listActiveHiddenUpdates(systemId);
    expect(active).toHaveLength(1);
    expect(active[0].inactiveSince).toBeNull();
  });

  test("deletes stale inactive hidden updates only after a later confirming check", () => {
    const systemId = createSystem();
    getDb().insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "bash",
      currentVersion: "5.1",
      newVersion: "5.2",
      isSecurity: 0,
    }).run();

    createHiddenUpdate(systemId, {
      pkgManager: "apt",
      packageName: "bash",
      newVersion: "5.2",
    });

    const staleInactiveSince = new Date(
      Date.now() - (HIDDEN_UPDATE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString().replace("T", " ").slice(0, 19);

    getDb().update(hiddenUpdates)
      .set({
        active: 0,
        inactiveSince: staleInactiveSince,
      })
      .where(eq(hiddenUpdates.systemId, systemId))
      .run();

    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "curl",
        currentVersion: "8.0",
        newVersion: "8.1",
        architecture: null,
        repository: "stable",
        isSecurity: false,
      },
    ], ["apt"]);

    const remaining = getDb()
      .select()
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.systemId, systemId))
      .all();
    expect(remaining).toHaveLength(0);
  });
});
