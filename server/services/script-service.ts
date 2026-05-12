import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { customPackageManagers, customScripts, systemScriptOverrides, systems } from "../db/schema";
import {
  getManagerConfig,
  parsePackageManagerConfigs,
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
  name: string;
  label: string;
  color: string | null;
  parserConfig: CustomParserConfig | null;
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

export const PLACEHOLDER_HELP: PlaceholderHelpEntry[] = [
  { name: "{{package}}", description: "The first selected package name, validated before execution.", example: "apt-get install --only-upgrade -y {{package}}" },
  { name: "{{packages}}", description: "All selected package names joined by spaces after validation.", example: "dnf upgrade -y {{packages}}" },
  { name: "{{quotedPackage}}", description: "The first selected package shell-quoted with single quotes.", example: "tool upgrade {{quotedPackage}}" },
  { name: "{{quotedPackages}}", description: "All selected packages shell-quoted and joined by spaces.", example: "tool upgrade {{quotedPackages}}" },
  { name: "{{manager}}", description: "The package manager key for the current operation.", example: "echo Checking {{manager}}" },
  { name: "{{config.someKey}}", description: "A manager-specific config value from the system package-manager settings.", example: "echo {{config.defaultUpgradeMode}}" },
  { name: "{{sudo:COMMAND}}", description: "Wraps COMMAND with the dashboard sudo fallback helper.", example: "{{sudo:apk update}} 2>&1" },
];

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
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
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    color: row.color,
    parserConfig: parseJson<CustomParserConfig | null>(row.parserConfig, null),
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
    .map(serializeCustomPackageManager);
}

export function listScripts(): ScriptListResponse {
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
    packageManagers: listCustomPackageManagers(),
    placeholders: PLACEHOLDER_HELP,
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
  if (!input.name || typeof input.name !== "string" || input.name.trim().length > 120) {
    return "name is required (max 120 chars)";
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
  if (input.type === "system" && input.pkgManager) {
    return "system scripts cannot have pkgManager";
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return "steps must include at least one command";
  }
  for (const step of input.steps) {
    if (!step.label || !step.command || step.command.length > 8000) {
      return "each step needs a label and command";
    }
  }
  return null;
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

export function listScriptUsages(scriptId: string): ScriptUsage[] {
  return getDb()
    .select({
      systemId: systems.id,
      systemName: systems.name,
      operationKey: systemScriptOverrides.operationKey,
      disabledPkgManagers: systems.disabledPkgManagers,
    })
    .from(systemScriptOverrides)
    .innerJoin(systems, eq(systemScriptOverrides.systemId, systems.id))
    .where(eq(systemScriptOverrides.scriptId, scriptId))
    .orderBy(asc(systems.name), asc(systems.id), asc(systemScriptOverrides.operationKey))
    .all()
    .filter((usage) => {
      const [manager] = usage.operationKey.split("/");
      if (!manager || manager === "system") return true;
      return !parseJson<string[]>(usage.disabledPkgManagers, []).includes(manager);
    })
    .map(({ disabledPkgManagers, ...usage }) => usage);
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
}): CustomPackageManagerDefinition {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) {
    throw new Error("Package manager name must start with a letter and contain only lowercase letters, numbers, underscores, or dashes");
  }
  if (BUILTIN_MANAGER_ORDER.includes(name)) {
    throw new Error("A built-in package manager already uses that name");
  }
  if (!input.label.trim()) throw new Error("Package manager label is required");
  const row = getDb()
    .insert(customPackageManagers)
    .values({
      name,
      label: input.label.trim(),
      color: input.color?.trim() || null,
      parserConfig: input.parserConfig ? JSON.stringify(input.parserConfig) : null,
    })
    .returning()
    .get();
  return serializeCustomPackageManager(row);
}

export function updateCustomPackageManager(name: string, input: {
  label?: string;
  color?: string | null;
  parserConfig?: CustomParserConfig | null;
}): CustomPackageManagerDefinition {
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
  if (!input.label?.trim()) throw new Error("Package manager label is required");

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const row = getDb()
    .update(customPackageManagers)
    .set({
      label: input.label.trim(),
      color: input.color?.trim() || null,
      parserConfig: input.parserConfig ? JSON.stringify(input.parserConfig) : null,
      updatedAt: now,
    })
    .where(eq(customPackageManagers.name, normalizedName))
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
  const updateRegex = new RegExp(config.updateRegex);
  const securityRegex = config.securityRegex ? new RegExp(config.securityRegex) : null;
  const keptBackRegex = config.keptBackRegex ? new RegExp(config.keptBackRegex) : null;
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
  return getManagerConfig(parsePackageManagerConfigs(system.pkgManagerConfigs ?? null), manager);
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
    next.needsReboot = new RegExp(config.rebootRequiredRegex).test(stdout);
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
    ? new RegExp(script.systemInfoConfig.rebootRequiredRegex).test(stdout)
    : resolveRebootRequired(previous, info);
  const rebootDismissal = resolveRebootDismissal(previous, info, rawNeedsReboot);
  return {
    info,
    needsReboot: rebootDismissal.needsReboot,
    dismissalExpired: rebootDismissal.dismissalExpired,
  };
}
