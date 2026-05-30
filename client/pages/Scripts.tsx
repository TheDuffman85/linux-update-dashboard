import { useEffect, useMemo, useRef, useState } from "react";
import Sortable from "sortablejs";
import { Layout } from "../components/Layout";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CopyableCodeBlock, CopyButton } from "../components/CopyableCodeBlock";
import { useToast } from "../context/ToastContext";
import { highlightShell } from "../lib/shell-highlight";
import {
  useCreatePackageManager,
  useCreateScript,
  useDeletePackageManager,
  useDeleteScript,
  formatScriptCommand,
  useScripts,
  useUpdatePackageManager,
  useUpdateScript,
  type CustomPackageManagerDefinition,
  type PlaceholderHelpEntry,
  type ScriptDefinition,
  type ScriptOperation,
  type ScriptOperationProfile,
  type ScriptStep,
  type ScriptType,
  type CustomParserConfig,
  type CustomSystemInfoConfig,
  type ScriptUsage,
} from "../lib/scripts";
import type { CustomPackageManagerConfigEntry } from "../lib/package-manager-configs";

const OPERATION_LABELS: Record<ScriptOperation, string> = {
  detect: "Detection",
  check_updates: "Check updates",
  repair_issue: "Repair issue",
  upgrade_all: "Upgrade all",
  full_upgrade_all: "Full upgrade",
  upgrade_selected: "Upgrade selected",
  system_info: "System info",
  reboot: "Reboot",
};
const FALLBACK_OPERATION_PROFILES: ScriptOperationProfile[] = [
  {
    operation: "detect",
    label: OPERATION_LABELS.detect,
    allowedTypes: ["package_manager"],
    purpose: "Determines whether a package manager is available on a remote system.",
    stepBehavior: "Detection uses exactly one command so the result is unambiguous.",
    outputConsumer: "The command must exit with 0 and print found on stdout to enable the manager.",
    parserBehavior: "No update parser is used for detection output.",
    exitCodeBehavior: "Exit code 0 with found means detected; any other result is treated as not detected.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}"],
    defaultStepBadge: "detection output",
  },
  {
    operation: "check_updates",
    label: OPERATION_LABELS.check_updates,
    allowedTypes: ["package_manager"],
    purpose: "Refreshes package metadata and turns command output into cached update rows.",
    stepBehavior: "Steps run in order and stop at the first failed step.",
    outputConsumer: "Built-in parsers inspect the command results they need; custom parsers read one selected step, defaulting to the last step.",
    parserBehavior: "Custom package managers need an update regex with packageName and newVersion groups.",
    exitCodeBehavior: "Built-in parsers and custom success/update exit-code lists decide whether a non-zero exit code is acceptable.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "parser input",
  },
  {
    operation: "repair_issue",
    label: OPERATION_LABELS.repair_issue,
    allowedTypes: ["package_manager"],
    purpose: "Runs the repair action offered for package-manager issue banners.",
    stepBehavior: "The configured repair steps run in order and stop at the first failed step.",
    outputConsumer: "Output is streamed live and stored in activity history; it is not parsed into update rows.",
    parserBehavior: "No parser configuration is used.",
    exitCodeBehavior: "A non-zero exit code marks the repair operation as failed.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  {
    operation: "upgrade_all",
    label: OPERATION_LABELS.upgrade_all,
    allowedTypes: ["package_manager"],
    purpose: "Installs all available updates for one package manager.",
    stepBehavior: "Upgrade commands run as the operation body for the selected manager.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while upgrading.",
    exitCodeBehavior: "A non-zero exit code marks the upgrade as failed.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  {
    operation: "full_upgrade_all",
    label: OPERATION_LABELS.full_upgrade_all,
    allowedTypes: ["package_manager"],
    purpose: "Runs the fuller upgrade mode for package managers that support it.",
    stepBehavior: "Full-upgrade commands run as the operation body for the selected manager.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while upgrading.",
    exitCodeBehavior: "A non-zero exit code marks the full upgrade as failed.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  {
    operation: "upgrade_selected",
    label: OPERATION_LABELS.upgrade_selected,
    allowedTypes: ["package_manager"],
    purpose: "Upgrades the packages selected by the user.",
    stepBehavior: "Selected package placeholders are resolved immediately before SSH execution.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while upgrading selected packages.",
    exitCodeBehavior: "A non-zero exit code marks the selected-package upgrade as failed.",
    relevantPlaceholders: ["{{package}}", "{{packages}}", "{{quotedPackage}}", "{{quotedPackages}}", "{{manager}}", "{{config.someKey}}", "{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
  {
    operation: "system_info",
    label: OPERATION_LABELS.system_info,
    allowedTypes: ["system"],
    purpose: "Collects OS, kernel, uptime, resource, boot, and reboot-required details.",
    stepBehavior: "System-info steps run in order and their output is consumed by the configured mapping mode.",
    outputConsumer: "The built-in parser reads dashboard sections; custom section mapping reads named output sections into system fields.",
    parserBehavior: "Use built-in mode for copied standard scripts, or sectioned mode for custom output.",
    exitCodeBehavior: "A non-zero exit code marks system-info collection as failed.",
    relevantPlaceholders: ["{{sudo:COMMAND}}"],
    defaultStepBadge: "system fields",
  },
  {
    operation: "reboot",
    label: OPERATION_LABELS.reboot,
    allowedTypes: ["system"],
    purpose: "Reboots the remote system after any configured safety checks pass.",
    stepBehavior: "Reboot steps run in order and stop before later steps when an earlier step fails.",
    outputConsumer: "Output is streamed live and stored in activity history; it is not parsed into system fields or update rows.",
    parserBehavior: "No parser configuration is used.",
    exitCodeBehavior: "A non-zero exit code before the reboot command prevents later steps from running.",
    relevantPlaceholders: ["{{sudo:COMMAND}}"],
    defaultStepBadge: "streamed only",
  },
];
const PACKAGE_MANAGER_OPERATIONS: ScriptOperation[] = [
  "detect",
  "check_updates",
  "repair_issue",
  "upgrade_all",
  "full_upgrade_all",
  "upgrade_selected",
];
const SYSTEM_OPERATIONS: ScriptOperation[] = ["system_info", "reboot"];
const BUILTIN_PACKAGE_MANAGERS = ["apt", "dnf", "yum", "pacman", "apk", "flatpak", "snap"];
const BUILTIN_PACKAGE_MANAGER_LABELS: Record<string, string> = {
  apt: "APT",
  dnf: "DNF",
  yum: "YUM",
  pacman: "Pacman",
  apk: "APK",
  flatpak: "Flatpak",
  snap: "Snap",
};
const PACKAGE_MANAGER_CONFIG_KEYS: Record<string, Array<{ key: string; description: string }>> = {
  apt: [
    { key: "defaultUpgradeMode", description: "upgrade or full-upgrade" },
    { key: "autoHideKeptBackUpdates", description: "true when kept-back updates are auto-hidden" },
  ],
  dnf: [
    { key: "defaultUpgradeMode", description: "upgrade or distro-sync" },
    { key: "refreshMetadataOnCheck", description: "true when checks refresh metadata" },
    { key: "autoAcceptNewSigningKeysOnCheck", description: "true when checks may import new signing keys" },
    { key: "autoAcceptEulaOnUpgrade", description: "true when upgrades prepend ACCEPT_EULA=Y" },
  ],
  yum: [
    { key: "autoAcceptNewSigningKeysOnCheck", description: "true when checks may import new signing keys" },
    { key: "autoAcceptEulaOnUpgrade", description: "true when upgrades prepend ACCEPT_EULA=Y" },
  ],
  pacman: [
    { key: "refreshDatabasesOnCheck", description: "true unless database refresh is disabled" },
  ],
  apk: [
    { key: "refreshIndexesOnCheck", description: "true unless index refresh is disabled" },
  ],
  flatpak: [
    { key: "refreshAppstreamOnCheck", description: "true unless appstream refresh is disabled" },
  ],
};
const BUILTIN_PACKAGE_MANAGER_CONFIG_KEY_NAMES = new Map(
  Object.entries(PACKAGE_MANAGER_CONFIG_KEYS).map(([manager, entries]) => [
    manager,
    entries.map((entry) => entry.key),
  ]),
);
const SYSTEM_INFO_FIELDS = [
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
] as const;

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass = "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const PACKAGE_MANAGERS_PANEL_STORAGE_KEY = "scripts.packageManagersPanelOpen";

type PackageManagerDraft = {
  name: string;
  label: string;
  configEntries: CustomPackageManagerConfigEntry[];
  builtin?: boolean;
};

type ManagedPackageManager = PackageManagerDraft & {
  builtin: boolean;
  registered: boolean;
  scriptCount: number;
  customScriptCount: number;
  operations: ScriptOperation[];
};

function emptyScript(): ScriptDefinition {
  return {
    id: "",
    readonly: false,
    name: "",
    description: "",
    type: "package_manager",
    operation: "detect",
    pkgManager: "apt",
    isDefault: false,
    steps: [{ label: "Run command", command: "" }],
    parserConfig: null,
    systemInfoConfig: null,
    sourceScriptId: null,
  };
}

function emptyPackageManager(): PackageManagerDraft {
  return {
    name: "",
    label: "",
    configEntries: [],
    builtin: false,
  };
}

function normalizeConfigEntries(entries: CustomPackageManagerConfigEntry[]): CustomPackageManagerConfigEntry[] {
  return entries
    .map((entry) => ({
      key: entry.key.trim(),
      description: entry.description?.trim() || undefined,
      defaultValue: entry.defaultValue,
    }))
    .filter((entry) => entry.key || entry.description || entry.defaultValue);
}

function validateConfigEntries(
  entries: CustomPackageManagerConfigEntry[],
  managers: CustomPackageManagerDefinition[],
  currentManagerName: string | null,
): string | null {
  const seen = new Set<string>();
  const keyPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
  const otherKeys = new Map<string, string>();
  for (const manager of managers) {
    if (currentManagerName && manager.name === currentManagerName) continue;
    for (const entry of manager.configEntries ?? []) {
      otherKeys.set(entry.key, manager.label);
    }
  }
  for (const entry of entries) {
    if (!keyPattern.test(entry.key)) {
      return "Custom config keys must start with a letter and use only letters, numbers, underscores, or dashes.";
    }
    if (currentManagerName && BUILTIN_PACKAGE_MANAGER_CONFIG_KEY_NAMES.get(currentManagerName)?.includes(entry.key)) {
      return `${entry.key} collides with a built-in ${currentManagerName} config key.`;
    }
    if (seen.has(entry.key)) return `Duplicate custom config key: ${entry.key}`;
    seen.add(entry.key);
    const collidingManager = otherKeys.get(entry.key);
    if (collidingManager) return `${entry.key} is already used by ${collidingManager}.`;
  }
  return null;
}

function copyScriptDraft(script: ScriptDefinition): ScriptDefinition {
  return {
    ...script,
    id: "",
    readonly: false,
    name: `${script.name} (Copy)`,
    steps: script.steps.map((step) => ({ ...step })),
    parserConfig: script.parserConfig ? { ...script.parserConfig } : null,
    systemInfoConfig: script.systemInfoConfig
      ? {
          ...script.systemInfoConfig,
          fieldSections: script.systemInfoConfig.fieldSections
            ? { ...script.systemInfoConfig.fieldSections }
            : undefined,
        }
      : null,
    sourceScriptId: script.id,
    isDefault: false,
    createdAt: undefined,
    updatedAt: undefined,
  };
}

function commandUsesSudo(command: string): boolean {
  return /\{\{sudo:/i.test(command) ||
    /\bsudo\s/.test(command) ||
    /\bsudo -S\b/.test(command) ||
    /command -v sudo/.test(command);
}

function scriptUsesSudo(script: ScriptDefinition): boolean {
  return script.steps.some((step) => commandUsesSudo(step.command));
}

function formatUsageOperation(usage: ScriptUsage): string {
  const [manager, operation] = usage.operationKey.split("/");
  const operationLabel = OPERATION_LABELS[(operation || usage.operationKey) as ScriptOperation] ?? usage.operationKey;
  return manager && manager !== "system" ? `${manager} · ${operationLabel}` : operationLabel;
}

function formatUsageSummary(usages: ScriptUsage[]): string {
  if (usages.length === 0) return "Not assigned to any system";
  const names = usages.map((usage) => usage.systemName);
  const visible = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `Assigned to ${visible}${extra}`;
}

function UsageDetails({ usages }: { usages: ScriptUsage[] }) {
  return (
    <div className="space-y-2">
      {usages.map((usage) => (
        <div
          key={`${usage.systemId}-${usage.operationKey}`}
          className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm"
        >
          <span className="min-w-0 truncate font-medium text-slate-800 dark:text-slate-100">
            {usage.systemName}
          </span>
          <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
            {formatUsageOperation(usage)}
          </span>
        </div>
      ))}
    </div>
  );
}

function UsageBadge({
  usages,
  onOpen,
}: {
  usages: ScriptUsage[];
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (usages.length === 0) return null;

  const label = usages.length === 1 ? "1 system" : `${usages.length} systems`;
  const summary = formatUsageSummary(usages);

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={onOpen}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex items-center rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700 transition-colors hover:bg-green-200 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-1 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50"
        aria-label={`${summary}. Tap to view script assignments.`}
        title={summary}
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-2 w-max max-w-xs rounded-lg border border-border bg-white p-2 text-xs shadow-lg dark:bg-slate-900">
          <div className="mb-1 font-medium text-slate-700 dark:text-slate-200">
            {summary}
          </div>
          <UsageDetails usages={usages} />
        </div>
      )}
    </span>
  );
}

function joinExitCodes(value: number[] | undefined): string {
  return value?.join(", ") ?? "";
}

function parseExitCodes(value: string): number[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const codes = trimmed.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (codes.some((code) => !Number.isInteger(code) || code < 0)) {
    throw new Error("Exit codes must be comma-separated non-negative integers");
  }
  return codes;
}

async function formatShellScript(command: string): Promise<string> {
  return formatScriptCommand(command);
}

function ShellCodeBlock({
  code,
  className = "",
}: {
  code: string;
  className?: string;
}) {
  const [displayCode, setDisplayCode] = useState(code);

  useEffect(() => {
    let cancelled = false;
    setDisplayCode(code);
    if (!code.trim()) return;

    formatShellScript(code)
      .then((formatted) => {
        if (!cancelled) setDisplayCode(formatted);
      })
      .catch(() => {
        if (!cancelled) setDisplayCode(code);
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  const highlighted = useMemo(() => highlightShell(displayCode), [displayCode]);
  return (
    <CopyableCodeBlock
      text={displayCode}
      className={`script-code max-h-64 overflow-x-auto overflow-y-auto rounded-lg bg-slate-950 px-3 py-2 text-xs leading-5 whitespace-pre-wrap break-words ${className}`}
      successMessage="Copied script command"
    >
      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    </CopyableCodeBlock>
  );
}

function ShellCommandEditor({
  id,
  value,
  onChange,
  onBeautify,
  beautifying,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBeautify: () => void;
  beautifying?: boolean;
}) {
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const highlighted = useMemo(() => highlightShell(value), [value]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <label htmlFor={id} className={`${labelClass} mb-0`}>Command</label>
        <div className="flex items-center gap-2">
          <CopyButton
            text={value}
            successMessage="Copied command"
            className="border-border bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
          />
          <button
            type="button"
            onClick={onBeautify}
            disabled={beautifying || !value.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-700"
            title="Beautify command"
          >
            {beautifying ? <span className="spinner spinner-sm" /> : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 20l8.5-8.5m0 0L14 7l3 3-4.5 1.5zm3-14h.01M18 4h.01M20 10h.01M14 20h.01" />
              </svg>
            )}
            Beautify
          </button>
        </div>
      </div>
      <div className="relative min-h-36 overflow-hidden rounded-lg border border-border bg-slate-950 focus-within:ring-2 focus-within:ring-blue-500">
        <pre
          ref={highlightRef}
          aria-hidden="true"
          className="script-editor-highlight pointer-events-none absolute inset-0 min-h-36 overflow-auto p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words"
        >
          <code dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (!highlightRef.current) return;
            highlightRef.current.scrollTop = e.currentTarget.scrollTop;
            highlightRef.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          spellCheck={false}
          className="relative block min-h-36 w-full resize-y bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-white selection:bg-blue-500/30 focus:outline-none"
        />
      </div>
    </div>
  );
}

type ScriptReferenceEntry = {
  id: string;
  token: string;
  description: string;
};

function isGeneratedConfigPlaceholder(placeholder: PlaceholderHelpEntry): boolean {
  return /^\{\{config\.[^}]+\}\}$/.test(placeholder.name);
}

function ScriptReferenceSection({
  title,
  entries,
  emptyMessage,
  defaultOpen = false,
  onCopy,
}: {
  title: string;
  entries: ScriptReferenceEntry[];
  emptyMessage: string;
  defaultOpen?: boolean;
  onCopy: (value: string) => void;
}) {
  const countLabel = entries.length === 1 ? "1 entry" : `${entries.length} entries`;
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 p-3 text-left"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {title}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {countLabel}
          </div>
        </div>
        <svg
          className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-border p-3">
          {entries.length > 0 ? (
            <div className="space-y-2">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-white p-2.5 dark:bg-slate-900 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0">
                    <code className="inline-block max-w-full rounded bg-slate-200/70 px-1.5 py-0.5 text-xs dark:bg-slate-800">
                      {entry.token}
                    </code>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {entry.description}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onCopy(entry.token)}
                    className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-slate-700 transition-colors hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700"
                    title={`Copy ${entry.token}`}
                    aria-label={`Copy ${entry.token}`}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    Copy
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {emptyMessage}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function operationProfileMap(profiles: ScriptOperationProfile[] | undefined): Map<ScriptOperation, ScriptOperationProfile> {
  return new Map((profiles?.length ? profiles : FALLBACK_OPERATION_PROFILES).map((profile) => [
    profile.operation,
    profile,
  ]));
}

function RuntimeBehaviorPanel({
  profile,
  parseStepLabel,
  parseStepOutOfRange,
  usesBuiltinParser,
  showParserConfig,
}: {
  profile: ScriptOperationProfile;
  parseStepLabel: string;
  parseStepOutOfRange: boolean;
  usesBuiltinParser: boolean;
  showParserConfig: boolean;
}) {
  const [open, setOpen] = useState(false);
  const outputDetail = showParserConfig
    ? `Custom parser output: ${parseStepLabel}.`
    : usesBuiltinParser && profile.operation === "check_updates"
      ? "Built-in parser chooses the required command output from the completed steps."
      : profile.outputConsumer;

  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50/70 text-sm text-blue-950 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-100">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 p-3 text-left"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
              Runtime behavior
            </span>
            <Badge variant="info" small>{profile.label}</Badge>
          </div>
          <div className="mt-1 text-xs text-blue-700/80 dark:text-blue-200/80">
            Steps, output, parser, and exit codes
          </div>
        </div>
        <svg
          className={`h-5 w-5 shrink-0 text-blue-600 transition-transform dark:text-blue-300 ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-blue-200 p-3 dark:border-blue-900/50">
          <p>{profile.purpose}</p>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                Steps
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{profile.stepBehavior}</p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                Output
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{outputDetail}</p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                Parser
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{profile.parserBehavior}</p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                Exit codes
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{profile.exitCodeBehavior}</p>
            </div>
          </div>
          {parseStepOutOfRange && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              The saved parser step no longer exists. Choose an existing step before saving this script.
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function readPackageManagersPanelOpen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(PACKAGE_MANAGERS_PANEL_STORAGE_KEY) === "1";
}

function buildParserConfig(input: {
  parseStep: string;
  updateRegex: string;
  securityRegex: string;
  keptBackRegex: string;
  successExitCodes: string;
  updatesExitCodes: string;
}): CustomParserConfig | null {
  const config: CustomParserConfig = {};
  if (input.parseStep.trim()) {
    const parseStep = Number.parseInt(input.parseStep.trim(), 10);
    if (!Number.isInteger(parseStep) || parseStep < 0) {
      throw new Error("Parse step must be a non-negative number");
    }
    config.parseStep = parseStep;
  }
  if (input.updateRegex.trim()) config.updateRegex = input.updateRegex.trim();
  if (input.securityRegex.trim()) config.securityRegex = input.securityRegex.trim();
  if (input.keptBackRegex.trim()) config.keptBackRegex = input.keptBackRegex.trim();
  const successExitCodes = parseExitCodes(input.successExitCodes);
  const updatesExitCodes = parseExitCodes(input.updatesExitCodes);
  if (successExitCodes) config.successExitCodes = successExitCodes;
  if (updatesExitCodes) config.updatesExitCodes = updatesExitCodes;
  return Object.keys(config).length ? config : null;
}

function buildSystemInfoConfig(
  mode: "builtin" | "sectioned",
  fieldSections: Record<string, string>,
  rebootRequiredRegex: string,
): CustomSystemInfoConfig | null {
  if (mode === "builtin") return { mode: "builtin" };
  const cleanedFields = Object.fromEntries(
    Object.entries(fieldSections)
      .map(([field, section]) => [field, section.trim()])
      .filter(([, section]) => section),
  );
  const config: CustomSystemInfoConfig = { mode: "sectioned" };
  if (Object.keys(cleanedFields).length) config.fieldSections = cleanedFields;
  if (rebootRequiredRegex.trim()) config.rebootRequiredRegex = rebootRequiredRegex.trim();
  return Object.keys(config).length ? config : null;
}

export function ScriptEditor({
  script,
  packageManagers,
  placeholders,
  operationProfiles,
  onSave,
  onCancel,
  busy,
}: {
  script: ScriptDefinition;
  packageManagers: Array<{ name: string; label: string; configEntries?: CustomPackageManagerConfigEntry[] }>;
  placeholders: PlaceholderHelpEntry[];
  operationProfiles?: ScriptOperationProfile[];
  onSave: (script: ScriptDefinition) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const { addToast } = useToast();
  const [draft, setDraft] = useState(script);
  const [steps, setSteps] = useState<ScriptStep[]>(script.steps.length ? script.steps : [{ label: "Run command", command: "" }]);
  const [parserConfig, setParserConfig] = useState({
    parseStep: script.parserConfig?.parseStep?.toString() ?? "",
    updateRegex: script.parserConfig?.updateRegex ?? "",
    securityRegex: script.parserConfig?.securityRegex ?? "",
    keptBackRegex: script.parserConfig?.keptBackRegex ?? "",
    successExitCodes: joinExitCodes(script.parserConfig?.successExitCodes),
    updatesExitCodes: joinExitCodes(script.parserConfig?.updatesExitCodes),
  });
  const [systemInfoSections, setSystemInfoSections] = useState<Record<string, string>>(
    Object.fromEntries(
      SYSTEM_INFO_FIELDS.map((field) => [
        field,
        script.systemInfoConfig?.fieldSections?.[field] ?? "",
      ]),
    ),
  );
  const [systemInfoMode, setSystemInfoMode] = useState<"builtin" | "sectioned">(
    script.systemInfoConfig?.mode ?? "sectioned"
  );
  const [rebootRequiredRegex, setRebootRequiredRegex] = useState(script.systemInfoConfig?.rebootRequiredRegex ?? "");
  const [beautifyingStep, setBeautifyingStep] = useState<number | null>(null);
  const stepsRef = useRef<ScriptStep[]>(steps);
  const stepsListRef = useRef<HTMLDivElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);
  const operationOptions = draft.type === "system" ? SYSTEM_OPERATIONS : PACKAGE_MANAGER_OPERATIONS;
  const profiles = useMemo(() => operationProfileMap(operationProfiles), [operationProfiles]);
  const operationProfile = profiles.get(draft.operation) ?? FALLBACK_OPERATION_PROFILES[0];
  const selectedPackageManager = draft.pkgManager ?? "";
  const usesBuiltinParser = selectedPackageManager ? BUILTIN_PACKAGE_MANAGERS.includes(selectedPackageManager) : false;
  const customConfigKeys = packageManagers
    .find((manager) => manager.name === selectedPackageManager)
    ?.configEntries?.map((entry) => ({
      key: entry.key,
      description: entry.description?.trim()
        || (entry.defaultValue ? `Default: ${entry.defaultValue}` : "Custom config value"),
    })) ?? [];
  const configKeys = selectedPackageManager
    ? [
        ...(PACKAGE_MANAGER_CONFIG_KEYS[selectedPackageManager] ?? []),
        ...customConfigKeys,
      ]
    : [];
  const configReferenceEntries = configKeys.map((entry) => ({
    id: `config.${entry.key}`,
    token: `{{config.${entry.key}}}`,
    description: entry.description,
  }));
  const placeholderReferenceEntries = placeholders
    .filter((placeholder) => !isGeneratedConfigPlaceholder(placeholder))
    .map((placeholder) => ({
      id: placeholder.name,
      token: placeholder.name,
      description: placeholder.description,
    }));
  const showPackageManagerControls = draft.type === "package_manager";
  const showParserConfig =
    draft.type === "package_manager" &&
    draft.operation === "check_updates" &&
    !usesBuiltinParser;
  const showSystemInfoConfig = draft.type === "system" && draft.operation === "system_info";
  const singleStepOperation = draft.operation === "detect";
  const explicitParseStep = parserConfig.parseStep.trim();
  const parsedStepNumber = explicitParseStep
    ? Number.parseInt(explicitParseStep, 10)
    : steps.length - 1;
  const parsedStepIndex = Number.isInteger(parsedStepNumber) ? parsedStepNumber : steps.length - 1;
  const parseStepOutOfRange =
    showParserConfig &&
    (!Number.isInteger(parsedStepNumber) || parsedStepNumber < 0 || parsedStepNumber >= steps.length);
  const parsedStepLabel = parseStepOutOfRange
    ? Number.isInteger(parsedStepNumber)
      ? `missing step ${parsedStepNumber + 1}`
      : "invalid parser step"
    : steps[parsedStepIndex]?.label || `step ${parsedStepIndex + 1}`;
  const parseStepSummary = showParserConfig
    ? parseStepOutOfRange
      ? parsedStepLabel
      : `Step ${parsedStepIndex + 1}: ${parsedStepLabel}`
    : "";

  const stepBadge = (index: number): string => {
    if (draft.operation === "detect") return index === 0 ? "detection output" : "not used";
    if (draft.operation === "check_updates") {
      if (showParserConfig) {
        if (parseStepOutOfRange) return "streamed only";
        return index === parsedStepIndex ? "parsed output" : "streamed only";
      }
      return usesBuiltinParser ? "parser input" : operationProfile.defaultStepBadge;
    }
    if (draft.operation === "system_info") return "system fields";
    if (draft.operation === "reboot") return index < steps.length - 1 ? "reboot guard" : "reboot command";
    return operationProfile.defaultStepBadge;
  };

  useEffect(() => {
    stepsRef.current = steps;
  }, [steps]);

  useEffect(() => {
    const element = stepsListRef.current;
    if (!element || steps.length <= 1) {
      sortableRef.current?.destroy();
      sortableRef.current = null;
      return;
    }

    sortableRef.current?.destroy();
    sortableRef.current = new Sortable(element, {
      animation: 150,
      handle: ".step-drag-handle",
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (
          evt.oldIndex === undefined ||
          evt.newIndex === undefined ||
          evt.oldIndex === evt.newIndex
        ) {
          return;
        }

        const next = [...stepsRef.current];
        const [moved] = next.splice(evt.oldIndex, 1);
        next.splice(evt.newIndex, 0, moved);
        setSteps(next);
      },
    });

    return () => {
      sortableRef.current?.destroy();
      sortableRef.current = null;
    };
  }, [steps.length]);

  const updateStep = (index: number, patch: Partial<ScriptStep>) => {
    setSteps((current) =>
      current.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step
      )
    );
  };

  const addStep = () => {
    if (singleStepOperation) return;
    setSteps((current) => [
      ...current,
      { label: `Step ${current.length + 1}`, command: "" },
    ]);
  };

  const removeStep = (index: number) => {
    setSteps((current) => current.filter((_step, stepIndex) => stepIndex !== index));
  };

  const beautifyStep = async (index: number) => {
    const command = steps[index]?.command ?? "";
    if (!command.trim()) return;
    setBeautifyingStep(index);
    try {
      updateStep(index, { command: await formatShellScript(command) });
      addToast("Command beautified", "success");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Invalid shell syntax";
      addToast(`Could not beautify command: ${detail}`, "danger");
    } finally {
      setBeautifyingStep(null);
    }
  };

  const copyReference = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      addToast(`Copied ${value}`, "success");
    } catch {
      addToast("Could not copy to clipboard", "danger");
    }
  };

  const save = () => {
    try {
      const normalizedSteps = steps.map((step) => ({
        label: step.label.trim(),
        command: step.command.trim(),
      }));
      if (normalizedSteps.some((step) => !step.label || !step.command)) {
        throw new Error("Each step needs a label and command");
      }
      if (draft.operation === "detect" && normalizedSteps.length !== 1) {
        throw new Error("Detection scripts use exactly one step");
      }
      const pkgManager = draft.type === "package_manager"
        ? draft.pkgManager?.trim() || null
        : null;
      onSave({
        ...draft,
        pkgManager,
        isDefault: draft.isDefault ?? false,
        steps: normalizedSteps,
        parserConfig: showParserConfig ? buildParserConfig(parserConfig) : null,
        systemInfoConfig: showSystemInfoConfig
          ? buildSystemInfoConfig(systemInfoMode, systemInfoSections, rebootRequiredRegex)
          : null,
      });
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Invalid script", "danger");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
        <p className="min-w-0 text-sm">
          No support will be given for custom scripts.
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Name</label>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={draft.type}
            onChange={(e) => {
              const nextType = e.target.value as ScriptType;
              setDraft({
                ...draft,
                type: nextType,
                operation: nextType === "system" ? "system_info" : "detect",
                pkgManager: nextType === "system" ? null : draft.pkgManager,
              });
            }}
            className={inputClass}
          >
            <option value="package_manager">Package manager</option>
            <option value="system">System</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Operation</label>
          <select
            value={draft.operation}
            onChange={(e) => setDraft({ ...draft, operation: e.target.value as ScriptOperation })}
            className={inputClass}
          >
            {operationOptions.map((operation) => (
              <option key={operation} value={operation}>{OPERATION_LABELS[operation]}</option>
            ))}
          </select>
        </div>
        {showPackageManagerControls && (
          <div>
            <label className={labelClass}>Package Manager</label>
            <select
              value={draft.pkgManager ?? ""}
              onChange={(e) => {
                setDraft({ ...draft, pkgManager: e.target.value });
              }}
              className={inputClass}
            >
              {packageManagers.map((manager) => (
                <option key={manager.name} value={manager.name}>
                  {manager.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div>
        <label className={labelClass}>Description</label>
        <textarea
          value={draft.description ?? ""}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className={`${inputClass} min-h-20`}
        />
      </div>

      <RuntimeBehaviorPanel
        profile={operationProfile}
        parseStepLabel={parseStepSummary}
        parseStepOutOfRange={parseStepOutOfRange}
        usesBuiltinParser={usesBuiltinParser}
        showParserConfig={showParserConfig}
      />

      {showPackageManagerControls && (
        <ScriptReferenceSection
          title="Config Keys"
          entries={configReferenceEntries}
          emptyMessage="No config keys are defined for this package manager yet."
          onCopy={copyReference}
        />
      )}

      <ScriptReferenceSection
        title="Placeholders"
        entries={placeholderReferenceEntries}
        emptyMessage="No script placeholders are available."
        onCopy={copyReference}
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className={labelClass}>Steps</label>
          <button
            type="button"
            onClick={addStep}
            disabled={singleStepOperation}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 transition-colors text-lg leading-none"
            title={singleStepOperation ? "Detection scripts use one step" : "Add step"}
            aria-label="Add step"
          >
            +
          </button>
        </div>
        {singleStepOperation && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Detection scripts use one command. It must exit with 0 and print found when the package manager is available.
          </p>
        )}
        <div ref={stepsListRef} className="space-y-3">
          {steps.map((step, index) => (
            <div key={`${index}-${step.label}`} className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3">
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  className={`step-drag-handle mt-7 shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                    steps.length > 1 ? "cursor-grab hover:bg-slate-100 dark:hover:bg-slate-800" : "cursor-not-allowed opacity-40"
                  }`}
                  title="Drag to reorder"
                  aria-label={`Drag to reorder step ${index + 1}`}
                  disabled={steps.length <= 1}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                  </svg>
                </button>
                <div className="min-w-0 flex-1 space-y-3">
                  <div>
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <label className={`${labelClass} mb-0`}>Step {index + 1} Label</label>
                      <span className="rounded-full bg-slate-200/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {stepBadge(index)}
                      </span>
                    </div>
                    <input
                      value={step.label}
                      onChange={(e) => updateStep(index, { label: e.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <ShellCommandEditor
                    id={`script-step-${index}-command`}
                    value={step.command}
                    onChange={(command) => updateStep(index, { command })}
                    onBeautify={() => beautifyStep(index)}
                    beautifying={beautifyingStep === index}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeStep(index)}
                  disabled={steps.length <= 1}
                  className="mt-7 inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-lg leading-none"
                  title="Remove step"
                  aria-label={`Remove step ${index + 1}`}
                >
                  -
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {draft.type === "package_manager" && draft.operation === "check_updates" && usesBuiltinParser && (
        <div className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3 text-sm text-slate-500 dark:text-slate-400">
          {selectedPackageManager.toUpperCase()} update output is parsed by the built-in parser. Custom parser rules are only needed for custom package managers.
        </div>
      )}

      {showParserConfig && (
        <details className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
            Advanced parser rules
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Use named regex groups to turn the selected step output into update rows. Required groups are packageName and newVersion; other step output stays in activity history.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Output to Parse</label>
                <select
                  value={parserConfig.parseStep}
                  onChange={(e) => setParserConfig({ ...parserConfig, parseStep: e.target.value })}
                  className={inputClass}
                >
                  <option value="">
                    Last step ({steps.at(-1)?.label || `Step ${steps.length}`})
                  </option>
                  {steps.map((step, index) => (
                    <option key={`${index}-${step.label}`} value={index.toString()}>
                      Step {index + 1}: {step.label || `Step ${index + 1}`}
                    </option>
                  ))}
                  {parseStepOutOfRange && (
                    <option value={parserConfig.parseStep}>
                      {Number.isInteger(parsedStepNumber)
                        ? `Missing step ${parsedStepNumber + 1}`
                        : "Invalid parser step"}
                    </option>
                  )}
                </select>
                {parseStepOutOfRange && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    The saved parser step is outside the current step list.
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass}>Successful Exit Codes</label>
                <input
                  value={parserConfig.successExitCodes}
                  onChange={(e) => setParserConfig({ ...parserConfig, successExitCodes: e.target.value })}
                  className={inputClass}
                  placeholder="0"
                />
              </div>
              <div className="md:col-span-2">
                <label className={labelClass}>Update Line Regex</label>
                <textarea
                  value={parserConfig.updateRegex}
                  onChange={(e) => setParserConfig({ ...parserConfig, updateRegex: e.target.value })}
                  className={`${inputClass} min-h-20 font-mono text-xs`}
                  placeholder={"^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$"}
                />
              </div>
              <div>
                <label className={labelClass}>Security Marker Regex</label>
                <input
                  value={parserConfig.securityRegex}
                  onChange={(e) => setParserConfig({ ...parserConfig, securityRegex: e.target.value })}
                  className={inputClass}
                  placeholder="security"
                />
              </div>
              <div>
                <label className={labelClass}>Kept-Back Marker Regex</label>
                <input
                  value={parserConfig.keptBackRegex}
                  onChange={(e) => setParserConfig({ ...parserConfig, keptBackRegex: e.target.value })}
                  className={inputClass}
                  placeholder="held|kept back"
                />
              </div>
              <div>
                <label className={labelClass}>Updates-Available Exit Codes</label>
                <input
                  value={parserConfig.updatesExitCodes}
                  onChange={(e) => setParserConfig({ ...parserConfig, updatesExitCodes: e.target.value })}
                  className={inputClass}
                  placeholder="100"
                />
              </div>
            </div>
          </div>
        </details>
      )}

      {showSystemInfoConfig && (
        <details className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
            Advanced system-info mapping
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Use the built-in parser for copied standard scripts, or map custom output section names into dashboard system fields.
            </p>
            <div>
              <label className={labelClass}>Parser Mode</label>
              <select
                value={systemInfoMode}
                onChange={(e) => setSystemInfoMode(e.target.value as "builtin" | "sectioned")}
                className={inputClass}
              >
                <option value="builtin">Built-in dashboard parser</option>
                <option value="sectioned">Custom section mapping</option>
              </select>
            </div>
            {systemInfoMode === "builtin" ? (
              <div className="rounded-lg border border-border p-3 text-sm text-slate-500 dark:text-slate-400">
                This script will use the same OS, Proxmox/Raspberry Pi, uptime, kernel, and reboot-required parsing logic as the built-in system-info script.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {SYSTEM_INFO_FIELDS.map((field) => (
                  <div key={field}>
                    <label className={labelClass}>{field}</label>
                    <input
                      value={systemInfoSections[field] ?? ""}
                      onChange={(e) =>
                        setSystemInfoSections({
                          ...systemInfoSections,
                          [field]: e.target.value,
                        })
                      }
                      className={inputClass}
                      placeholder={field.toUpperCase()}
                    />
                  </div>
                ))}
                <div className="md:col-span-2">
                  <label className={labelClass}>Reboot Required Regex</label>
                  <input
                    value={rebootRequiredRegex}
                    onChange={(e) => setRebootRequiredRegex(e.target.value)}
                    className={inputClass}
                    placeholder="PRESENT|required"
                  />
                </div>
              </div>
            )}
          </div>
        </details>
      )}

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={save} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
          {busy ? <span className="spinner spinner-sm" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

function PackageManagerEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  busy,
  editing,
}: {
  draft: PackageManagerDraft;
  setDraft: (draft: PackageManagerDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy?: boolean;
  editing?: boolean;
}) {
  const updateConfigEntry = (index: number, patch: Partial<CustomPackageManagerConfigEntry>) => {
    setDraft({
      ...draft,
      configEntries: draft.configEntries.map((entry, entryIndex) =>
        entryIndex === index ? { ...entry, ...patch } : entry
      ),
    });
  };
  const addConfigEntry = () => {
    setDraft({
      ...draft,
      configEntries: [
        ...draft.configEntries,
        { key: "", description: "", defaultValue: "" },
      ],
    });
  };
  const removeConfigEntry = (index: number) => {
    setDraft({
      ...draft,
      configEntries: draft.configEntries.filter((_entry, entryIndex) => entryIndex !== index),
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Manager Key</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={inputClass}
            placeholder="custom-pm"
            disabled={editing}
          />
          {editing && (
            <p className="mt-1 text-xs text-slate-400">
              Keys are used by scripts and systems, so rename by creating a new manager.
            </p>
          )}
        </div>
        <div>
          <label className={labelClass}>Display Label</label>
          <input
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className={inputClass}
            placeholder="Custom PM"
            disabled={draft.builtin}
          />
        </div>
      </div>
      <div className="rounded-lg border border-border bg-slate-50/60 p-3 dark:bg-slate-900/30">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Custom Config
            </div>
          </div>
          <button
            type="button"
            onClick={addConfigEntry}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-lg leading-none transition-colors hover:bg-slate-50 dark:hover:bg-slate-700"
            title="Add config entry"
            aria-label="Add config entry"
          >
            +
          </button>
        </div>
        {draft.configEntries.length > 0 ? (
          <div className="space-y-3">
            {draft.configEntries.map((entry, index) => (
              <div key={index} className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-white p-3 dark:bg-slate-900 md:grid-cols-[1fr_1fr_1fr_auto]">
                <div>
                  <label className={labelClass}>Key</label>
                  <input
                    value={entry.key}
                    onChange={(e) => updateConfigEntry(index, { key: e.target.value })}
                    className={inputClass}
                    placeholder="channel"
                  />
                </div>
                <div>
                  <label className={labelClass}>Default Value</label>
                  <input
                    value={entry.defaultValue}
                    onChange={(e) => updateConfigEntry(index, { defaultValue: e.target.value })}
                    className={inputClass}
                    placeholder="stable"
                  />
                </div>
                <div>
                  <label className={labelClass}>Description</label>
                  <input
                    value={entry.description ?? ""}
                    onChange={(e) => updateConfigEntry(index, { description: e.target.value })}
                    className={inputClass}
                    placeholder="Optional"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => removeConfigEntry(index)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
                    title="Remove config entry"
                    aria-label="Remove config entry"
                  >
                    -
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No custom config entries yet.
          </p>
        )}
      </div>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700">
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={onSave} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
          {busy ? <span className="spinner spinner-sm" /> : "Save"}
        </button>
      </div>
    </div>
  );
}

function PackageManagersPanel({
  managers,
  open,
  onOpenChange,
  onEditManager,
  onDeleteManager,
}: {
  managers: ManagedPackageManager[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEditManager: (manager: ManagedPackageManager) => void;
  onDeleteManager: (manager: ManagedPackageManager) => void;
}) {
  const customCount = managers.filter((manager) => !manager.builtin).length;
  const totalScripts = managers.reduce((sum, manager) => sum + manager.scriptCount, 0);

  return (
    <section className="rounded-xl border border-border bg-white dark:bg-slate-800">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Package Managers
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {managers.length} managers · {customCount} custom · {totalScripts} scripts
          </p>
        </div>
        <svg
          className={`h-5 w-5 shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            Built-ins can be extended with custom config entries; custom managers can also be labeled.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
            {managers.map((manager) => (
              <div
                key={manager.name}
                className="rounded-lg border border-border bg-slate-50/60 p-3 dark:bg-slate-900/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div>
                      <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {manager.label}
                      </h3>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant={manager.builtin ? "muted" : "info"} small>
                        {manager.builtin ? "built-in" : "custom"}
                      </Badge>
                      {!manager.registered && (
                        <Badge variant="warning" small>
                          script-only
                        </Badge>
                      )}
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                        {manager.name}
                      </code>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {manager.scriptCount} scripts · {manager.operations.length} ops · {manager.configEntries.length} configs
                      </span>
                    </div>
                  </div>
                  {manager.registered && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => onEditManager(manager)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Edit package manager"
                        aria-label={`Edit ${manager.label}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      {!manager.builtin && (
                        <button
                          type="button"
                          onClick={() => onDeleteManager(manager)}
                          className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                          title="Delete package manager"
                          aria-label={`Delete ${manager.label}`}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap gap-1">
                  {PACKAGE_MANAGER_OPERATIONS.map((operation) => {
                    const exists = manager.operations.includes(operation);
                    return (
                      <span
                        key={operation}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          exists
                            ? "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
                            : "bg-slate-50 text-slate-300 dark:bg-slate-900 dark:text-slate-600"
                        }`}
                        title={OPERATION_LABELS[operation]}
                      >
                        {OPERATION_LABELS[operation]}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export default function Scripts() {
  const { data, isLoading } = useScripts();
  const createScript = useCreateScript();
  const updateScript = useUpdateScript();
  const deleteScript = useDeleteScript();
  const createPackageManager = useCreatePackageManager();
  const updatePackageManager = useUpdatePackageManager();
  const deletePackageManager = useDeletePackageManager();
  const { addToast } = useToast();
  const [typeFilter, setTypeFilter] = useState<"all" | ScriptType>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "builtin" | "custom">("all");
  const [managerFilter, setManagerFilter] = useState("all");
  const [packageManagersOpen, setPackageManagersOpen] = useState(readPackageManagersPanelOpen);
  const [editing, setEditing] = useState<ScriptDefinition | null>(null);
  const [showPackageManager, setShowPackageManager] = useState(false);
  const [editingPackageManager, setEditingPackageManager] = useState<CustomPackageManagerDefinition | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScriptDefinition | null>(null);
  const [deleteManagerTarget, setDeleteManagerTarget] = useState<ManagedPackageManager | null>(null);
  const [usageTarget, setUsageTarget] = useState<ScriptDefinition | null>(null);
  const [packageManagerDraft, setPackageManagerDraft] = useState(emptyPackageManager());
  const [copyingScriptId, setCopyingScriptId] = useState<string | null>(null);
  const [defaultingScriptId, setDefaultingScriptId] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(
      PACKAGE_MANAGERS_PANEL_STORAGE_KEY,
      packageManagersOpen ? "1" : "0",
    );
  }, [packageManagersOpen]);

  const scripts = useMemo(() => {
    const all = data?.scripts ?? [];
    return all
      .filter((script) => {
        if (typeFilter !== "all" && script.type !== typeFilter) return false;
        if (sourceFilter === "builtin" && !script.readonly) return false;
        if (sourceFilter === "custom" && script.readonly) return false;
        if (managerFilter !== "all" && script.pkgManager !== managerFilter) return false;
        return true;
      })
      .sort((a, b) => {
        if (a.readonly !== b.readonly) return a.readonly ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }, [data, typeFilter, sourceFilter, managerFilter]);
  const managedPackageManagers = useMemo<ManagedPackageManager[]>(() => {
    const managerMap = new Map<string, ManagedPackageManager>();
    const ensureManager = (manager: string, patch: Partial<ManagedPackageManager> = {}) => {
      const existing = managerMap.get(manager);
      const next: ManagedPackageManager = {
        name: manager,
        label: BUILTIN_PACKAGE_MANAGER_LABELS[manager] ?? manager,
        configEntries: [],
        builtin: BUILTIN_PACKAGE_MANAGERS.includes(manager),
        registered: BUILTIN_PACKAGE_MANAGERS.includes(manager),
        scriptCount: 0,
        customScriptCount: 0,
        operations: [],
        ...existing,
        ...patch,
      };
      managerMap.set(manager, next);
      return next;
    };

    for (const manager of BUILTIN_PACKAGE_MANAGERS) {
      ensureManager(manager, {
        label: BUILTIN_PACKAGE_MANAGER_LABELS[manager] ?? manager,
        builtin: true,
        registered: true,
      });
    }
    for (const manager of data?.packageManagers ?? []) {
      ensureManager(manager.name, {
        label: manager.label,
        configEntries: manager.configEntries ?? [],
        builtin: manager.builtin,
        registered: true,
      });
    }
    for (const script of data?.scripts ?? []) {
      if (!script.pkgManager) continue;
      const manager = ensureManager(script.pkgManager);
      manager.scriptCount += 1;
      if (!script.readonly) manager.customScriptCount += 1;
      if (!manager.operations.includes(script.operation)) {
        manager.operations.push(script.operation);
      }
    }

    return Array.from(managerMap.values())
      .map((manager) => ({
        ...manager,
        operations: manager.operations.sort(
          (a, b) => PACKAGE_MANAGER_OPERATIONS.indexOf(a) - PACKAGE_MANAGER_OPERATIONS.indexOf(b),
        ),
      }))
      .sort((a, b) => {
        if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  }, [data]);
  const packageManagerOptions = useMemo(() => {
    const labels = new Map<string, { label: string; configEntries: CustomPackageManagerConfigEntry[] }>();
    for (const manager of managedPackageManagers) {
      labels.set(manager.name, { label: manager.label, configEntries: manager.configEntries });
    }
    return Array.from(labels.entries())
      .map(([name, details]) => ({ name, label: details.label, configEntries: details.configEntries }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [managedPackageManagers]);

  const saveScript = (script: ScriptDefinition) => {
    const callbacks = {
      onSuccess: () => {
        setEditing(null);
        addToast("Script saved", "success");
      },
      onError: (err: Error) => addToast(err.message, "danger"),
    };
    if (script.id) {
      updateScript.mutate(script, callbacks);
    } else {
      createScript.mutate({ ...script, id: undefined }, callbacks);
    }
  };

  const toggleScriptDefault = (script: ScriptDefinition) => {
    setDefaultingScriptId(script.id);
    updateScript.mutate(
      { ...script, isDefault: !(script.isDefault ?? false) },
      {
        onSuccess: () => {
          addToast(script.isDefault ? "Script default cleared" : "Script set as default", "success");
        },
        onError: (err: Error) => addToast(err.message, "danger"),
        onSettled: () => setDefaultingScriptId(null),
      },
    );
  };

  const handleSavePackageManager = () => {
    const configEntries = normalizeConfigEntries(packageManagerDraft.configEntries);
    const configEntryError = validateConfigEntries(
      configEntries,
      data?.packageManagers ?? [],
      editingPackageManager?.name ?? null,
    );
    if (configEntryError) {
      addToast(configEntryError, "danger");
      return;
    }
    const payload = {
      ...packageManagerDraft,
      configEntries,
    };
    const callbacks = {
      onSuccess: () => {
        setShowPackageManager(false);
        setEditingPackageManager(null);
        setPackageManagerDraft(emptyPackageManager());
        addToast("Package manager saved", "success");
      },
      onError: (err: Error) => addToast(err.message, "danger"),
    };
    if (editingPackageManager) {
      updatePackageManager.mutate(payload, callbacks);
    } else {
      createPackageManager.mutate(payload, callbacks);
    }
  };

  const openPackageManagerModal = () => {
    setEditingPackageManager(null);
    setPackageManagerDraft(emptyPackageManager());
    setShowPackageManager(true);
  };

  const openEditPackageManager = (manager: ManagedPackageManager) => {
    const existing = data?.packageManagers.find((entry) => entry.name === manager.name);
    if (!existing) return;
    setEditingPackageManager(existing);
    setPackageManagerDraft({
      name: existing.name,
      label: existing.label,
      configEntries: (existing.configEntries ?? []).map((entry) => ({ ...entry })),
      builtin: existing.builtin,
    });
    setShowPackageManager(true);
  };

  const createScriptForManager = (manager: ManagedPackageManager) => {
    setEditing({
      ...emptyScript(),
      pkgManager: manager.name,
      name: `${manager.label} script`,
    });
  };

  const handleCopy = async (script: ScriptDefinition) => {
    const draft = copyScriptDraft(script);
    setCopyingScriptId(script.id);
    try {
      draft.steps = await Promise.all(
        draft.steps.map(async (step) => ({
          ...step,
          command: step.command.trim()
            ? await formatShellScript(step.command)
            : step.command,
        })),
      );
    } catch (error) {
      addToast(
        error instanceof Error
          ? `Copied script without beautifying: ${error.message}`
          : "Copied script without beautifying",
        "info",
      );
    } finally {
      setCopyingScriptId(null);
      setEditing(draft);
    }
  };

  return (
    <Layout
      title="Scripts"
      actions={
        <>
          <button onClick={openPackageManagerModal} className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700">
            New Package Manager
          </button>
          <button onClick={() => setEditing(emptyScript())} className="px-3 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white">
            New Script
          </button>
        </>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-16"><span className="spinner !w-6 !h-6 text-blue-500" /></div>
      ) : (
        <div className="space-y-5">
          <PackageManagersPanel
            managers={managedPackageManagers}
            open={packageManagersOpen}
            onOpenChange={setPackageManagersOpen}
            onEditManager={openEditPackageManager}
            onDeleteManager={setDeleteManagerTarget}
          />

          <div className="flex flex-wrap gap-2">
            <select value={managerFilter} onChange={(e) => setManagerFilter(e.target.value)} className={inputClass + " max-w-52"}>
              <option value="all">All managers</option>
              {managedPackageManagers.map((manager) => (
                <option key={manager.name} value={manager.name}>
                  {manager.label}
                </option>
              ))}
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} className={inputClass + " max-w-52"}>
              <option value="all">All types</option>
              <option value="package_manager">Package manager</option>
              <option value="system">System</option>
            </select>
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)} className={inputClass + " max-w-52"}>
              <option value="all">All sources</option>
              <option value="builtin">Built-in</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {scripts.length === 0 && (
              <div className="xl:col-span-2 rounded-lg border border-border p-6 text-sm text-slate-500 dark:text-slate-400">
                <div>No scripts match these filters.</div>
                {sourceFilter === "custom" && (
                  <button
                    type="button"
                    onClick={() => {
                      const manager = managedPackageManagers.find((entry) => entry.name === managerFilter);
                      if (manager) {
                        createScriptForManager(manager);
                      } else {
                        setEditing(emptyScript());
                      }
                    }}
                    className="mt-3 px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200"
                  >
                    New Script
                  </button>
                )}
              </div>
            )}
            {scripts.map((script) => (
              <div key={script.id} className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold truncate">{script.name}</h2>
                      <Badge variant={script.readonly ? "muted" : "info"} small>{script.readonly ? "built-in" : "custom"}</Badge>
                      {script.isDefault ? <Badge variant="success" small>default</Badge> : null}
                      {script.pkgManager ? <Badge variant="muted" small>{script.pkgManager}</Badge> : null}
                      {scriptUsesSudo(script) ? <Badge variant="warning" small>sudo</Badge> : null}
                      <UsageBadge
                        usages={script.usages ?? []}
                        onOpen={() => setUsageTarget(script)}
                      />
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {OPERATION_LABELS[script.operation]} · {script.description || "No description"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {!script.readonly && (
                      <button
                        type="button"
                        onClick={() => toggleScriptDefault(script)}
                        disabled={defaultingScriptId === script.id}
                        className={`p-1.5 rounded transition-colors disabled:cursor-wait disabled:opacity-50 ${
                          script.isDefault
                            ? "text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                            : "text-slate-400 hover:bg-slate-100 hover:text-amber-500 dark:hover:bg-slate-700"
                        }`}
                        title={script.isDefault ? "Clear default script" : "Set as default script"}
                        aria-label={script.isDefault ? `Clear ${script.name} as default` : `Set ${script.name} as default`}
                        aria-pressed={script.isDefault ?? false}
                      >
                        {defaultingScriptId === script.id ? (
                          <span className="spinner spinner-sm" />
                        ) : (
                          <svg
                            className="w-4 h-4"
                            fill={script.isDefault ? "currentColor" : "none"}
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M11.48 3.5a.6.6 0 011.04 0l2.28 4.62a.6.6 0 00.45.33l5.1.74a.6.6 0 01.33 1.02l-3.69 3.6a.6.6 0 00-.17.53l.87 5.08a.6.6 0 01-.87.63l-4.56-2.4a.6.6 0 00-.56 0l-4.56 2.4a.6.6 0 01-.87-.63l.87-5.08a.6.6 0 00-.17-.53l-3.69-3.6a.6.6 0 01.33-1.02l5.1-.74a.6.6 0 00.45-.33L11.48 3.5z"
                            />
                          </svg>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleCopy(script)}
                      disabled={copyingScriptId === script.id}
                      className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-50 disabled:cursor-wait transition-colors"
                      title="Copy script"
                    >
                      {copyingScriptId === script.id ? (
                        <span className="spinner spinner-sm" />
                      ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      )}
                    </button>
                    {!script.readonly && (
                      <>
                        <button
                          onClick={() => setEditing(script)}
                          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                          title="Edit script"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setDeleteTarget(script)}
                          className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                          title="Delete script"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  {script.steps.map((step, index) => (
                    <div key={`${script.id}-${index}`}>
                      <div className="mb-1 text-xs font-medium text-slate-500">{step.label}</div>
                      <ShellCodeBlock code={step.command} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? "Edit Script" : "New Script"} dismissible={!createScript.isPending && !updateScript.isPending}>
        {editing && (
          <ScriptEditor
            script={editing}
            packageManagers={packageManagerOptions}
            placeholders={data?.placeholders ?? []}
            operationProfiles={data?.operationProfiles}
            onSave={saveScript}
            onCancel={() => setEditing(null)}
            busy={createScript.isPending || updateScript.isPending}
          />
        )}
      </Modal>

      <Modal
        open={usageTarget !== null}
        onClose={() => setUsageTarget(null)}
        title={`${usageTarget?.name ?? "Script"} assignments`}
      >
        {usageTarget && (
          <div>
            <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
              {formatUsageSummary(usageTarget.usages ?? [])}
            </p>
            <UsageDetails usages={usageTarget.usages ?? []} />
          </div>
        )}
      </Modal>

      <Modal
        open={showPackageManager}
        onClose={() => {
          setShowPackageManager(false);
          setEditingPackageManager(null);
        }}
        title={editingPackageManager ? "Edit Package Manager" : "New Package Manager"}
        dismissible={!createPackageManager.isPending && !updatePackageManager.isPending}
      >
        <PackageManagerEditor
          draft={packageManagerDraft}
          setDraft={setPackageManagerDraft}
          onSave={handleSavePackageManager}
          onCancel={() => {
            setShowPackageManager(false);
            setEditingPackageManager(null);
          }}
          busy={createPackageManager.isPending || updatePackageManager.isPending}
          editing={editingPackageManager !== null}
        />
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteScript.mutate(deleteTarget.id, {
            onSuccess: () => {
              setDeleteTarget(null);
              addToast("Script deleted", "success");
            },
            onError: (err) => addToast(err.message, "danger"),
          });
        }}
        title="Delete Script"
        message={
          deleteTarget && (deleteTarget.usages ?? []).length > 0
            ? `Delete ${deleteTarget.name}? ${formatUsageSummary(deleteTarget.usages ?? [])}. It cannot be deleted until those systems use another script.`
            : `Delete ${deleteTarget?.name ?? "this script"}? This action cannot be undone.`
        }
        confirmLabel="Delete"
        danger
      />

      <ConfirmDialog
        open={deleteManagerTarget !== null}
        onClose={() => setDeleteManagerTarget(null)}
        onConfirm={() => {
          if (!deleteManagerTarget) return;
          deletePackageManager.mutate(deleteManagerTarget.name, {
            onSuccess: () => {
              if (managerFilter === deleteManagerTarget.name) setManagerFilter("all");
              setDeleteManagerTarget(null);
              addToast("Package manager deleted", "success");
            },
            onError: (err) => addToast(err.message, "danger"),
          });
        }}
        title="Delete Package Manager"
        message={`Delete ${deleteManagerTarget?.label ?? "this package manager"}? Managers with scripts must be cleared before they can be deleted.`}
        confirmLabel="Delete"
        danger
      />
    </Layout>
  );
}
