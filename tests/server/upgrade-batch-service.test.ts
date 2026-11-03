import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { dashboardGroups, systems, updateCache, updateHistory, upgradeBatchItems, upgradeBatches } from "../../server/db/schema";
import { createUpgradeBatch, runUpgradeBatches } from "../../server/services/upgrade-batch-service";
import { updateDashboardGroupPriority } from "../../server/services/system-service";
import * as updateService from "../../server/services/update-service";

describe("upgrade batch service", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-upgrade-batch-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("persists queued items and queued activity rows", () => {
    const db = getDb();
    const group = db.insert(dashboardGroups).values({
      name: "Wave 1",
      sortOrder: 0,
      updatePriority: 7,
    }).returning({ id: dashboardGroups.id }).get();
    updateDashboardGroupPriority(null, 3);
    const inserted = db.insert(systems).values([
      {
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
        pkgManager: "apt",
        detectedPkgManagers: JSON.stringify(["apt"]),
        dashboardGroupId: group.id,
        dashboardOrder: 2,
        updatePriority: 5,
      },
      {
        name: "Bravo",
        hostname: "bravo.local",
        port: 22,
        authType: "password",
        username: "root",
        pkgManager: "apt",
        detectedPkgManagers: JSON.stringify(["apt"]),
        dashboardOrder: 1,
        updatePriority: 9,
      },
    ]).returning({ id: systems.id }).all();
    db.insert(updateCache).values([
      {
        systemId: inserted[0].id,
        pkgManager: "apt",
        packageName: "openssl",
        newVersion: "1.2.3",
      },
      {
        systemId: inserted[1].id,
        pkgManager: "apt",
        packageName: "bash",
        newVersion: "5.3",
      },
    ]).run();

    const { batchId } = createUpgradeBatch(
      [
        { systemId: inserted[0].id, defaultUpgradeModeOverride: "aggressive" },
        { systemId: inserted[1].id },
      ],
      { autoRun: false },
    );

    expect(db.select().from(upgradeBatches).where(eq(upgradeBatches.id, batchId)).get()?.status).toBe("queued");
    const items = db
      .select()
      .from(upgradeBatchItems)
      .where(eq(upgradeBatchItems.batchId, batchId))
      .all();
    expect(items.map((item) => item.status)).toEqual(["queued", "queued"]);
    expect(items.find((item) => item.systemId === inserted[0].id)?.groupId).toBe(group.id);
    expect(items.find((item) => item.systemId === inserted[0].id)?.groupSortOrder).toBe(7);
    expect(items.find((item) => item.systemId === inserted[1].id)?.groupSortOrder).toBe(3);
    expect(items.find((item) => item.systemId === inserted[0].id)?.systemSortOrder).toBe(5);
    expect(items.find((item) => item.systemId === inserted[1].id)?.systemSortOrder).toBe(9);

    const history = db.select().from(updateHistory).all();
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.status === "queued")).toBe(true);
    expect(history.every((row) => row.action === "upgrade_all")).toBe(true);
    expect(history.every((row) => row.command?.includes("apt"))).toBe(true);
  });

  test("advances system priorities independently inside equal-priority groups", async () => {
    const db = getDb();
    const groups = db.insert(dashboardGroups).values([
      { name: "Alpha group", sortOrder: 0, updatePriority: 1 },
      { name: "Bravo group", sortOrder: 1, updatePriority: 1 },
    ]).returning({ id: dashboardGroups.id }).all();
    const inserted = db.insert(systems).values([
      { name: "Alpha 1", hostname: "alpha-1.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[0].id, updatePriority: 1 },
      { name: "Alpha 2", hostname: "alpha-2.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[0].id, updatePriority: 2 },
      { name: "Bravo 1", hostname: "bravo-1.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[1].id, updatePriority: 1 },
      { name: "Bravo 2", hostname: "bravo-2.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[1].id, updatePriority: 2 },
    ]).returning({ id: systems.id }).all();
    db.insert(updateCache).values(inserted.map((system) => ({
      systemId: system.id,
      pkgManager: "apt",
      packageName: `package-${system.id}`,
      newVersion: "2",
    }))).run();

    const started: number[] = [];
    let releaseBravoFirst!: () => void;
    const bravoFirstBlocked = new Promise<void>((resolve) => {
      releaseBravoFirst = resolve;
    });
    vi.spyOn(updateService, "applyUpgradeAll").mockImplementation(async (systemId) => {
      started.push(systemId);
      if (systemId === inserted[2].id) await bravoFirstBlocked;
      return { success: true, warning: false, cancelled: false, output: "" };
    });

    createUpgradeBatch(inserted.map((system) => ({ systemId: system.id })), {
      autoRun: false,
    });
    const running = runUpgradeBatches();
    await vi.waitFor(() => {
      expect(started).toContain(inserted[1].id);
    });
    expect(started).toContain(inserted[0].id);
    expect(started).toContain(inserted[2].id);
    expect(started).not.toContain(inserted[3].id);

    releaseBravoFirst();
    await running;
    expect(started).toContain(inserted[3].id);
  });

  test("a failed upgrade script holds back later priorities in its group only", async () => {
    const db = getDb();
    const groups = db.insert(dashboardGroups).values([
      { name: "Cluster", sortOrder: 0, updatePriority: 1 },
      { name: "Other", sortOrder: 1, updatePriority: 1 },
    ]).returning({ id: dashboardGroups.id }).all();
    const inserted = db.insert(systems).values([
      { name: "Node 1", hostname: "n1.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[0].id, updatePriority: 1 },
      { name: "Node 2", hostname: "n2.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[0].id, updatePriority: 2 },
      { name: "Other 1", hostname: "o1.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[1].id, updatePriority: 1 },
      { name: "Other 2", hostname: "o2.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', dashboardGroupId: groups[1].id, updatePriority: 2 },
    ]).returning({ id: systems.id }).all();
    db.insert(updateCache).values(inserted.map((system) => ({
      systemId: system.id,
      pkgManager: "apt",
      packageName: `package-${system.id}`,
      newVersion: "2",
    }))).run();

    const started: number[] = [];
    vi.spyOn(updateService, "applyUpgradeAll").mockImplementation(async (systemId) => {
      started.push(systemId);
      return systemId === inserted[0].id
        ? { success: false, output: "Post-upgrade script failed", hookFailed: true }
        : { success: true, output: "" };
    });

    const { batchId } = createUpgradeBatch(inserted.map((system) => ({ systemId: system.id })), {
      autoRun: false,
    });
    await runUpgradeBatches();

    expect(started.sort()).toEqual([inserted[0].id, inserted[2].id, inserted[3].id].sort());
    const items = db.select().from(upgradeBatchItems).where(eq(upgradeBatchItems.batchId, batchId)).all();
    const held = items.find((item) => item.systemId === inserted[1].id);
    expect(held?.status).toBe("cancelled");
    expect(held?.error).toContain("did not finish");
    expect(db.select().from(updateHistory).where(eq(updateHistory.id, held!.historyId!)).get()?.status).toBe("cancelled");
    expect(items.find((item) => item.systemId === inserted[0].id)?.status).toBe("failed");
    expect(items.find((item) => item.systemId === inserted[3].id)?.status).toBe("success");
    expect(db.select().from(upgradeBatches).where(eq(upgradeBatches.id, batchId)).get()?.status).toBe("failed");
  });

  describe("a restart after a script failure", () => {
    function seedInterruptedBatch(states: Array<{ priority: number; status: string; hookFailed?: number; group?: number | null }>) {
      const db = getDb();
      const batch = db.insert(upgradeBatches).values({ status: "running" }).returning({ id: upgradeBatches.id }).get();
      return states.map((state, index) => {
        const system = db.insert(systems).values({
          name: `Node ${index}`,
          hostname: `n${index}.local`,
          username: "root",
          pkgManager: "apt",
          detectedPkgManagers: '["apt"]',
        }).returning({ id: systems.id }).get();
        const history = db.insert(updateHistory).values({
          systemId: system.id,
          action: "upgrade_all",
          pkgManager: "apt",
          status: "queued",
          startedAt: "2026-01-01 00:00:00",
        }).returning({ id: updateHistory.id }).get();
        const item = db.insert(upgradeBatchItems).values({
          batchId: batch.id,
          systemId: system.id,
          groupId: state.group ?? null,
          systemSortOrder: state.priority,
          status: state.status,
          hookFailed: state.hookFailed ?? 0,
          historyId: history.id,
        }).returning({ id: upgradeBatchItems.id }).get();
        return { systemId: system.id, itemId: item.id };
      });
    }

    function itemStatus(itemId: number) {
      return getDb().select().from(upgradeBatchItems).where(eq(upgradeBatchItems.id, itemId)).get();
    }

    test("finishes the node still running, then holds later priorities", async () => {
      const [failed, running, later] = seedInterruptedBatch([
        { priority: 1, status: "failed", hookFailed: 1 },
        { priority: 1, status: "running" },
        { priority: 2, status: "queued" },
      ]);
      const started: number[] = [];
      vi.spyOn(updateService, "applyUpgradeAll").mockImplementation(async (systemId) => {
        started.push(systemId);
        return { success: true, output: "" };
      });

      await runUpgradeBatches();

      expect(started).toEqual([running.systemId]);
      expect(itemStatus(failed.itemId)?.status).toBe("failed");
      expect(itemStatus(running.itemId)?.status).toBe("success");
      expect(itemStatus(later.itemId)?.status).toBe("cancelled");
      expect(itemStatus(later.itemId)?.error).toContain("did not finish");
    });

    test("holds later priorities when nothing at the failed priority is left to run", async () => {
      const [, later, last] = seedInterruptedBatch([
        { priority: 1, status: "failed", hookFailed: 1 },
        { priority: 2, status: "queued" },
        { priority: 3, status: "queued" },
      ]);
      const applyUpgradeAll = vi.spyOn(updateService, "applyUpgradeAll");

      await runUpgradeBatches();

      expect(applyUpgradeAll).not.toHaveBeenCalled();
      expect(itemStatus(later.itemId)?.status).toBe("cancelled");
      expect(itemStatus(last.itemId)?.status).toBe("cancelled");
    });

    test("a failure in another group holds nothing back", async () => {
      const groups = getDb().insert(dashboardGroups).values([
        { name: "Cluster", sortOrder: 0, updatePriority: 0 },
        { name: "Other", sortOrder: 1, updatePriority: 0 },
      ]).returning({ id: dashboardGroups.id }).all();
      const [, other] = seedInterruptedBatch([
        { priority: 1, status: "failed", hookFailed: 1, group: groups[0].id },
        { priority: 2, status: "queued", group: groups[1].id },
      ]);
      const started: number[] = [];
      vi.spyOn(updateService, "applyUpgradeAll").mockImplementation(async (systemId) => {
        started.push(systemId);
        return { success: true, output: "" };
      });

      await runUpgradeBatches();

      expect(started).toEqual([other.systemId]);
      expect(itemStatus(other.itemId)?.status).toBe("success");
    });

    test("an ordinary failure at an earlier priority holds nothing back", async () => {
      const [, later] = seedInterruptedBatch([
        { priority: 1, status: "failed" },
        { priority: 2, status: "queued" },
      ]);
      vi.spyOn(updateService, "applyUpgradeAll").mockResolvedValue({ success: true, output: "" });

      await runUpgradeBatches();

      expect(itemStatus(later.itemId)?.status).toBe("success");
    });

    test("stores the failure with the item that hit it", async () => {
      const [item, later] = seedInterruptedBatch([
        { priority: 1, status: "queued" },
        { priority: 2, status: "queued" },
      ]);
      vi.spyOn(updateService, "applyUpgradeAll").mockImplementation(async (systemId) =>
        systemId === item.systemId
          ? { success: false, output: "Post-upgrade script failed", hookFailed: true }
          : { success: true, output: "" });

      await runUpgradeBatches();

      expect(itemStatus(item.itemId)?.hookFailed).toBe(1);
      expect(itemStatus(later.itemId)?.hookFailed).toBe(0);
      expect(itemStatus(later.itemId)?.status).toBe("cancelled");
    });
  });

  test("an ordinary upgrade failure does not hold back later priorities", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values([
      { name: "Node 1", hostname: "n1.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', updatePriority: 1 },
      { name: "Node 2", hostname: "n2.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]', updatePriority: 2 },
    ]).returning({ id: systems.id }).all();
    db.insert(updateCache).values(inserted.map((system) => ({
      systemId: system.id,
      pkgManager: "apt",
      packageName: `package-${system.id}`,
      newVersion: "2",
    }))).run();

    const started: number[] = [];
    vi.spyOn(updateService, "applyUpgradeAll").mockImplementation(async (systemId) => {
      started.push(systemId);
      return { success: systemId !== inserted[0].id, output: "" };
    });

    createUpgradeBatch(inserted.map((system) => ({ systemId: system.id })), { autoRun: false });
    await runUpgradeBatches();

    expect(started).toEqual([inserted[0].id, inserted[1].id]);
  });

  test("starts another batch for idle systems while a batch is already active", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values([
      { name: "Alpha", hostname: "alpha.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]' },
      { name: "Bravo", hostname: "bravo.local", username: "root", pkgManager: "apt", detectedPkgManagers: '["apt"]' },
    ]).returning({ id: systems.id }).all();
    db.insert(updateCache).values(inserted.map((system) => ({
      systemId: system.id,
      pkgManager: "apt",
      packageName: `package-${system.id}`,
      newVersion: "2",
    }))).run();

    const started: number[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(updateService, "applyUpgradeAll").mockImplementation(async (systemId) => {
      started.push(systemId);
      if (systemId === inserted[0].id) await firstBlocked;
      return { success: true, warning: false, cancelled: false, output: "" };
    });

    const first = createUpgradeBatch([{ systemId: inserted[0].id }]);
    await vi.waitFor(() => expect(started).toContain(inserted[0].id));
    const second = createUpgradeBatch([{ systemId: inserted[1].id }]);
    await vi.waitFor(() => expect(started).toContain(inserted[1].id));

    expect(second.batchId).not.toBe(first.batchId);
    expect(() =>
      createUpgradeBatch([{ systemId: inserted[0].id }], { autoRun: false })
    ).toThrow("already has an operation queued or running");

    releaseFirst();
    await runUpgradeBatches();
    expect(
      db.select({ status: upgradeBatches.status }).from(upgradeBatches).all(),
    ).toEqual([{ status: "success" }, { status: "success" }]);
  });
});
