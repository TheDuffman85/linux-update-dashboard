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
  secret?: boolean;
  envVar?: string;
  sudoEnvKeep?: boolean;
  /** Shipped with a built-in package manager; read-only. */
  builtin?: boolean;
}

export type CustomPackageManagerConfig = Record<string, string>;

/** Per-system secret assignments: { manager: { configKey: credentialId } }. */
export type PackageManagerSecretRefs = Record<string, Record<string, number>>;

export const SECRET_ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function suggestSecretEnvVar(key: string): string {
  const candidate = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toUpperCase();
  return /^[A-Z_]/.test(candidate) ? candidate.slice(0, 64) : `_${candidate}`.slice(0, 64);
}
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
  builtin?: boolean;
  configEntries?: CustomPackageManagerConfigEntry[] | null;
}

export function getLegacyCustomConfigKey(manager: string, key: string): string {
  const trimmed = key.trim();
  const pathPrefix = `${manager}.`;
  if (trimmed.startsWith(pathPrefix)) return trimmed.slice(pathPrefix.length);
  return trimmed;
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
  const keyMap = new Map<string, string>();
  const secretKeys = new Set<string>();
  if (definition?.configEntries?.length) {
    for (const entry of definition.configEntries) {
      const targetKey = getLegacyCustomConfigKey(manager, entry.key);
      if (entry.secret) {
        secretKeys.add(targetKey);
        continue;
      }
      keyMap.set(targetKey, targetKey);
    }
  }
  const config: CustomPackageManagerConfig = {};
  for (const [key, raw] of Object.entries(rawConfig)) {
    // Secret entries are assigned as credential references, never as values.
    if (secretKeys.has(key)) continue;
    const targetKey = keyMap.size > 0 || secretKeys.size > 0 ? keyMap.get(key) : key;
    if (!targetKey) continue;
    if (typeof raw === "string") {
      config[targetKey] = raw;
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      config[targetKey] = String(raw);
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
  allowUnknownCustomManagers = true,
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
    const customManager = customManagerMap.get(manager);
    if (!allowUnknownCustomManagers && (!customManager || customManager.builtin)) continue;
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) continue;
    mergeCustomConfig(next, manager, rawConfig as Record<string, unknown>, customManagerMap, true);
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function getUpgradeBehaviorNotes(
  managers: string[],
  configs: PackageManagerConfigs | null | undefined,
  t?: (key: string) => string,
): string[] {
  const uniqueManagers = Array.from(new Set(managers));
  return uniqueManagers.flatMap((manager) => {
    if (manager === "apt" && configs?.apt?.defaultUpgradeMode === "full-upgrade") {
      return [t ? t("pages.systemDetail.aptUpgradeUsesFullUpgrade") : "APT upgrade uses full-upgrade on this system."];
    }
    if (manager === "dnf" && configs?.dnf?.defaultUpgradeMode === "distro-sync") {
      return [t ? t("pages.systemDetail.dnfUpgradeUsesDistroSync") : "DNF upgrade uses distro-sync on this system."];
    }
    return [];
  });
}

export function normalizePackageManagerSecretRefs(
  value: PackageManagerSecretRefs | null | undefined,
  managers: CustomPackageManagerConfigDefinition[] = [],
  isManagerActive: (manager: string) => boolean = () => true,
): PackageManagerSecretRefs | null {
  if (!value) return null;
  const next: PackageManagerSecretRefs = {};
  for (const manager of managers) {
    if (!isManagerActive(manager.name)) continue;
    const refs = value[manager.name];
    if (!refs) continue;
    const secretKeys = new Set((manager.configEntries ?? [])
      .filter((entry) => entry.secret)
      .map((entry) => getLegacyCustomConfigKey(manager.name, entry.key)));
    const kept = Object.fromEntries(
      Object.entries(refs).filter(([key, id]) => secretKeys.has(key) && Number.isInteger(id) && id > 0),
    );
    if (Object.keys(kept).length > 0) next[manager.name] = kept;
  }
  return Object.keys(next).length > 0 ? next : null;
}
