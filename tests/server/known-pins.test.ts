import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { knownPins, systems } from "../../server/db/schema";
import { reconcileKnownPins } from "../../server/services/known-pin-service";
import type { ParsedUpdate } from "../../server/ssh/parsers";

function update(packageName: string, isKeptBack: boolean, pkgManager = "flatpak"): ParsedUpdate {
  return {
    packageName, currentVersion: "1.0", newVersion: "2.0", architecture: null,
    repository: null, isSecurity: false, isKeptBack, pkgManager,
  };
}

describe("known pins", () => {
  let dir: string;
  let dbPath: string;
  let systemId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ludash-known-pins-"));
    dbPath = join(dir, "dashboard.db");
    initDatabase(dbPath);
    systemId = getDb().insert(systems).values({
      name: "Host", hostname: "host.local", authType: "password", username: "root",
    }).returning({ id: systems.id }).get().id;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  const stored = (pkgManager = "flatpak") => getDb()
    .select({ packageName: knownPins.packageName })
    .from(knownPins)
    .where(eq(knownPins.pkgManager, pkgManager))
    .all()
    .map((row) => row.packageName)
    .sort();

  test("a complete detection replaces the manager's pins and leaves updates unchanged", () => {
    reconcileKnownPins(systemId, "flatpak", [update("old", true)], false);
    const updates = [update("new", true), update("free", false)];
    expect(reconcileKnownPins(systemId, "flatpak", updates, false)).toEqual(updates);
    expect(stored()).toEqual(["new"]);
  });

  test("an incomplete detection marks known pins and keeps those not currently listed", () => {
    reconcileKnownPins(systemId, "flatpak", [update("known", true), update("unlisted", true)], false);
    const result = reconcileKnownPins(systemId, "flatpak", [update("known", false), update("free", false)], true);
    expect(result.map((entry) => [entry.packageName, entry.isKeptBack])).toEqual([["known", true], ["free", false]]);
    expect(stored()).toEqual(["known", "unlisted"]);
  });

  test("an incomplete detection adds pins it could still find", () => {
    reconcileKnownPins(systemId, "apk", [update("known", true, "apk")], false);
    reconcileKnownPins(systemId, "apk", [update("exact", true, "apk")], true);
    expect(stored("apk")).toEqual(["exact", "known"]);
  });

  test("pins are separate per package manager and removed with the system", () => {
    reconcileKnownPins(systemId, "flatpak", [update("app", true)], false);
    reconcileKnownPins(systemId, "snap", [], false);
    expect(stored()).toEqual(["app"]);

    getDb().delete(systems).where(eq(systems.id, systemId)).run();
    expect(stored()).toEqual([]);
  });

  test("upgrading seeds pins from cached and hidden updates once", () => {
    closeDatabase();
    const sqlite = new Database(dbPath);
    sqlite.exec(`
      DROP TABLE known_pins;
      DELETE FROM settings WHERE key = 'known_pins_migrated';
      INSERT INTO update_cache (system_id, pkg_manager, package_name, new_version, is_kept_back) VALUES
        (${systemId}, 'flatpak', 'cached-pin', '2.0', 1),
        (${systemId}, 'flatpak', 'both', '2.0', 1),
        (${systemId}, 'flatpak', 'free', '2.0', 0),
        (${systemId}, 'apt', 'apt-kept-back', '2.0', 1),
        (${systemId}, 'pacman', 'ignored', '2.0', 1);
      INSERT INTO hidden_updates (system_id, pkg_manager, package_name, new_version, is_kept_back, hide_reason, active) VALUES
        (${systemId}, 'flatpak', 'both', '2.0', 1, 'kept_back', 1),
        (${systemId}, 'snap', 'hidden-pin', '2.0', 0, 'kept_back', 1),
        (${systemId}, 'snap', 'released', '2.0', 1, 'kept_back', 0),
        (${systemId}, 'snap', 'manually-hidden', '2.0', 0, 'manual', 1);
    `);
    sqlite.close();

    initDatabase(dbPath);
    expect(stored()).toEqual(["both", "cached-pin"]);
    expect(stored("snap")).toEqual(["hidden-pin"]);
    expect(stored("apt")).toEqual([]);
    expect(stored("pacman")).toEqual([]);

    reconcileKnownPins(systemId, "flatpak", [], false);
    closeDatabase();
    initDatabase(dbPath);
    expect(stored()).toEqual([]);
  });
});
