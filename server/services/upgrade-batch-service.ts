import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { systems, updateHistory, upgradeBatchItems, upgradeBatches, upgradeGroups } from "../db/schema";
import { sanitizeCommand, sanitizeOutput } from "../utils/sanitize";
import * as systemService from "./system-service";
import * as updateService from "./update-service";
import type { DefaultUpgradeModeOverride } from "./update-service";
import type { PersistentCommandInfo } from "../ssh/connection";
import { logger } from "../logger";

type BatchStatus = "queued" | "running" | "success" | "warning" | "failed" | "cancelled";
type ItemStatus = "queued" | "running" | "success" | "warning" | "failed" | "cancelled";

interface BatchItemInput {
  systemId: number;
  defaultUpgradeModeOverride?: DefaultUpgradeModeOverride;
}

function now(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function terminalStatuses(): ItemStatus[] {
  return ["success", "warning", "failed", "cancelled"];
}

function isTerminal(status: string): boolean {
  return terminalStatuses().includes(status as ItemStatus);
}

function getActiveBatch() {
  return getDb()
    .select()
    .from(upgradeBatches)
    .where(sql`${upgradeBatches.status} IN ('queued', 'running')`)
    .orderBy(asc(upgradeBatches.createdAt), asc(upgradeBatches.id))
    .get();
}

function getSystemUpdateCounts(): Map<number, number> {
  return new Map(
    systemService
      .listVisibleSystemsWithUpdateCounts()
      .map((system) => [system.id, system.updateCount])
  );
}

function validateBatchItems(items: BatchItemInput[]): BatchItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one system is required");
  }
  const seen = new Set<number>();
  const updateCounts = getSystemUpdateCounts();
  const normalized: BatchItemInput[] = [];
  for (const item of items) {
    if (!Number.isInteger(item.systemId) || item.systemId <= 0) {
      throw new Error("System IDs must be positive integers");
    }
    if (seen.has(item.systemId)) {
      throw new Error("System list contains duplicate IDs");
    }
    if (!updateCounts.has(item.systemId)) {
      throw new Error("System is not visible");
    }
    if ((updateCounts.get(item.systemId) ?? 0) <= 0) {
      throw new Error("Only systems with updates can be queued");
    }
    if (
      item.defaultUpgradeModeOverride !== undefined &&
      item.defaultUpgradeModeOverride !== "standard" &&
      item.defaultUpgradeModeOverride !== "aggressive"
    ) {
      throw new Error("defaultUpgradeModeOverride must be 'standard' or 'aggressive'");
    }
    seen.add(item.systemId);
    normalized.push({
      systemId: item.systemId,
      defaultUpgradeModeOverride: item.defaultUpgradeModeOverride,
    });
  }
  return normalized;
}

function insertQueuedHistory(input: {
  systemId: number;
  pkgManager: string;
  command: string | null;
  packageCount: number;
}): number {
  const inserted = getDb()
    .insert(updateHistory)
    .values({
      systemId: input.systemId,
      action: "upgrade_all",
      pkgManager: input.pkgManager,
      packageCount: input.packageCount,
      command: input.command ? sanitizeCommand(input.command) : null,
      status: "queued",
      startedAt: now(),
      completedAt: null,
    })
    .returning({ id: updateHistory.id })
    .get();
  updateService.pruneHistoryForSystem(input.systemId);
  return inserted.id;
}

export function createUpgradeBatch(items: BatchItemInput[], options?: { autoRun?: boolean }): { batchId: number } {
  if (getActiveBatch()) {
    throw new Error("An Upgrade All batch is already queued or running");
  }

  const normalized = validateBatchItems(items);
  const db = getDb();
  const groupRows = db.select().from(upgradeGroups).all();
  const groupsById = new Map(groupRows.map((group) => [group.id, group]));
  const ungroupedSortOrder = systemService.getUngroupedUpgradeGroupSortOrder();
  const systemsById = new Map(
    db
      .select()
      .from(systems)
      .where(inArray(systems.id, normalized.map((item) => item.systemId)))
      .all()
      .map((system) => [system.id, system])
  );
  const updateCounts = getSystemUpdateCounts();

  const batch = db
    .insert(upgradeBatches)
    .values({ status: "queued" })
    .returning({ id: upgradeBatches.id })
    .get();

  for (const item of normalized) {
    const system = systemsById.get(item.systemId);
    if (!system) continue;
    const group = system.upgradeGroupId ? groupsById.get(system.upgradeGroupId) : undefined;
    const snapshot = updateService.getUpgradeAllCommandSnapshot(item.systemId, {
      defaultUpgradeModeOverride: item.defaultUpgradeModeOverride,
    });
    const historyId = insertQueuedHistory({
      systemId: item.systemId,
      pkgManager: snapshot.pkgManager,
      command: snapshot.command,
      packageCount: updateCounts.get(item.systemId) ?? 0,
    });
    db.insert(upgradeBatchItems)
      .values({
        batchId: batch.id,
        systemId: item.systemId,
        groupId: system.upgradeGroupId ?? null,
        groupSortOrder: group?.sortOrder ?? ungroupedSortOrder,
        systemSortOrder: system.upgradeOrder ?? 1,
        defaultUpgradeModeOverride: item.defaultUpgradeModeOverride ?? null,
        status: "queued",
        command: snapshot.command,
        pkgManager: snapshot.pkgManager,
        historyId,
      })
      .run();
  }

  if (options?.autoRun !== false) {
    void runUpgradeBatches();
  }
  return { batchId: batch.id };
}

let runnerActive = false;

function getNextGroupItems(batchId: number) {
  const db = getDb();
  const activeRows = db
    .select()
    .from(upgradeBatchItems)
    .where(
      and(
        eq(upgradeBatchItems.batchId, batchId),
        sql`${upgradeBatchItems.status} IN ('queued', 'running')`,
      ),
    )
    .orderBy(
      asc(upgradeBatchItems.groupSortOrder),
      asc(upgradeBatchItems.systemSortOrder),
      asc(upgradeBatchItems.id),
    )
    .all();
  const first = activeRows[0];
  if (!first) return [];
  return activeRows.filter((row) => row.groupSortOrder === first.groupSortOrder);
}

async function runBatchItem(itemId: number): Promise<ItemStatus> {
  const db = getDb();
  const item = db.select().from(upgradeBatchItems).where(eq(upgradeBatchItems.id, itemId)).get();
  if (!item || isTerminal(item.status)) return (item?.status as ItemStatus) ?? "failed";

  const resume =
    item.status === "running" &&
    item.historyId &&
    item.currentPkgManager &&
    item.currentCommand &&
    item.remotePid &&
    item.remoteLogFile &&
    item.remoteExitFile
      ? {
          historyId: item.historyId,
          pkgManager: item.currentPkgManager,
          command: item.currentCommand,
          preUpgradeUpdateCount: item.preUpgradeUpdateCount ?? 0,
          persistentInfo: {
            pid: item.remotePid,
            logFile: item.remoteLogFile,
            exitFile: item.remoteExitFile,
            scriptFile: item.remoteScriptFile ?? undefined,
          } satisfies PersistentCommandInfo,
        }
      : undefined;

  try {
    const result = await updateService.applyUpgradeAll(item.systemId, {
      defaultUpgradeModeOverride:
        item.defaultUpgradeModeOverride === "standard" || item.defaultUpgradeModeOverride === "aggressive"
          ? item.defaultUpgradeModeOverride
          : undefined,
      queuedHistoryId: resume ? undefined : item.historyId ?? undefined,
      resume,
      onStepStarted: ({ historyId, pkgManager, command, preUpgradeUpdateCount }) => {
        db.update(upgradeBatchItems)
          .set({
            status: "running",
            historyId,
            currentPkgManager: pkgManager,
            currentCommand: command,
            preUpgradeUpdateCount,
            remotePid: null,
            remoteLogFile: null,
            remoteExitFile: null,
            remoteScriptFile: null,
            startedAt: item.startedAt ?? now(),
          })
          .where(eq(upgradeBatchItems.id, itemId))
          .run();
      },
      onPersistentInfo: ({ info }) => {
        db.update(upgradeBatchItems)
          .set({
            remotePid: info.pid,
            remoteLogFile: info.logFile,
            remoteExitFile: info.exitFile,
            remoteScriptFile: info.scriptFile ?? null,
          })
          .where(eq(upgradeBatchItems.id, itemId))
          .run();
      },
    });

    const status: ItemStatus = result.cancelled
      ? "cancelled"
      : result.warning
        ? "warning"
        : result.success
          ? "success"
          : "failed";
    db.update(upgradeBatchItems)
      .set({
        status,
        error: result.success || result.warning ? null : sanitizeOutput(result.output).slice(0, 2000),
        completedAt: now(),
      })
      .where(eq(upgradeBatchItems.id, itemId))
      .run();
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(upgradeBatchItems)
      .set({
        status: "failed",
        error: sanitizeOutput(message).slice(0, 2000),
        completedAt: now(),
      })
      .where(eq(upgradeBatchItems.id, itemId))
      .run();
    return "failed";
  }
}

function summarizeBatch(batchId: number): BatchStatus {
  const rows = getDb()
    .select({ status: upgradeBatchItems.status })
    .from(upgradeBatchItems)
    .where(eq(upgradeBatchItems.batchId, batchId))
    .all();
  if (rows.some((row) => row.status === "queued" || row.status === "running")) return "running";
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (rows.some((row) => row.status === "warning")) return "warning";
  if (rows.some((row) => row.status === "cancelled")) return "cancelled";
  return "success";
}

export async function runUpgradeBatches(): Promise<void> {
  if (runnerActive) return;
  runnerActive = true;
  try {
    while (true) {
      const batch = getActiveBatch();
      if (!batch) return;
      if (batch.status === "queued") {
        getDb().update(upgradeBatches)
          .set({ status: "running", startedAt: batch.startedAt ?? now() })
          .where(eq(upgradeBatches.id, batch.id))
          .run();
      }

      while (true) {
        const groupItems = getNextGroupItems(batch.id);
        if (groupItems.length === 0) break;
        await Promise.all(groupItems.map((item) => runBatchItem(item.id)));
      }

      const status = summarizeBatch(batch.id);
      getDb().update(upgradeBatches)
        .set({ status, completedAt: now() })
        .where(eq(upgradeBatches.id, batch.id))
        .run();
    }
  } catch (error) {
    logger.error("Upgrade batch runner failed", { error: String(error) });
  } finally {
    runnerActive = false;
  }
}

export function resumeUpgradeBatches(): void {
  const db = getDb();
  db.update(upgradeBatches)
    .set({ status: "running" })
    .where(eq(upgradeBatches.status, "queued"))
    .run();
  void runUpgradeBatches();
}

export function getQueuedOrRunningOperation(systemId: number): { type: "upgrade_all"; startedAt: string; phase: "queued" } | null {
  const item = getDb()
    .select({
      status: upgradeBatchItems.status,
      createdAt: upgradeBatchItems.createdAt,
      startedAt: upgradeBatchItems.startedAt,
    })
    .from(upgradeBatchItems)
    .innerJoin(upgradeBatches, eq(upgradeBatchItems.batchId, upgradeBatches.id))
    .where(
      and(
        eq(upgradeBatchItems.systemId, systemId),
        sql`${upgradeBatches.status} IN ('queued', 'running')`,
        sql`${upgradeBatchItems.status} IN ('queued', 'running')`,
      ),
    )
    .orderBy(desc(upgradeBatchItems.id))
    .get();
  if (!item) return null;
  return {
    type: "upgrade_all",
    startedAt: item.startedAt ?? item.createdAt,
    phase: "queued",
  };
}
