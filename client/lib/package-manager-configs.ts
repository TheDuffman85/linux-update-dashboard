export interface AptPackageManagerConfig {
  defaultUpgradeMode?: "upgrade" | "full-upgrade";
  autoHideKeptBackUpdates?: boolean;
}

export interface DnfPackageManagerConfig {
  defaultUpgradeMode?: "upgrade" | "distro-sync";
  refreshMetadataOnCheck?: boolean;
}

export interface PacmanPackageManagerConfig {
  refreshDatabasesOnCheck?: boolean;
}

export interface ApkPackageManagerConfig {
  refreshIndexesOnCheck?: boolean;
}

export interface FlatpakPackageManagerConfig {
  refreshAppstreamOnCheck?: boolean;
}

export interface PackageManagerConfigs {
  apt?: AptPackageManagerConfig;
  dnf?: DnfPackageManagerConfig;
  pacman?: PacmanPackageManagerConfig;
  apk?: ApkPackageManagerConfig;
  flatpak?: FlatpakPackageManagerConfig;
}

export const SUPPORTED_PACKAGE_MANAGER_CONFIGS = [
  "apt",
  "dnf",
  "pacman",
  "apk",
  "flatpak",
] as const satisfies Array<keyof PackageManagerConfigs>;

export function normalizePackageManagerConfigs(
  value: PackageManagerConfigs | null | undefined,
): PackageManagerConfigs | null {
  if (!value) return null;

  const next: PackageManagerConfigs = {};

  if (value.apt?.defaultUpgradeMode) {
    next.apt = { defaultUpgradeMode: value.apt.defaultUpgradeMode };
  }
  if (value.apt?.autoHideKeptBackUpdates !== undefined) {
    next.apt = {
      ...(next.apt ?? {}),
      autoHideKeptBackUpdates: value.apt.autoHideKeptBackUpdates,
    };
  }
  if (value.dnf?.defaultUpgradeMode !== undefined || value.dnf?.refreshMetadataOnCheck !== undefined) {
    next.dnf = {};
    if (value.dnf.defaultUpgradeMode !== undefined) {
      next.dnf.defaultUpgradeMode = value.dnf.defaultUpgradeMode;
    }
    if (value.dnf.refreshMetadataOnCheck !== undefined) {
      next.dnf.refreshMetadataOnCheck = value.dnf.refreshMetadataOnCheck;
    }
  }
  if (value.pacman?.refreshDatabasesOnCheck !== undefined) {
    next.pacman = { refreshDatabasesOnCheck: value.pacman.refreshDatabasesOnCheck };
  }
  if (value.apk?.refreshIndexesOnCheck !== undefined) {
    next.apk = { refreshIndexesOnCheck: value.apk.refreshIndexesOnCheck };
  }
  if (value.flatpak?.refreshAppstreamOnCheck !== undefined) {
    next.flatpak = { refreshAppstreamOnCheck: value.flatpak.refreshAppstreamOnCheck };
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function getUpgradeBehaviorNotes(
  managers: string[],
  configs: PackageManagerConfigs | null | undefined,
): string[] {
  const uniqueManagers = Array.from(new Set(managers));
  return uniqueManagers.flatMap((manager) => {
    if (manager === "apt" && configs?.apt?.defaultUpgradeMode === "full-upgrade") {
      return ["APT upgrade uses full-upgrade on this system."];
    }
    if (manager === "dnf" && configs?.dnf?.defaultUpgradeMode === "distro-sync") {
      return ["DNF upgrade uses distro-sync on this system."];
    }
    return [];
  });
}
