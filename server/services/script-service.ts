import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { customPackageManagers, customScripts, systemScriptOverrides, systems } from "../db/schema";
import {
  getManagerConfig,
  normalizeCustomPackageManagerConfigEntries,
  parsePackageManagerConfigs,
  validateCustomPackageManagerConfigEntries,
  type CustomPackageManagerConfig,
  type CustomPackageManagerConfigEntry,
  type PackageManagerConfigValue,
} from "../package-manager-configs";
import { getPackageManagerDetectionCommands } from "../ssh/detector";
import { getParser, type ParsedUpdate } from "../ssh/parsers";
import type { CheckCommandResult } from "../ssh/parsers/types";
import { sudo, validatePackageName, validatePackageNames } from "../ssh/parsers/types";
import { getRebootCommand } from "../ssh/reboot";
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
  securityRegex?: string;
  keptBackRegex?: string;
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

export interface CustomPackageManagerDefinition {
  id: number;
  builtin: boolean;
  name: string;
  label: string;
  color: string | null;
  parserConfig: CustomParserConfig | null;
  configEntries: CustomPackageManagerConfigEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ScriptListResponse {
  scripts: ScriptDefinition[];
  packageManagers: CustomPackageManagerDefinition[];
  placeholders: PlaceholderHelpEntry[];
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

export const PLACEHOLDER_HELP: PlaceholderHelpEntry[] = [
  { name: "{{package}}", description: "The first selected package name, validated before execution.", example: "apt-get install --only-upgrade -y {{package}}" },
  { name: "{{packages}}", description: "All selected package names joined by spaces after validation.", example: "dnf upgrade -y {{packages}}" },
  { name: "{{quotedPackage}}", description: "The first selected package shell-quoted with single quotes.", example: "tool upgrade {{quotedPackage}}" },
  { name: "{{quotedPackages}}", description: "All selected packages shell-quoted and joined by spaces.", example: "tool upgrade {{quotedPackages}}" },
  { name: "{{manager}}", description: "The package manager key for the current operation.", example: "echo Checking {{manager}}" },
  { name: "{{config.someKey}}", description: "A manager-specific config value from the system package-manager settings.", example: "echo {{config.defaultUpgradeMode}}" },
  { name: "{{sudo:COMMAND}}", description: "Wraps COMMAND with the dashboard sudo fallback helper.", example: "{{sudo:apk update}} 2>&1" },
];

function buildPlaceholderHelp(customManagers: CustomPackageManagerDefinition[]): PlaceholderHelpEntry[] {
  const entries = [...PLACEHOLDER_HELP];
  for (const manager of customManagers) {
    for (const entry of manager.configEntries) {
      entries.push({
        name: `{{config.${entry.key}}}`,
        description: entry.description?.trim()
          ? `${manager.label}: ${entry.description.trim()}`
          : `${manager.label} custom config value.`,
        example: `echo {{config.${entry.key}}}`,
      });
    }
  }
  return entries;
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
  options: { required?: boolean; requireUpdateGroups?: boolean } = {},
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
  options: { requireUpdateGroups?: boolean } = {},
): RegExp {
  const error = validateRegexSource(source, field, {
    required: true,
    requireUpdateGroups: options.requireUpdateGroups,
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
    validateRegexSource(config.securityRegex, `${field}.securityRegex`) ||
    validateRegexSource(config.keptBackRegex, `${field}.keptBackRegex`) ||
    validateExitCodes(config.successExitCodes, `${field}.successExitCodes`) ||
    validateExitCodes(config.updatesExitCodes, `${field}.updatesExitCodes`)
  );
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
  let rendered = command
    .replaceAll("{{manager}}", context.pkgManager ?? "")
    .replaceAll("{{package}}", firstPackage)
    .replaceAll("{{packages}}", packages.join(" "))
    .replaceAll("{{quotedPackage}}", firstPackage ? shellQuote(firstPackage) : "")
    .replaceAll("{{quotedPackages}}", packages.map(shellQuote).join(" "));

  rendered = rendered.replace(/\{\{config\.([a-zA-Z0-9_.-]+)\}\}/g, (_match, path: string) =>
    resolveConfigValue(context.config, path),
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

function aptUpgradeModeScript(defaultMode: "upgrade" | "full-upgrade"): string {
  return commandLines(
    "# Use the configured APT upgrade mode; fall back to the standard mode when unset.",
    'upgrade_mode="{{config.defaultUpgradeMode}}"',
    `if [ "$upgrade_mode" != "full-upgrade" ]; then upgrade_mode="${defaultMode}"; fi`,
    "export DEBIAN_FRONTEND=noninteractive",
    sudo(`apt-get -o DPkg::Lock::Timeout=60 \${upgrade_mode} -y`) + " 2>&1",
  );
}

function dnfCheckScript(tool: "dnf" | "yum"): string {
  const hasRefresh = tool === "dnf";
  const checkLine = hasRefresh
    ? 'if [ "{{config.refreshMetadataOnCheck}}" = "true" ]; then check_args="$check_args --refresh"; fi'
    : "# Yum does not support the DNF metadata refresh flag here.";
  return commandLines(
    `# Check ${tool.toUpperCase()} updates and keep exit code 100 as updates-available, not a failure.`,
    'check_args=""',
    'if [ "{{config.autoAcceptNewSigningKeysOnCheck}}" = "true" ]; then check_args="$check_args -y"; fi',
    checkLine,
    `updates="$(${tool} $check_args check-update --quiet 2>&1)"; rc=$?`,
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
    `# Run ${tool.toUpperCase()} with automatic EULA acceptance only when that system setting is enabled.`,
    'if [ "{{config.autoAcceptEulaOnUpgrade}}" = "true" ]; then',
    `  ${sudo(`env ACCEPT_EULA=Y ${command}`)} 2>&1`,
    "else",
    `  ${sudo(command)} 2>&1`,
    "fi",
  );
}

function dnfUpgradeAllScript(full = false): string {
  const command = full
    ? "dnf distro-sync -y"
    : 'dnf ${upgrade_command} -y';
  return commandLines(
    "# Use DNF distro-sync when configured; otherwise use the regular upgrade command.",
    'upgrade_command="{{config.defaultUpgradeMode}}"',
    'if [ "$upgrade_command" != "distro-sync" ]; then upgrade_command="upgrade"; fi',
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
    `  ${command}`,
    "fi",
  );
}

function builtinCheckSteps(manager: string): ScriptStep[] {
  switch (manager) {
    case "apt":
      return [
        {
          label: "Fetching package lists",
          command: commentedCommand(
            "Refresh APT package metadata before listing available updates.",
            sudo("apt-get -o DPkg::Lock::Timeout=60 update -qq") + " 2>&1",
          ),
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
            sudo("pacman -Sy --noconfirm") + " 2>&1",
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
            sudo("apk update") + " 2>&1",
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
            sudo("flatpak update --appstream") + " 2>/dev/null; true",
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

function builtinUpgradeAllCommand(manager: string): string {
  switch (manager) {
    case "apt":
      return aptUpgradeModeScript("upgrade");
    case "dnf":
      return dnfUpgradeAllScript();
    case "yum":
      return dnfLikeUpgradeScript("yum", "yum update -y");
    case "pacman":
      return commentedCommand("Upgrade all Pacman packages and refresh package databases.", sudo("pacman -Syu --noconfirm") + " 2>&1");
    case "apk":
      return commentedCommand("Upgrade all APK packages from the configured repositories.", sudo("apk upgrade") + " 2>&1");
    case "flatpak":
      return commentedCommand("Upgrade all installed Flatpak applications and runtimes.", sudo("flatpak update -y") + " 2>&1");
    case "snap":
      return commentedCommand("Refresh all installed Snap packages.", sudo("snap refresh") + " 2>&1");
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

function builtinUpgradeSelectedCommand(manager: string): string {
  switch (manager) {
    case "apt":
      return commandLines(
        "# Upgrade only the selected APT packages.",
        "export DEBIAN_FRONTEND=noninteractive",
        sudo("apt-get -o DPkg::Lock::Timeout=60 install --only-upgrade -y {{packages}}") + " 2>&1",
      );
    case "dnf":
      return dnfLikeUpgradeScript("dnf", "dnf upgrade -y {{packages}}");
    case "yum":
      return dnfLikeUpgradeScript("yum", "yum update -y {{packages}}");
    case "pacman":
      return commentedCommand("Upgrade only the selected Pacman packages.", sudo("pacman -S --noconfirm {{packages}}") + " 2>&1");
    case "apk":
      return commentedCommand("Upgrade only the selected APK packages.", sudo("apk upgrade {{packages}}") + " 2>&1");
    case "flatpak":
      return commentedCommand("Upgrade only the selected Flatpak applications or runtimes.", sudo("flatpak update -y {{packages}}") + " 2>&1");
    case "snap":
      return commentedCommand("Refresh only the selected Snap packages.", sudo("snap refresh {{packages}}") + " 2>&1");
    default:
      return "";
  }
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
      [{ label: "Reboot system", command: getRebootCommand() }],
    ),
  ];
}

function serializeCustomScript(row: typeof customScripts.$inferSelect): ScriptDefinition {
  return {
    id: `custom:${row.id}`,
    readonly: false,
    name: row.name,
    description: row.description,
    type: row.type as ScriptType,
    operation: row.operation as ScriptOperation,
    pkgManager: row.pkgManager,
    steps: parseJson<ScriptStep[]>(row.steps, []),
    parserConfig: parseJson<CustomParserConfig | null>(row.parserConfig, null),
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
    color: row.color,
    parserConfig: builtin ? null : parseJson<CustomParserConfig | null>(row.parserConfig, null),
    configEntries: normalizeCustomPackageManagerConfigEntries(parseJson<unknown>(row.configEntries, [])),
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
    color: null,
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
    placeholders: buildPlaceholderHelp(packageManagers),
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
  const operations: ScriptOperation[] = ["detect", "check_updates", "upgrade_all", "full_upgrade_all", "upgrade_selected", "system_info", "reboot"];
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
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return "steps must include at least one command";
  }
  if (input.steps.length > MAX_SCRIPT_STEPS) {
    return `steps must include at most ${MAX_SCRIPT_STEPS} commands`;
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
  if (
    input.sourceScriptId !== undefined &&
    input.sourceScriptId !== null &&
    (typeof input.sourceScriptId !== "string" || input.sourceScriptId.length > 120 || !parseScriptId(input.sourceScriptId))
  ) {
    return "sourceScriptId must be a valid script ID";
  }
  return validateParserConfig(input.parserConfig) || validateSystemInfoConfig(input.systemInfoConfig);
}

export function createScript(input: Partial<ScriptDefinition>): ScriptDefinition {
  const error = validateScriptInput(input);
  if (error) throw new Error(error);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const row = getDb()
    .insert(customScripts)
    .values({
      name: input.name!.trim(),
      description: input.description?.trim() || null,
      type: input.type!,
      operation: input.operation!,
      pkgManager: input.pkgManager ?? null,
      steps: JSON.stringify(input.steps),
      parserConfig: input.parserConfig ? JSON.stringify(input.parserConfig) : null,
      systemInfoConfig: input.systemInfoConfig ? JSON.stringify(input.systemInfoConfig) : null,
      sourceScriptId: input.sourceScriptId ?? null,
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
  const next = { ...existing, ...input, readonly: false, id: scriptId };
  const error = validateScriptInput(next);
  if (error) throw new Error(error);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const row = getDb()
    .update(customScripts)
    .set({
      name: next.name.trim(),
      description: next.description?.trim() || null,
      type: next.type,
      operation: next.operation,
      pkgManager: next.pkgManager ?? null,
      steps: JSON.stringify(next.steps),
      parserConfig: next.parserConfig ? JSON.stringify(next.parserConfig) : null,
      systemInfoConfig: next.systemInfoConfig ? JSON.stringify(next.systemInfoConfig) : null,
      updatedAt: now,
    })
    .where(eq(customScripts.id, parsed.id))
    .returning()
    .get();
  return serializeCustomScript(row);
}

function isManagerActiveForSystem(system: {
  detectedPkgManagers: string | null;
  disabledPkgManagers: string | null;
}, manager: string): boolean {
  const disabled = parseJson<string[]>(system.disabledPkgManagers, []);
  if (disabled.includes(manager)) return false;
  if (!BUILTIN_MANAGER_ORDER.includes(manager)) {
    return parseJson<string[]>(system.detectedPkgManagers, []).includes(manager);
  }
  return true;
}

function getDefaultCustomManagerScriptId(script: ScriptDefinition): string | null {
  if (!script.pkgManager || BUILTIN_MANAGER_ORDER.includes(script.pkgManager)) return null;
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

  if (getDefaultCustomManagerScriptId(script) === scriptId && script.pkgManager) {
    const activeSystems = getDb()
      .select({
        systemId: systems.id,
        systemName: systems.name,
        detectedPkgManagers: systems.detectedPkgManagers,
        disabledPkgManagers: systems.disabledPkgManagers,
      })
      .from(systems)
      .orderBy(asc(systems.name), asc(systems.id))
      .all()
      .filter((system) => isManagerActiveForSystem(system, script.pkgManager!));

    for (const system of activeSystems) {
      const override = getDb()
        .select({ id: systemScriptOverrides.id })
        .from(systemScriptOverrides)
        .where(and(
          eq(systemScriptOverrides.systemId, system.systemId),
          eq(systemScriptOverrides.operationKey, operationKey),
        ))
        .get();
      if (override) continue;
      addUsage({
        systemId: system.systemId,
        systemName: system.systemName,
        operationKey,
      });
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
  color?: string | null;
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
  const configEntries = normalizeCustomPackageManagerConfigEntries(input.configEntries);
  const row = getDb()
    .insert(customPackageManagers)
    .values({
      name,
      label: input.label.trim(),
      color: input.color?.trim() || null,
      parserConfig: input.parserConfig ? JSON.stringify(input.parserConfig) : null,
      configEntries: configEntries.length ? JSON.stringify(configEntries) : null,
    })
    .returning()
    .get();
  return serializeCustomPackageManager(row);
}

export function updateCustomPackageManager(name: string, input: {
  label?: string;
  color?: string | null;
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
  const configEntries = normalizeCustomPackageManagerConfigEntries(rawConfigEntries);

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const values = {
    label: isBuiltin ? MANAGER_LABELS[normalizedName] ?? normalizedName : input.label!.trim(),
    color: input.color?.trim() || null,
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

export function deleteCustomPackageManager(name: string): void {
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
  if (script) throw new Error("Package manager is used by one or more scripts");

  getDb()
    .delete(customPackageManagers)
    .where(eq(customPackageManagers.name, normalizedName))
    .run();
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

function withCustomConfigDefaults(
  manager: string | null | undefined,
  config: PackageManagerConfigValue | undefined,
): PackageManagerConfigValue | undefined {
  if (!manager) return config;
  const definition = listPackageManagerDefinitions().find((entry) => entry.name === manager);
  if (!definition?.configEntries.length) return config;
  const configured = config && typeof config === "object" && !Array.isArray(config)
    ? config as CustomPackageManagerConfig
    : {};
  const defaults = Object.fromEntries(
    definition.configEntries.map((entry) => [
      entry.key,
      configured[entry.key] ?? entry.defaultValue,
    ]),
  );
  return {
    ...defaults,
    ...configured,
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
      config: withCustomConfigDefaults(args.pkgManager, args.pkgManagerConfig),
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
  return withCustomConfigDefaults(
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
