export type AptDefaultUpgradeMode = "upgrade" | "full-upgrade";
export type DnfDefaultUpgradeMode = "upgrade" | "distro-sync";

export interface AptPackageManagerConfig {
  defaultUpgradeMode?: AptDefaultUpgradeMode;
  autoHideKeptBackUpdates?: boolean;
}

export interface DnfPackageManagerConfig {
  defaultUpgradeMode?: DnfDefaultUpgradeMode;
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

export type SupportedPackageManagerConfigName = keyof PackageManagerConfigs;
export type PackageManagerConfigValue = PackageManagerConfigs[SupportedPackageManagerConfigName];

const SUPPORTED_CONFIG_MANAGERS = [
  "apt",
  "dnf",
  "pacman",
  "apk",
  "flatpak",
] as const satisfies SupportedPackageManagerConfigName[];

const UNSUPPORTED_CONFIG_MANAGERS = new Set(["yum", "snap"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parsePackageManagerConfigs(
  value: string | null | undefined,
): PackageManagerConfigs | null {
  if (!value) return null;
  try {
    return normalizePackageManagerConfigs(JSON.parse(value));
  } catch {
    return null;
  }
}

export function serializePackageManagerConfigs(
  value: PackageManagerConfigs | null | undefined,
): string | null {
  const normalized = normalizePackageManagerConfigs(value);
  return normalized ? JSON.stringify(normalized) : null;
}

export function normalizePackageManagerConfigs(
  value: unknown,
): PackageManagerConfigs | null {
  if (!isRecord(value)) return null;

  const next: PackageManagerConfigs = {};

  if (isRecord(value.apt)) {
    const apt: AptPackageManagerConfig = {};
    if (value.apt.defaultUpgradeMode === "upgrade" || value.apt.defaultUpgradeMode === "full-upgrade") {
      apt.defaultUpgradeMode = value.apt.defaultUpgradeMode;
    }
    if (typeof value.apt.autoHideKeptBackUpdates === "boolean") {
      apt.autoHideKeptBackUpdates = value.apt.autoHideKeptBackUpdates;
    }
    if (Object.keys(apt).length > 0) next.apt = apt;
  }

  if (isRecord(value.dnf)) {
    const dnf: DnfPackageManagerConfig = {};
    if (value.dnf.defaultUpgradeMode === "upgrade" || value.dnf.defaultUpgradeMode === "distro-sync") {
      dnf.defaultUpgradeMode = value.dnf.defaultUpgradeMode;
    }
    if (typeof value.dnf.refreshMetadataOnCheck === "boolean") {
      dnf.refreshMetadataOnCheck = value.dnf.refreshMetadataOnCheck;
    }
    if (Object.keys(dnf).length > 0) next.dnf = dnf;
  }

  if (isRecord(value.pacman)) {
    const pacman: PacmanPackageManagerConfig = {};
    if (typeof value.pacman.refreshDatabasesOnCheck === "boolean") {
      pacman.refreshDatabasesOnCheck = value.pacman.refreshDatabasesOnCheck;
    }
    if (Object.keys(pacman).length > 0) next.pacman = pacman;
  }

  if (isRecord(value.apk)) {
    const apk: ApkPackageManagerConfig = {};
    if (typeof value.apk.refreshIndexesOnCheck === "boolean") {
      apk.refreshIndexesOnCheck = value.apk.refreshIndexesOnCheck;
    }
    if (Object.keys(apk).length > 0) next.apk = apk;
  }

  if (isRecord(value.flatpak)) {
    const flatpak: FlatpakPackageManagerConfig = {};
    if (typeof value.flatpak.refreshAppstreamOnCheck === "boolean") {
      flatpak.refreshAppstreamOnCheck = value.flatpak.refreshAppstreamOnCheck;
    }
    if (Object.keys(flatpak).length > 0) next.flatpak = flatpak;
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function validatePackageManagerConfigsInput(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    return "pkgManagerConfigs must be an object";
  }

  for (const [manager, rawConfig] of Object.entries(value)) {
    if (UNSUPPORTED_CONFIG_MANAGERS.has(manager)) {
      return `pkgManagerConfigs.${manager} is not supported`;
    }
    if (!SUPPORTED_CONFIG_MANAGERS.includes(manager as SupportedPackageManagerConfigName)) {
      return `pkgManagerConfigs.${manager} is not a supported package manager`;
    }
    if (!isRecord(rawConfig)) {
      return `pkgManagerConfigs.${manager} must be an object`;
    }

    const keys = Object.keys(rawConfig);
    if (manager === "apt") {
      for (const key of keys) {
        if (key !== "defaultUpgradeMode" && key !== "autoHideKeptBackUpdates") {
          return `pkgManagerConfigs.apt.${key} is not supported`;
        }
      }
      if (
        rawConfig.defaultUpgradeMode !== undefined &&
        rawConfig.defaultUpgradeMode !== "upgrade" &&
        rawConfig.defaultUpgradeMode !== "full-upgrade"
      ) {
        return "pkgManagerConfigs.apt.defaultUpgradeMode must be 'upgrade' or 'full-upgrade'";
      }
      if (
        rawConfig.autoHideKeptBackUpdates !== undefined &&
        typeof rawConfig.autoHideKeptBackUpdates !== "boolean"
      ) {
        return "pkgManagerConfigs.apt.autoHideKeptBackUpdates must be a boolean";
      }
      continue;
    }

    if (manager === "dnf") {
      for (const key of keys) {
        if (key !== "defaultUpgradeMode" && key !== "refreshMetadataOnCheck") {
          return `pkgManagerConfigs.dnf.${key} is not supported`;
        }
      }
      if (
        rawConfig.defaultUpgradeMode !== undefined &&
        rawConfig.defaultUpgradeMode !== "upgrade" &&
        rawConfig.defaultUpgradeMode !== "distro-sync"
      ) {
        return "pkgManagerConfigs.dnf.defaultUpgradeMode must be 'upgrade' or 'distro-sync'";
      }
      if (
        rawConfig.refreshMetadataOnCheck !== undefined &&
        typeof rawConfig.refreshMetadataOnCheck !== "boolean"
      ) {
        return "pkgManagerConfigs.dnf.refreshMetadataOnCheck must be a boolean";
      }
      continue;
    }

    if (manager === "pacman") {
      for (const key of keys) {
        if (key !== "refreshDatabasesOnCheck") {
          return `pkgManagerConfigs.pacman.${key} is not supported`;
        }
      }
      if (
        rawConfig.refreshDatabasesOnCheck !== undefined &&
        typeof rawConfig.refreshDatabasesOnCheck !== "boolean"
      ) {
        return "pkgManagerConfigs.pacman.refreshDatabasesOnCheck must be a boolean";
      }
      continue;
    }

    if (manager === "apk") {
      for (const key of keys) {
        if (key !== "refreshIndexesOnCheck") {
          return `pkgManagerConfigs.apk.${key} is not supported`;
        }
      }
      if (
        rawConfig.refreshIndexesOnCheck !== undefined &&
        typeof rawConfig.refreshIndexesOnCheck !== "boolean"
      ) {
        return "pkgManagerConfigs.apk.refreshIndexesOnCheck must be a boolean";
      }
      continue;
    }

    if (manager === "flatpak") {
      for (const key of keys) {
        if (key !== "refreshAppstreamOnCheck") {
          return `pkgManagerConfigs.flatpak.${key} is not supported`;
        }
      }
      if (
        rawConfig.refreshAppstreamOnCheck !== undefined &&
        typeof rawConfig.refreshAppstreamOnCheck !== "boolean"
      ) {
        return "pkgManagerConfigs.flatpak.refreshAppstreamOnCheck must be a boolean";
      }
    }
  }

  return null;
}

export function getManagerConfig(
  configs: PackageManagerConfigs | null | undefined,
  manager: string,
): PackageManagerConfigValue | undefined {
  if (!configs) return undefined;
  if (!SUPPORTED_CONFIG_MANAGERS.includes(manager as SupportedPackageManagerConfigName)) {
    return undefined;
  }
  return configs[manager as SupportedPackageManagerConfigName];
}

export function getAptAutoHideKeptBackUpdates(
  configs: PackageManagerConfigs | null | undefined,
): boolean | undefined {
  return configs?.apt?.autoHideKeptBackUpdates;
}

export function mergeLegacyAutoHideKeptBackUpdates(
  configs: PackageManagerConfigs | null | undefined,
  legacyValue: boolean | number | null | undefined,
): PackageManagerConfigs | null {
  const normalized = normalizePackageManagerConfigs(configs) ?? {};
  if (normalized.apt?.autoHideKeptBackUpdates !== undefined) {
    return Object.keys(normalized).length > 0 ? normalized : null;
  }
  if (!(legacyValue === true || legacyValue === 1)) {
    return Object.keys(normalized).length > 0 ? normalized : null;
  }
  return {
    ...normalized,
    apt: {
      ...normalized.apt,
      autoHideKeptBackUpdates: true,
    },
  };
}

export function usesAggressiveUpgradeMode(
  manager: string,
  config: PackageManagerConfigValue | undefined,
): boolean {
  if (manager === "apt") {
    return (config as AptPackageManagerConfig | undefined)?.defaultUpgradeMode === "full-upgrade";
  }
  if (manager === "dnf") {
    return (config as DnfPackageManagerConfig | undefined)?.defaultUpgradeMode === "distro-sync";
  }
  return false;
}

export function describeUpgradeBehavior(
  manager: string,
  config: PackageManagerConfigValue | undefined,
): string | null {
  if (manager === "apt" && (config as AptPackageManagerConfig | undefined)?.defaultUpgradeMode === "full-upgrade") {
    return "APT runs full-upgrade";
  }
  if (manager === "dnf" && (config as DnfPackageManagerConfig | undefined)?.defaultUpgradeMode === "distro-sync") {
    return "DNF runs distro-sync";
  }
  return null;
}

export function describeUpgradeBehaviors(
  managers: string[],
  configs: PackageManagerConfigs | null | undefined,
): string[] {
  const uniqueManagers = Array.from(new Set(managers));
  return uniqueManagers
    .map((manager) => describeUpgradeBehavior(manager, getManagerConfig(configs, manager)))
    .filter((value): value is string => !!value);
}
