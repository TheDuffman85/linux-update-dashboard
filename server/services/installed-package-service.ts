import { and, eq, notInArray } from "drizzle-orm";
import { getDb } from "../db";
import { installedPackageCache } from "../db/schema";
import type { InstalledPackage } from "../ssh/installed-packages";

export function getInstalledPackages(systemId: number) {
  return getDb()
    .select()
    .from(installedPackageCache)
    .where(eq(installedPackageCache.systemId, systemId))
    .orderBy(
      installedPackageCache.pkgManager,
      installedPackageCache.packageName,
      installedPackageCache.architecture,
      installedPackageCache.currentVersion,
    )
    .all();
}

export function replaceInstalledPackagesForManager(
  systemId: number,
  pkgManager: string,
  packages: InstalledPackage[],
): void {
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const uniquePackages = Array.from(new Map(
    packages.map((pkg) => [`${pkg.packageName}\0${pkg.architecture ?? ""}`, pkg]),
  ).values());

  db.transaction((tx) => {
    tx.delete(installedPackageCache)
      .where(and(
        eq(installedPackageCache.systemId, systemId),
        eq(installedPackageCache.pkgManager, pkgManager),
      ))
      .run();

    for (const pkg of uniquePackages) {
      tx.insert(installedPackageCache)
        .values({
          systemId,
          pkgManager,
          packageName: pkg.packageName,
          currentVersion: pkg.currentVersion,
          architecture: pkg.architecture,
          repository: pkg.repository,
          cachedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            installedPackageCache.systemId,
            installedPackageCache.pkgManager,
            installedPackageCache.packageName,
            installedPackageCache.architecture,
          ],
          set: {
            currentVersion: pkg.currentVersion,
            repository: pkg.repository,
            cachedAt: now,
          },
        })
        .run();
    }
  });
}

export function pruneInstalledPackagesForInactiveManagers(
  systemId: number,
  activeManagers: string[],
): void {
  const db = getDb();
  const systemFilter = eq(installedPackageCache.systemId, systemId);
  db.delete(installedPackageCache)
    .where(
      activeManagers.length > 0
        ? and(systemFilter, notInArray(installedPackageCache.pkgManager, activeManagers))
        : systemFilter,
    )
    .run();
}
