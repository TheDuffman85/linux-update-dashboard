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
  exportPackageManagerBundle,
  formatScriptCommand,
  useImportPackageManagerBundle,
  useScripts,
  useUpdatePackageManager,
  useUpdateScript,
  type CustomPackageManagerBundle,
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
import {
  getLegacyCustomConfigKey,
  type CustomPackageManagerConfigEntry,
} from "../lib/package-manager-configs";
import { useI18n } from "../lib/i18n";

const OPERATION_LABELS: Record<ScriptOperation, string> = {
  detect: "Detection",
  check_updates: "Check updates",
  list_installed_packages: "List installed packages",
  repair_issue: "Repair issue",
  autoremove: "Autoremove",
  upgrade_all: "Upgrade all",
  full_upgrade_all: "Full upgrade",
  upgrade_selected: "Upgrade selected",
  system_info: "System info",
  reboot: "Reboot",
};
const OPERATION_LABEL_KEYS: Record<ScriptOperation, string> = {
  detect: "pages.scripts.operation.detect",
  check_updates: "pages.scripts.operation.checkUpdates",
  list_installed_packages: "pages.scripts.operation.listInstalledPackages",
  repair_issue: "pages.scripts.operation.repairIssue",
  autoremove: "pages.scripts.operation.autoremove",
  upgrade_all: "pages.scripts.operation.upgradeAll",
  full_upgrade_all: "pages.scripts.operation.fullUpgrade",
  upgrade_selected: "pages.scripts.operation.upgradeSelected",
  system_info: "pages.scripts.operation.systemInfo",
  reboot: "pages.scripts.operation.reboot",
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
    operation: "list_installed_packages",
    label: OPERATION_LABELS.list_installed_packages,
    allowedTypes: ["package_manager"],
    purpose: "Lists installed packages and their current versions for the system-detail inventory.",
    stepBehavior: "Steps run in order and stop at the first failed step.",
    outputConsumer: "The parsed package snapshot is cached per manager; full listing output is not stored in activity history.",
    parserBehavior: "Custom package managers need an installed-package regex with packageName and currentVersion groups.",
    exitCodeBehavior: "A non-zero exit code keeps the previous snapshot and marks the refresh as a warning.",
    relevantPlaceholders: ["{{manager}}", "{{config.someKey}}"],
    defaultStepBadge: "inventory parser input",
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
    operation: "autoremove",
    label: OPERATION_LABELS.autoremove,
    allowedTypes: ["package_manager"],
    purpose: "Removes packages or runtimes that are no longer needed.",
    stepBehavior: "The autoremove command runs as the operation body for the selected manager.",
    outputConsumer: "Output is streamed live, stored in history, and followed by a recheck.",
    parserBehavior: "No parser configuration is used while removing unused packages.",
    exitCodeBehavior: "A non-zero exit code marks the autoremove operation as failed.",
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
  "list_installed_packages",
  "repair_issue",
  "autoremove",
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
const PACKAGE_MANAGER_CONFIG_KEYS: Record<
  string,
  Array<{ key: string; descriptionKey: string; description: string }>
> = {
  apt: [
    { key: "defaultUpgradeMode", descriptionKey: "pages.scripts.configDescription.defaultUpgradeModeApt", description: "upgrade or full-upgrade" },
    { key: "autoHideKeptBackUpdates", descriptionKey: "pages.scripts.configDescription.autoHideKeptBackUpdates", description: "true when kept-back updates are auto-hidden" },
  ],
  dnf: [
    { key: "defaultUpgradeMode", descriptionKey: "pages.scripts.configDescription.defaultUpgradeModeDnf", description: "upgrade or distro-sync" },
    { key: "refreshMetadataOnCheck", descriptionKey: "pages.scripts.configDescription.refreshMetadataOnCheck", description: "true when checks refresh metadata" },
    { key: "autoAcceptNewSigningKeysOnCheck", descriptionKey: "pages.scripts.configDescription.autoAcceptNewSigningKeysOnCheck", description: "true when checks may import new signing keys" },
    { key: "autoAcceptEulaOnUpgrade", descriptionKey: "pages.scripts.configDescription.autoAcceptEulaOnUpgrade", description: "true when upgrades prepend ACCEPT_EULA=Y" },
  ],
  yum: [
    { key: "autoAcceptNewSigningKeysOnCheck", descriptionKey: "pages.scripts.configDescription.autoAcceptNewSigningKeysOnCheck", description: "true when checks may import new signing keys" },
    { key: "autoAcceptEulaOnUpgrade", descriptionKey: "pages.scripts.configDescription.autoAcceptEulaOnUpgrade", description: "true when upgrades prepend ACCEPT_EULA=Y" },
  ],
  pacman: [
    { key: "refreshDatabasesOnCheck", descriptionKey: "pages.scripts.configDescription.refreshDatabasesOnCheck", description: "true unless database refresh is disabled" },
  ],
  apk: [
    { key: "refreshIndexesOnCheck", descriptionKey: "pages.scripts.configDescription.refreshIndexesOnCheck", description: "true unless index refresh is disabled" },
  ],
  flatpak: [
    { key: "refreshAppstreamOnCheck", descriptionKey: "pages.scripts.configDescription.refreshAppstreamOnCheck", description: "true unless appstream refresh is disabled" },
  ],
};
const BUILTIN_PACKAGE_MANAGER_CONFIG_KEY_NAMES = new Map(
  Object.entries(PACKAGE_MANAGER_CONFIG_KEYS).map(([manager, entries]) => [
    manager,
    entries.map((entry) => entry.key),
  ]),
);
const SYSTEM_INFO_FIELDS = [
  "osId",
  "osIdLike",
  "osName",
  "osVersion",
  "osVersionCodename",
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

const STEP_BADGE_LABEL_KEYS: Record<string, string> = {
  "detection output": "pages.scripts.stepBadge.detectionOutput",
  "inventory parser input": "pages.scripts.stepBadge.inventoryParserInput",
  "not used": "pages.scripts.stepBadge.notUsed",
  "parsed output": "pages.scripts.stepBadge.parsedOutput",
  "parser input": "pages.scripts.stepBadge.parserInput",
  "reboot command": "pages.scripts.stepBadge.rebootCommand",
  "reboot guard": "pages.scripts.stepBadge.rebootGuard",
  "streamed only": "pages.scripts.stepBadge.streamedOnly",
  "system fields": "pages.scripts.stepBadge.systemFields",
};

const PLACEHOLDER_DESCRIPTION_KEYS: Record<string, string> = {
  "{{manager}}": "pages.scripts.placeholder.manager",
  "{{package}}": "pages.scripts.placeholder.package",
  "{{packages}}": "pages.scripts.placeholder.packages",
  "{{quotedPackage}}": "pages.scripts.placeholder.quotedPackage",
  "{{quotedPackages}}": "pages.scripts.placeholder.quotedPackages",
  "{{sudo:COMMAND}}": "pages.scripts.placeholder.sudoCommand",
};

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass = "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const PACKAGE_MANAGERS_PANEL_STORAGE_KEY = "scripts.packageManagersPanelOpen";
type Translate = ReturnType<typeof useI18n>["t"];

function getExamplesRepositoryUrl(): string | null {
  if (typeof __APP_REPO_URL__ !== "string" || !__APP_REPO_URL__) return null;
  return `${__APP_REPO_URL__.replace(/\/+$/, "")}/tree/main/examples`;
}

type PackageManagerDraft = {
  name: string;
  label: string;
  parserConfig: CustomParserConfig | null;
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

function emptyScript(t?: Translate): ScriptDefinition {
  return {
    id: "",
    readonly: false,
    name: "",
    description: "",
    type: "package_manager",
    operation: "detect",
    pkgManager: "apt",
    isDefault: false,
    steps: [{ label: t?.("pages.scripts.defaultStepLabel") ?? "Run command", command: "" }],
    parserConfig: null,
    systemInfoConfig: null,
    sourceScriptId: null,
  };
}

function emptyPackageManager(): PackageManagerDraft {
  return {
    name: "",
    label: "",
    parserConfig: null,
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

function normalizeConfigEntriesForManager(
  manager: string,
  entries: CustomPackageManagerConfigEntry[],
): CustomPackageManagerConfigEntry[] {
  const trimmedManager = manager.trim().toLowerCase();
  if (!trimmedManager) return entries;
  return entries.map((entry) => ({
    ...entry,
    key: getLegacyCustomConfigKey(trimmedManager, entry.key),
  }));
}

function validateConfigEntries(
  entries: CustomPackageManagerConfigEntry[],
  currentManagerName: string | null,
  t: Translate,
): string | null {
  const seen = new Set<string>();
  const keyPattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
  for (const entry of entries) {
    if (!keyPattern.test(entry.key)) {
      return t("pages.scripts.error.configKeyPattern");
    }
    if (currentManagerName && BUILTIN_PACKAGE_MANAGER_CONFIG_KEY_NAMES.get(currentManagerName)?.includes(entry.key)) {
      return t("pages.scripts.error.configKeyCollides", { key: entry.key, manager: currentManagerName });
    }
    if (seen.has(entry.key)) return t("pages.scripts.error.duplicateConfigKey", { key: entry.key });
    seen.add(entry.key);
  }
  return null;
}

function copyScriptDraft(script: ScriptDefinition, t: Translate): ScriptDefinition {
  return {
    ...script,
    id: "",
    readonly: false,
    name: t("pages.scripts.nameCopy", { name: script.name }),
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

function formatUsageOperation(usage: ScriptUsage, t: Translate): string {
  const [manager, operation] = usage.operationKey.split("/");
  const operationKey = OPERATION_LABEL_KEYS[(operation || usage.operationKey) as ScriptOperation];
  const operationLabel = operationKey
    ? t(operationKey)
    : OPERATION_LABELS[(operation || usage.operationKey) as ScriptOperation] ?? usage.operationKey;
  return manager && manager !== "system" ? `${manager} · ${operationLabel}` : operationLabel;
}

function formatUsageSummary(usages: ScriptUsage[], t: Translate): string {
  if (usages.length === 0) return t("pages.scripts.notAssignedToAnySystem");
  const names = usages.map((usage) => usage.systemName);
  const visible = names.slice(0, 3).join(", ");
  const extra = names.length > 3 ? t("pages.scripts.andCountMore", { count: names.length - 3 }) : "";
  return t("pages.scripts.assignedToNames", { names: `${visible}${extra}` });
}

function UsageDetails({ usages }: { usages: ScriptUsage[] }) {
  const { t } = useI18n();

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
            {formatUsageOperation(usage, t)}
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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (usages.length === 0) return null;

  const label = usages.length === 1
    ? t("pages.scripts.oneSystem")
    : t("pages.scripts.countSystems", { count: usages.length });
  const summary = formatUsageSummary(usages, t);

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
        aria-label={t("pages.scripts.viewScriptAssignmentsAria", { summary })}
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

function parseExitCodes(value: string, t: Translate): number[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const codes = trimmed.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (codes.some((code) => !Number.isInteger(code) || code < 0)) {
    throw new Error(t("pages.scripts.error.exitCodes"));
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
      successMessage="pages.scripts.copiedScriptCommand"
      expandable
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
  const { t } = useI18n();
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const highlighted = useMemo(() => highlightShell(value), [value]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <label htmlFor={id} className={`${labelClass} mb-0`}>{t("pages.scripts.command")}</label>
        <div className="flex items-center gap-2">
          <CopyButton
            text={value}
            successMessage="pages.scripts.copiedCommand"
            className="border-border bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-700"
          />
          <button
            type="button"
            onClick={onBeautify}
            disabled={beautifying || !value.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-700"
            title={t("pages.scripts.beautifyCommand")}
          >
            {beautifying ? <span className="spinner spinner-sm" /> : (
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 20l8.5-8.5m0 0L14 7l3 3-4.5 1.5zm3-14h.01M18 4h.01M20 10h.01M14 20h.01" />
              </svg>
            )}
            {t("pages.scripts.beautify")}
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

function translateStepBadge(label: string, t: Translate): string {
  const key = STEP_BADGE_LABEL_KEYS[label];
  return key ? t(key) : label;
}

function translatePlaceholderDescription(placeholder: PlaceholderHelpEntry, t: Translate): string {
  const key = PLACEHOLDER_DESCRIPTION_KEYS[placeholder.name];
  return key ? t(key) : placeholder.description;
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
  const { t } = useI18n();
  const countLabel = entries.length === 1
    ? t("pages.scripts.oneEntry")
    : t("pages.scripts.countEntries", { count: entries.length });
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
                    title={t("pages.scripts.copyValue", { value: entry.token })}
                    aria-label={t("pages.scripts.copyValue", { value: entry.token })}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    {t("pages.scripts.copy")}
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
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const outputDetail = showParserConfig
    ? t("pages.scripts.runtime.customParserOutput", { step: parseStepLabel })
    : usesBuiltinParser && profile.operation === "check_updates"
      ? t("pages.scripts.runtime.builtinParserOutput")
      : t(`pages.scripts.runtime.${profile.operation}.outputConsumer`);

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
              {t("pages.scripts.runtime.title")}
            </span>
            <Badge variant="info" small>{t(OPERATION_LABEL_KEYS[profile.operation])}</Badge>
          </div>
          <div className="mt-1 text-xs text-blue-700/80 dark:text-blue-200/80">
            {t("pages.scripts.runtime.subtitle")}
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
          <p>{t(`pages.scripts.runtime.${profile.operation}.purpose`)}</p>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.runtime.steps")}
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{t(`pages.scripts.runtime.${profile.operation}.stepBehavior`)}</p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.runtime.output")}
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{outputDetail}</p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.runtime.parser")}
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{t(`pages.scripts.runtime.${profile.operation}.parserBehavior`)}</p>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.runtime.exitCodes")}
              </div>
              <p className="mt-1 text-blue-900/80 dark:text-blue-100/80">{t(`pages.scripts.runtime.${profile.operation}.exitCodeBehavior`)}</p>
            </div>
          </div>
          {parseStepOutOfRange && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
              {t("pages.scripts.savedParserStepNoLongerExists")}
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

function downloadJsonFile(filename: string, value: unknown): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseImportBundle(value: unknown, t: Translate): CustomPackageManagerBundle {
  if (!isRecord(value) || value.format !== "ludash.custom-package-manager.v1") {
    throw new Error(t("pages.scripts.error.unsupportedPackageManagerExportFormat"));
  }
  if (!isRecord(value.packageManager)) {
    throw new Error(t("pages.scripts.error.importMissingPackageManagerDetails"));
  }
  if (!Array.isArray(value.scripts)) {
    throw new Error(t("pages.scripts.error.importMissingScripts"));
  }
  return {
    ...(value as unknown as CustomPackageManagerBundle),
    packageManager: {
      name: typeof value.packageManager.name === "string" ? value.packageManager.name : "",
      label: typeof value.packageManager.label === "string" ? value.packageManager.label : "",
      parserConfig: isRecord(value.packageManager.parserConfig)
        ? value.packageManager.parserConfig as CustomParserConfig
        : null,
      configEntries: Array.isArray(value.packageManager.configEntries)
        ? value.packageManager.configEntries as CustomPackageManagerConfigEntry[]
        : [],
    },
    scripts: value.scripts as CustomPackageManagerBundle["scripts"],
  };
}

function buildParserConfig(input: {
  parseStep: string;
  updateRegex: string;
  installedPackageRegex: string;
  securityRegex: string;
  keptBackRegex: string;
  successExitCodes: string;
  updatesExitCodes: string;
}, t: Translate): CustomParserConfig | null {
  const config: CustomParserConfig = {};
  if (input.parseStep.trim()) {
    const parseStep = Number.parseInt(input.parseStep.trim(), 10);
    if (!Number.isInteger(parseStep) || parseStep < 0) {
      throw new Error(t("pages.scripts.error.parseStep"));
    }
    config.parseStep = parseStep;
  }
  if (input.updateRegex.trim()) config.updateRegex = input.updateRegex.trim();
  if (input.installedPackageRegex.trim()) config.installedPackageRegex = input.installedPackageRegex.trim();
  if (input.securityRegex.trim()) config.securityRegex = input.securityRegex.trim();
  if (input.keptBackRegex.trim()) config.keptBackRegex = input.keptBackRegex.trim();
  const successExitCodes = parseExitCodes(input.successExitCodes, t);
  const updatesExitCodes = parseExitCodes(input.updatesExitCodes, t);
  if (successExitCodes) config.successExitCodes = successExitCodes;
  if (updatesExitCodes) config.updatesExitCodes = updatesExitCodes;
  return Object.keys(config).length ? config : null;
}

function updateParserConfigField(
  parserConfig: CustomParserConfig | null | undefined,
  field: keyof Pick<CustomParserConfig, "issueRegex" | "issueTitle" | "issueMessage">,
  value: string,
): CustomParserConfig | null {
  const next: CustomParserConfig = { ...(parserConfig ?? {}) };
  const trimmed = value.trim();
  if (trimmed) next[field] = trimmed;
  else delete next[field];
  return Object.keys(next).length ? next : null;
}

function buildIssueDetectionConfig(input: {
  issueRegex: string;
  issueTitle: string;
  issueMessage: string;
}): CustomParserConfig | null {
  return updateParserConfigField(
    updateParserConfigField(
      updateParserConfigField(null, "issueRegex", input.issueRegex),
      "issueTitle",
      input.issueTitle,
    ),
    "issueMessage",
    input.issueMessage,
  );
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
  const { t } = useI18n();
  const { addToast } = useToast();
  const [draft, setDraft] = useState(script);
  const [steps, setSteps] = useState<ScriptStep[]>(
    script.steps.length
      ? script.steps
      : [{ label: t("pages.scripts.defaultStepLabel"), command: "" }],
  );
  const [parserConfig, setParserConfig] = useState({
    parseStep: script.parserConfig?.parseStep?.toString() ?? "",
    updateRegex: script.parserConfig?.updateRegex ?? "",
    installedPackageRegex: script.parserConfig?.installedPackageRegex ?? "",
    securityRegex: script.parserConfig?.securityRegex ?? "",
    keptBackRegex: script.parserConfig?.keptBackRegex ?? "",
    issueRegex: script.parserConfig?.issueRegex ?? "",
    issueTitle: script.parserConfig?.issueTitle ?? "",
    issueMessage: script.parserConfig?.issueMessage ?? "",
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
  const builtinConfigKeys = selectedPackageManager
    ? (PACKAGE_MANAGER_CONFIG_KEYS[selectedPackageManager] ?? []).map((entry) => ({
        id: `config.${entry.key}`,
        token: `{{config.${entry.key}}}`,
        description: t(entry.descriptionKey),
      }))
    : [];
  const customConfigKeys = packageManagers
    .find((manager) => manager.name === selectedPackageManager)
    ?.configEntries?.map((entry) => ({
      id: `config.${entry.key}`,
      token: `{{config.${entry.key}}}`,
      description: entry.description?.trim()
        || (entry.defaultValue
          ? t("pages.scripts.defaultValueInline", { value: entry.defaultValue })
          : t("pages.scripts.customConfigValue")),
    })) ?? [];
  const configReferenceEntries = [...builtinConfigKeys, ...customConfigKeys];
  const placeholderReferenceEntries = placeholders
    .filter((placeholder) => !isGeneratedConfigPlaceholder(placeholder))
    .map((placeholder) => ({
      id: placeholder.name,
      token: placeholder.name,
      description: translatePlaceholderDescription(placeholder, t),
    }));
  const showPackageManagerControls = draft.type === "package_manager";
  const showParserConfig =
    draft.type === "package_manager" &&
    (draft.operation === "check_updates" || draft.operation === "list_installed_packages") &&
    !usesBuiltinParser;
  const showIssueDetectionConfig =
    draft.type === "package_manager" &&
    draft.operation === "repair_issue" &&
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
      ? t("pages.scripts.missingStep", { step: parsedStepNumber + 1 })
      : t("pages.scripts.invalidParserStep")
    : steps[parsedStepIndex]?.label || t("pages.scripts.stepNumber", { step: parsedStepIndex + 1 });
  const parseStepSummary = showParserConfig
    ? parseStepOutOfRange
      ? parsedStepLabel
      : t("pages.scripts.stepNumberWithLabel", { step: parsedStepIndex + 1, label: parsedStepLabel })
    : "";

  const stepBadge = (index: number): string => {
    if (draft.operation === "detect") return index === 0 ? t("pages.scripts.stepBadge.detectionOutput") : t("pages.scripts.stepBadge.notUsed");
    if (draft.operation === "check_updates" || draft.operation === "list_installed_packages") {
      if (showParserConfig) {
        if (parseStepOutOfRange) return t("pages.scripts.stepBadge.streamedOnly");
        return index === parsedStepIndex ? t("pages.scripts.stepBadge.parsedOutput") : t("pages.scripts.stepBadge.streamedOnly");
      }
      return usesBuiltinParser
        ? t("pages.scripts.stepBadge.parserInput")
        : translateStepBadge(operationProfile.defaultStepBadge, t);
    }
    if (draft.operation === "system_info") return t("pages.scripts.stepBadge.systemFields");
    if (draft.operation === "reboot") return index < steps.length - 1 ? t("pages.scripts.stepBadge.rebootGuard") : t("pages.scripts.stepBadge.rebootCommand");
    return translateStepBadge(operationProfile.defaultStepBadge, t);
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
      { label: t("pages.scripts.stepNumber", { step: current.length + 1 }), command: "" },
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
      addToast(t("pages.scripts.commandBeautified"), "success");
    } catch (error) {
      const detail = error instanceof Error ? error.message : t("pages.scripts.invalidShellSyntax");
      addToast(t("pages.scripts.couldNotBeautifyCommand", { detail }), "danger");
    } finally {
      setBeautifyingStep(null);
    }
  };

  const copyReference = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      addToast(t("pages.scripts.copiedValue", { value }), "success");
    } catch {
      addToast(t("components.copyableCodeBlock.couldNotCopyToClipboard"), "danger");
    }
  };

  const save = () => {
    try {
      const normalizedSteps = steps.map((step) => ({
        label: step.label.trim(),
        command: step.command.trim(),
      }));
      if (normalizedSteps.some((step) => !step.label || !step.command)) {
        throw new Error(t("pages.scripts.error.eachStepNeedsLabelAndCommand"));
      }
      if (draft.operation === "detect" && normalizedSteps.length !== 1) {
        throw new Error(t("pages.scripts.error.detectionScriptsUseOneStep"));
      }
      const pkgManager = draft.type === "package_manager"
        ? draft.pkgManager?.trim() || null
        : null;
      onSave({
        ...draft,
        pkgManager,
        isDefault: draft.isDefault ?? false,
        steps: normalizedSteps,
        parserConfig: showParserConfig
          ? buildParserConfig(parserConfig, t)
          : showIssueDetectionConfig
            ? buildIssueDetectionConfig(parserConfig)
            : null,
        systemInfoConfig: showSystemInfoConfig
          ? buildSystemInfoConfig(systemInfoMode, systemInfoSections, rebootRequiredRegex)
          : null,
      });
    } catch (error) {
      addToast(error instanceof Error ? error.message : t("pages.scripts.invalidScript"), "danger");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
        <p className="min-w-0 text-sm">
          {t("pages.scripts.noSupportCustomScripts")}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("common.name")}</label>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>{t("common.type")}</label>
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
            <option value="package_manager">{t("pages.scripts.packageManager")}</option>
            <option value="system">{t("pages.scripts.system")}</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>{t("pages.scripts.operation")}</label>
          <select
            value={draft.operation}
            onChange={(e) => setDraft({ ...draft, operation: e.target.value as ScriptOperation })}
            className={inputClass}
          >
            {operationOptions.map((operation) => (
              <option key={operation} value={operation}>{t(OPERATION_LABEL_KEYS[operation])}</option>
            ))}
          </select>
        </div>
        {showPackageManagerControls && (
          <div>
            <label className={labelClass}>{t("pages.scripts.packageManager")}</label>
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
        <label className={labelClass}>{t("pages.scripts.description")}</label>
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
          title={t("pages.scripts.configKeys")}
          entries={configReferenceEntries}
          emptyMessage={t("pages.scripts.noConfigKeysForPackageManager")}
          onCopy={copyReference}
        />
      )}

      <ScriptReferenceSection
        title={t("pages.scripts.placeholders")}
        entries={placeholderReferenceEntries}
        emptyMessage={t("pages.scripts.noScriptPlaceholdersAvailable")}
        onCopy={copyReference}
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className={labelClass}>{t("pages.scripts.steps")}</label>
          <button
            type="button"
            onClick={addStep}
            disabled={singleStepOperation}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40 transition-colors text-lg leading-none"
            title={singleStepOperation ? t("pages.scripts.detectionScriptsUseOneStep") : t("pages.scripts.addStep")}
            aria-label={t("pages.scripts.addStep")}
          >
            +
          </button>
        </div>
        {singleStepOperation && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("pages.scripts.detectionScriptsUseOneCommand")}
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
                  title={t("pages.scripts.dragToReorder")}
                  aria-label={t("pages.scripts.dragToReorderStep", { step: index + 1 })}
                  disabled={steps.length <= 1}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                  </svg>
                </button>
                <div className="min-w-0 flex-1 space-y-3">
                  <div>
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <label className={`${labelClass} mb-0`}>{t("pages.scripts.stepLabel", { step: index + 1 })}</label>
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
                  title={t("pages.scripts.removeStep")}
                  aria-label={t("pages.scripts.removeStepNumber", { step: index + 1 })}
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
          {t("pages.scripts.builtinParserNotice", { manager: selectedPackageManager.toUpperCase() })}
        </div>
      )}

      {showParserConfig && (
        <details className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
            {t("pages.scripts.advancedParserRules")}
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {draft.operation === "list_installed_packages"
                ? t("pages.scripts.installedPackageParserDescription")
                : t("pages.scripts.updateParserDescription")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>{t("pages.scripts.outputToParse")}</label>
                <select
                  value={parserConfig.parseStep}
                  onChange={(e) => setParserConfig({ ...parserConfig, parseStep: e.target.value })}
                  className={inputClass}
                >
                  <option value="">
                    {t("pages.scripts.lastStep", {
                      label: steps.at(-1)?.label || t("pages.scripts.stepNumber", { step: steps.length }),
                    })}
                  </option>
                  {steps.map((step, index) => (
                    <option key={`${index}-${step.label}`} value={index.toString()}>
                      {t("pages.scripts.stepNumberWithLabel", {
                        step: index + 1,
                        label: step.label || t("pages.scripts.stepNumber", { step: index + 1 }),
                      })}
                    </option>
                  ))}
                  {parseStepOutOfRange && (
                    <option value={parserConfig.parseStep}>
                      {Number.isInteger(parsedStepNumber)
                        ? t("pages.scripts.missingStep", { step: parsedStepNumber + 1 })
                        : t("pages.scripts.invalidParserStep")}
                    </option>
                  )}
                </select>
                {parseStepOutOfRange && (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    {t("pages.scripts.savedParserStepOutsideCurrentList")}
                  </p>
                )}
              </div>
              <div>
                <label className={labelClass}>{t("pages.scripts.successfulExitCodes")}</label>
                <input
                  value={parserConfig.successExitCodes}
                  onChange={(e) => setParserConfig({ ...parserConfig, successExitCodes: e.target.value })}
                  className={inputClass}
                  placeholder="0"
                />
              </div>
              {draft.operation === "list_installed_packages" ? (
                <div className="md:col-span-2">
                  <label className={labelClass}>{t("pages.scripts.installedPackageLineRegex")}</label>
                  <textarea
                    value={parserConfig.installedPackageRegex}
                    onChange={(e) => setParserConfig({ ...parserConfig, installedPackageRegex: e.target.value })}
                    className={`${inputClass} min-h-20 font-mono text-xs`}
                    placeholder={"^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)$"}
                  />
                </div>
              ) : (
                <>
                  <div className="md:col-span-2">
                    <label className={labelClass}>{t("pages.scripts.updateLineRegex")}</label>
                    <textarea
                      value={parserConfig.updateRegex}
                      onChange={(e) => setParserConfig({ ...parserConfig, updateRegex: e.target.value })}
                      className={`${inputClass} min-h-20 font-mono text-xs`}
                      placeholder={"^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$"}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>{t("pages.scripts.securityMarkerRegex")}</label>
                    <input
                      value={parserConfig.securityRegex}
                      onChange={(e) => setParserConfig({ ...parserConfig, securityRegex: e.target.value })}
                      className={inputClass}
                      placeholder="security"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>{t("pages.scripts.keptBackMarkerRegex")}</label>
                    <input
                      value={parserConfig.keptBackRegex}
                      onChange={(e) => setParserConfig({ ...parserConfig, keptBackRegex: e.target.value })}
                      className={inputClass}
                      placeholder="held|kept back"
                    />
                  </div>
                  <div>
                    <label className={labelClass}>{t("pages.scripts.updatesAvailableExitCodes")}</label>
                    <input
                      value={parserConfig.updatesExitCodes}
                      onChange={(e) => setParserConfig({ ...parserConfig, updatesExitCodes: e.target.value })}
                      className={inputClass}
                      placeholder="100"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </details>
      )}

      {showSystemInfoConfig && (
        <details className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
            {t("pages.scripts.advancedSystemInfoMapping")}
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("pages.scripts.systemInfoMappingDescription")}
            </p>
            <div>
              <label className={labelClass}>{t("pages.scripts.parserMode")}</label>
              <select
                value={systemInfoMode}
                onChange={(e) => setSystemInfoMode(e.target.value as "builtin" | "sectioned")}
                className={inputClass}
              >
                <option value="builtin">{t("pages.scripts.parserMode.builtin")}</option>
                <option value="sectioned">{t("pages.scripts.parserMode.sectioned")}</option>
              </select>
            </div>
            {systemInfoMode === "builtin" ? (
              <div className="rounded-lg border border-border p-3 text-sm text-slate-500 dark:text-slate-400">
                {t("pages.scripts.builtinSystemInfoParserDescription")}
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
                  <label className={labelClass}>{t("pages.scripts.rebootRequiredRegex")}</label>
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

      {showIssueDetectionConfig && (
        <details className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-200">
            {t("pages.scripts.issueDetection")}
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {t("pages.scripts.issueDetectionDescription")}
            </p>
            <div>
              <label className={labelClass}>{t("pages.scripts.issueRegex")}</label>
              <textarea
                value={parserConfig.issueRegex}
                onChange={(e) => setParserConfig({ ...parserConfig, issueRegex: e.target.value })}
                className={`${inputClass} min-h-20 font-mono text-xs`}
                placeholder="needs repair|database is locked"
              />
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className={labelClass}>{t("pages.scripts.issueTitle")}</label>
                <input
                  value={parserConfig.issueTitle}
                  onChange={(e) => setParserConfig({ ...parserConfig, issueTitle: e.target.value })}
                  className={inputClass}
                  placeholder={t("pages.scripts.packageManagerNeedsRepair", {
                    manager: selectedPackageManager || t("pages.scripts.packageManager"),
                  })}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.scripts.issueMessage")}</label>
                <input
                  value={parserConfig.issueMessage}
                  onChange={(e) => setParserConfig({ ...parserConfig, issueMessage: e.target.value })}
                  className={inputClass}
                  placeholder={t("pages.scripts.runRepairThenRefresh")}
                />
              </div>
            </div>
          </div>
        </details>
      )}

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700">
          {t("common.cancel")}
        </button>
        <button type="button" disabled={busy} onClick={save} className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">
          {busy ? <span className="spinner spinner-sm" /> : t("common.save")}
        </button>
      </div>
    </div>
  );
}

export function PackageManagerEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
  onImport,
  onClearImport,
  importBundle,
  importFileName,
  saveLabel,
  busy,
  importing,
  editing,
  importKeyExists,
}: {
  draft: PackageManagerDraft;
  setDraft: (draft: PackageManagerDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onImport?: () => void;
  onClearImport?: () => void;
  importBundle?: CustomPackageManagerBundle | null;
  importFileName?: string | null;
  saveLabel?: string;
  busy?: boolean;
  importing?: boolean;
  editing?: boolean;
  importKeyExists?: boolean;
}) {
  const { t } = useI18n();
  const effectiveSaveLabel = saveLabel ?? t("common.save");
  const importOperations = importBundle
    ? Array.from(new Set(importBundle.scripts.map((script) => script.operation)))
        .sort((a, b) => PACKAGE_MANAGER_OPERATIONS.indexOf(a) - PACKAGE_MANAGER_OPERATIONS.indexOf(b))
    : [];
  const examplesUrl = getExamplesRepositoryUrl();
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
      <div className="flex min-w-0 gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        </svg>
        <p className="min-w-0 text-sm">
          {t("pages.scripts.noSupportCustomPackageManagers")}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("pages.scripts.managerKey")}</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className={inputClass}
            placeholder="custom-pm"
            disabled={editing}
          />
          {editing && (
            <p className="mt-1 text-xs text-slate-400">
              {t("pages.scripts.managerKeysRenameGuidance")}
            </p>
          )}
          {importKeyExists && (
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {t("pages.scripts.managerKeyAlreadyExists")}
            </p>
          )}
        </div>
        <div>
          <label className={labelClass}>{t("pages.scripts.displayLabel")}</label>
          <input
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className={inputClass}
            placeholder="Custom PM"
            disabled={draft.builtin}
          />
        </div>
      </div>
      {!editing && onImport && !importBundle ? (
        <div className="rounded-lg border border-dashed border-border bg-slate-50/70 p-3 dark:bg-slate-900/30">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {t("pages.scripts.examplesFolderDescription")}
              {examplesUrl ? (
                <>
                  {" "}
                  <a
                    href={examplesUrl}
                    target="_blank"
                    rel="noreferrer"
                  className="font-medium text-blue-600 hover:underline dark:text-blue-300"
                  >
                    {t("pages.scripts.viewExamplesOnGithub")}
                  </a>
                  .
                </>
              ) : null}
            </p>
            <button
              type="button"
              onClick={onImport}
              disabled={importing}
              className="w-full shrink-0 rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-slate-50 disabled:opacity-50 dark:hover:bg-slate-700 sm:w-auto"
            >
              {t("pages.scripts.importFile")}
            </button>
          </div>
        </div>
      ) : null}
      {importBundle && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/70 p-3 text-sm text-blue-950 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-100">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.importPreview")}
              </div>
              {importFileName && (
                <div className="mt-1 truncate text-xs text-blue-700/80 dark:text-blue-200/80">
                  {importFileName}
                </div>
              )}
            </div>
            {onClearImport ? (
              <button
                type="button"
                onClick={onClearImport}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40"
                title={t("pages.scripts.unloadImportFile")}
                aria-label={t("pages.scripts.unloadImportFile")}
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.scripts")}
              </div>
              <div className="mt-1">{importBundle.scripts.length}</div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.operations")}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {importOperations.length ? (
                  importOperations.map((operation) => (
                    <span
                      key={operation}
                      className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300"
                      title={OPERATION_LABEL_KEYS[operation] ? t(OPERATION_LABEL_KEYS[operation]) : operation}
                    >
                      {OPERATION_LABEL_KEYS[operation] ? t(OPERATION_LABEL_KEYS[operation]) : operation}
                    </span>
                  ))
                ) : (
                  <span>{t("pages.scripts.none")}</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-blue-700 dark:text-blue-300">
                {t("pages.scripts.configEntries")}
              </div>
              <div className="mt-1">{importBundle.packageManager.configEntries.length}</div>
            </div>
          </div>
        </div>
      )}
      <div className="rounded-lg border border-border bg-slate-50/60 p-3 dark:bg-slate-900/30">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {t("pages.scripts.customConfig")}
            </div>
          </div>
          <button
            type="button"
            onClick={addConfigEntry}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border text-lg leading-none transition-colors hover:bg-slate-50 dark:hover:bg-slate-700"
            title={t("pages.scripts.addConfigEntry")}
            aria-label={t("pages.scripts.addConfigEntry")}
          >
            +
          </button>
        </div>
        {draft.configEntries.length > 0 ? (
          <div className="space-y-3">
            {draft.configEntries.map((entry, index) => (
              <div key={index} className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-white p-3 dark:bg-slate-900 md:grid-cols-[1fr_1fr_1fr_auto]">
                <div>
                  <label className={labelClass}>{t("pages.scripts.key")}</label>
                  <input
                    value={entry.key}
                    onChange={(e) => updateConfigEntry(index, { key: e.target.value })}
                    className={inputClass}
                    placeholder="channel"
                  />
                </div>
                <div>
                  <label className={labelClass}>{t("pages.scripts.defaultValue")}</label>
                  <input
                    value={entry.defaultValue}
                    onChange={(e) => updateConfigEntry(index, { defaultValue: e.target.value })}
                    className={inputClass}
                    placeholder="stable"
                  />
                </div>
                <div>
                  <label className={labelClass}>{t("pages.scripts.description")}</label>
                  <input
                    value={entry.description ?? ""}
                    onChange={(e) => updateConfigEntry(index, { description: e.target.value })}
                    className={inputClass}
                    placeholder={t("pages.scripts.optional")}
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={() => removeConfigEntry(index)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
                    title={t("pages.scripts.removeConfigEntry")}
                    aria-label={t("pages.scripts.removeConfigEntry")}
                  >
                    -
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("pages.scripts.noCustomConfigEntriesYet")}
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:flex sm:justify-end">
        <button type="button" onClick={onCancel} className="w-full px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 sm:w-auto">
          {t("common.cancel")}
        </button>
        <button type="button" disabled={busy || importKeyExists} onClick={onSave} className="w-full px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 sm:w-auto">
          {busy ? <span className="spinner spinner-sm" /> : effectiveSaveLabel}
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
  onExportManager,
  onDeleteManager,
}: {
  managers: ManagedPackageManager[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onEditManager: (manager: ManagedPackageManager) => void;
  onExportManager: (manager: ManagedPackageManager) => void;
  onDeleteManager: (manager: ManagedPackageManager) => void;
}) {
  const { t } = useI18n();
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
            {t("pages.scripts.packageManagers")}
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t("pages.scripts.packageManagersSummary", {
              managers: managers.length,
              custom: customCount,
              scripts: totalScripts,
            })}
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
            {t("pages.scripts.packageManagersDescription")}
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
                        {manager.builtin ? t("pages.scripts.builtIn2") : t("pages.scripts.custom2")}
                      </Badge>
                      {!manager.registered && (
                        <Badge variant="warning" small>
                          {t("pages.scripts.scriptOnly")}
                        </Badge>
                      )}
                      <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-slate-900 dark:text-slate-300">
                        {manager.name}
                      </code>
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {t("pages.scripts.managerStats", {
                          scripts: manager.scriptCount,
                          ops: manager.operations.length,
                          configs: manager.configEntries.length,
                        })}
                      </span>
                    </div>
                  </div>
                  {manager.registered && (
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        onClick={() => onEditManager(manager)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title={t("pages.scripts.editPackageManager")}
                        aria-label={t("pages.scripts.editName", { name: manager.label })}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      {!manager.builtin && (
                        <>
                          <button
                            type="button"
                            onClick={() => onExportManager(manager)}
                            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                            title={t("pages.scripts.exportPackageManager")}
                            aria-label={t("pages.scripts.exportName", { name: manager.label })}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v10m0 0l-4-4m4 4l4-4M5 20h14" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteManager(manager)}
                            className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                            title={t("pages.scripts.deletePackageManager")}
                            aria-label={t("pages.scripts.deleteName", { name: manager.label })}
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </>
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
                        title={t(OPERATION_LABEL_KEYS[operation])}
                      >
                        {t(OPERATION_LABEL_KEYS[operation])}
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
  const importPackageManagerBundle = useImportPackageManagerBundle();
  const { addToast } = useToast();
  const { t } = useI18n();
  const [typeFilter, setTypeFilter] = useState<"all" | ScriptType>("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "builtin" | "custom">("all");
  const [managerFilter, setManagerFilter] = useState("all");
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [packageManagersOpen, setPackageManagersOpen] = useState(readPackageManagersPanelOpen);
  const [editing, setEditing] = useState<ScriptDefinition | null>(null);
  const [showPackageManager, setShowPackageManager] = useState(false);
  const [editingPackageManager, setEditingPackageManager] = useState<CustomPackageManagerDefinition | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScriptDefinition | null>(null);
  const [deleteManagerTarget, setDeleteManagerTarget] = useState<ManagedPackageManager | null>(null);
  const [deleteManagerScripts, setDeleteManagerScripts] = useState(false);
  const [usageTarget, setUsageTarget] = useState<ScriptDefinition | null>(null);
  const [packageManagerDraft, setPackageManagerDraft] = useState(emptyPackageManager());
  const [packageManagerImportBundle, setPackageManagerImportBundle] = useState<CustomPackageManagerBundle | null>(null);
  const [packageManagerImportFileName, setPackageManagerImportFileName] = useState<string | null>(null);
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
        parserConfig: null,
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
        parserConfig: manager.parserConfig ? { ...manager.parserConfig } : null,
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
  const packageManagerImportKeyExists = Boolean(
    packageManagerImportBundle &&
      !editingPackageManager &&
      packageManagerDraft.name.trim() &&
      managedPackageManagers.some(
        (manager) => manager.name === packageManagerDraft.name.trim().toLowerCase(),
      ),
  );

  const saveScript = (script: ScriptDefinition) => {
    const callbacks = {
      onSuccess: () => {
        setEditing(null);
        addToast(t("pages.scripts.scriptSaved"), "success");
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
          addToast(script.isDefault ? t("pages.scripts.scriptDefaultCleared") : t("pages.scripts.scriptSetAsDefault"), "success");
        },
        onError: (err: Error) => addToast(err.message, "danger"),
        onSettled: () => setDefaultingScriptId(null),
      },
    );
  };

  const handleSavePackageManager = () => {
    const managerName = packageManagerDraft.name.trim().toLowerCase();
    if (
      packageManagerImportBundle &&
      !editingPackageManager &&
      managerName &&
      managedPackageManagers.some((manager) => manager.name === managerName)
    ) {
      addToast(
        t("pages.scripts.packageManagerKeyKeyAlreadyExistsChooseA", {
          key: managerName,
        }),
        "danger",
      );
      return;
    }
    const configEntries = normalizeConfigEntriesForManager(
      managerName,
      normalizeConfigEntries(packageManagerDraft.configEntries),
    );
    const configEntryError = validateConfigEntries(
      configEntries,
      editingPackageManager?.name ?? (packageManagerImportBundle ? managerName : null),
      t,
    );
    if (configEntryError) {
      addToast(configEntryError, "danger");
      return;
    }
    const payload = {
      ...packageManagerDraft,
      name: managerName,
      configEntries,
    };
    if (packageManagerImportBundle && !editingPackageManager) {
      const bundle: CustomPackageManagerBundle = {
        ...packageManagerImportBundle,
        packageManager: {
          ...packageManagerImportBundle.packageManager,
          name: payload.name,
          label: payload.label,
          configEntries,
        },
        scripts: packageManagerImportBundle.scripts.map((script) => ({
          ...script,
          pkgManager: payload.name,
        })),
      };
      importPackageManagerBundle.mutate(bundle, {
        onSuccess: (result) => {
          setShowPackageManager(false);
          setEditingPackageManager(null);
          setPackageManagerDraft(emptyPackageManager());
          setPackageManagerImportBundle(null);
          setPackageManagerImportFileName(null);
          setPackageManagersOpen(true);
          setManagerFilter(result.manager.name);
          addToast(
            t("pages.scripts.packageManagerImportedCreatedScriptsCreatedUpdatedUpdated", {
              created: result.createdScripts,
              updated: result.updatedScripts,
            }),
            "success",
          );
        },
        onError: (err: Error) => addToast(err.message, "danger"),
      });
      return;
    }
    const callbacks = {
      onSuccess: () => {
        setShowPackageManager(false);
        setEditingPackageManager(null);
        setPackageManagerDraft(emptyPackageManager());
        setPackageManagerImportBundle(null);
        setPackageManagerImportFileName(null);
        addToast(t("pages.scripts.packageManagerSaved"), "success");
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
    setPackageManagerImportBundle(null);
    setPackageManagerImportFileName(null);
    setShowPackageManager(true);
  };

  const openEditPackageManager = (manager: ManagedPackageManager) => {
    const existing = data?.packageManagers.find((entry) => entry.name === manager.name);
    if (!existing) return;
    setEditingPackageManager(existing);
    setPackageManagerImportBundle(null);
    setPackageManagerImportFileName(null);
    setPackageManagerDraft({
      name: existing.name,
      label: existing.label,
      parserConfig: existing.parserConfig ? { ...existing.parserConfig } : null,
      configEntries: (existing.configEntries ?? []).map((entry) => ({ ...entry })),
      builtin: existing.builtin,
    });
    setShowPackageManager(true);
  };

  const handleExportPackageManager = async (manager: ManagedPackageManager) => {
    try {
      const bundle = await exportPackageManagerBundle(manager.name);
      downloadJsonFile(`${bundle.packageManager.name}-package-manager.json`, bundle);
      addToast(t("pages.scripts.packageManagerExported"), "success");
    } catch (error) {
      addToast(error instanceof Error ? error.message : t("pages.scripts.failedToExportPackageManager"), "danger");
    }
  };

  const handleImportPackageManager = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const bundle = parseImportBundle(JSON.parse(await file.text()), t);
      const importedManagerName = bundle.packageManager.name.trim().toLowerCase();
      setEditingPackageManager(null);
      setPackageManagerDraft({
        name: bundle.packageManager.name,
        label: bundle.packageManager.label,
        parserConfig: bundle.packageManager.parserConfig
          ? { ...bundle.packageManager.parserConfig }
          : null,
        configEntries: (bundle.packageManager.configEntries ?? []).map((entry) => ({
          ...entry,
          key: getLegacyCustomConfigKey(importedManagerName, entry.key),
        })),
        builtin: false,
      });
      setPackageManagerImportBundle(bundle);
      setPackageManagerImportFileName(file.name);
      setShowPackageManager(true);
    } catch (error) {
      addToast(error instanceof Error ? error.message : t("pages.scripts.invalidPackageManagerExportFile"), "danger");
    }
  };

  const createScriptForManager = (manager: ManagedPackageManager) => {
    setEditing({
      ...emptyScript(t),
      pkgManager: manager.name,
      name: t("pages.scripts.nameScript", { name: manager.label }),
    });
  };

  const handleCopy = async (script: ScriptDefinition) => {
    const draft = copyScriptDraft(script, t);
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
          ? t("pages.scripts.copiedScriptWithoutBeautifyingError", { error: error.message })
          : t("pages.scripts.copiedScriptWithoutBeautifying"),
        "info",
      );
    } finally {
      setCopyingScriptId(null);
      setEditing(draft);
    }
  };

  return (
    <Layout
      title={t("pages.scripts.scripts")}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportPackageManager}
          />
          <button onClick={openPackageManagerModal} className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700">
            {t("pages.scripts.newPackageManager")}
          </button>
          <button onClick={() => setEditing(emptyScript(t))} className="px-3 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white">
            {t("pages.scripts.newScript")}
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
            onExportManager={handleExportPackageManager}
            onDeleteManager={(manager) => {
              setDeleteManagerScripts(false);
              setDeleteManagerTarget(manager);
            }}
          />

          <div className="flex flex-wrap gap-2">
            <select value={managerFilter} onChange={(e) => setManagerFilter(e.target.value)} className={inputClass + " max-w-52"}>
              <option value="all">{t("pages.scripts.allManagers")}</option>
              {managedPackageManagers.map((manager) => (
                <option key={manager.name} value={manager.name}>
                  {manager.label}
                </option>
              ))}
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)} className={inputClass + " max-w-52"}>
              <option value="all">{t("pages.scripts.allTypes")}</option>
              <option value="package_manager">{t("pages.scripts.packageManager")}</option>
              <option value="system">{t("pages.scripts.system")}</option>
            </select>
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)} className={inputClass + " max-w-52"}>
              <option value="all">{t("pages.scripts.allSources")}</option>
              <option value="builtin">{t("pages.scripts.builtIn")}</option>
              <option value="custom">{t("pages.scripts.custom")}</option>
            </select>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {scripts.length === 0 && (
              <div className="xl:col-span-2 rounded-lg border border-border p-6 text-sm text-slate-500 dark:text-slate-400">
                <div>{t("pages.scripts.noScriptsMatchTheseFilters")}</div>
                {sourceFilter === "custom" && (
                  <button
                    type="button"
                    onClick={() => {
                      const manager = managedPackageManagers.find((entry) => entry.name === managerFilter);
                      if (manager) {
                        createScriptForManager(manager);
                      } else {
                        setEditing(emptyScript(t));
                      }
                    }}
                    className="mt-3 px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200"
                  >
                    {t("pages.scripts.newScript")}
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
                      <Badge variant={script.readonly ? "muted" : "info"} small>{script.readonly ? t("pages.scripts.builtIn2") : t("pages.scripts.custom2")}</Badge>
                      {script.isDefault ? <Badge variant="success" small>{t("pages.scripts.default")}</Badge> : null}
                      {script.pkgManager ? <Badge variant="muted" small>{script.pkgManager}</Badge> : null}
                      {scriptUsesSudo(script) ? <Badge variant="warning" small>sudo</Badge> : null}
                      <UsageBadge
                        usages={script.usages ?? []}
                        onOpen={() => setUsageTarget(script)}
                      />
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {t(OPERATION_LABEL_KEYS[script.operation])} · {script.description || t("pages.scripts.noDescription")}
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
                        title={script.isDefault ? t("pages.scripts.clearDefaultScript") : t("pages.scripts.setAsDefaultScript")}
                        aria-label={script.isDefault ? t("pages.scripts.clearNameAsDefault", { name: script.name }) : t("pages.scripts.setNameAsDefault", { name: script.name })}
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
                      title={t("pages.scripts.copyScript")}
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
                          title={t("pages.scripts.editScript")}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => setDeleteTarget(script)}
                          className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                          title={t("pages.scripts.deleteScript")}
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

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? t("pages.scripts.editScript2") : t("pages.scripts.newScript")} dismissible={!createScript.isPending && !updateScript.isPending}>
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
        title={t("pages.scripts.nameAssignments", { name: usageTarget?.name ?? t("pages.scripts.script") })}
      >
        {usageTarget && (
          <div>
            <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
              {formatUsageSummary(usageTarget.usages ?? [], t)}
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
          setPackageManagerImportBundle(null);
          setPackageManagerImportFileName(null);
        }}
        title={editingPackageManager ? t("pages.scripts.editPackageManager") : t("pages.scripts.newPackageManager")}
        dismissible={!createPackageManager.isPending && !updatePackageManager.isPending && !importPackageManagerBundle.isPending}
      >
        <PackageManagerEditor
          draft={packageManagerDraft}
          setDraft={setPackageManagerDraft}
          onSave={handleSavePackageManager}
          onImport={() => importInputRef.current?.click()}
          onClearImport={() => {
            setPackageManagerImportBundle(null);
            setPackageManagerImportFileName(null);
            setPackageManagerDraft(emptyPackageManager());
            if (importInputRef.current) importInputRef.current.value = "";
          }}
          importBundle={packageManagerImportBundle}
          importFileName={packageManagerImportFileName}
          onCancel={() => {
            setShowPackageManager(false);
            setEditingPackageManager(null);
            setPackageManagerImportBundle(null);
            setPackageManagerImportFileName(null);
          }}
          busy={createPackageManager.isPending || updatePackageManager.isPending || importPackageManagerBundle.isPending}
          importing={importPackageManagerBundle.isPending}
          saveLabel={packageManagerImportBundle ? t("pages.scripts.import") : t("pages.scripts.save")}
          editing={editingPackageManager !== null}
          importKeyExists={packageManagerImportKeyExists}
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
              addToast(t("pages.scripts.scriptDeleted"), "success");
            },
            onError: (err) => addToast(err.message, "danger"),
          });
        }}
        title={t("pages.scripts.deleteScript2")}
        message={
          deleteTarget && (deleteTarget.usages ?? []).length > 0
            ? t("pages.scripts.deleteNameSummaryItCannotBeDeletedUntil", {
                name: deleteTarget.name,
                summary: formatUsageSummary(deleteTarget.usages ?? [], t),
              })
            : t("pages.scripts.deleteNameThisActionCannotBeUndone", {
                name: deleteTarget?.name ?? t("pages.scripts.thisScript"),
              })
        }
        confirmLabel={t("pages.scripts.delete")}
        danger
      />

      <ConfirmDialog
        open={deleteManagerTarget !== null}
        onClose={() => {
          setDeleteManagerTarget(null);
          setDeleteManagerScripts(false);
        }}
        onConfirm={() => {
          if (!deleteManagerTarget) return;
          deletePackageManager.mutate({
            name: deleteManagerTarget.name,
            deleteScripts: deleteManagerScripts,
          }, {
            onSuccess: () => {
              if (managerFilter === deleteManagerTarget.name) setManagerFilter("all");
              setDeleteManagerTarget(null);
              setDeleteManagerScripts(false);
              addToast(t("pages.scripts.packageManagerDeleted"), "success");
            },
            onError: (err) => addToast(err.message, "danger"),
          });
        }}
        title={t("pages.scripts.deletePackageManager")}
        message={t("pages.scripts.deleteName", { name: deleteManagerTarget?.label ?? t("pages.scripts.thisPackageManager") })}
        confirmLabel={t("pages.scripts.delete")}
        danger
      >
        <p className="mb-3 text-sm text-slate-600 dark:text-slate-300">
          {t("pages.scripts.packageManagerDeleteRequirement")}
        </p>
        {deleteManagerTarget?.scriptCount ? (
          <label className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50/70 p-3 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-100">
            <input
              type="checkbox"
              checked={deleteManagerScripts}
              onChange={(event) => setDeleteManagerScripts(event.target.checked)}
              className="mt-0.5 rounded border-red-300 text-red-600 focus:ring-red-500"
            />
            <span>
              <span className="block font-medium">
                {t("pages.scripts.alsoDeleteCountScripts", {
                  count: deleteManagerTarget.scriptCount,
                  scriptLabel: deleteManagerTarget.scriptCount === 1
                    ? t("pages.scripts.scriptLower")
                    : t("pages.scripts.scriptsLower"),
                })}
              </span>
              <span className="mt-1 block text-xs text-red-700 dark:text-red-200">
                {t("pages.scripts.deleteScriptsBlockedIfAssigned")}
              </span>
            </span>
          </label>
        ) : (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("pages.scripts.packageManagerHasNoScripts")}
          </p>
        )}
      </ConfirmDialog>
    </Layout>
  );
}
