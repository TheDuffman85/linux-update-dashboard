import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { getDb } from "../db";
import { customPackageManagers, customScripts, systemScriptOverrides, systems } from "../db/schema";
import {
  getLegacyCustomConfigKey,
  getManagerConfig,
  normalizeCustomPackageManagerConfigEntriesForManager,
  parsePackageManagerConfigs,
  validateCustomPackageManagerConfigEntries,
  type CustomPackageManagerConfigEntry,
  type PackageManagerConfigValue,
} from "../package-manager-configs";
import { getPackageManagerDetectionCommands } from "../ssh/detector";
import {
  getBuiltinInstalledPackageCommand,
  parseBuiltinInstalledPackages,
  type InstalledPackage,
} from "../ssh/installed-packages";
import { getParser, type ParsedUpdate } from "../ssh/parsers";
import { APT_DPKG_AUDIT_SCRIPT, APT_UPDATE_COMMAND } from "../ssh/parsers/apt";
import type { CheckCommandResult } from "../ssh/parsers/types";
import { sudo, validatePackageName, validatePackageNames } from "../ssh/parsers/types";
import { getProxmoxBackupGuardCommand, getRebootCommand } from "../ssh/reboot";
import {
  SYSTEM_INFO_CMD,
  parseSystemInfo,
  resolveRebootDismissal,
  resolveRebootRequired,
  type PreviousRebootState,
  type SystemInfo,
} from "../ssh/system-info";
import type { SSHConnectionManager } from "../ssh/connection";
import type { Client } from "ssh2";

export type ScriptType = "package_manager" | "system";
export type ScriptOperation =
  | "detect"
  | "check_updates"
  | "list_installed_packages"
  | "repair_issue"
  | "autoremove"
  | "upgrade_all"
  | "full_upgrade_all"
  | "upgrade_selected"
  | "system_info"
  | "reboot";

export interface ScriptStep {
  label: string;
  command: string;
}

export interface CustomParserConfig {
  parseStep?: number;
  updateRegex?: string;
  installedPackageRegex?: string;
  securityRegex?: string;
  keptBackRegex?: string;
  issueRegex?: string;
  issueTitle?: string;
  issueMessage?: string;
  successExitCodes?: number[];
  updatesExitCodes?: number[];
}

export interface CustomSystemInfoConfig {
  mode?: "builtin" | "sectioned";
  fieldSections?: Partial<Record<keyof SystemInfo, string>>;
  rebootRequiredRegex?: string;
}

export interface ScriptDefinition {
  id: string;
  readonly: boolean;
  name: string;
  description: string | null;
  type: ScriptType;
  operation: ScriptOperation;
  pkgManager: string | null;
  isDefault: boolean;
  steps: ScriptStep[];
  parserConfig: CustomParserConfig | null;
  systemInfoConfig: CustomSystemInfoConfig | null;
  sourceScriptId: string | null;
  usageCount?: number;
  usages?: ScriptUsage[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ScriptUsage {
  systemId: number;
  systemName: string;
  operationKey: string;
}

export interface ScriptOperationProfile {
  operation: ScriptOperation;
  label: string;
  allowedTypes: ScriptType[];
  purpose: string;
  stepBehavior: string;
  outputConsumer: string;
  parserBehavior: string;
  exitCodeBehavior: string;
  relevantPlaceholders: string[];
  defaultStepBadge: string;
}

export interface CustomPackageManagerDefinition {
  id: number;
  builtin: boolean;
  name: string;
  label: string;
  parserConfig: CustomParserConfig | null;
  configEntries: CustomPackageManagerConfigEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ScriptListResponse {
  scripts: ScriptDefinition[];
  packageManagers: CustomPackageManagerDefinition[];
  placeholders: PlaceholderHelpEntry[];
  operationProfiles: ScriptOperationProfile[];
}

export interface CustomPackageManagerBundle {
  format: "ludash.custom-package-manager.v1";
  exportedAt: string;
  packageManager: {
    name: string;
    label: string;
    parserConfig: CustomParserConfig | null;
    configEntries: CustomPackageManagerConfigEntry[];
  };
  scripts: Array<{
    name: string;
    description: string | null;
    type: "package_manager";
    operation: Exclude<ScriptOperation, "system_info" | "reboot">;
    pkgManager: string;
    isDefault: boolean;
    steps: ScriptStep[];
    parserConfig: CustomParserConfig | null;
    systemInfoConfig: null;
    sourceScriptId: string | null;
  }>;
}

export interface CustomPackageManagerImportResult {
  manager: CustomPackageManagerDefinition;
  scripts: ScriptDefinition[];
  createdScripts: number;
  updatedScripts: number;
}

export interface PlaceholderHelpEntry {
  name: string;
  description: string;
  example: string;
}

const BUILTIN_MANAGER_ORDER = ["apt", "dnf", "yum", "pacman", "apk", "flatpak", "snap"];
const MANAGER_LABELS: Record<string, string> = {
  apt: "APT",
  dnf: "DNF",
  yum: "YUM",
  pacman: "Pacman",
  apk: "APK",
  flatpak: "Flatpak",
  snap: "Snap",
};

const MAX_SCRIPT_STEPS = 8;
const MAX_SCRIPT_NAME_LENGTH = 120;
const MAX_SCRIPT_DESCRIPTION_LENGTH = 2000;
const MAX_STEP_LABEL_LENGTH = 120;
const MAX_STEP_COMMAND_LENGTH = 8000;
const MAX_SCRIPT_CONFIG_JSON_LENGTH = 5000;
const MAX_REGEX_LENGTH = 500;
const MAX_ISSUE_TITLE_LENGTH = 160;
const MAX_ISSUE_MESSAGE_LENGTH = 1000;
const MAX_EXIT_CODE_COUNT = 16;
const MAX_PARSE_STEP = 20;
const PACKAGE_MANAGER_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;
const SYSTEM_INFO_FIELDS = new Set<keyof SystemInfo>([
  "osName",
  "osVersion",
  "kernel",
  "hostname",
  "uptime",
  "uptimeSeconds",
  "arch",
  "cpuCores",
  "memory",
  "disk",
  "bootId",
  "installedKernels",
  "rebootRequiredFilePresent",
  "needsRestartingStatus",
  "needsReboot",
]);

const OPERATION_PROFILE_ORDER: ScriptOperation[] = [
  "detect",
  "check_updates",
  "list_installed_packages",
  "repair_issue",
  "autoremove",
  "upgrade_all",
  "full_upgrade_all",
  "upgrade_selected",
  "system_info",
  "reboot",
];

export const SCRIPT_OPERATION_PROFILES: Record<ScriptOperation, ScriptOperationProfile> = {
  detect: {
    operation: "detect",
    label: "Detection",
    allowedTypes: ["package_manager"],
    purpose: "Determines whether a package manager is available on a remote system.",
    stepBehavior: "Detection uses exactly one command so the result is unambiguous.",
    outputConsumer: "The command must exit with 0 and print found on stdout to enable the manager.",
    parserBehavior: "No update parser is used for detection output.",
    exitCodeBehavior: "Exit code 0 with found means detected; any other result is treated as not detected.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}"],
    defaultStepBadge: "detection output",
  },
  check_updates: {
    operation: "check_updates",
    label: "Check updates",
    allowedTypes: ["package_manager"],
    purpose: "Refreshes package metadata and turns command output into cached update rows.",
    stepBehavior: "Steps run in order and stop at the first failed step.",
    outputConsumer: "Built-in parsers inspect the command results they need; custom parsers read one selected step, defaulting to the last step.",
    parserBehavior: "Custom package managers need an update regex with packageName and newVersion groups.",
    exitCodeBehavior: "Built-in parsers and custom success/update exit-code lists decide whether a non-zero exit code is acceptable.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "parser input",
  },
  list_installed_packages: {
    operation: "list_installed_packages",
    label: "List installed packages",
    allowedTypes: ["package_manager"],
    purpose: "Lists installed packages and their current versions for the system-detail inventory.",
    stepBehavior: "Steps run in order and stop at the first failed step.",
    outputConsumer: "The parsed package snapshot is cached per manager; full listing output is not stored in activity history.",
    parserBehavior: "Custom package managers need an installed-package regex with packageName and currentVersion groups.",
    exitCodeBehavior: "A non-zero exit code keeps the previous snapshot and marks the refresh as a warning.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}"],
    defaultStepBadge: "inventory parser input",
  },
  repair_issue: {
    operation: "repair_issue",
    label: "Repair issue",
    allowedTypes: ["package_manager"],
    purpose: "Runs the repair action offered for package-manager issue banners.",
    stepBehavior: "The configured repair steps run in order and stop at the first failed step.",
    outputConsumer: "Output is streamed live and stored in activity history; it is not parsed into update rows.",
    parserBehavior: "No parser configuration is used.",
    exitCodeBehavior: "A non-zero exit code marks the repair operation as failed.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  autoremove: {
    operation: "autoremove",
    label: "Autoremove",
    allowedTypes: ["package_manager"],
    purpose: "Removes packages or runtimes that are no longer needed.",
    stepBehavior: "The autoremove command runs as the operation body for the selected manager.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while removing unused packages.",
    exitCodeBehavior: "A non-zero exit code marks the autoremove operation as failed.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  upgrade_all: {
    operation: "upgrade_all",
    label: "Upgrade all",
    allowedTypes: ["package_manager"],
    purpose: "Installs all available updates for one package manager.",
    stepBehavior: "Upgrade commands run as the operation body for the selected manager.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while upgrading.",
    exitCodeBehavior: "A non-zero exit code marks the upgrade as failed.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  full_upgrade_all: {
    operation: "full_upgrade_all",
    label: "Full upgrade",
    allowedTypes: ["package_manager"],
    purpose: "Runs the fuller upgrade mode for package managers that support it.",
    stepBehavior: "Full-upgrade commands run as the operation body for the selected manager.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while upgrading.",
    exitCodeBehavior: "A non-zero exit code marks the full upgrade as failed.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  upgrade_selected: {
    operation: "upgrade_selected",
    label: "Upgrade selected",
    allowedTypes: ["package_manager"],
    purpose: "Upgrades the packages selected by the user.",
    stepBehavior: "Selected package placeholders are resolved immediately before SSH execution.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while upgrading selected packages.",
    exitCodeBehavior: "A non-zero exit code marks the selected-package upgrade as failed.",
    relevantPlaceholders: ["{{package}}", "{{packages}}", "{{quotedPackage}}", "{{quotedPackages}}", "{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  system_info: {
    operation: "system_info",
    label: "System info",
    allowedTypes: ["system"],
    purpose: "Collects OS, kernel, uptime, resource, boot, and reboot-required details.",
    stepBehavior: "System-info steps run in order and their output is consumed by the configured mapping mode.",
    outputConsumer: "The built-in parser reads dashboard sections; custom section mapping reads named output sections into system fields.",
    parserBehavior: "Use built-in mode for copied standard scripts, or sectioned mode for custom output.",
    exitCodeBehavior: "A non-zero exit code marks system-info collection as failed.",
    relevantPlaceholders: ["{{sudo:COMMAND}}"],
    defaultStepBadge: "system fields",
  },
  reboot: {
    operation: "reboot",
    label: "Reboot",
    allowedTypes: ["system"],
    purpose: "Reboots the remote system after any configured safety checks pass.",
    stepBehavior: "Reboot steps run in order and stop before later steps when an earlier step fails.",
    outputConsumer: "Output is streamed live and stored in activity history; it is not parsed into system fields or update rows.",
    parserBehavior: "No parser configuration is used.",
    exitCodeBehavior: "A non-zero exit code before the reboot command prevents later steps from running.",
    relevantPlaceholders: ["{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
};

export function getScriptOperationProfiles(): ScriptOperationProfile[] {
  return OPERATION_PROFILE_ORDER.map((operation) => SCRIPT_OPERATION_PROFILES[operation]);
}

export const PLACEHOLDER_HELP: PlaceholderHelpEntry[] = [
  { name: "{{package}}", description: "The first selected package name, validated before execution.", example: "apt-get install --only-upgrade -y {{package}}" },
  { name: "{{packages}}", description: "All selected package names joined by spaces after validation.", example: "dnf upgrade -y {{packages}}" },
  { name: "{{quotedPackage}}", description: "The first selected package shell-quoted with single quotes.", example: "tool upgrade {{quotedPackage}}" },
  { name: "{{quotedPackages}}", description: "All selected packages shell-quoted and joined by spaces.", example: "tool upgrade {{quotedPackages}}" },
  { name: "{{manager}}", description: "The package manager key for the current operation.", example: "echo Checking {{manager}}" },
  { name: "{{sudo:COMMAND}}", description: "Wraps COMMAND with the dashboard sudo fallback helper.", example: "{{sudo:apk update}} 2>&1" },
];

function buildPlaceholderHelp(): PlaceholderHelpEntry[] {
  return [...PLACEHOLDER_HELP];
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateJsonSize(value: unknown, field: string, maxLength = MAX_SCRIPT_CONFIG_JSON_LENGTH): string | null {
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > maxLength) {
      return `${field} must serialize to at most ${maxLength} characters`;
    }
  } catch {
    return `${field} must be JSON-serializable`;
  }
  return null;
}

function hasDangerousRegexConstruct(source: string): boolean {
  const nestedQuantifier = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,?\d*\})/;
  return nestedQuantifier.test(source) || /\\[1-9]/.test(source);
}

function validateRegexSource(
  value: unknown,
  field: string,
  options: {
    required?: boolean;
    requireUpdateGroups?: boolean;
    requireInstalledPackageGroups?: boolean;
  } = {},
): string | null {
  if (value === undefined || value === null || value === "") {
    return options.required ? `${field} is required` : null;
  }
  if (typeof value !== "string") return `${field} must be a string`;
  const source = value.trim();
  if (!source) return options.required ? `${field} is required` : null;
  if (source.length > MAX_REGEX_LENGTH) {
    return `${field} must be ${MAX_REGEX_LENGTH} characters or less`;
  }
  if (hasDangerousRegexConstruct(source)) {
    return `${field} contains an unsafe regular expression pattern`;
  }
  if (options.requireUpdateGroups) {
    if (!source.includes("(?<packageName>") || !source.includes("(?<newVersion>")) {
      return `${field} must include named capture groups packageName and newVersion`;
    }
  }
  if (options.requireInstalledPackageGroups) {
    if (!source.includes("(?<packageName>") || !source.includes("(?<currentVersion>")) {
      return `${field} must include named capture groups packageName and currentVersion`;
    }
  }
  try {
    new RegExp(source);
  } catch (error) {
    return `${field} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

function compileValidatedRegex(
  source: string,
  field: string,
  options: {
    requireUpdateGroups?: boolean;
    requireInstalledPackageGroups?: boolean;
  } = {},
): RegExp {
  const error = validateRegexSource(source, field, {
    required: true,
    requireUpdateGroups: options.requireUpdateGroups,
    requireInstalledPackageGroups: options.requireInstalledPackageGroups,
  });
  if (error) throw new Error(error);
  return new RegExp(source.trim());
}

function validateExitCodes(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return `${field} must be an array`;
  if (value.length > MAX_EXIT_CODE_COUNT) {
    return `${field} must include at most ${MAX_EXIT_CODE_COUNT} values`;
  }
  if (!value.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)) {
    return `${field} must contain exit codes between 0 and 255`;
  }
  return null;
}

function validateOptionalStringLength(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return `${field} must be a string`;
  if (value.trim().length > maxLength) {
    return `${field} must be ${maxLength} characters or less`;
  }
  return null;
}

function validateParserConfig(config: unknown, field = "parserConfig"): string | null {
  if (config === undefined || config === null) return null;
  if (!isRecord(config)) return `${field} must be an object`;
  const sizeError = validateJsonSize(config, field);
  if (sizeError) return sizeError;
  if (config.parseStep !== undefined) {
    const parseStep = config.parseStep;
    if (typeof parseStep !== "number" || !Number.isInteger(parseStep) || parseStep < 0 || parseStep > MAX_PARSE_STEP) {
      return `${field}.parseStep must be an integer between 0 and ${MAX_PARSE_STEP}`;
    }
  }
  return (
    validateRegexSource(config.updateRegex, `${field}.updateRegex`, { requireUpdateGroups: config.updateRegex !== undefined }) ||
    validateRegexSource(config.installedPackageRegex, `${field}.installedPackageRegex`, { requireInstalledPackageGroups: config.installedPackageRegex !== undefined }) ||
    validateRegexSource(config.securityRegex, `${field}.securityRegex`) ||
    validateRegexSource(config.keptBackRegex, `${field}.keptBackRegex`) ||
    validateRegexSource(config.issueRegex, `${field}.issueRegex`) ||
    validateOptionalStringLength(config.issueTitle, `${field}.issueTitle`, MAX_ISSUE_TITLE_LENGTH) ||
    validateOptionalStringLength(config.issueMessage, `${field}.issueMessage`, MAX_ISSUE_MESSAGE_LENGTH) ||
    validateExitCodes(config.successExitCodes, `${field}.successExitCodes`) ||
    validateExitCodes(config.updatesExitCodes, `${field}.updatesExitCodes`)
  );
}

function normalizeParserConfigForOperation(
  config: CustomParserConfig | null | undefined,
  operation: ScriptOperation,
): CustomParserConfig | null {
  if (!config || (
    operation !== "check_updates" &&
    operation !== "list_installed_packages" &&
    operation !== "repair_issue"
  )) {
    return null;
  }
  const next: CustomParserConfig = {};
  if (operation === "check_updates" || operation === "list_installed_packages") {
    if (config.parseStep !== undefined) next.parseStep = config.parseStep;
    if (config.successExitCodes !== undefined) next.successExitCodes = config.successExitCodes;
  }

  if (operation === "check_updates") {
    if (config.updateRegex !== undefined) next.updateRegex = config.updateRegex;
    if (config.securityRegex !== undefined) next.securityRegex = config.securityRegex;
    if (config.keptBackRegex !== undefined) next.keptBackRegex = config.keptBackRegex;
    if (config.updatesExitCodes !== undefined) next.updatesExitCodes = config.updatesExitCodes;
  }

  if (operation === "list_installed_packages") {
    if (config.installedPackageRegex !== undefined) next.installedPackageRegex = config.installedPackageRegex;
  }

  if (operation === "repair_issue") {
    if (config.issueRegex !== undefined) next.issueRegex = config.issueRegex;
    if (config.issueTitle !== undefined) next.issueTitle = config.issueTitle;
    if (config.issueMessage !== undefined) next.issueMessage = config.issueMessage;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function validateSystemInfoConfig(config: unknown): string | null {
  if (config === undefined || config === null) return null;
  if (!isRecord(config)) return "systemInfoConfig must be an object";
  const sizeError = validateJsonSize(config, "systemInfoConfig");
  if (sizeError) return sizeError;
  if (
    config.mode !== undefined &&
    config.mode !== "builtin" &&
    config.mode !== "sectioned"
  ) {
    return "systemInfoConfig.mode must be builtin or sectioned";
  }
  if (config.fieldSections !== undefined && config.fieldSections !== null) {
    if (!isRecord(config.fieldSections)) return "systemInfoConfig.fieldSections must be an object";
    for (const [field, section] of Object.entries(config.fieldSections)) {
      if (!SYSTEM_INFO_FIELDS.has(field as keyof SystemInfo)) {
        return `systemInfoConfig.fieldSections.${field} is not supported`;
      }
      if (typeof section !== "string" || section.length > 120) {
        return `systemInfoConfig.fieldSections.${field} must be a string up to 120 characters`;
      }
    }
  }
  return validateRegexSource(config.rebootRequiredRegex, "systemInfoConfig.rebootRequiredRegex");
}

function validatePackageManagerName(value: unknown): string | null {
  if (typeof value !== "string" || !PACKAGE_MANAGER_NAME_PATTERN.test(value)) {
    return "pkgManager must start with a letter and contain only lowercase letters, numbers, underscores, or dashes";
  }
  const knownManagers = new Set(listPackageManagerDefinitions().map((manager) => manager.name));
  if (!knownManagers.has(value)) {
    return `Unsupported package manager: ${value}`;
  }
  return null;
}

function managerLabel(manager: string): string {
  return MANAGER_LABELS[manager] ?? manager;
}

export function buildOperationKey(operation: ScriptOperation, pkgManager?: string | null): string {
  return pkgManager ? `${pkgManager}/${operation}` : `system/${operation}`;
}

export function parseScriptId(id: string): { kind: "builtin"; key: string } | { kind: "custom"; id: number } | null {
  if (id.startsWith("builtin:")) return { kind: "builtin", key: id.slice("builtin:".length) };
  if (id.startsWith("custom:")) {
    const customId = Number.parseInt(id.slice("custom:".length), 10);
    return Number.isInteger(customId) && customId > 0 ? { kind: "custom", id: customId } : null;
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function normalizeConfigPlaceholder(command: string): string {
  return command;
}

function normalizeScriptConfigPlaceholders(script: Partial<ScriptDefinition>): Partial<ScriptDefinition> {
  if (!script.pkgManager || !Array.isArray(script.steps)) return script;
  return {
    ...script,
    steps: script.steps.map((step) => ({
      ...step,
      command: normalizeConfigPlaceholder(step.command),
    })),
  };
}

function resolveConfigValue(config: PackageManagerConfigValue | undefined, path: string): string {
  const value = path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, config);
  if (value === undefined || value === null) return "";
  return String(value);
}

export function renderCommandTemplate(
  command: string,
  context: {
    pkgManager?: string | null;
    packages?: string[];
    config?: PackageManagerConfigValue;
  } = {},
): string {
  const packages = context.packages ? validatePackageNames(context.packages) : [];
  const firstPackage = packages[0] ? validatePackageName(packages[0]) : "";
  const config = withConfigDefaults(context.pkgManager, context.config);
  let rendered = command
    .replaceAll("{{manager}}", context.pkgManager ?? "")
    .replaceAll("{{package}}", firstPackage)
    .replaceAll("{{packages}}", packages.join(" "))
    .replaceAll("{{quotedPackage}}", firstPackage ? shellQuote(firstPackage) : "")
    .replaceAll("{{quotedPackages}}", packages.map(shellQuote).join(" "));

  rendered = rendered.replace(/\{\{config\.([a-zA-Z0-9_.-]+)\}\}/g, (_match, path: string) =>
    resolveConfigValue(config, path),
  );
  rendered = rendered.replace(/\{\{sudo:([\s\S]*?)\}\}/g, (_match, inner: string) => {
    return sudo(inner.trim());
  });

  if (/\{\{[^}]+\}\}/.test(rendered)) {
    throw new Error(`Unknown script placeholder in command: ${rendered.match(/\{\{[^}]+\}\}/)?.[0]}`);
  }

  return rendered;
}

export async function formatShellCommand(command: string): Promise<string> {
  if (typeof command !== "string" || !command.trim()) {
    throw new Error("Command is required");
  }
  if (command.length > 8000) {
    throw new Error("Command is too long");
  }
  const [{ format }, shellPlugin] = await Promise.all([
    import("prettier"),
    import("prettier-plugin-sh"),
  ]);
  const formatted = await format(prettifyShellDisplay(command.trimEnd()) + "\n", {
    parser: "sh",
    plugins: [shellPlugin as never],
    printWidth: 100,
  });
  return formatted.trimEnd();
}

function splitShellSemicolons(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of line) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? null : char;
      current += char;
      continue;
    }
    if (char === ";" && !quote) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function expandCompactSudoWrappers(value: string): string {
  const sudoPattern =
    /(^|\n)([ \t]*)if \[ "\$\(id -u\)" = "0" \]; then ([^;\n]+); elif command -v sudo >\/dev\/null 2>&1; then sudo -S -p '' ([^;\n]+); else ([^;\n]+); fi([^\n]*)/g;
  let previous = "";
  let next = value;
  while (next !== previous) {
    previous = next;
    next = next.replace(
      sudoPattern,
      (_match, prefix: string, indent: string, rootCommand: string, sudoCommand: string, fallbackCommand: string, suffix: string) =>
        [
          `${prefix}${indent}if [ "$(id -u)" = "0" ]; then`,
          `${indent}  ${rootCommand.trim()}`,
          `${indent}elif command -v sudo >/dev/null 2>&1; then`,
          `${indent}  sudo -S -p '' ${sudoCommand.trim()}`,
          `${indent}else`,
          `${indent}  ${fallbackCommand.trim()}`,
          `${indent}fi${suffix}`,
        ].join("\n"),
    );
  }
  return next;
}

function expandCompactIfLine(line: string): string[] {
  const parts = splitShellSemicolons(line);
  if (parts.length <= 1) return [line];
  if (!parts.some((part) => /^(if|elif|then|else|fi)\b/.test(part))) {
    return parts;
  }

  const output: string[] = [];
  let indent = 0;
  const push = (text: string, offset = 0) => {
    output.push(`${"  ".repeat(Math.max(0, indent + offset))}${text}`);
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const next = parts[index + 1] ?? "";
    if (/^if\b/.test(part) && next.startsWith("then ")) {
      push(`${part}; then`);
      indent += 1;
      const remainder = next.slice("then ".length).trim();
      if (remainder) push(remainder);
      index += 1;
      continue;
    }
    if (/^elif\b/.test(part) && next.startsWith("then ")) {
      indent = Math.max(0, indent - 1);
      push(`${part}; then`);
      indent += 1;
      const remainder = next.slice("then ".length).trim();
      if (remainder) push(remainder);
      index += 1;
      continue;
    }
    if (part === "else" || part.startsWith("else ")) {
      indent = Math.max(0, indent - 1);
      push("else");
      indent += 1;
      const remainder = part.slice("else".length).trim();
      if (remainder) push(remainder);
      continue;
    }
    if (part === "fi" || part.startsWith("fi ")) {
      indent = Math.max(0, indent - 1);
      push(part);
      continue;
    }
    push(part);
  }

  return output.length ? output : [line];
}

function prettifyShellDisplay(command: string): string {
  const expandedSudo = expandCompactSudoWrappers(command);
  const lines = expandedSudo.split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [line];
    return expandCompactIfLine(line);
  });
  return lines.join("\n");
}

function builtinScript(
  operation: ScriptOperation,
  pkgManager: string | null,
  name: string,
  description: string,
  steps: ScriptStep[],
  extra?: Partial<ScriptDefinition>,
): ScriptDefinition {
  return {
    id: `builtin:${pkgManager ? `${pkgManager}:` : "system:"}${operation}`,
    readonly: true,
    name,
    description,
    type: pkgManager ? "package_manager" : "system",
    operation,
    pkgManager,
    isDefault: false,
    steps,
    parserConfig: null,
    systemInfoConfig: null,
    sourceScriptId: null,
    ...extra,
  };
}

function commentedCommand(comment: string, command: string): string {
  return [`# ${comment}`, command].join("\n");
}

function commandLines(...lines: string[]): string {
  return lines.join("\n");
}

function indentCommand(command: string, indent = "  "): string {
  return command
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function sudoersRelevantCommand(command: string): string {
  return commandLines(
    `# Sudoers-relevant command: ${command}`,
    sudo(command),
  );
}

function aptUpgradeModeScript(defaultMode: "upgrade" | "full-upgrade"): string {
  const command = defaultMode === "full-upgrade"
    ? "apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y"
    : "apt-get -o DPkg::Lock::Timeout=60 {{config.defaultUpgradeMode}} -y";
  return commandLines(
    defaultMode === "full-upgrade"
      ? "# Run the full APT upgrade mode."
      : "# Use the configured APT upgrade mode.",
    "export DEBIAN_FRONTEND=noninteractive",
    sudoersRelevantCommand(command) + " 2>&1",
  );
}

function dnfCheckScript(tool: "dnf" | "yum"): string {
  const hasRefresh = tool === "dnf";
  const refreshArg = hasRefresh ? "{{config.refreshMetadataOnCheckArg}}" : "";
  return commandLines(
    `# Check ${tool.toUpperCase()} updates and keep exit code 100 as updates-available, not a failure.`,
    'if [ "{{config.autoAcceptNewSigningKeysOnCheck}}" = "true" ]; then',
    `  # Sudoers-relevant command: ${tool} -y check-update${refreshArg} --quiet`,
    `  updates="$(${sudo(`${tool} -y check-update${refreshArg} --quiet`)} 2>&1)"; rc=$?`,
    "else",
    `  updates="$(${tool} check-update${refreshArg} --quiet 2>&1)"; rc=$?`,
    "fi",
    'echo "$updates"',
    'echo "---INSTALLED---"',
    'if [ "$rc" -eq 100 ] && command -v rpm >/dev/null 2>&1; then',
    '  echo "$updates" | awk \'NF>=3 && $1 ~ /^[[:alnum:]_+.-]+\\.[[:alnum:]_+-]+$/ {print $1}\' | xargs -r rpm -q --qf \'%{NAME}.%{ARCH}\\t%{EPOCH}:%{VERSION}-%{RELEASE}\\n\' 2>/dev/null | sed \'s/\\t(none):/\\t/\'',
    "fi",
    'echo "EXIT:$rc"',
    'if [ "$rc" -ne 0 ] && [ "$rc" -ne 100 ]; then exit "$rc"; fi',
  );
}

function dnfLikeUpgradeScript(tool: "dnf" | "yum", command: string): string {
  return commandLines(
    `# Run ${tool.toUpperCase()} with the configured EULA-acceptance environment prefix.`,
    sudoersRelevantCommand(`{{config.autoAcceptEulaOnUpgradePrefix}}${command}`) + " 2>&1",
  );
}

function dnfUpgradeAllScript(full = false): string {
  const command = full
    ? "dnf distro-sync -y"
    : "dnf {{config.defaultUpgradeMode}} -y";
  return commandLines(
    full
      ? "# Run DNF distro-sync."
      : "# Use the configured DNF upgrade command.",
    dnfLikeUpgradeScript("dnf", command),
  );
}

function maybeRefreshScript(
  comment: string,
  configKey: string,
  command: string,
): string {
  return commandLines(
    `# ${comment}`,
    `if [ "{{config.${configKey}}}" != "false" ]; then`,
    indentCommand(command),
    "fi",
  );
}

function builtinCheckSteps(manager: string): ScriptStep[] {
  switch (manager) {
    case "apt":
      return [
        {
          label: "Auditing dpkg state",
          command: APT_DPKG_AUDIT_SCRIPT,
        },
        {
          label: "Fetching package lists",
          command: APT_UPDATE_COMMAND,
        },
        {
          label: "Listing available updates",
          command: commentedCommand(
            "List APT packages with available updates; the first header line is ignored by the parser.",
            "DEBIAN_FRONTEND=noninteractive apt list --upgradable 2>/dev/null | tail -n +2",
          ),
        },
        {
          label: "Detecting kept-back packages",
          command: commentedCommand(
            "Simulate a standard APT upgrade so the parser can mark packages that would be kept back.",
            "DEBIAN_FRONTEND=noninteractive apt-get -s -o Debug::NoLocking=1 upgrade 2>&1",
          ),
        },
      ];
    case "dnf":
      return [{ label: "Checking for updates", command: dnfCheckScript("dnf") }];
    case "yum":
      return [{ label: "Checking for updates", command: dnfCheckScript("yum") }];
    case "pacman":
      return [
        {
          label: "Refreshing package databases",
          command: maybeRefreshScript(
            "Refresh Pacman package databases unless this system has disabled that check step.",
            "refreshDatabasesOnCheck",
            sudoersRelevantCommand("pacman -Sy --noconfirm") + " 2>&1",
          ),
        },
        {
          label: "Listing available updates",
          command: commandLines(
            "# List Pacman updates while treating 'no updates' as a successful empty result.",
            'errfile="$(mktemp)"',
            'updates="$(pacman -Qu 2>"$errfile")"',
            "rc=$?",
            'printf "%s\\n" "$updates"',
            'cat "$errfile" >&2',
            'if [ "$rc" -eq 1 ] && [ -z "$updates" ] && [ ! -s "$errfile" ]; then rc=0; fi',
            'rm -f "$errfile"',
            'exit "$rc"',
          ),
        },
      ];
    case "apk":
      return [
        {
          label: "Refreshing package indexes",
          command: maybeRefreshScript(
            "Refresh APK package indexes unless this system has disabled that check step.",
            "refreshIndexesOnCheck",
            sudoersRelevantCommand("apk update") + " 2>&1",
          ),
        },
        {
          label: "Listing available updates",
          command: commentedCommand(
            "List APK packages that are upgradable from the current repository indexes.",
            "apk list -u 2>/dev/null",
          ),
        },
      ];
    case "flatpak":
      return [
        {
          label: "Refreshing appstream data",
          command: maybeRefreshScript(
            "Refresh Flatpak appstream data unless this system has disabled that check step.",
            "refreshAppstreamOnCheck",
            sudoersRelevantCommand("flatpak update --appstream") + " 2>/dev/null; true",
          ),
        },
        {
          label: "Checking for updates",
          command: commentedCommand(
            "Print installed Flatpak versions, then print available remote updates for parser comparison.",
            'echo "===INSTALLED==="; flatpak list --columns=application,version 2>/dev/null; echo "===UPDATES==="; flatpak remote-ls --updates --columns=name,application,version,branch,origin 2>/dev/null',
          ),
        },
      ];
    case "snap":
      return [
        {
          label: "Checking for updates",
          command: commentedCommand(
            "Print installed Snap versions, then print refresh candidates for parser comparison.",
            'echo "===INSTALLED==="; snap list --color=never 2>/dev/null; echo "===UPDATES==="; snap refresh --list 2>/dev/null',
          ),
        },
      ];
    default:
      return [];
  }
}

function dnfLikeRepairIssueScript(tool: "dnf" | "yum"): string {
  return commandLines(
    `# Accept a newly presented ${tool.toUpperCase()} repository signing key for this one repair attempt.`,
    `# Sudoers-relevant command: ${tool} -y check-update --quiet`,
    `updates="$(${sudo(`${tool} -y check-update --quiet`)} 2>&1)"; rc=$?`,
    'echo "$updates"',
    'if [ "$rc" -ne 0 ] && [ "$rc" -ne 100 ]; then exit "$rc"; fi',
  );
}

function builtinRepairIssueCommand(manager: string): string | null {
  switch (manager) {
    case "apt":
      return commandLines(
        "# Finish any interrupted dpkg package configuration.",
        "export DEBIAN_FRONTEND=noninteractive",
        sudoersRelevantCommand("dpkg --configure -a") + " 2>&1",
      );
    case "dnf":
      return dnfLikeRepairIssueScript("dnf");
    case "yum":
      return dnfLikeRepairIssueScript("yum");
    default:
      return null;
  }
}

function builtinUpgradeAllCommand(manager: string): string {
  switch (manager) {
    case "apt":
      return aptUpgradeModeScript("upgrade");
    case "dnf":
      return dnfUpgradeAllScript();
    case "yum":
      return dnfLikeUpgradeScript("yum", "yum update -y");
    case "pacman":
      return commentedCommand("Upgrade all Pacman packages and refresh package databases.", sudoersRelevantCommand("pacman -Syu --noconfirm") + " 2>&1");
    case "apk":
      return commentedCommand("Upgrade all APK packages from the configured repositories.", sudoersRelevantCommand("apk upgrade") + " 2>&1");
    case "flatpak":
      return commentedCommand("Upgrade all installed Flatpak applications and runtimes.", sudoersRelevantCommand("flatpak update -y") + " 2>&1");
    case "snap":
      return commentedCommand("Refresh all installed Snap packages.", sudoersRelevantCommand("snap refresh") + " 2>&1");
    default:
      return "";
  }
}

function builtinFullUpgradeCommand(manager: string): string | null {
  switch (manager) {
    case "apt":
      return aptUpgradeModeScript("full-upgrade");
    case "dnf":
      return dnfUpgradeAllScript(true);
    default:
      return null;
  }
}

function builtinAutoremoveCommand(manager: string): string | null {
  switch (manager) {
    case "apt":
      return commandLines(
        "# Remove APT packages that are no longer needed.",
        "export DEBIAN_FRONTEND=noninteractive",
        sudoersRelevantCommand("apt-get -o DPkg::Lock::Timeout=60 autoremove -y") + " 2>&1",
      );
    case "dnf":
      return commentedCommand("Remove DNF packages that are no longer needed.", sudoersRelevantCommand("dnf autoremove -y") + " 2>&1");
    case "yum":
      return commentedCommand("Remove YUM packages that are no longer needed.", sudoersRelevantCommand("yum autoremove -y") + " 2>&1");
    case "pacman":
      return commandLines(
        "# Remove orphaned Pacman packages when any are present.",
        'orphans="$(pacman -Qtdq)"',
        'if [ -n "$orphans" ]; then',
        '  if [ "$(id -u)" = "0" ]; then',
        "    printf '%s\\n' \"$orphans\" | pacman -Rns --noconfirm - 2>&1",
        "  elif command -v sudo >/dev/null 2>&1; then",
        "    # Sudoers-relevant command: pacman -Rns --noconfirm -",
        "    { cat; printf '%s\\n' \"$orphans\"; } | sudo -S -p '' pacman -Rns --noconfirm - 2>&1",
        "  else",
        "    printf '%s\\n' \"$orphans\" | pacman -Rns --noconfirm - 2>&1",
        "  fi",
        "else",
        '  echo "No orphaned Pacman packages to remove."',
        "fi",
      );
    case "flatpak":
      return commentedCommand("Remove unused Flatpak runtimes.", sudoersRelevantCommand("flatpak uninstall --unused -y") + " 2>&1");
    default:
      return null;
  }
}

function builtinUpgradeSelectedCommand(manager: string): string {
  switch (manager) {
    case "apt":
      return commandLines(
        "# Upgrade only the selected APT packages.",
        "export DEBIAN_FRONTEND=noninteractive",
        sudoersRelevantCommand("apt-get -o DPkg::Lock::Timeout=60 install --only-upgrade -y {{packages}}") + " 2>&1",
      );
    case "dnf":
      return dnfLikeUpgradeScript("dnf", "dnf upgrade -y {{packages}}");
    case "yum":
      return dnfLikeUpgradeScript("yum", "yum update -y {{packages}}");
    case "pacman":
      return commentedCommand("Upgrade only the selected Pacman packages.", sudoersRelevantCommand("pacman -S --noconfirm {{packages}}") + " 2>&1");
    case "apk":
      return commentedCommand("Upgrade only the selected APK packages.", sudoersRelevantCommand("apk upgrade {{packages}}") + " 2>&1");
    case "flatpak":
      return commentedCommand("Upgrade only the selected Flatpak applications or runtimes.", sudoersRelevantCommand("flatpak update -y {{packages}}") + " 2>&1");
    case "snap":
      return commentedCommand("Refresh only the selected Snap packages.", sudoersRelevantCommand("snap refresh {{packages}}") + " 2>&1");
    default:
      return "";
  }
}

function builtinListInstalledPackagesCommand(manager: string): string {
  const command = getBuiltinInstalledPackageCommand(manager);
  return command
    ? commentedCommand(
        `List installed ${managerLabel(manager)} packages and their current versions for the dashboard inventory.`,
        command,
      )
    : "";
}

function builtinScriptsForManager(manager: string): ScriptDefinition[] {
  const parser = getParser(manager);
  const scripts: ScriptDefinition[] = [];
  const detection = getPackageManagerDetectionCommands().find((entry) => entry.name === manager);
  if (detection) {
    scripts.push(builtinScript(
      "detect",
      manager,
      `Detect ${managerLabel(manager)}`,
      `Checks whether ${managerLabel(manager)} is available on the remote system.`,
      [{
        label: `Detect ${managerLabel(manager)}`,
        command: commentedCommand(
          `Check whether the ${managerLabel(manager)} command exists on the remote system.`,
          detection.command,
        ),
      }],
    ));
  }
  if (!parser) return scripts;

  scripts.push(builtinScript(
    "check_updates",
    manager,
    `Check ${managerLabel(manager)} updates`,
    `Refreshes and checks available ${managerLabel(manager)} updates.`,
    builtinCheckSteps(manager),
  ));
  const listInstalledPackages = builtinListInstalledPackagesCommand(manager);
  if (listInstalledPackages) {
    scripts.push(builtinScript(
      "list_installed_packages",
      manager,
      `List installed ${managerLabel(manager)} packages`,
      `Lists installed ${managerLabel(manager)} packages and their current versions.`,
      [{ label: `Listing installed ${managerLabel(manager)} packages`, command: listInstalledPackages }],
    ));
  }
  const repairIssue = builtinRepairIssueCommand(manager);
  if (repairIssue) {
    scripts.push(builtinScript(
      "repair_issue",
      manager,
      `Repair ${managerLabel(manager)} issue`,
      `Runs the built-in ${managerLabel(manager)} repair action used by package manager issue banners.`,
      [{ label: `Repair ${managerLabel(manager)} issue`, command: repairIssue }],
    ));
  }
  const autoremove = builtinAutoremoveCommand(manager);
  if (autoremove) {
    scripts.push(builtinScript(
      "autoremove",
      manager,
      `Autoremove unused ${managerLabel(manager)} packages`,
      `Removes ${managerLabel(manager)} packages or runtimes that are no longer needed.`,
      [{ label: `Autoremove unused ${managerLabel(manager)} packages`, command: autoremove }],
    ));
  }
  scripts.push(builtinScript(
    "upgrade_all",
    manager,
    `Upgrade all ${managerLabel(manager)} packages`,
    `Installs all available ${managerLabel(manager)} updates.`,
    [{ label: `Upgrade all ${managerLabel(manager)} packages`, command: builtinUpgradeAllCommand(manager) }],
  ));
  const fullUpgrade = builtinFullUpgradeCommand(manager);
  if (fullUpgrade) {
    scripts.push(builtinScript(
      "full_upgrade_all",
      manager,
      `Full upgrade ${managerLabel(manager)}`,
      `Runs the fuller ${managerLabel(manager)} upgrade operation.`,
      [{ label: `Full upgrade ${managerLabel(manager)}`, command: fullUpgrade }],
    ));
  }
  scripts.push(builtinScript(
    "upgrade_selected",
    manager,
    `Upgrade selected ${managerLabel(manager)} packages`,
    `Upgrades selected packages through ${managerLabel(manager)}.`,
    [{ label: `Upgrade selected ${managerLabel(manager)} packages`, command: builtinUpgradeSelectedCommand(manager) }],
  ));
  return scripts;
}

export function getBuiltinScripts(): ScriptDefinition[] {
  return [
    ...BUILTIN_MANAGER_ORDER.flatMap(builtinScriptsForManager),
    builtinScript(
      "system_info",
      null,
      "Collect system information",
      "Collects OS, kernel, uptime, resource, boot, and reboot-required details.",
      [{ label: "Collect system information", command: SYSTEM_INFO_CMD }],
      { systemInfoConfig: { mode: "builtin" } },
    ),
    builtinScript(
      "reboot",
      null,
      "Reboot system",
      "Reboots the remote system.",
      [
        { label: "Pre-reboot safety checks", command: getProxmoxBackupGuardCommand() },
        { label: "Reboot system", command: getRebootCommand() },
      ],
    ),
  ];
}

function serializeCustomScript(row: typeof customScripts.$inferSelect): ScriptDefinition {
  const operation = row.operation as ScriptOperation;
  return {
    id: `custom:${row.id}`,
    readonly: false,
    name: row.name,
    description: row.description,
    type: row.type as ScriptType,
    operation,
    pkgManager: row.pkgManager,
    isDefault: row.isDefault,
    steps: parseJson<ScriptStep[]>(row.steps, []).map((step) => ({
      ...step,
      command: normalizeConfigPlaceholder(step.command),
    })),
    parserConfig: normalizeParserConfigForOperation(
      parseJson<CustomParserConfig | null>(row.parserConfig, null),
      operation,
    ),
    systemInfoConfig: parseJson<CustomSystemInfoConfig | null>(row.systemInfoConfig, null),
    sourceScriptId: row.sourceScriptId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeCustomPackageManager(row: typeof customPackageManagers.$inferSelect): CustomPackageManagerDefinition {
  const builtin = BUILTIN_MANAGER_ORDER.includes(row.name);
  return {
    id: row.id,
    builtin,
    name: row.name,
    label: builtin ? MANAGER_LABELS[row.name] ?? row.name : row.label,
    parserConfig: builtin ? null : parseJson<CustomParserConfig | null>(row.parserConfig, null),
    configEntries: normalizeCustomPackageManagerConfigEntriesForManager(row.name, parseJson<unknown>(row.configEntries, [])),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listCustomPackageManagers(): CustomPackageManagerDefinition[] {
  return getDb()
    .select()
    .from(customPackageManagers)
    .orderBy(asc(customPackageManagers.label), asc(customPackageManagers.name))
    .all()
    .map(serializeCustomPackageManager)
    .filter((manager) => !manager.builtin);
}

export function listPackageManagerDefinitions(): CustomPackageManagerDefinition[] {
  let rows: CustomPackageManagerDefinition[] = [];
  try {
    rows = getDb()
      .select()
      .from(customPackageManagers)
      .all()
      .map(serializeCustomPackageManager);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Database not initialized") {
      throw error;
    }
  }
  const rowMap = new Map(rows.map((row) => [row.name, row]));
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const builtins = BUILTIN_MANAGER_ORDER.map((name, index) => rowMap.get(name) ?? {
    id: -(index + 1),
    builtin: true,
    name,
    label: MANAGER_LABELS[name] ?? name,
    parserConfig: null,
    configEntries: [],
    createdAt: now,
    updatedAt: now,
  });
  const custom = rows
    .filter((manager) => !manager.builtin)
    .sort((a, b) => a.label.localeCompare(b.label) || a.name.localeCompare(b.name));
  return [...builtins, ...custom];
}

export function listScripts(): ScriptListResponse {
  const packageManagers = listPackageManagerDefinitions();
  const custom = getDb()
    .select()
    .from(customScripts)
    .orderBy(asc(customScripts.type), asc(customScripts.pkgManager), asc(customScripts.operation), asc(customScripts.name))
    .all()
    .map(serializeCustomScript);
  const scripts = [...getBuiltinScripts(), ...custom].map((script) => {
    const usages = listScriptUsages(script.id);
    return {
      ...script,
      usageCount: usages.length,
      usages,
    };
  });
  return {
    scripts,
    packageManagers,
    placeholders: buildPlaceholderHelp(),
    operationProfiles: getScriptOperationProfiles(),
  };
}

export function getScriptById(scriptId: string): ScriptDefinition | null {
  const parsed = parseScriptId(scriptId);
  if (!parsed) return null;
  if (parsed.kind === "builtin") {
    return getBuiltinScripts().find((script) => script.id === scriptId) ?? null;
  }
  const row = getDb()
    .select()
    .from(customScripts)
    .where(eq(customScripts.id, parsed.id))
    .get();
  return row ? serializeCustomScript(row) : null;
}

function validateScriptInput(input: Partial<ScriptDefinition>): string | null {
  if (!input.name || typeof input.name !== "string" || input.name.trim().length > MAX_SCRIPT_NAME_LENGTH) {
    return `name is required (max ${MAX_SCRIPT_NAME_LENGTH} chars)`;
  }
  if (
    input.description !== undefined &&
    input.description !== null &&
    (typeof input.description !== "string" || input.description.length > MAX_SCRIPT_DESCRIPTION_LENGTH)
  ) {
    return `description must be ${MAX_SCRIPT_DESCRIPTION_LENGTH} characters or less`;
  }
  if (input.type !== "package_manager" && input.type !== "system") {
    return "type must be package_manager or system";
  }
  const operations: ScriptOperation[] = ["detect", "check_updates", "list_installed_packages", "repair_issue", "autoremove", "upgrade_all", "full_upgrade_all", "upgrade_selected", "system_info", "reboot"];
  if (!input.operation || !operations.includes(input.operation)) {
    return "operation is not supported";
  }
  if (input.type === "package_manager" && !input.pkgManager) {
    return "pkgManager is required for package manager scripts";
  }
  if (input.type === "package_manager") {
    const managerError = validatePackageManagerName(input.pkgManager);
    if (managerError) return managerError;
    if (input.operation === "system_info" || input.operation === "reboot") {
      return "package manager scripts cannot use system operations";
    }
  }
  if (input.type === "system" && input.pkgManager) {
    return "system scripts cannot have pkgManager";
  }
  if (input.type === "system" && input.operation !== "system_info" && input.operation !== "reboot") {
    return "system scripts must use system_info or reboot";
  }
  if (input.isDefault !== undefined && typeof input.isDefault !== "boolean") {
    return "isDefault must be a boolean";
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return "steps must include at least one command";
  }
  if (input.steps.length > MAX_SCRIPT_STEPS) {
    return `steps must include at most ${MAX_SCRIPT_STEPS} commands`;
  }
  if (input.operation === "detect" && input.steps.length !== 1) {
    return "detection scripts must include exactly one step";
  }
  for (const step of input.steps) {
    if (!isRecord(step)) return "each step must be an object";
    if (
      typeof step.label !== "string" ||
      !step.label.trim() ||
      step.label.length > MAX_STEP_LABEL_LENGTH ||
      typeof step.command !== "string" ||
      !step.command.trim() ||
      step.command.length > MAX_STEP_COMMAND_LENGTH
    ) {
      return `each step needs a label and command (command max ${MAX_STEP_COMMAND_LENGTH} chars)`;
    }
  }
  const parserConfig = normalizeParserConfigForOperation(input.parserConfig, input.operation);
  const parserConfigError = validateParserConfig(parserConfig);
  if (parserConfigError) return parserConfigError;
  if (
    (input.operation === "check_updates" || input.operation === "list_installed_packages") &&
    parserConfig?.parseStep !== undefined &&
    parserConfig.parseStep >= input.steps.length
  ) {
    return "parserConfig.parseStep must reference an existing step";
  }
  if (
    input.sourceScriptId !== undefined &&
    input.sourceScriptId !== null &&
    (typeof input.sourceScriptId !== "string" || input.sourceScriptId.length > 120 || !parseScriptId(input.sourceScriptId))
  ) {
    return "sourceScriptId must be a valid script ID";
  }
  return validateSystemInfoConfig(input.systemInfoConfig);
}

function defaultScopeCondition(input: Pick<ScriptDefinition, "type" | "operation" | "pkgManager">) {
  return and(
    eq(customScripts.type, input.type),
    eq(customScripts.operation, input.operation),
    input.pkgManager ? eq(customScripts.pkgManager, input.pkgManager) : isNull(customScripts.pkgManager),
  );
}

function clearOtherDefaults(input: Pick<ScriptDefinition, "type" | "operation" | "pkgManager">, exceptId?: number): void {
  const conditions = [
    defaultScopeCondition(input),
    eq(customScripts.isDefault, true),
  ];
  if (exceptId !== undefined) conditions.push(ne(customScripts.id, exceptId));
  getDb()
    .update(customScripts)
    .set({ isDefault: false })
    .where(and(...conditions))
    .run();
}

export function createScript(input: Partial<ScriptDefinition>): ScriptDefinition {
  const normalizedInput = normalizeScriptConfigPlaceholders(input);
  const error = validateScriptInput(normalizedInput);
  if (error) throw new Error(error);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (normalizedInput.isDefault) clearOtherDefaults(normalizedInput as ScriptDefinition);
  const parserConfig = normalizeParserConfigForOperation(normalizedInput.parserConfig, normalizedInput.operation!);
  const row = getDb()
    .insert(customScripts)
    .values({
      name: normalizedInput.name!.trim(),
      description: normalizedInput.description?.trim() || null,
      type: normalizedInput.type!,
      operation: normalizedInput.operation!,
      pkgManager: normalizedInput.pkgManager ?? null,
      isDefault: normalizedInput.isDefault ?? false,
      steps: JSON.stringify(normalizedInput.steps),
      parserConfig: parserConfig ? JSON.stringify(parserConfig) : null,
      systemInfoConfig: normalizedInput.systemInfoConfig ? JSON.stringify(normalizedInput.systemInfoConfig) : null,
      sourceScriptId: normalizedInput.sourceScriptId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return serializeCustomScript(row);
}

export function updateScript(scriptId: string, input: Partial<ScriptDefinition>): ScriptDefinition {
  const parsed = parseScriptId(scriptId);
  if (!parsed || parsed.kind !== "custom") throw new Error("Built-in scripts are read-only");
  const existing = getScriptById(scriptId);
  if (!existing) throw new Error("Script not found");
  const next = normalizeScriptConfigPlaceholders({ ...existing, ...input, readonly: false, id: scriptId }) as ScriptDefinition;
  const error = validateScriptInput(next);
  if (error) throw new Error(error);
  const scopeChanged =
    existing.type !== next.type ||
    existing.operation !== next.operation ||
    existing.pkgManager !== next.pkgManager;
  if (scopeChanged && listScriptUsages(scriptId).length > 0) {
    throw new Error("Script operation or package manager cannot be changed while assigned to systems");
  }
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  if (next.isDefault) clearOtherDefaults(next, parsed.id);
  const parserConfig = normalizeParserConfigForOperation(next.parserConfig, next.operation);
  const row = getDb()
    .update(customScripts)
    .set({
      name: next.name.trim(),
      description: next.description?.trim() || null,
      type: next.type,
      operation: next.operation,
      pkgManager: next.pkgManager ?? null,
      isDefault: next.isDefault,
      steps: JSON.stringify(next.steps),
      parserConfig: parserConfig ? JSON.stringify(parserConfig) : null,
      systemInfoConfig: next.systemInfoConfig ? JSON.stringify(next.systemInfoConfig) : null,
      sourceScriptId: next.sourceScriptId ?? null,
      updatedAt: now,
    })
    .where(eq(customScripts.id, parsed.id))
    .returning()
    .get();
  return serializeCustomScript(row);
}

function isManagerActiveForSystem(system: {
  pkgManager?: string | null;
  detectedPkgManagers: string | null;
  disabledPkgManagers: string | null;
}, manager: string): boolean {
  const disabled = parseJson<string[]>(system.disabledPkgManagers, []);
  if (disabled.includes(manager)) return false;
  const detected = parseJson<string[]>(system.detectedPkgManagers, []);
  if (detected.length > 0) return detected.includes(manager);
  if (system.pkgManager) return system.pkgManager === manager;
  return BUILTIN_MANAGER_ORDER.includes(manager);
}

function listSystemsUsingPackageManager(manager: string): ScriptUsage[] {
  return getDb()
    .select({
      systemId: systems.id,
      systemName: systems.name,
      pkgManager: systems.pkgManager,
      detectedPkgManagers: systems.detectedPkgManagers,
      disabledPkgManagers: systems.disabledPkgManagers,
    })
    .from(systems)
    .orderBy(asc(systems.name), asc(systems.id))
    .all()
    .filter((system) => isManagerActiveForSystem(system, manager))
    .map((system) => ({
      systemId: system.systemId,
      systemName: system.systemName,
      operationKey: buildOperationKey("detect", manager),
    }));
}

function withoutManager(value: string | null, manager: string): string | null {
  const raw = parseJson<unknown>(value, []);
  const next = Array.from(new Set(
    Array.isArray(raw)
      ? raw.filter((entry): entry is string => typeof entry === "string" && entry !== manager)
      : [],
  ));
  return next.length > 0 ? JSON.stringify(next) : null;
}

function removePackageManagerFromSystemConfigs(manager: string): void {
  const systemRows = getDb()
    .select({
      id: systems.id,
      pkgManager: systems.pkgManager,
      detectedPkgManagers: systems.detectedPkgManagers,
      disabledPkgManagers: systems.disabledPkgManagers,
      pkgManagerConfigs: systems.pkgManagerConfigs,
    })
    .from(systems)
    .all();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  for (const system of systemRows) {
    const rawConfigs = parseJson<unknown>(system.pkgManagerConfigs, {});
    const configs = isRecord(rawConfigs) ? { ...rawConfigs } : {};
    delete configs[manager];
    const nextConfigs = Object.keys(configs).length > 0 ? JSON.stringify(configs) : null;
    const nextPkgManager = system.pkgManager === manager ? null : system.pkgManager;
    const nextDetected = withoutManager(system.detectedPkgManagers, manager);
    const nextDisabled = withoutManager(system.disabledPkgManagers, manager);

    if (
      nextPkgManager === system.pkgManager &&
      nextDetected === system.detectedPkgManagers &&
      nextDisabled === system.disabledPkgManagers &&
      nextConfigs === system.pkgManagerConfigs
    ) {
      continue;
    }

    getDb()
      .update(systems)
      .set({
        pkgManager: nextPkgManager,
        detectedPkgManagers: nextDetected,
        disabledPkgManagers: nextDisabled,
        pkgManagerConfigs: nextConfigs,
        updatedAt: now,
      })
      .where(eq(systems.id, system.id))
      .run();
  }

  const overrideRows = getDb()
    .select({ id: systemScriptOverrides.id, operationKey: systemScriptOverrides.operationKey })
    .from(systemScriptOverrides)
    .all()
    .filter((override) => override.operationKey.startsWith(`${manager}/`));
  for (const override of overrideRows) {
    getDb()
      .delete(systemScriptOverrides)
      .where(eq(systemScriptOverrides.id, override.id))
      .run();
  }
}

function getExplicitDefaultScriptId(script: Pick<ScriptDefinition, "type" | "operation" | "pkgManager">): string | null {
  const row = getDb()
    .select({ id: customScripts.id })
    .from(customScripts)
    .where(and(defaultScopeCondition(script), eq(customScripts.isDefault, true)))
    .orderBy(asc(customScripts.id))
    .get();
  return row ? `custom:${row.id}` : null;
}

function getLegacyDefaultCustomManagerScriptId(script: ScriptDefinition): string | null {
  if (!script.pkgManager || BUILTIN_MANAGER_ORDER.includes(script.pkgManager)) return null;
  if (getExplicitDefaultScriptId(script)) return null;
  const row = getDb()
    .select({ id: customScripts.id })
    .from(customScripts)
    .where(and(
      eq(customScripts.operation, script.operation),
      eq(customScripts.pkgManager, script.pkgManager),
    ))
    .orderBy(asc(customScripts.id))
    .get();
  return row ? `custom:${row.id}` : null;
}

function getEffectiveDefaultScriptId(script: ScriptDefinition): string | null {
  if (script.isDefault) return script.id;
  return getLegacyDefaultCustomManagerScriptId(script);
}

function listSystemsUsingDefault(script: ScriptDefinition, operationKey: string): ScriptUsage[] {
  const rows = getDb()
    .select({
      systemId: systems.id,
      systemName: systems.name,
      pkgManager: systems.pkgManager,
      detectedPkgManagers: systems.detectedPkgManagers,
      disabledPkgManagers: systems.disabledPkgManagers,
    })
    .from(systems)
    .orderBy(asc(systems.name), asc(systems.id))
    .all();

  return rows
    .filter((system) => !script.pkgManager || isManagerActiveForSystem(system, script.pkgManager))
    .filter((system) => {
      const override = getDb()
        .select({ id: systemScriptOverrides.id })
        .from(systemScriptOverrides)
        .where(and(
          eq(systemScriptOverrides.systemId, system.systemId),
          eq(systemScriptOverrides.operationKey, operationKey),
        ))
        .get();
      return !override;
    })
    .map((system) => ({
      systemId: system.systemId,
      systemName: system.systemName,
      operationKey,
    }));
}

export function listScriptUsages(scriptId: string): ScriptUsage[] {
  const script = getScriptById(scriptId);
  if (!script) return [];
  const operationKey = buildOperationKey(script.operation, script.pkgManager);
  const usageMap = new Map<string, ScriptUsage>();
  const addUsage = (usage: ScriptUsage) => {
    usageMap.set(`${usage.systemId}:${usage.operationKey}`, usage);
  };

  getDb()
    .select({
      systemId: systems.id,
      systemName: systems.name,
      operationKey: systemScriptOverrides.operationKey,
      pkgManager: systems.pkgManager,
      detectedPkgManagers: systems.detectedPkgManagers,
      disabledPkgManagers: systems.disabledPkgManagers,
    })
    .from(systemScriptOverrides)
    .innerJoin(systems, eq(systemScriptOverrides.systemId, systems.id))
    .where(eq(systemScriptOverrides.scriptId, scriptId))
    .orderBy(asc(systems.name), asc(systems.id), asc(systemScriptOverrides.operationKey))
    .all()
    .forEach((usage) => {
      const [manager] = usage.operationKey.split("/");
      if (manager && manager !== "system" && !isManagerActiveForSystem(usage, manager)) return;
      addUsage({
        systemId: usage.systemId,
        systemName: usage.systemName,
        operationKey: usage.operationKey,
      });
    });

  if (getEffectiveDefaultScriptId(script) === scriptId) {
    for (const usage of listSystemsUsingDefault(script, operationKey)) {
      addUsage(usage);
    }
  }

  return Array.from(usageMap.values()).sort((a, b) =>
    a.systemName.localeCompare(b.systemName) ||
    a.systemId - b.systemId ||
    a.operationKey.localeCompare(b.operationKey)
  );
}

export function deleteScript(scriptId: string): void {
  const parsed = parseScriptId(scriptId);
  if (!parsed || parsed.kind !== "custom") throw new Error("Built-in scripts are read-only");
  const usages = listScriptUsages(scriptId);
  if (usages.length > 0) throw new Error("Script is assigned to one or more systems");
  getDb()
    .delete(systemScriptOverrides)
    .where(eq(systemScriptOverrides.scriptId, scriptId))
    .run();
  getDb().delete(customScripts).where(eq(customScripts.id, parsed.id)).run();
}

export function createCustomPackageManager(input: {
  name: string;
  label: string;
  parserConfig?: CustomParserConfig | null;
  configEntries?: CustomPackageManagerConfigEntry[] | null;
}): CustomPackageManagerDefinition {
  const name = input.name.trim().toLowerCase();
  if (!PACKAGE_MANAGER_NAME_PATTERN.test(name)) {
    throw new Error("Package manager name must start with a letter and contain only lowercase letters, numbers, underscores, or dashes");
  }
  if (BUILTIN_MANAGER_ORDER.includes(name)) {
    throw new Error("A built-in package manager already uses that name");
  }
  if (!input.label.trim() || input.label.trim().length > 120) throw new Error("Package manager label is required (max 120 chars)");
  const parserConfigError = validateParserConfig(input.parserConfig);
  if (parserConfigError) throw new Error(parserConfigError);
  const configEntryError = validateCustomPackageManagerConfigEntries(
    input.configEntries,
    listPackageManagerDefinitions(),
    name,
  );
  if (configEntryError) throw new Error(configEntryError);
  const configEntries = normalizeCustomPackageManagerConfigEntriesForManager(name, input.configEntries);
  const row = getDb()
    .insert(customPackageManagers)
    .values({
      name,
      label: input.label.trim(),
      parserConfig: input.parserConfig ? JSON.stringify(input.parserConfig) : null,
      configEntries: configEntries.length ? JSON.stringify(configEntries) : null,
    })
    .returning()
    .get();
  return serializeCustomPackageManager(row);
}

export function updateCustomPackageManager(name: string, input: {
  label?: string;
  parserConfig?: CustomParserConfig | null;
  configEntries?: CustomPackageManagerConfigEntry[] | null;
}): CustomPackageManagerDefinition {
  const normalizedName = name.trim().toLowerCase();
  const isBuiltin = BUILTIN_MANAGER_ORDER.includes(normalizedName);
  const existing = getDb()
    .select()
    .from(customPackageManagers)
    .where(eq(customPackageManagers.name, normalizedName))
    .get();
  if (!existing && !isBuiltin) throw new Error("Package manager not found");
  if (!isBuiltin && (!input.label?.trim() || input.label.trim().length > 120)) {
    throw new Error("Package manager label is required (max 120 chars)");
  }
  if (!isBuiltin) {
    const parserConfigError = validateParserConfig(input.parserConfig);
    if (parserConfigError) throw new Error(parserConfigError);
  }
  const rawConfigEntries = input.configEntries === undefined
    ? parseJson<unknown>(existing?.configEntries, [])
    : input.configEntries;
  const configEntryError = validateCustomPackageManagerConfigEntries(
    rawConfigEntries,
    listPackageManagerDefinitions(),
    normalizedName,
  );
  if (configEntryError) throw new Error(configEntryError);
  const configEntries = normalizeCustomPackageManagerConfigEntriesForManager(normalizedName, rawConfigEntries);

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const values = {
    label: isBuiltin ? MANAGER_LABELS[normalizedName] ?? normalizedName : input.label!.trim(),
    parserConfig: isBuiltin || !input.parserConfig ? null : JSON.stringify(input.parserConfig),
    configEntries: configEntries.length ? JSON.stringify(configEntries) : null,
    updatedAt: now,
  };
  const row = existing
    ? getDb()
        .update(customPackageManagers)
        .set(values)
        .where(eq(customPackageManagers.name, normalizedName))
        .returning()
        .get()
    : getDb()
        .insert(customPackageManagers)
        .values({
          name: normalizedName,
          ...values,
          createdAt: now,
        })
        .returning()
        .get();
  return serializeCustomPackageManager(row);
}

export function deleteCustomPackageManager(name: string, options: { deleteScripts?: boolean } = {}): void {
  const normalizedName = name.trim().toLowerCase();
  if (BUILTIN_MANAGER_ORDER.includes(normalizedName)) {
    throw new Error("Built-in package managers are read-only");
  }
  const existing = getDb()
    .select()
    .from(customPackageManagers)
    .where(eq(customPackageManagers.name, normalizedName))
    .get();
  if (!existing) throw new Error("Package manager not found");
  const script = getDb()
    .select({ id: customScripts.id })
    .from(customScripts)
    .where(eq(customScripts.pkgManager, normalizedName))
    .get();
  if (script && !options.deleteScripts) {
    throw new Error("Package manager is used by one or more scripts");
  }

  if (options.deleteScripts) {
    const scriptRows = getDb()
      .select({ id: customScripts.id })
      .from(customScripts)
      .where(eq(customScripts.pkgManager, normalizedName))
      .all();
    for (const row of scriptRows) {
      const usages = listScriptUsages(`custom:${row.id}`);
      if (usages.length > 0) {
        throw new Error("Package manager has scripts assigned to one or more systems");
      }
    }
  }

  const activeSystems = listSystemsUsingPackageManager(normalizedName);
  if (activeSystems.length > 0) {
    const names = activeSystems.map((system) => system.systemName).join(", ");
    throw new Error(`Package manager is enabled or detected on ${activeSystems.length} ${activeSystems.length === 1 ? "system" : "systems"}: ${names}`);
  }

  if (options.deleteScripts) {
    const scriptRows = getDb()
      .select({ id: customScripts.id })
      .from(customScripts)
      .where(eq(customScripts.pkgManager, normalizedName))
      .all();
    for (const row of scriptRows) {
      getDb()
        .delete(systemScriptOverrides)
        .where(eq(systemScriptOverrides.scriptId, `custom:${row.id}`))
        .run();
    }
    getDb()
      .delete(customScripts)
      .where(eq(customScripts.pkgManager, normalizedName))
      .run();
  }

  removePackageManagerFromSystemConfigs(normalizedName);

  getDb()
    .delete(customPackageManagers)
    .where(eq(customPackageManagers.name, normalizedName))
    .run();
}

function findCustomPackageManager(name: string): CustomPackageManagerDefinition | null {
  const row = getDb()
    .select()
    .from(customPackageManagers)
    .where(eq(customPackageManagers.name, name))
    .get();
  return row ? serializeCustomPackageManager(row) : null;
}

function scriptBundleEntry(script: ScriptDefinition): CustomPackageManagerBundle["scripts"][number] {
  if (!script.pkgManager || script.type !== "package_manager") {
    throw new Error("Only package manager scripts can be exported with a package manager");
  }
  if (script.operation === "system_info" || script.operation === "reboot") {
    throw new Error("System scripts cannot be exported with a package manager");
  }
  return {
    name: script.name,
    description: script.description,
    type: "package_manager",
    operation: script.operation,
    pkgManager: script.pkgManager,
    isDefault: script.isDefault,
    steps: script.steps.map((step) => ({ ...step })),
    parserConfig: script.parserConfig ? { ...script.parserConfig } : null,
    systemInfoConfig: null,
    sourceScriptId: script.sourceScriptId,
  };
}

export function exportCustomPackageManagerBundle(name: string): CustomPackageManagerBundle {
  const normalizedName = name.trim().toLowerCase();
  if (BUILTIN_MANAGER_ORDER.includes(normalizedName)) {
    throw new Error("Built-in package managers cannot be exported as custom bundles");
  }
  const manager = findCustomPackageManager(normalizedName);
  if (!manager) throw new Error("Package manager not found");
  const scripts = getDb()
    .select()
    .from(customScripts)
    .where(eq(customScripts.pkgManager, normalizedName))
    .orderBy(asc(customScripts.operation), asc(customScripts.name), asc(customScripts.id))
    .all()
    .map(serializeCustomScript)
    .map(scriptBundleEntry);

  return {
    format: "ludash.custom-package-manager.v1",
    exportedAt: new Date().toISOString(),
    packageManager: {
      name: manager.name,
      label: manager.label,
      parserConfig: manager.parserConfig,
      configEntries: manager.configEntries.map((entry) => ({ ...entry })),
    },
    scripts,
  };
}

function normalizeBundle(value: unknown): CustomPackageManagerBundle {
  if (!isRecord(value)) throw new Error("Import file must contain a JSON object");
  if (value.format !== "ludash.custom-package-manager.v1") {
    throw new Error("Unsupported package manager export format");
  }
  if (!isRecord(value.packageManager)) {
    throw new Error("Import file is missing packageManager");
  }
  if (!Array.isArray(value.scripts)) {
    throw new Error("Import file scripts must be an array");
  }

  const packageManager = value.packageManager;
  const managerName = typeof packageManager.name === "string" ? packageManager.name.trim().toLowerCase() : "";
  const configEntryError = validateCustomPackageManagerConfigEntries(packageManager.configEntries);
  if (configEntryError) throw new Error(configEntryError);
  const bundle: CustomPackageManagerBundle = {
    format: "ludash.custom-package-manager.v1",
    exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : new Date().toISOString(),
    packageManager: {
      name: managerName,
      label: typeof packageManager.label === "string" ? packageManager.label : "",
      parserConfig: isRecord(packageManager.parserConfig) ? packageManager.parserConfig as CustomParserConfig : null,
      configEntries: normalizeCustomPackageManagerConfigEntriesForManager(managerName, packageManager.configEntries),
    },
    scripts: [],
  };

  for (const [index, rawScript] of value.scripts.entries()) {
    if (!isRecord(rawScript)) throw new Error(`scripts.${index} must be an object`);
    const script = {
      name: typeof rawScript.name === "string" ? rawScript.name : "",
      description: typeof rawScript.description === "string" ? rawScript.description : null,
      type: "package_manager" as const,
      operation: rawScript.operation as ScriptOperation,
      pkgManager: managerName,
      isDefault: rawScript.isDefault === true,
      steps: Array.isArray(rawScript.steps) ? rawScript.steps as ScriptStep[] : [],
      parserConfig: isRecord(rawScript.parserConfig) ? rawScript.parserConfig as CustomParserConfig : null,
      systemInfoConfig: null,
      sourceScriptId: typeof rawScript.sourceScriptId === "string" ? rawScript.sourceScriptId : null,
    };
    if (script.operation === "system_info" || script.operation === "reboot") {
      throw new Error(`scripts.${index}.operation must be a package manager operation`);
    }
    script.parserConfig = normalizeParserConfigForOperation(script.parserConfig, script.operation);
    bundle.scripts.push(script as CustomPackageManagerBundle["scripts"][number]);
  }

  return bundle;
}

function findImportScriptMatch(script: Pick<ScriptDefinition, "name" | "operation" | "pkgManager">): ScriptDefinition | null {
  const row = getDb()
    .select()
    .from(customScripts)
    .where(and(
      eq(customScripts.type, "package_manager"),
      eq(customScripts.pkgManager, script.pkgManager ?? ""),
      eq(customScripts.operation, script.operation),
      eq(customScripts.name, script.name.trim()),
    ))
    .orderBy(asc(customScripts.id))
    .get();
  return row ? serializeCustomScript(row) : null;
}

export function importCustomPackageManagerBundle(input: unknown): CustomPackageManagerImportResult {
  const bundle = normalizeBundle(input);
  const existingManager = findCustomPackageManager(bundle.packageManager.name);
  const manager = existingManager
    ? updateCustomPackageManager(bundle.packageManager.name, bundle.packageManager)
    : createCustomPackageManager(bundle.packageManager);

  const scripts: ScriptDefinition[] = [];
  let createdScripts = 0;
  let updatedScripts = 0;
  for (const script of bundle.scripts) {
    const match = findImportScriptMatch(script);
    if (match) {
      scripts.push(updateScript(match.id, script));
      updatedScripts += 1;
    } else {
      scripts.push(createScript(script));
      createdScripts += 1;
    }
  }

  return { manager, scripts, createdScripts, updatedScripts };
}

export function getSystemOverrides(systemId: number): Record<string, string> {
  const rows = getDb()
    .select()
    .from(systemScriptOverrides)
    .where(eq(systemScriptOverrides.systemId, systemId))
    .all();
  return Object.fromEntries(rows.map((row) => [row.operationKey, row.scriptId]));
}

function validateSystemOverride(operationKey: string, scriptId: string | null | undefined): void {
  if (!/^[a-z0-9_-]+\/[a-z_]+$|^system\/[a-z_]+$/.test(operationKey)) {
    throw new Error(`Invalid operation key: ${operationKey}`);
  }
  if (!scriptId) return;
  const script = getScriptById(scriptId);
  if (!script) throw new Error(`Script not found: ${scriptId}`);
  const expectedKey = buildOperationKey(script.operation, script.pkgManager);
  if (expectedKey !== operationKey) {
    throw new Error(`Script ${scriptId} is not compatible with ${operationKey}`);
  }
}

export function setSystemOverrides(systemId: number, overrides: Record<string, string | null | undefined>): Record<string, string> {
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  for (const [operationKey, scriptId] of Object.entries(overrides)) {
    validateSystemOverride(operationKey, scriptId);
    db.delete(systemScriptOverrides)
      .where(and(eq(systemScriptOverrides.systemId, systemId), eq(systemScriptOverrides.operationKey, operationKey)))
      .run();
    if (!scriptId) continue;
    db.insert(systemScriptOverrides)
      .values({ systemId, operationKey, scriptId, createdAt: now, updatedAt: now })
      .run();
  }
  return getSystemOverrides(systemId);
}

export function replaceSystemOverrides(systemId: number, overrides: Record<string, string | null | undefined>): Record<string, string> {
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const entries = Object.entries(overrides);
  for (const [operationKey, scriptId] of entries) {
    validateSystemOverride(operationKey, scriptId);
  }
  db.delete(systemScriptOverrides)
    .where(eq(systemScriptOverrides.systemId, systemId))
    .run();
  for (const [operationKey, scriptId] of entries) {
    if (!scriptId) continue;
    db.insert(systemScriptOverrides)
      .values({ systemId, operationKey, scriptId, createdAt: now, updatedAt: now })
      .run();
  }
  return getSystemOverrides(systemId);
}

export function resolveScript(
  systemId: number,
  operation: ScriptOperation,
  pkgManager?: string | null,
): ScriptDefinition | null {
  const operationKey = buildOperationKey(operation, pkgManager);
  const override = getDb()
    .select()
    .from(systemScriptOverrides)
    .where(and(eq(systemScriptOverrides.systemId, systemId), eq(systemScriptOverrides.operationKey, operationKey)))
    .get();
  if (override) {
    const script = getScriptById(override.scriptId);
    if (script && buildOperationKey(script.operation, script.pkgManager) === operationKey) return script;
  }
  const explicitDefaultId = getExplicitDefaultScriptId({
    type: pkgManager == null ? "system" : "package_manager",
    operation,
    pkgManager: pkgManager ?? null,
  });
  if (explicitDefaultId) {
    const script = getScriptById(explicitDefaultId);
    if (script) return script;
  }
  const builtin = getBuiltinScripts().find((script) =>
    script.operation === operation && script.pkgManager === (pkgManager ?? null)
  );
  if (builtin) return builtin;

  const row = getDb()
    .select()
    .from(customScripts)
    .where(and(
      eq(customScripts.operation, operation),
      pkgManager == null
        ? eq(customScripts.type, "system")
        : eq(customScripts.pkgManager, pkgManager),
    ))
    .orderBy(asc(customScripts.id))
    .get();
  return row ? serializeCustomScript(row) : null;
}

function isUnmodifiedBuiltinCopy(script: ScriptDefinition): boolean {
  if (script.readonly || !script.sourceScriptId?.startsWith("builtin:")) return false;
  const source = getBuiltinScripts().find((candidate) => candidate.id === script.sourceScriptId);
  if (!source) return false;
  if (
    source.type !== script.type ||
    source.operation !== script.operation ||
    source.pkgManager !== script.pkgManager
  ) {
    return false;
  }
  if (script.steps.length !== source.steps.length) return false;
  return script.steps.every((step, index) => {
    const sourceStep = source.steps[index];
    return step.label === sourceStep.label && step.command === sourceStep.command;
  });
}

function getRuntimeBuiltinScript(script: ScriptDefinition): ScriptDefinition | null {
  if (script.readonly) return script;
  if (!isUnmodifiedBuiltinCopy(script)) return null;
  return getBuiltinScripts().find((candidate) => candidate.id === script.sourceScriptId) ?? null;
}

function withConfigDefaults(
  manager: string | null | undefined,
  config: PackageManagerConfigValue | undefined,
): PackageManagerConfigValue | undefined {
  if (!manager) return config;
  const configured = config && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
  const builtinDefaults: Record<string, Record<string, unknown>> = {
    apt: {
      defaultUpgradeMode: "upgrade",
    },
    dnf: {
      defaultUpgradeMode: "upgrade",
    },
  };
  const builtinFragments: Record<string, Record<string, unknown>> = {
    dnf: {
      refreshMetadataOnCheckArg: configured.refreshMetadataOnCheck === true ? " --refresh" : "",
      autoAcceptEulaOnUpgradePrefix: configured.autoAcceptEulaOnUpgrade === true
        ? "env ACCEPT_EULA=Y "
        : "",
    },
    yum: {
      autoAcceptEulaOnUpgradePrefix: configured.autoAcceptEulaOnUpgrade === true
        ? "env ACCEPT_EULA=Y "
        : "",
    },
  };
  const withBuiltinDefaults = {
    ...(builtinDefaults[manager] ?? {}),
    ...configured,
    ...(builtinFragments[manager] ?? {}),
  };
  const definition = listPackageManagerDefinitions().find((entry) => entry.name === manager);
  if (!definition?.configEntries.length) return withBuiltinDefaults;
  const defaults: Record<string, unknown> = {};
  for (const entry of definition.configEntries) {
    const legacyKey = getLegacyCustomConfigKey(manager, entry.key);
    const value = withBuiltinDefaults[legacyKey] ?? entry.defaultValue;
    defaults[legacyKey] = value;
  }
  return {
    ...defaults,
    ...withBuiltinDefaults,
  };
}

export function resolveRuntimeSteps(args: {
  systemId: number;
  operation: ScriptOperation;
  pkgManager?: string | null;
  pkgManagerConfig?: PackageManagerConfigValue;
  packages?: string[];
}): ScriptStep[] {
  const script = resolveScript(args.systemId, args.operation, args.pkgManager);
  if (!script) return [];
  return script.steps.map((step) => ({
    label: step.label,
    command: renderCommandTemplate(step.command, {
      pkgManager: args.pkgManager,
      packages: args.packages,
      config: args.pkgManagerConfig,
    }),
  }));
}

export async function detectPackageManagersWithScripts(
  systemId: number,
  sshManager: SSHConnectionManager,
  conn: Client,
): Promise<string[]> {
  const detected: string[] = [];
  const candidates = [
    ...BUILTIN_MANAGER_ORDER,
    ...listCustomPackageManagers().map((manager) => manager.name),
  ];
  for (const name of candidates) {
    const steps = resolveRuntimeSteps({ systemId, operation: "detect", pkgManager: name });
    if (!steps.length) continue;
    const { stdout, exitCode } = await sshManager.runCommand(conn, steps[0].command, 10);
    if (exitCode === 0 && stdout.includes("found")) {
      detected.push(name);
    }
  }
  if (detected.includes("dnf") && detected.includes("yum")) {
    detected.splice(detected.indexOf("yum"), 1);
  }
  return detected;
}

export function isCustomPackageManager(name: string): boolean {
  return listCustomPackageManagers().some((manager) => manager.name === name);
}

export function parseCustomUpdates(
  pkgManager: string,
  parserConfig: CustomParserConfig | null | undefined,
  commandResults: CheckCommandResult[],
): ParsedUpdate[] {
  const config = parserConfig ?? listCustomPackageManagers().find((manager) => manager.name === pkgManager)?.parserConfig;
  if (!config?.updateRegex) return [];
  const parseStep = Number.isInteger(config.parseStep) ? Math.max(0, config.parseStep ?? 0) : commandResults.length - 1;
  const output = commandResults[parseStep]?.stdout ?? commandResults[commandResults.length - 1]?.stdout ?? "";
  const configError = validateParserConfig(config);
  if (configError) throw new Error(configError);
  const updateRegex = compileValidatedRegex(config.updateRegex, "parserConfig.updateRegex", { requireUpdateGroups: true });
  const securityRegex = config.securityRegex ? compileValidatedRegex(config.securityRegex, "parserConfig.securityRegex") : null;
  const keptBackRegex = config.keptBackRegex ? compileValidatedRegex(config.keptBackRegex, "parserConfig.keptBackRegex") : null;
  const updates: ParsedUpdate[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = updateRegex.exec(line);
    if (!match?.groups?.packageName) continue;
    updates.push({
      packageName: match.groups.packageName,
      currentVersion: match.groups.currentVersion ?? null,
      newVersion: match.groups.newVersion ?? "",
      architecture: match.groups.architecture ?? null,
      repository: match.groups.repository ?? null,
      isSecurity: securityRegex ? securityRegex.test(line) : false,
      isKeptBack: keptBackRegex ? keptBackRegex.test(line) : false,
      pkgManager,
    });
  }
  return updates.filter((update) => update.newVersion);
}

export function parseUpdatesWithScript(
  pkgManager: string,
  script: ScriptDefinition | null | undefined,
  commandResults: CheckCommandResult[],
): ParsedUpdate[] {
  const runtimeBuiltin = script ? getRuntimeBuiltinScript(script) : null;
  const sourceParser = runtimeBuiltin?.pkgManager
    ? getParser(runtimeBuiltin.pkgManager)
    : undefined;
  if (sourceParser) {
    const last = commandResults[commandResults.length - 1] ?? {
      command: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
    return sourceParser.parseCheckOutput(last.stdout, last.stderr, last.exitCode, {
      commandResults,
    }).map((update) => ({ ...update, pkgManager }));
  }
  return parseCustomUpdates(pkgManager, script?.parserConfig, commandResults);
}

export function parseCustomInstalledPackages(
  pkgManager: string,
  parserConfig: CustomParserConfig | null | undefined,
  commandResults: CheckCommandResult[],
): InstalledPackage[] {
  const config = parserConfig ?? listCustomPackageManagers().find((manager) => manager.name === pkgManager)?.parserConfig;
  if (!config?.installedPackageRegex) {
    throw new Error("Installed-package parser requires installedPackageRegex");
  }
  const parseStep = Number.isInteger(config.parseStep)
    ? Math.max(0, config.parseStep ?? 0)
    : commandResults.length - 1;
  const output = commandResults[parseStep]?.stdout ?? commandResults[commandResults.length - 1]?.stdout ?? "";
  const configError = validateParserConfig(config);
  if (configError) throw new Error(configError);
  const installedPackageRegex = compileValidatedRegex(
    config.installedPackageRegex,
    "parserConfig.installedPackageRegex",
    { requireInstalledPackageGroups: true },
  );
  const packages: InstalledPackage[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = installedPackageRegex.exec(line);
    if (!match?.groups?.packageName || !match.groups.currentVersion) continue;
    packages.push({
      pkgManager,
      packageName: match.groups.packageName,
      currentVersion: match.groups.currentVersion,
      architecture: match.groups.architecture ?? null,
      repository: match.groups.repository ?? null,
    });
  }
  return packages;
}

export function parseInstalledPackagesWithScript(
  pkgManager: string,
  script: ScriptDefinition | null | undefined,
  commandResults: CheckCommandResult[],
): InstalledPackage[] {
  const last = commandResults[commandResults.length - 1] ?? {
    command: "",
    stdout: "",
    stderr: "",
    exitCode: 0,
  };
  const runtimeBuiltin = script ? getRuntimeBuiltinScript(script) : null;
  const builtinPackages = runtimeBuiltin?.pkgManager
    ? parseBuiltinInstalledPackages(runtimeBuiltin.pkgManager, last.stdout)
    : null;
  if (builtinPackages) return builtinPackages;
  return parseCustomInstalledPackages(pkgManager, script?.parserConfig, commandResults);
}

export function getCustomCheckErrorMessage(
  parserConfig: CustomParserConfig | null | undefined,
  stdout: string,
  stderr: string,
  exitCode: number,
): string | null {
  const successCodes = new Set([0, ...(parserConfig?.successExitCodes ?? []), ...(parserConfig?.updatesExitCodes ?? [])]);
  if (successCodes.has(exitCode)) return null;
  return stderr || stdout || `Command exited with code ${exitCode}`;
}

export function getSystemPackageManagerConfig(system: { pkgManagerConfigs?: string | null }, manager: string): PackageManagerConfigValue | undefined {
  return withConfigDefaults(
    manager,
    getManagerConfig(parsePackageManagerConfigs(system.pkgManagerConfigs ?? null, listPackageManagerDefinitions()), manager),
  );
}

function applySystemInfoConfig(stdout: string, config: CustomSystemInfoConfig | null | undefined): SystemInfo | null {
  if (!config?.fieldSections || config.mode === "builtin") return null;
  const base = parseSystemInfo(stdout);
  const sections = parseSections(stdout);
  const next: SystemInfo = { ...base };
  for (const [field, section] of Object.entries(config.fieldSections)) {
    if (!section || !(field in next)) continue;
    const value = sections[section]?.trim();
    if (!value) continue;
    if (field === "uptimeSeconds") {
      next.uptimeSeconds = Number.isFinite(Number(value)) ? Number(value) : next.uptimeSeconds;
    } else if (field === "installedKernels") {
      next.installedKernels = value.split("\n").map((line) => line.trim()).filter(Boolean);
    } else if (field === "rebootRequiredFilePresent" || field === "needsReboot") {
      (next as unknown as Record<string, unknown>)[field] = /^(1|true|yes|present|required)$/i.test(value);
    } else {
      (next as unknown as Record<string, unknown>)[field] = value.split("\n")[0]?.trim() ?? value;
    }
  }
  if (config.rebootRequiredRegex) {
    next.needsReboot = compileValidatedRegex(config.rebootRequiredRegex, "systemInfoConfig.rebootRequiredRegex").test(stdout);
  }
  return next;
}

function parseSections(stdout: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = "";
  for (const line of stdout.split("\n")) {
    const match = /^===([^=]+)===$/.exec(line.trim());
    if (match) {
      current = match[1];
      sections[current] = "";
    } else if (current) {
      sections[current] += `${line}\n`;
    }
  }
  return sections;
}

export function parseSystemInfoWithScript(
  stdout: string,
  script: ScriptDefinition | null,
  previous: PreviousRebootState | null | undefined,
): { info: SystemInfo; needsReboot: boolean; dismissalExpired: boolean } | null {
  if (!stdout.includes("===OS===") && !script?.systemInfoConfig?.fieldSections) return null;
  const usesBuiltinParser =
    !script ||
    script.readonly ||
    script.systemInfoConfig?.mode === "builtin" ||
    isUnmodifiedBuiltinCopy(script);
  const customInfo = usesBuiltinParser ? null : applySystemInfoConfig(stdout, script.systemInfoConfig);
  const info = customInfo ?? parseSystemInfo(stdout);
  const rawNeedsReboot = script?.systemInfoConfig?.rebootRequiredRegex
    ? compileValidatedRegex(script.systemInfoConfig.rebootRequiredRegex, "systemInfoConfig.rebootRequiredRegex").test(stdout)
    : resolveRebootRequired(previous, info);
  const rebootDismissal = resolveRebootDismissal(previous, info, rawNeedsReboot);
  return {
    info,
    needsReboot: rebootDismissal.needsReboot,
    dismissalExpired: rebootDismissal.dismissalExpired,
  };
}
