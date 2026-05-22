import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateCache, updateHistory, upgradeBatchItems, upgradeBatches, upgradeGroups } from "../../server/db/schema";
import { createUpgradeBatch } from "../../server/services/upgrade-batch-service";

describe("upgrade batch service", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-upgrade-batch-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("persists queued items and queued activity rows", () => {
    const db = getDb();
    const group = db.insert(upgradeGroups).values({ name: "Wave 1", sortOrder: 0 }).returning({ id: upgradeGroups.id }).get();
    const inserted = db.insert(systems).values([
      {
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
        pkgManager: "apt",
        detectedPkgManagers: JSON.stringify(["apt"]),
        upgradeGroupId: group.id,
        upgradeOrder: 2,
      },
      {
        name: "Bravo",
        hostname: "bravo.local",
        port: 22,
        authType: "password",
        username: "root",
        pkgManager: "apt",
        detectedPkgManagers: JSON.stringify(["apt"]),
        upgradeOrder: 1,
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
    expect(items.find((item) => item.systemId === inserted[0].id)?.groupSortOrder).toBe(0);
    expect(items.find((item) => item.systemId === inserted[1].id)?.groupSortOrder).toBe(1_000_000);

    const history = db.select().from(updateHistory).all();
    expect(history).toHaveLength(2);
    expect(history.every((row) => row.status === "queued")).toBe(true);
    expect(history.every((row) => row.action === "upgrade_all")).toBe(true);
    expect(history.every((row) => row.command?.includes("apt"))).toBe(true);
  });
});
