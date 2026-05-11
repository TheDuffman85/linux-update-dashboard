import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { customPackageManagers, customScripts, systemScriptOverrides } from "../db/schema";
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
  createdAt?: string;
  updatedAt?: string;
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

export interface CopiedPackageManagerResult {
  manager: CustomPackageManagerDefinition;
  scripts: ScriptDefinition[];
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
      [{ label: `Detect ${managerLabel(manager)}`, command: detection.command }],
    ));
  }
  if (!parser) return scripts;

  const checkCommands = parser.getCheckCommands();
  const labels = parser.getCheckCommandLabels?.() ?? [];
  scripts.push(builtinScript(
    "check_updates",
    manager,
    `Check ${managerLabel(manager)} updates`,
    `Refreshes and checks available ${managerLabel(manager)} updates.`,
    checkCommands.map((command, index) => ({
      label: labels[index] ?? `Step ${index + 1}`,
      command,
    })),
  ));
  scripts.push(builtinScript(
    "upgrade_all",
    manager,
    `Upgrade all ${managerLabel(manager)} packages`,
    `Installs all available ${managerLabel(manager)} updates.`,
    [{ label: `Upgrade all ${managerLabel(manager)} packages`, command: parser.getUpgradeAllCommand() }],
  ));
  const fullUpgrade = parser.getFullUpgradeAllCommand();
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
    [{ label: `Upgrade selected ${managerLabel(manager)} packages`, command: parser.getUpgradePackageCommand("codex-package-placeholder").replaceAll("codex-package-placeholder", "{{packages}}") }],
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
  return {
    scripts: [...getBuiltinScripts(), ...custom],
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

export function copyScript(scriptId: string): ScriptDefinition {
  const source = getScriptById(scriptId);
  if (!source) throw new Error("Script not found");
  return createScript({
    ...source,
    id: undefined,
    readonly: false,
    name: `${source.name} copy`,
    sourceScriptId: source.id,
  });
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

export function deleteScript(scriptId: string): void {
  const parsed = parseScriptId(scriptId);
  if (!parsed || parsed.kind !== "custom") throw new Error("Built-in scripts are read-only");
  const referenced = getDb()
    .select({ id: systemScriptOverrides.id })
    .from(systemScriptOverrides)
    .where(eq(systemScriptOverrides.scriptId, scriptId))
    .get();
  if (referenced) throw new Error("Script is assigned to one or more systems");
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

export function copyBuiltinPackageManager(input: {
  sourceManager: string;
  name: string;
  label: string;
  color?: string | null;
}): CopiedPackageManagerResult {
  const sourceManager = input.sourceManager.trim().toLowerCase();
  if (!BUILTIN_MANAGER_ORDER.includes(sourceManager)) {
    throw new Error("sourceManager must be a built-in package manager");
  }

  const sourceScripts = getBuiltinScripts().filter((script) =>
    script.type === "package_manager" && script.pkgManager === sourceManager
  );
  if (!sourceScripts.length) {
    throw new Error(`No built-in scripts found for ${sourceManager}`);
  }

  const manager = createCustomPackageManager({
    name: input.name,
    label: input.label,
    color: input.color,
  });
  const scripts = sourceScripts.map((script) => createScript({
    ...script,
    id: undefined,
    readonly: false,
    name: `${manager.label} ${script.operation}`,
    pkgManager: manager.name,
    parserConfig: null,
    sourceScriptId: script.id,
  }));

  return { manager, scripts };
}

export function getSystemOverrides(systemId: number): Record<string, string> {
  const rows = getDb()
    .select()
    .from(systemScriptOverrides)
    .where(eq(systemScriptOverrides.systemId, systemId))
    .all();
  return Object.fromEntries(rows.map((row) => [row.operationKey, row.scriptId]));
}

export function setSystemOverrides(systemId: number, overrides: Record<string, string | null | undefined>): Record<string, string> {
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  for (const [operationKey, scriptId] of Object.entries(overrides)) {
    if (!/^[a-z0-9_-]+\/[a-z_]+$|^system\/[a-z_]+$/.test(operationKey)) {
      throw new Error(`Invalid operation key: ${operationKey}`);
    }
    db.delete(systemScriptOverrides)
      .where(and(eq(systemScriptOverrides.systemId, systemId), eq(systemScriptOverrides.operationKey, operationKey)))
      .run();
    if (!scriptId) continue;
    const script = getScriptById(scriptId);
    if (!script) throw new Error(`Script not found: ${scriptId}`);
    const expectedKey = buildOperationKey(script.operation, script.pkgManager);
    if (expectedKey !== operationKey) {
      throw new Error(`Script ${scriptId} is not compatible with ${operationKey}`);
    }
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
  return JSON.stringify(script.steps) === JSON.stringify(source.steps);
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
  const runtimeBuiltin = getRuntimeBuiltinScript(script);
  if (runtimeBuiltin) {
    const parser = args.pkgManager ? getParser(args.pkgManager) : null;
    if (args.operation === "detect" && args.pkgManager) {
      const command = getPackageManagerDetectionCommands().find((entry) => entry.name === args.pkgManager)?.command;
      return command
        ? [{ label: `Detect ${managerLabel(args.pkgManager)}`, command }]
        : runtimeBuiltin.steps;
    }
    if (args.operation === "system_info") return [{ label: "Collect system information", command: SYSTEM_INFO_CMD }];
    if (args.operation === "reboot") return [{ label: "Reboot system", command: getRebootCommand() }];
    if (!parser) {
      return runtimeBuiltin.steps.map((step) => ({
        label: step.label,
        command: renderCommandTemplate(step.command, {
          pkgManager: args.pkgManager,
          packages: args.packages,
          config: args.pkgManagerConfig,
        }),
      }));
    }
    if (args.operation === "check_updates") {
      const commands = parser.getCheckCommands(args.pkgManagerConfig);
      const labels = parser.getCheckCommandLabels?.(args.pkgManagerConfig) ?? [];
      return commands.map((command, index) => ({ label: labels[index] ?? `Step ${index + 1}`, command }));
    }
    if (args.operation === "upgrade_all") {
      return [{ label: runtimeBuiltin.steps[0]?.label ?? "Upgrade all packages", command: parser.getUpgradeAllCommand(args.pkgManagerConfig) }];
    }
    if (args.operation === "full_upgrade_all") {
      const command = parser.getFullUpgradeAllCommand(args.pkgManagerConfig);
      return command ? [{ label: runtimeBuiltin.steps[0]?.label ?? "Full upgrade packages", command }] : [];
    }
    if (args.operation === "upgrade_selected") {
      return [{
        label: runtimeBuiltin.steps[0]?.label ?? "Upgrade selected packages",
        command: parser.getUpgradePackagesCommand(args.packages ?? [], args.pkgManagerConfig),
      }];
    }
  }
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
