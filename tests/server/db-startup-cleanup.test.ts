import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
import { listSystems } from "../../server/services/system-service";

describe("database startup cleanup", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-db-cleanup-test-"));
    dbPath = join(tempDir, "dashboard.db");
    initDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("marks orphaned SSH-safe upgrade rows as warning after restart", () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get();

    const history = db.insert(updateHistory).values({
      systemId: inserted.id,
      action: "upgrade_all",
      pkgManager: "apt",
      status: "started",
      command: "sudo apt-get upgrade -y",
    }).returning({ id: updateHistory.id }).get();

    closeDatabase();
    initDatabase(dbPath);

    const restartedDb = getDb();
    const row = restartedDb
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.id, history.id))
      .get();

    expect(row?.status).toBe("warning");
    expect(row?.output).toBe("Server restarted while operation was in progress");
    expect(row?.error).toBeNull();
    expect(row?.completedAt).not.toBeNull();
  });

  test("marks orphaned non-SSH-safe rows as failed after restart", () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get();

    const history = db.insert(updateHistory).values({
      systemId: inserted.id,
      action: "check",
      pkgManager: "apt",
      status: "started",
      command: "apt-get update",
    }).returning({ id: updateHistory.id }).get();

    closeDatabase();
    initDatabase(dbPath);

    const restartedDb = getDb();
    const row = restartedDb
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.id, history.id))
      .get();

    expect(row?.status).toBe("failed");
    expect(row?.output).toBeNull();
    expect(row?.error).toBe("Server restarted while operation was in progress");
    expect(row?.completedAt).not.toBeNull();
  });

  test("assigns alphabetical sort order when existing systems all use the default order", () => {
    const db = getDb();
    db.insert(systems).values([
      {
        name: "Zulu",
        hostname: "zulu.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        name: "Mike",
        hostname: "mike.local",
        port: 22,
        authType: "password",
        username: "root",
      },
    ]).run();

    closeDatabase();
    initDatabase(dbPath);

    expect(listSystems().map((system) => system.name)).toEqual([
      "Alpha",
      "Mike",
      "Zulu",
    ]);
  });

  test("preserves a custom sort order on restart", () => {
    const db = getDb();
    db.insert(systems).values([
      {
        sortOrder: 2,
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        sortOrder: 0,
        name: "Zulu",
        hostname: "zulu.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        sortOrder: 1,
        name: "Mike",
        hostname: "mike.local",
        port: 22,
        authType: "password",
        username: "root",
      },
    ]).run();

    closeDatabase();
    initDatabase(dbPath);

    expect(listSystems().map((system) => system.name)).toEqual([
      "Zulu",
      "Mike",
      "Alpha",
    ]);
  });
});
