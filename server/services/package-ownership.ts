import type { ParsedUpdate } from "../ssh/parsers";
import * as installedPackageService from "./installed-package-service";

/**
 * Some package managers install packages through another one. deb-get installs
 * downloaded .deb files with apt-get, so its apps also appear in dpkg and, when a
 * vendor package adds its own APT source, in APT updates. The owner reports
 * those packages; the underlying manager must not report them a second time.
 */
const PACKAGE_OWNERSHIP_CLAIMS: ReadonlyArray<{ owner: string; claimsFrom: string }> = [
  { owner: "deb-get", claimsFrom: "apt" },
];

export function applyPackageOwnershipClaims(
  systemId: number,
  activeManagers: string[],
  updates: ParsedUpdate[],
): ParsedUpdate[] {
  let result = updates;
  for (const claim of PACKAGE_OWNERSHIP_CLAIMS) {
    if (!activeManagers.includes(claim.owner) || !activeManagers.includes(claim.claimsFrom)) continue;
    const owned = new Set(
      installedPackageService.getInstalledPackages(systemId)
        .filter((pkg) => pkg.pkgManager === claim.owner)
        .map((pkg) => pkg.packageName),
    );
    for (const update of updates) {
      if (update.pkgManager === claim.owner) owned.add(update.packageName);
    }
    if (owned.size === 0) continue;
    result = result.filter((update) =>
      !(update.pkgManager === claim.claimsFrom && owned.has(update.packageName)));
    installedPackageService.removeInstalledPackagesByName(systemId, claim.claimsFrom, [...owned]);
  }
  return result;
}
