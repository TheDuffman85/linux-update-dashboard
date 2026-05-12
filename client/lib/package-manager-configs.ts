export interface AptPackageManagerConfig {
  defaultUpgradeMode?: "upgrade" | "full-upgrade";
  autoHideKeptBackUpdates?: boolean;
}

export interface DnfPackageManagerConfig {
  defaultUpgradeMode?: "upgrade" | "distro-sync";
  refreshMetadataOnCheck?: boolean;
  autoAcceptNewSigningKeysOnCheck?: boolean;
  autoAcceptEulaOnUpgrade?: boolean;
}

export interface YumPackageManagerConfig {
  autoAcceptNewSigningKeysOnCheck?: boolean;
  autoAcceptEulaOnUpgrade?: boolean;
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

export interface BuiltinPackageManagerConfigs {
  apt?: AptPackageManagerConfig;
  dnf?: DnfPackageManagerConfig;
  yum?: YumPackageManagerConfig;
  pacman?: PacmanPackageManagerConfig;
  apk?: ApkPackageManagerConfig;
  flatpak?: FlatpakPackageManagerConfig;
}

export interface CustomPackageManagerConfigEntry {
  key: string;
  description?: string;
  defaultValue: string;
}

export type CustomPackageManagerConfig = Record<string, string>;
export type BuiltinPackageManagerConfigValue = NonNullable<BuiltinPackageManagerConfigs[keyof BuiltinPackageManagerConfigs]>;

export type PackageManagerConfigs = BuiltinPackageManagerConfigs & {
  [manager: string]: BuiltinPackageManagerConfigValue | CustomPackageManagerConfig | undefined;
};

export const SUPPORTED_PACKAGE_MANAGER_CONFIGS = [
  "apt",
  "dnf",
  "yum",
  "pacman",
  "apk",
  "flatpak",
] as const satisfies Array<keyof BuiltinPackageManagerConfigs>;

export interface CustomPackageManagerConfigDefinition {
  name: string;
  configEntries?: CustomPackageManagerConfigEntry[] | null;
}

function mergeCustomConfig(
  next: PackageManagerConfigs,
  manager: string,
  rawConfig: Record<string, unknown>,
  customManagerMap: Map<string, CustomPackageManagerConfigDefinition>,
  allowUnknownKeys = false,
): void {
  const definition = customManagerMap.get(manager);
  if (!definition?.configEntries?.length && !allowUnknownKeys) return;
  const allowedKeys = definition?.configEntries?.length
    ? new Set(definition.configEntries.map((entry) => entry.key))
    : null;
  const config: CustomPackageManagerConfig = {};
  for (const [key, raw] of Object.entries(rawConfig)) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (typeof raw === "string") {
      config[key] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      config[key] = String(raw);
    }
  }
  if (Object.keys(config).length === 0) return;
  const current = next[manager] && typeof next[manager] === "object" && !Array.isArray(next[manager])
    ? next[manager]
    : {};
  next[manager] = {
    ...current,
    ...config,
  };
}

export function normalizePackageManagerConfigs(
  value: PackageManagerConfigs | null | undefined,
  customManagers: CustomPackageManagerConfigDefinition[] = [],
): PackageManagerConfigs | null {
  if (!value) return null;

  const next: PackageManagerConfigs = {};
  const customManagerMap = new Map(customManagers.map((manager) => [manager.name, manager]));

  if (value.apt?.defaultUpgradeMode) {
    next.apt = { defaultUpgradeMode: value.apt.defaultUpgradeMode };
  }
  if (value.apt?.autoHideKeptBackUpdates !== undefined) {
    next.apt = {
      ...(next.apt ?? {}),
      autoHideKeptBackUpdates: value.apt.autoHideKeptBackUpdates,
    };
  }
  if (value.apt && typeof value.apt === "object" && !Array.isArray(value.apt)) {
    mergeCustomConfig(next, "apt", value.apt as Record<string, unknown>, customManagerMap);
  }
  if (
    value.dnf?.defaultUpgradeMode !== undefined ||
    value.dnf?.refreshMetadataOnCheck !== undefined ||
    value.dnf?.autoAcceptNewSigningKeysOnCheck !== undefined ||
    value.dnf?.autoAcceptEulaOnUpgrade !== undefined
  ) {
    next.dnf = {};
    if (value.dnf.defaultUpgradeMode !== undefined) {
      next.dnf.defaultUpgradeMode = value.dnf.defaultUpgradeMode;
    }
    if (value.dnf.refreshMetadataOnCheck !== undefined) {
      next.dnf.refreshMetadataOnCheck = value.dnf.refreshMetadataOnCheck;
    }
    if (value.dnf.autoAcceptNewSigningKeysOnCheck !== undefined) {
      next.dnf.autoAcceptNewSigningKeysOnCheck = value.dnf.autoAcceptNewSigningKeysOnCheck;
    }
    if (value.dnf.autoAcceptEulaOnUpgrade !== undefined) {
      next.dnf.autoAcceptEulaOnUpgrade = value.dnf.autoAcceptEulaOnUpgrade;
    }
  }
  if (value.dnf && typeof value.dnf === "object" && !Array.isArray(value.dnf)) {
    mergeCustomConfig(next, "dnf", value.dnf as Record<string, unknown>, customManagerMap);
  }
  if (
    value.yum?.autoAcceptNewSigningKeysOnCheck !== undefined ||
    value.yum?.autoAcceptEulaOnUpgrade !== undefined
  ) {
    next.yum = {};
    if (value.yum.autoAcceptNewSigningKeysOnCheck !== undefined) {
      next.yum.autoAcceptNewSigningKeysOnCheck = value.yum.autoAcceptNewSigningKeysOnCheck;
    }
    if (value.yum.autoAcceptEulaOnUpgrade !== undefined) {
      next.yum.autoAcceptEulaOnUpgrade = value.yum.autoAcceptEulaOnUpgrade;
    }
  }
  if (value.yum && typeof value.yum === "object" && !Array.isArray(value.yum)) {
    mergeCustomConfig(next, "yum", value.yum as Record<string, unknown>, customManagerMap);
  }
  if (value.pacman?.refreshDatabasesOnCheck !== undefined) {
    next.pacman = { refreshDatabasesOnCheck: value.pacman.refreshDatabasesOnCheck };
  }
  if (value.pacman && typeof value.pacman === "object" && !Array.isArray(value.pacman)) {
    mergeCustomConfig(next, "pacman", value.pacman as Record<string, unknown>, customManagerMap);
  }
  if (value.apk?.refreshIndexesOnCheck !== undefined) {
    next.apk = { refreshIndexesOnCheck: value.apk.refreshIndexesOnCheck };
  }
  if (value.apk && typeof value.apk === "object" && !Array.isArray(value.apk)) {
    mergeCustomConfig(next, "apk", value.apk as Record<string, unknown>, customManagerMap);
  }
  if (value.flatpak?.refreshAppstreamOnCheck !== undefined) {
    next.flatpak = { refreshAppstreamOnCheck: value.flatpak.refreshAppstreamOnCheck };
  }
  if (value.flatpak && typeof value.flatpak === "object" && !Array.isArray(value.flatpak)) {
    mergeCustomConfig(next, "flatpak", value.flatpak as Record<string, unknown>, customManagerMap);
  }

  for (const [manager, rawConfig] of Object.entries(value)) {
    if ((SUPPORTED_PACKAGE_MANAGER_CONFIGS as readonly string[]).includes(manager)) continue;
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) continue;
    mergeCustomConfig(next, manager, rawConfig as Record<string, unknown>, customManagerMap, true);
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
