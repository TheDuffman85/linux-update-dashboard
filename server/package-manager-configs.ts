export type AptDefaultUpgradeMode = "upgrade" | "full-upgrade";
export type DnfDefaultUpgradeMode = "upgrade" | "distro-sync";

export interface AptPackageManagerConfig {
  defaultUpgradeMode?: AptDefaultUpgradeMode;
  autoHideKeptBackUpdates?: boolean;
}

export interface DnfPackageManagerConfig {
  defaultUpgradeMode?: DnfDefaultUpgradeMode;
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
export type SupportedPackageManagerConfigName = keyof BuiltinPackageManagerConfigs;
export type BuiltinPackageManagerConfigValue = NonNullable<BuiltinPackageManagerConfigs[SupportedPackageManagerConfigName]>;

export type PackageManagerConfigs = BuiltinPackageManagerConfigs & {
  [manager: string]: BuiltinPackageManagerConfigValue | CustomPackageManagerConfig | undefined;
};

export type PackageManagerConfigValue =
  | BuiltinPackageManagerConfigValue
  | CustomPackageManagerConfig;

const SUPPORTED_CONFIG_MANAGERS = [
  "apt",
  "dnf",
  "yum",
  "pacman",
  "apk",
  "flatpak",
] as const satisfies SupportedPackageManagerConfigName[];

const UNSUPPORTED_CONFIG_MANAGERS = new Set(["snap"]);
const CUSTOM_CONFIG_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const BUILTIN_CONFIG_KEYS: Record<string, string[]> = {
  apt: ["defaultUpgradeMode", "autoHideKeptBackUpdates"],
  dnf: [
    "defaultUpgradeMode",
    "refreshMetadataOnCheck",
    "autoAcceptNewSigningKeysOnCheck",
    "autoAcceptEulaOnUpgrade",
    "refreshMetadataOnCheckArg",
    "autoAcceptEulaOnUpgradePrefix",
  ],
  yum: [
    "autoAcceptNewSigningKeysOnCheck",
    "autoAcceptEulaOnUpgrade",
    "autoAcceptEulaOnUpgradePrefix",
  ],
  pacman: ["refreshDatabasesOnCheck"],
  apk: ["refreshIndexesOnCheck"],
  flatpak: ["refreshAppstreamOnCheck"],
};

export interface CustomPackageManagerConfigDefinition {
  name: string;
  configEntries?: CustomPackageManagerConfigEntry[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function customConfigForManager(
  manager: string,
  rawConfig: Record<string, unknown>,
  customManagerMap: Map<string, CustomPackageManagerConfigDefinition>,
  allowUnknownKeys = false,
): CustomPackageManagerConfig | null {
  const definition = customManagerMap.get(manager);
  if (!definition?.configEntries?.length && !allowUnknownKeys) return null;
  const allowedKeys = definition?.configEntries?.length
    ? new Set(definition.configEntries.map((entry) => entry.key))
    : null;
  const customConfig: CustomPackageManagerConfig = {};
  for (const [key, rawValue] of Object.entries(rawConfig)) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (typeof rawValue === "string") {
      customConfig[key] = rawValue;
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      customConfig[key] = String(rawValue);
    }
  }
  return Object.keys(customConfig).length > 0 ? customConfig : null;
}

function mergeCustomConfig(
  next: PackageManagerConfigs,
  manager: string,
  rawConfig: Record<string, unknown>,
  customManagerMap: Map<string, CustomPackageManagerConfigDefinition>,
  allowUnknownKeys = false,
): void {
  const customConfig = customConfigForManager(manager, rawConfig, customManagerMap, allowUnknownKeys);
  if (!customConfig) return;
  const existing = next[manager] && typeof next[manager] === "object" && !Array.isArray(next[manager])
    ? next[manager]
    : {};
  next[manager] = {
    ...existing,
    ...customConfig,
  };
}

export function parsePackageManagerConfigs(
  value: string | null | undefined,
  customManagers: CustomPackageManagerConfigDefinition[] = [],
): PackageManagerConfigs | null {
  if (!value) return null;
  try {
    return normalizePackageManagerConfigs(JSON.parse(value), customManagers);
  } catch {
    return null;
  }
}

export function serializePackageManagerConfigs(
  value: PackageManagerConfigs | null | undefined,
  customManagers: CustomPackageManagerConfigDefinition[] = [],
): string | null {
  const normalized = normalizePackageManagerConfigs(value, customManagers);
  return normalized ? JSON.stringify(normalized) : null;
}

export function normalizePackageManagerConfigs(
  value: unknown,
  customManagers: CustomPackageManagerConfigDefinition[] = [],
): PackageManagerConfigs | null {
  if (!isRecord(value)) return null;

  const next: PackageManagerConfigs = {};
  const customManagerMap = new Map(customManagers.map((manager) => [manager.name, manager]));

  if (isRecord(value.apt)) {
    const apt: AptPackageManagerConfig = {};
    if (value.apt.defaultUpgradeMode === "upgrade" || value.apt.defaultUpgradeMode === "full-upgrade") {
      apt.defaultUpgradeMode = value.apt.defaultUpgradeMode;
    }
    if (typeof value.apt.autoHideKeptBackUpdates === "boolean") {
      apt.autoHideKeptBackUpdates = value.apt.autoHideKeptBackUpdates;
    }
    if (Object.keys(apt).length > 0) next.apt = apt;
    mergeCustomConfig(next, "apt", value.apt, customManagerMap);
  }

  if (isRecord(value.dnf)) {
    const dnf: DnfPackageManagerConfig = {};
    if (value.dnf.defaultUpgradeMode === "upgrade" || value.dnf.defaultUpgradeMode === "distro-sync") {
      dnf.defaultUpgradeMode = value.dnf.defaultUpgradeMode;
    }
    if (typeof value.dnf.refreshMetadataOnCheck === "boolean") {
      dnf.refreshMetadataOnCheck = value.dnf.refreshMetadataOnCheck;
    }
    if (typeof value.dnf.autoAcceptNewSigningKeysOnCheck === "boolean") {
      dnf.autoAcceptNewSigningKeysOnCheck = value.dnf.autoAcceptNewSigningKeysOnCheck;
    }
    if (typeof value.dnf.autoAcceptEulaOnUpgrade === "boolean") {
      dnf.autoAcceptEulaOnUpgrade = value.dnf.autoAcceptEulaOnUpgrade;
    }
    if (Object.keys(dnf).length > 0) next.dnf = dnf;
    mergeCustomConfig(next, "dnf", value.dnf, customManagerMap);
  }

  if (isRecord(value.yum)) {
    const yum: YumPackageManagerConfig = {};
    if (typeof value.yum.autoAcceptNewSigningKeysOnCheck === "boolean") {
      yum.autoAcceptNewSigningKeysOnCheck = value.yum.autoAcceptNewSigningKeysOnCheck;
    }
    if (typeof value.yum.autoAcceptEulaOnUpgrade === "boolean") {
      yum.autoAcceptEulaOnUpgrade = value.yum.autoAcceptEulaOnUpgrade;
    }
    if (Object.keys(yum).length > 0) next.yum = yum;
    mergeCustomConfig(next, "yum", value.yum, customManagerMap);
  }

  if (isRecord(value.pacman)) {
    const pacman: PacmanPackageManagerConfig = {};
    if (typeof value.pacman.refreshDatabasesOnCheck === "boolean") {
      pacman.refreshDatabasesOnCheck = value.pacman.refreshDatabasesOnCheck;
    }
    if (Object.keys(pacman).length > 0) next.pacman = pacman;
    mergeCustomConfig(next, "pacman", value.pacman, customManagerMap);
  }

  if (isRecord(value.apk)) {
    const apk: ApkPackageManagerConfig = {};
    if (typeof value.apk.refreshIndexesOnCheck === "boolean") {
      apk.refreshIndexesOnCheck = value.apk.refreshIndexesOnCheck;
    }
    if (Object.keys(apk).length > 0) next.apk = apk;
    mergeCustomConfig(next, "apk", value.apk, customManagerMap);
  }

  if (isRecord(value.flatpak)) {
    const flatpak: FlatpakPackageManagerConfig = {};
    if (typeof value.flatpak.refreshAppstreamOnCheck === "boolean") {
      flatpak.refreshAppstreamOnCheck = value.flatpak.refreshAppstreamOnCheck;
    }
    if (Object.keys(flatpak).length > 0) next.flatpak = flatpak;
    mergeCustomConfig(next, "flatpak", value.flatpak, customManagerMap);
  }

  for (const [manager, rawConfig] of Object.entries(value)) {
    if (SUPPORTED_CONFIG_MANAGERS.includes(manager as SupportedPackageManagerConfigName)) continue;
    if (UNSUPPORTED_CONFIG_MANAGERS.has(manager) || !isRecord(rawConfig)) continue;

    mergeCustomConfig(next, manager, rawConfig, customManagerMap, true);
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function validateCustomPackageManagerConfigEntries(
  entries: unknown,
  existingManagers: CustomPackageManagerConfigDefinition[] = [],
  currentManagerName?: string,
): string | null {
  if (entries === undefined || entries === null) return null;
  if (!Array.isArray(entries)) {
    return "configEntries must be an array";
  }

  const seen = new Set<string>();
  const currentBuiltinKeys = currentManagerName ? BUILTIN_CONFIG_KEYS[currentManagerName] ?? [] : [];
  const otherKeys = new Map<string, string>();
  for (const manager of existingManagers) {
    if (currentManagerName && manager.name === currentManagerName) continue;
    for (const entry of manager.configEntries ?? []) {
      otherKeys.set(entry.key, manager.name);
    }
  }

  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) return `configEntries.${index} must be an object`;
    if (typeof entry.key !== "string" || !CUSTOM_CONFIG_KEY_PATTERN.test(entry.key.trim())) {
      return `configEntries.${index}.key must start with a letter and contain only letters, numbers, underscores, or dashes`;
    }
    const key = entry.key.trim();
    if (currentBuiltinKeys.includes(key)) {
      return `Custom config key ${key} collides with a built-in ${currentManagerName} config key`;
    }
    if (seen.has(key)) return `Duplicate custom config key: ${key}`;
    seen.add(key);
    const collidingManager = otherKeys.get(key);
    if (collidingManager) {
      return `Custom config key ${key} is already used by ${collidingManager}`;
    }
    if (entry.description !== undefined && typeof entry.description !== "string") {
      return `configEntries.${index}.description must be a string`;
    }
    if (typeof entry.defaultValue !== "string") {
      return `configEntries.${index}.defaultValue is required`;
    }
  }

  return null;
}

export function normalizeCustomPackageManagerConfigEntries(entries: unknown): CustomPackageManagerConfigEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(isRecord)
    .map((entry) => ({
      key: typeof entry.key === "string" ? entry.key.trim() : "",
      description: typeof entry.description === "string" ? entry.description.trim() || undefined : undefined,
      defaultValue: typeof entry.defaultValue === "string" ? entry.defaultValue : "",
    }))
    .filter((entry) => CUSTOM_CONFIG_KEY_PATTERN.test(entry.key));
}

export function validatePackageManagerConfigsInput(
  value: unknown,
  customManagers: CustomPackageManagerConfigDefinition[] = [],
): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) {
    return "pkgManagerConfigs must be an object";
  }
  const customManagerMap = new Map(customManagers.map((manager) => [manager.name, manager]));

  for (const [manager, rawConfig] of Object.entries(value)) {
    if (UNSUPPORTED_CONFIG_MANAGERS.has(manager)) {
      return `pkgManagerConfigs.${manager} is not supported`;
    }
    const isBuiltinManager = SUPPORTED_CONFIG_MANAGERS.includes(manager as SupportedPackageManagerConfigName);
    const customManager = customManagerMap.get(manager);
    if (!isBuiltinManager && !customManager) {
      return `pkgManagerConfigs.${manager} is not a supported package manager`;
    }
    if (!isRecord(rawConfig)) {
      return `pkgManagerConfigs.${manager} must be an object`;
    }

    const keys = Object.keys(rawConfig);
    const customConfigKeys = new Set((customManager?.configEntries ?? []).map((entry) => entry.key));
    if (!isBuiltinManager && customManager) {
      for (const key of keys) {
        if (!customConfigKeys.has(key)) {
          return `pkgManagerConfigs.${manager}.${key} is not supported`;
        }
        if (typeof rawConfig[key] !== "string") {
          return `pkgManagerConfigs.${manager}.${key} must be a string`;
        }
      }
      continue;
    }

    if (manager === "apt") {
      for (const key of keys) {
        if (key !== "defaultUpgradeMode" && key !== "autoHideKeptBackUpdates" && !customConfigKeys.has(key)) {
          return `pkgManagerConfigs.apt.${key} is not supported`;
        }
      }
      for (const key of customConfigKeys) {
        if (rawConfig[key] !== undefined && typeof rawConfig[key] !== "string") {
          return `pkgManagerConfigs.apt.${key} must be a string`;
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
        if (
          key !== "defaultUpgradeMode" &&
          key !== "refreshMetadataOnCheck" &&
          key !== "autoAcceptNewSigningKeysOnCheck" &&
          key !== "autoAcceptEulaOnUpgrade" &&
          !customConfigKeys.has(key)
        ) {
          return `pkgManagerConfigs.dnf.${key} is not supported`;
        }
      }
      for (const key of customConfigKeys) {
        if (rawConfig[key] !== undefined && typeof rawConfig[key] !== "string") {
          return `pkgManagerConfigs.dnf.${key} must be a string`;
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
      if (
        rawConfig.autoAcceptNewSigningKeysOnCheck !== undefined &&
        typeof rawConfig.autoAcceptNewSigningKeysOnCheck !== "boolean"
      ) {
        return "pkgManagerConfigs.dnf.autoAcceptNewSigningKeysOnCheck must be a boolean";
      }
      if (
        rawConfig.autoAcceptEulaOnUpgrade !== undefined &&
        typeof rawConfig.autoAcceptEulaOnUpgrade !== "boolean"
      ) {
        return "pkgManagerConfigs.dnf.autoAcceptEulaOnUpgrade must be a boolean";
      }
      continue;
    }

    if (manager === "yum") {
      for (const key of keys) {
        if (key !== "autoAcceptNewSigningKeysOnCheck" && key !== "autoAcceptEulaOnUpgrade" && !customConfigKeys.has(key)) {
          return `pkgManagerConfigs.yum.${key} is not supported`;
        }
      }
      for (const key of customConfigKeys) {
        if (rawConfig[key] !== undefined && typeof rawConfig[key] !== "string") {
          return `pkgManagerConfigs.yum.${key} must be a string`;
        }
      }
      if (
        rawConfig.autoAcceptNewSigningKeysOnCheck !== undefined &&
        typeof rawConfig.autoAcceptNewSigningKeysOnCheck !== "boolean"
      ) {
        return "pkgManagerConfigs.yum.autoAcceptNewSigningKeysOnCheck must be a boolean";
      }
      if (
        rawConfig.autoAcceptEulaOnUpgrade !== undefined &&
        typeof rawConfig.autoAcceptEulaOnUpgrade !== "boolean"
      ) {
        return "pkgManagerConfigs.yum.autoAcceptEulaOnUpgrade must be a boolean";
      }
      continue;
    }

    if (manager === "pacman") {
      for (const key of keys) {
        if (key !== "refreshDatabasesOnCheck" && !customConfigKeys.has(key)) {
          return `pkgManagerConfigs.pacman.${key} is not supported`;
        }
      }
      for (const key of customConfigKeys) {
        if (rawConfig[key] !== undefined && typeof rawConfig[key] !== "string") {
          return `pkgManagerConfigs.pacman.${key} must be a string`;
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
        if (key !== "refreshIndexesOnCheck" && !customConfigKeys.has(key)) {
          return `pkgManagerConfigs.apk.${key} is not supported`;
        }
      }
      for (const key of customConfigKeys) {
        if (rawConfig[key] !== undefined && typeof rawConfig[key] !== "string") {
          return `pkgManagerConfigs.apk.${key} must be a string`;
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
        if (key !== "refreshAppstreamOnCheck" && !customConfigKeys.has(key)) {
          return `pkgManagerConfigs.flatpak.${key} is not supported`;
        }
      }
      for (const key of customConfigKeys) {
        if (rawConfig[key] !== undefined && typeof rawConfig[key] !== "string") {
          return `pkgManagerConfigs.flatpak.${key} must be a string`;
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
  return configs[manager];
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
