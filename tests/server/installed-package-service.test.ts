import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { installedPackageCache, systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  getInstalledPackages,
  pruneInstalledPackagesForInactiveManagers,
  replaceInstalledPackagesForManager,
} from "../../server/services/installed-package-service";

describe("installed package cache", () => {
  let tempDir: string;
  let systemId: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-installed-packages-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    systemId = getDb().insert(systems).values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("replaces manager snapshots atomically, including successful empty results", () => {
    replaceInstalledPackagesForManager(systemId, "apt", [
      {
        pkgManager: "apt",
        packageName: "curl",
        currentVersion: "7.0",
        architecture: "amd64",
        repository: null,
      },
      {
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.2",
        architecture: "amd64",
        repository: null,
      },
    ]);
    replaceInstalledPackagesForManager(systemId, "apt", [
      {
        pkgManager: "apt",
        packageName: "curl",
        currentVersion: "8.0",
        architecture: "amd64",
        repository: null,
      },
    ]);

    expect(getInstalledPackages(systemId)).toMatchObject([
      {
        pkgManager: "apt",
        packageName: "curl",
        currentVersion: "8.0",
        architecture: "amd64",
      },
    ]);

    replaceInstalledPackagesForManager(systemId, "apt", []);
    expect(getInstalledPackages(systemId)).toEqual([]);
  });

  test("prunes inactive managers and cascades rows when a system is deleted", () => {
    replaceInstalledPackagesForManager(systemId, "apt", [{
      pkgManager: "apt",
      packageName: "curl",
      currentVersion: "8.0",
      architecture: "amd64",
      repository: null,
    }]);
    replaceInstalledPackagesForManager(systemId, "snap", [{
      pkgManager: "snap",
      packageName: "hello-world",
      currentVersion: "6.4",
      architecture: null,
      repository: "snap",
    }]);

    pruneInstalledPackagesForInactiveManagers(systemId, ["apt"]);
    expect(getInstalledPackages(systemId).map((pkg) => pkg.pkgManager)).toEqual(["apt"]);

    pruneInstalledPackagesForInactiveManagers(systemId, []);
    expect(getInstalledPackages(systemId)).toEqual([]);

    replaceInstalledPackagesForManager(systemId, "apt", [{
      pkgManager: "apt",
      packageName: "curl",
      currentVersion: "8.0",
      architecture: "amd64",
      repository: null,
    }]);
    getDb().delete(systems).where(eq(systems.id, systemId)).run();
    expect(getDb().select().from(installedPackageCache).all()).toEqual([]);
  });
});
