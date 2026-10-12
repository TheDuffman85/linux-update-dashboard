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
  /** Secret entries never hold plaintext values: systems reference a secret credential instead. */
  secret?: boolean;
  /** Environment variable the secret is exported as on the remote host. */
  envVar?: string;
  /** Emit a sudoers env_keep rule so the variable survives sudo's env_reset. */
  sudoEnvKeep?: boolean;
  /** Shipped with a built-in package manager; read-only and never stored. */
  builtin?: boolean;
}

export type CustomPackageManagerConfig = Record<string, string>;

/** Per-system secret assignments: { manager: { configKey: credentialId } }. */
export type PackageManagerSecretRefs = Record<string, Record<string, number>>;
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
const SECRET_ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
// Variables that change how shells, loaders, interpreters, or sudo behave must
// never be fed from a secret, and must never be added to sudoers env_keep.
const RESERVED_SECRET_ENV_VARS = new Set([
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "MAIL", "TERM", "IFS", "ENV", "BASH_ENV",
  "PS1", "PS2", "PS4", "SHELLOPTS", "BASHOPTS", "CDPATH", "GLOBIGNORE", "TMPDIR", "TZ",
  "LANG", "LANGUAGE", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP",
  "PYTHONHOME", "PERL5LIB", "PERL5OPT", "PERLLIB", "RUBYOPT", "RUBYLIB", "GCONV_PATH",
  "HOSTALIASES", "LOCALDOMAIN", "RES_OPTIONS", "NLSPATH", "EDITOR", "VISUAL", "PAGER",
]);
const RESERVED_SECRET_ENV_VAR_PREFIXES = ["LD_", "DYLD_", "LC_", "SUDO_", "LUDASH_", "BASH_FUNC_"];

export function validateSecretEnvVarName(value: unknown): string | null {
  if (typeof value !== "string" || !SECRET_ENV_VAR_PATTERN.test(value)) {
    return "must be an upper-case environment variable name (A-Z, 0-9, underscore)";
  }
  if (
    RESERVED_SECRET_ENV_VARS.has(value) ||
    RESERVED_SECRET_ENV_VAR_PREFIXES.some((prefix) => value.startsWith(prefix))
  ) {
    return `${value} is reserved and cannot carry a secret`;
  }
  return null;
}

export function getSecretConfigEntries(
  definition: CustomPackageManagerConfigDefinition | undefined | null,
): CustomPackageManagerConfigEntry[] {
  return (definition?.configEntries ?? []).filter((entry) => entry.secret === true);
}
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
  "deb-get": ["githubToken"],
};

/** Config entries that ship with built-in package managers. */
export const BUILTIN_CONFIG_ENTRIES: Record<string, CustomPackageManagerConfigEntry[]> = {
  "deb-get": [{
    key: "githubToken",
    description: "GitHub token for deb-get's GitHub API lookups. Without it, unauthenticated rate limits can hide updates for GitHub-hosted apps. A fine-grained token without any permissions is enough.",
    defaultValue: "",
    secret: true,
    envVar: "DEBGET_TOKEN",
    sudoEnvKeep: true,
    builtin: true,
  }],
};

export function getBuiltinConfigEntries(manager: string): CustomPackageManagerConfigEntry[] {
  return (BUILTIN_CONFIG_ENTRIES[manager] ?? []).map((entry) => ({ ...entry }));
}

export interface CustomPackageManagerConfigDefinition {
  name: string;
  configEntries?: CustomPackageManagerConfigEntry[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function getLegacyCustomConfigKey(manager: string, key: string): string {
  const trimmed = key.trim();
  const pathPrefix = `${manager}.`;
  if (trimmed.startsWith(pathPrefix)) return trimmed.slice(pathPrefix.length);
  return trimmed;
}

function customConfigForManager(
  manager: string,
  rawConfig: Record<string, unknown>,
  customManagerMap: Map<string, CustomPackageManagerConfigDefinition>,
  allowUnknownKeys = false,
): CustomPackageManagerConfig | null {
  const definition = customManagerMap.get(manager);
  if (!definition?.configEntries?.length && !allowUnknownKeys) return null;
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
  const customConfig: CustomPackageManagerConfig = {};
  for (const [key, rawValue] of Object.entries(rawConfig)) {
    // Secret entries are only ever stored as credential references.
    if (secretKeys.has(key)) continue;
    const targetKey = keyMap.size > 0 || secretKeys.size > 0 ? keyMap.get(key) : key;
    if (!targetKey) continue;
    if (typeof rawValue === "string") {
      customConfig[targetKey] = rawValue;
    } else if (typeof rawValue === "number" || typeof rawValue === "boolean") {
      customConfig[targetKey] = String(rawValue);
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
  _existingManagers: CustomPackageManagerConfigDefinition[] = [],
  currentManagerName?: string,
): string | null {
  if (entries === undefined || entries === null) return null;
  if (!Array.isArray(entries)) {
    return "configEntries must be an array";
  }

  const seen = new Set<string>();
  const seenEnvVars = new Set<string>();
  const currentBuiltinKeys = currentManagerName ? BUILTIN_CONFIG_KEYS[currentManagerName] ?? [] : [];
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) return `configEntries.${index} must be an object`;
    if (typeof entry.key !== "string" || !CUSTOM_CONFIG_KEY_PATTERN.test(entry.key.trim())) {
      return `configEntries.${index}.key must start with a letter and contain only letters, numbers, underscores, or dashes`;
    }
    const key = currentManagerName
      ? getLegacyCustomConfigKey(currentManagerName, entry.key)
      : entry.key.trim();
    if (currentBuiltinKeys.includes(key)) {
      return `Custom config key ${key} collides with a built-in ${currentManagerName} config key`;
    }
    if (seen.has(key)) return `Duplicate custom config key: ${key}`;
    seen.add(key);
    if (entry.description !== undefined && typeof entry.description !== "string") {
      return `configEntries.${index}.description must be a string`;
    }
    if (entry.secret !== undefined && typeof entry.secret !== "boolean") {
      return `configEntries.${index}.secret must be a boolean`;
    }
    if (entry.secret === true) {
      if (entry.defaultValue !== undefined && entry.defaultValue !== "") {
        return `configEntries.${index}.defaultValue must be empty for secret entries`;
      }
      const envVarError = validateSecretEnvVarName(entry.envVar);
      if (envVarError) return `configEntries.${index}.envVar ${envVarError}`;
      if (seenEnvVars.has(entry.envVar as string)) {
        return `Duplicate secret environment variable: ${entry.envVar}`;
      }
      seenEnvVars.add(entry.envVar as string);
      if (entry.sudoEnvKeep !== undefined && typeof entry.sudoEnvKeep !== "boolean") {
        return `configEntries.${index}.sudoEnvKeep must be a boolean`;
      }
      continue;
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
    .map((entry): CustomPackageManagerConfigEntry => {
      const normalized: CustomPackageManagerConfigEntry = {
        key: typeof entry.key === "string" ? entry.key.trim() : "",
        description: typeof entry.description === "string" ? entry.description.trim() || undefined : undefined,
        defaultValue: typeof entry.defaultValue === "string" ? entry.defaultValue : "",
      };
      if (entry.secret !== true) return normalized;
      return {
        ...normalized,
        defaultValue: "",
        secret: true,
        envVar: typeof entry.envVar === "string" ? entry.envVar.trim() : "",
        sudoEnvKeep: entry.sudoEnvKeep === true,
      };
    })
    .filter((entry) =>
      CUSTOM_CONFIG_KEY_PATTERN.test(entry.key) &&
      (!entry.secret || validateSecretEnvVarName(entry.envVar) === null)
    );
}

export function normalizeCustomPackageManagerConfigEntriesForManager(
  manager: string,
  entries: unknown,
): CustomPackageManagerConfigEntry[] {
  return normalizeCustomPackageManagerConfigEntries(entries).map((entry) => ({
    ...entry,
    key: getLegacyCustomConfigKey(manager, entry.key),
  }));
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
    const customConfigKeys = new Set((customManager?.configEntries ?? [])
      .filter((entry) => !entry.secret)
      .map((entry) => getLegacyCustomConfigKey(manager, entry.key)));
    const secretKey = getSecretConfigEntries(customManager)
      .map((entry) => getLegacyCustomConfigKey(manager, entry.key))
      .find((key) => keys.includes(key));
    if (secretKey) {
      return `pkgManagerConfigs.${manager}.${secretKey} is a secret entry; assign a secret credential instead`;
    }
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
        if (
          key !== "defaultUpgradeMode" &&
          key !== "autoHideKeptBackUpdates" &&
          !customConfigKeys.has(key)
        ) {
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
        if (
          key !== "autoAcceptNewSigningKeysOnCheck" &&
          key !== "autoAcceptEulaOnUpgrade" &&
          !customConfigKeys.has(key)
        ) {
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

function secretEntryKeysByManager(
  definitions: CustomPackageManagerConfigDefinition[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const definition of definitions) {
    const keys = getSecretConfigEntries(definition)
      .map((entry) => getLegacyCustomConfigKey(definition.name, entry.key));
    if (keys.length > 0) result.set(definition.name, new Set(keys));
  }
  return result;
}

/** Keep only references to secret entries that still exist; drop everything else. */
export function normalizePackageManagerSecretRefs(
  value: unknown,
  definitions: CustomPackageManagerConfigDefinition[] = [],
): PackageManagerSecretRefs | null {
  if (!isRecord(value)) return null;
  const secretKeys = secretEntryKeysByManager(definitions);
  const next: PackageManagerSecretRefs = {};
  for (const [manager, rawRefs] of Object.entries(value)) {
    const keys = secretKeys.get(manager);
    if (!keys || !isRecord(rawRefs)) continue;
    const refs: Record<string, number> = {};
    for (const [key, rawId] of Object.entries(rawRefs)) {
      const id = typeof rawId === "string" && /^\d+$/.test(rawId) ? Number(rawId) : rawId;
      if (keys.has(key) && typeof id === "number" && Number.isInteger(id) && id > 0) {
        refs[key] = id;
      }
    }
    if (Object.keys(refs).length > 0) next[manager] = refs;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export function parsePackageManagerSecretRefs(
  value: string | null | undefined,
  definitions: CustomPackageManagerConfigDefinition[] = [],
): PackageManagerSecretRefs | null {
  if (!value) return null;
  try {
    return normalizePackageManagerSecretRefs(JSON.parse(value), definitions);
  } catch {
    return null;
  }
}

export function serializePackageManagerSecretRefs(
  value: PackageManagerSecretRefs | null | undefined,
  definitions: CustomPackageManagerConfigDefinition[] = [],
): string | null {
  const normalized = normalizePackageManagerSecretRefs(value, definitions);
  return normalized ? JSON.stringify(normalized) : null;
}

/** Structural validation; credential existence and kind are checked by the caller. */
export function validatePackageManagerSecretRefsInput(
  value: unknown,
  definitions: CustomPackageManagerConfigDefinition[] = [],
): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return "pkgManagerSecretRefs must be an object";
  const secretKeys = secretEntryKeysByManager(definitions);
  for (const [manager, rawRefs] of Object.entries(value)) {
    const keys = secretKeys.get(manager);
    if (!keys) return `pkgManagerSecretRefs.${manager} has no secret config entries`;
    if (!isRecord(rawRefs)) return `pkgManagerSecretRefs.${manager} must be an object`;
    for (const [key, rawId] of Object.entries(rawRefs)) {
      if (!keys.has(key)) return `pkgManagerSecretRefs.${manager}.${key} is not a secret config entry`;
      if (rawId === null) continue;
      if (typeof rawId !== "number" || !Number.isInteger(rawId) || rawId <= 0) {
        return `pkgManagerSecretRefs.${manager}.${key} must be a credential ID`;
      }
    }
  }
  return null;
}

export function listSecretRefCredentialIds(refs: PackageManagerSecretRefs | null | undefined): number[] {
  if (!refs) return [];
  return [...new Set(Object.values(refs).flatMap((managerRefs) => Object.values(managerRefs)))];
}
