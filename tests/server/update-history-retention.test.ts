import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings, systems, updateHistory } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { pruneHistoryForSystem } from "../../server/services/update-service";

describe("update history retention", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-history-retention-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("keeps only the newest configured history entries per system", () => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "Retention System",
      hostname: "retention.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;

    db.update(settings)
      .set({ value: "5" })
      .where(eq(settings.key, "activity_history_limit"))
      .run();

    db.insert(updateHistory).values([
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 10:00:00",
        completedAt: "2026-03-19 10:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 11:00:00",
        completedAt: "2026-03-19 11:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 12:00:00",
        completedAt: "2026-03-19 12:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 13:00:00",
        completedAt: "2026-03-19 13:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 14:00:00",
        completedAt: "2026-03-19 14:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 15:00:00",
        completedAt: "2026-03-19 15:00:05",
      },
    ]).run();

    pruneHistoryForSystem(systemId);

    const remaining = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .orderBy(updateHistory.startedAt)
      .all();

    expect(remaining).toHaveLength(5);
    expect(remaining.map((entry) => entry.startedAt)).toEqual([
      "2026-03-19 11:00:00",
      "2026-03-19 12:00:00",
      "2026-03-19 13:00:00",
      "2026-03-19 14:00:00",
      "2026-03-19 15:00:00",
    ]);
  });

  test("preserves the latest completed check even when it falls outside the visible limit", () => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "Protected Check System",
      hostname: "protected-check.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;

    db.update(settings)
      .set({ value: "5" })
      .where(eq(settings.key, "activity_history_limit"))
      .run();

    db.insert(updateHistory).values([
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "failed",
        startedAt: "2026-03-19 10:00:00",
        completedAt: "2026-03-19 10:00:05",
      },
      {
        systemId,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 11:00:00",
        completedAt: "2026-03-19 11:00:05",
      },
      {
        systemId,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 12:00:00",
        completedAt: "2026-03-19 12:00:05",
      },
      {
        systemId,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 13:00:00",
        completedAt: "2026-03-19 13:00:05",
      },
      {
        systemId,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 14:00:00",
        completedAt: "2026-03-19 14:00:05",
      },
      {
        systemId,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 15:00:00",
        completedAt: "2026-03-19 15:00:05",
      },
    ]).run();

    pruneHistoryForSystem(systemId);

    const remaining = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .orderBy(updateHistory.startedAt)
      .all();

    expect(remaining).toHaveLength(6);
    expect(remaining[0]?.action).toBe("check");
    expect(remaining[0]?.status).toBe("failed");
  });
});
