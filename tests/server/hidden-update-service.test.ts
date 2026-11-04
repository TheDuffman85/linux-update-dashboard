import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
  autoHideCachedKeptBackUpdates,
  autoHideKeptBackUpdatesForCheck,
  reconcileCachedKeptBackAutoHide,
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
    expect(summary).toEqual({ updateCount: 1, securityCount: 0, keptBackCount: 0 });
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
        isKeptBack: false,
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
        isKeptBack: false,
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
        isKeptBack: false,
      },
    ], ["apt"]);

    const remaining = getDb()
      .select()
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.systemId, systemId))
      .all();
    expect(remaining).toHaveLength(0);
  });

  test("can auto-hide kept-back updates already in cache for one enabled system", () => {
    const db = getDb();
    const systemId = createSystem();

    db.update(systems)
      .set({ autoHideKeptBackUpdates: 1 })
      .where(eq(systems.id, systemId))
      .run();

    db.insert(updateCache).values([
      {
        systemId,
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        isKeptBack: 1,
      },
      {
        systemId,
        pkgManager: "apt",
        packageName: "curl",
        currentVersion: "8.0",
        newVersion: "8.1",
        isKeptBack: 0,
      },
    ]).run();

    autoHideCachedKeptBackUpdates(systemId);

    expect(getVisibleCachedUpdates(systemId).map((update) => update.packageName)).toEqual(["curl"]);
    expect(getVisibleUpdateSummary(systemId)).toEqual({
      updateCount: 1,
      securityCount: 0,
      keptBackCount: 0,
    });
    expect(listActiveHiddenUpdates(systemId).map((update) => update.packageName)).toEqual(["bash"]);
    expect(listActiveHiddenUpdates(systemId)[0].hideReason).toBe("kept_back");
  });

  test("returns auto-hidden updates when they are no longer kept back", () => {
    const db = getDb();
    const systemId = createSystem();

    db.update(systems)
      .set({ autoHideKeptBackUpdates: 1 })
      .where(eq(systems.id, systemId))
      .run();
    db.insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "bash",
      currentVersion: "5.1",
      newVersion: "5.2",
      isKeptBack: 1,
    }).run();

    autoHideCachedKeptBackUpdates(systemId);
    expect(getVisibleCachedUpdates(systemId)).toHaveLength(0);

    db.update(updateCache)
      .set({ isKeptBack: 0 })
      .where(eq(updateCache.systemId, systemId))
      .run();
    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        architecture: null,
        repository: "stable",
        isSecurity: false,
        isKeptBack: false,
      },
    ], ["apt"]);

    expect(getVisibleCachedUpdates(systemId).map((update) => update.packageName)).toEqual(["bash"]);
    expect(listActiveHiddenUpdates(systemId)).toHaveLength(0);

    db.update(updateCache)
      .set({ isKeptBack: 1 })
      .where(eq(updateCache.systemId, systemId))
      .run();
    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        architecture: null,
        repository: "stable",
        isSecurity: false,
        isKeptBack: true,
      },
    ], ["apt"]);

    expect(listActiveHiddenUpdates(systemId)).toHaveLength(1);

    db.update(systems)
      .set({ autoHideKeptBackUpdates: 0 })
      .where(eq(systems.id, systemId))
      .run();
    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        architecture: null,
        repository: "stable",
        isSecurity: false,
        isKeptBack: true,
      },
    ], ["apt"]);

    expect(listActiveHiddenUpdates(systemId)).toHaveLength(0);
  });

  test("keeps manual hides active when kept-back status changes", () => {
    const db = getDb();
    const systemId = createSystem();

    db.update(systems)
      .set({ autoHideKeptBackUpdates: 1 })
      .where(eq(systems.id, systemId))
      .run();
    db.insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "bash",
      currentVersion: "5.1",
      newVersion: "5.2",
      isKeptBack: 1,
    }).run();

    createHiddenUpdate(systemId, {
      pkgManager: "apt",
      packageName: "bash",
      newVersion: "5.2",
    });
    autoHideCachedKeptBackUpdates(systemId);

    db.update(updateCache)
      .set({ isKeptBack: 0 })
      .where(eq(updateCache.systemId, systemId))
      .run();
    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        architecture: null,
        repository: "stable",
        isSecurity: false,
        isKeptBack: false,
      },
    ], ["apt"]);

    const active = listActiveHiddenUpdates(systemId);
    expect(active).toHaveLength(1);
    expect(active[0].hideReason).toBe("manual");
    expect(active[0].isKeptBack).toBe(0);
  });

  test("does not reconcile APT hidden rows after another manager succeeds", () => {
    const db = getDb();
    const systemId = createSystem();

    db.update(systems)
      .set({ autoHideKeptBackUpdates: 1 })
      .where(eq(systems.id, systemId))
      .run();
    db.insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "bash",
      currentVersion: "5.1",
      newVersion: "5.2",
      isKeptBack: 1,
    }).run();
    autoHideCachedKeptBackUpdates(systemId);

    syncHiddenUpdatesForCheck(systemId, [
      {
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
        architecture: null,
        repository: "stable",
        isSecurity: false,
        isKeptBack: false,
      },
    ], ["dnf"]);

    const active = listActiveHiddenUpdates(systemId);
    expect(active).toHaveLength(1);
    expect(active[0].isKeptBack).toBe(1);
  });

  describe("per-manager auto-hide of pinned updates", () => {
    const parsed = (pkgManager: string, packageName: string, isKeptBack: boolean) => ({
      pkgManager,
      packageName,
      currentVersion: "1.0",
      newVersion: "2.0",
      architecture: null,
      repository: null,
      isSecurity: false,
      isKeptBack,
    });

    function seed(systemId: number, configs: unknown, rows: Array<ReturnType<typeof parsed>>) {
      const db = getDb();
      db.update(systems)
        .set({ pkgManagerConfigs: JSON.stringify(configs) })
        .where(eq(systems.id, systemId))
        .run();
      for (const row of rows) {
        db.insert(updateCache).values({ ...row, systemId, isSecurity: 0, isKeptBack: row.isKeptBack ? 1 : 0 }).run();
      }
    }

    test.each(["apk", "pacman", "flatpak", "snap", "deb-get"])(
      "hides pinned %s updates by default so they do not count as pending",
      (pkgManager) => {
        const systemId = createSystem();
        const updates = [parsed(pkgManager, "pinned-pkg", true), parsed(pkgManager, "free-pkg", false)];
        seed(systemId, {}, updates);

        autoHideKeptBackUpdatesForCheck(systemId, updates, [pkgManager]);

        expect(listActiveHiddenUpdates(systemId).map((update) => update.packageName)).toEqual(["pinned-pkg"]);
        expect(getVisibleUpdateSummary(systemId)).toEqual({ updateCount: 1, securityCount: 0, keptBackCount: 0 });
      },
    );

    test("does not hide kept-back APT updates by default", () => {
      const systemId = createSystem();
      seed(systemId, {}, [parsed("apt", "bash", true)]);

      autoHideCachedKeptBackUpdates(systemId);

      expect(listActiveHiddenUpdates(systemId)).toEqual([]);
    });

    test("turning it off applies only to that manager", () => {
      const systemId = createSystem();
      seed(systemId, { apk: { autoHideKeptBackUpdates: false } }, [
        parsed("apk", "kernel", true),
        parsed("pacman", "linux", true),
      ]);

      autoHideCachedKeptBackUpdates(systemId);

      expect(listActiveHiddenUpdates(systemId).map((update) => update.packageName)).toEqual(["linux"]);
    });

    test("turning off the APT setting does not affect pinned updates of other managers", () => {
      const systemId = createSystem();
      seed(systemId, { apt: { autoHideKeptBackUpdates: false } }, [
        parsed("apk", "kernel", true),
        parsed("apt", "bash", true),
      ]);

      autoHideCachedKeptBackUpdates(systemId);

      expect(listActiveHiddenUpdates(systemId).map((update) => update.packageName)).toEqual(["kernel"]);
    });

    test("stays hidden across checks and returns once the pin is gone", () => {
      const systemId = createSystem();
      seed(systemId, {}, [parsed("snap", "core22", true)]);
      autoHideCachedKeptBackUpdates(systemId);

      syncHiddenUpdatesForCheck(systemId, [parsed("snap", "core22", true)], ["snap"]);
      expect(listActiveHiddenUpdates(systemId).map((update) => update.packageName)).toEqual(["core22"]);

      syncHiddenUpdatesForCheck(systemId, [parsed("snap", "core22", false)], ["snap"]);
      expect(listActiveHiddenUpdates(systemId)).toEqual([]);
    });

    test("reconciling after a settings change affects only that manager", () => {
      const systemId = createSystem();
      seed(systemId, {}, [parsed("apk", "kernel", true), parsed("flatpak", "org.gnome.Logs", true)]);
      autoHideCachedKeptBackUpdates(systemId);
      expect(listActiveHiddenUpdates(systemId)).toHaveLength(2);

      getDb().update(systems)
        .set({ pkgManagerConfigs: JSON.stringify({ apk: { autoHideKeptBackUpdates: false } }) })
        .where(eq(systems.id, systemId))
        .run();
      reconcileCachedKeptBackAutoHide(systemId);

      expect(listActiveHiddenUpdates(systemId).map((update) => update.packageName)).toEqual(["org.gnome.Logs"]);
    });
  });
});
