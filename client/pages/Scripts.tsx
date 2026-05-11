import { useEffect, useMemo, useRef, useState } from "react";
import Sortable from "sortablejs";
import { Layout } from "../components/Layout";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../context/ToastContext";
import {
  useCreatePackageManager,
  useCreateScript,
  useDeletePackageManager,
  useDeleteScript,
  useScripts,
  useUpdatePackageManager,
  useUpdateScript,
  type CustomPackageManagerDefinition,
  type PlaceholderHelpEntry,
  type ScriptDefinition,
  type ScriptOperation,
  type ScriptStep,
  type ScriptType,
  type CustomParserConfig,
  type CustomSystemInfoConfig,
} from "../lib/scripts";

const OPERATION_LABELS: Record<ScriptOperation, string> = {
  detect: "Detection",
  check_updates: "Check updates",
  upgrade_all: "Upgrade all",
  full_upgrade_all: "Full upgrade",
  upgrade_selected: "Upgrade selected",
  system_info: "System info",
  reboot: "Reboot",
};
const PACKAGE_MANAGER_OPERATIONS: ScriptOperation[] = [
  "detect",
  "check_updates",
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
  color: string;
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
    color: "",
  };
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

function colorInputValue(value: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#2563eb";
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

function ScriptEditor({
  script,
  packageManagers,
  onSave,
  onCancel,
  onShowHelp,
  busy,
}: {
  script: ScriptDefinition;
  packageManagers: Array<{ name: string; label: string }>;
  onSave: (script: ScriptDefinition) => void;
  onCancel: () => void;
  onShowHelp: () => void;
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
  const stepsRef = useRef<ScriptStep[]>(steps);
  const stepsListRef = useRef<HTMLDivElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);
  const operationOptions = draft.type === "system" ? SYSTEM_OPERATIONS : PACKAGE_MANAGER_OPERATIONS;
  const selectedPackageManager = draft.pkgManager ?? "";
  const usesBuiltinParser = selectedPackageManager ? BUILTIN_PACKAGE_MANAGERS.includes(selectedPackageManager) : false;
  const configKeys = selectedPackageManager ? PACKAGE_MANAGER_CONFIG_KEYS[selectedPackageManager] ?? [] : [];
  const showPackageManagerControls = draft.type === "package_manager";
  const showParserConfig =
    draft.type === "package_manager" &&
    draft.operation === "check_updates" &&
    !usesBuiltinParser;
  const showSystemInfoConfig = draft.type === "system" && draft.operation === "system_info";

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
    setSteps((current) => [
      ...current,
      { label: `Step ${current.length + 1}`, command: "" },
    ]);
  };

  const removeStep = (index: number) => {
    setSteps((current) => current.filter((_step, stepIndex) => stepIndex !== index));
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
      const pkgManager = draft.type === "package_manager"
        ? draft.pkgManager?.trim() || null
        : null;
      onSave({
        ...draft,
        pkgManager,
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
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-amber-700 dark:text-amber-300">
          No support is given for custom scripts whatsoever.
        </p>
        <button
          type="button"
          onClick={onShowHelp}
          className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          title="Show script placeholders"
          aria-label="Show script placeholders"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.09 9a3 3 0 115.82 1c0 2-2.91 2-2.91 4m0 4h.01" />
          </svg>
        </button>
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

      {showPackageManagerControls && (
        <div className="rounded-lg border border-border bg-slate-50/60 dark:bg-slate-900/30 p-3">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
            Config Keys
          </div>
          {configKeys.length > 0 ? (
            <div className="space-y-2">
              {configKeys.map((entry) => (
                <div key={entry.key} className="flex flex-wrap items-center gap-2 text-sm">
                  <code className="rounded bg-slate-200/70 dark:bg-slate-800 px-1.5 py-0.5 text-xs">
                    {`{{config.${entry.key}}}`}
                  </code>
                  <span className="text-slate-500 dark:text-slate-400">{entry.description}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              No built-in config keys are defined for this package manager yet.
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label className={labelClass}>Steps</label>
          <button
            type="button"
            onClick={addStep}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-lg leading-none"
            title="Add step"
            aria-label="Add step"
          >
            +
          </button>
        </div>
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
                    <label className={labelClass}>Step {index + 1} Label</label>
                    <input
                      value={step.label}
                      onChange={(e) => updateStep(index, { label: e.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>Command</label>
                    <textarea
                      value={step.command}
                      onChange={(e) => updateStep(index, { command: e.target.value })}
                      className={`${inputClass} min-h-24 font-mono text-xs`}
                    />
                  </div>
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
              Use named regex groups to turn check output into update rows. Required groups are packageName and newVersion.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Parse Step</label>
                <input
                  type="number"
                  min={0}
                  value={parserConfig.parseStep}
                  onChange={(e) => setParserConfig({ ...parserConfig, parseStep: e.target.value })}
                  className={inputClass}
                  placeholder="last step"
                />
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

function PlaceholderHelpContent({ placeholders }: { placeholders: PlaceholderHelpEntry[] }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-300">
        Placeholders are resolved immediately before SSH execution. Package placeholders are validated with the same package-name rules used by selected upgrades.
      </p>
      <div className="space-y-3">
        {placeholders.map((placeholder) => (
          <div key={placeholder.name} className="rounded-lg border border-border p-3">
            <div className="font-mono text-sm text-slate-900 dark:text-slate-100">{placeholder.name}</div>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{placeholder.description}</p>
            <pre className="mt-2 rounded bg-slate-900 px-3 py-2 text-xs text-slate-100 overflow-x-auto">{placeholder.example}</pre>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border p-3 text-sm text-slate-600 dark:text-slate-300">
        Parser regexes for custom package managers should use named groups such as <span className="font-mono">packageName</span>, <span className="font-mono">currentVersion</span>, <span className="font-mono">newVersion</span>, <span className="font-mono">architecture</span>, and <span className="font-mono">repository</span>.
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
          />
        </div>
        <div>
          <label className={labelClass}>Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={colorInputValue(draft.color)}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              className="h-10 w-12 rounded-lg border border-border bg-white dark:bg-slate-900 p-1"
              title="Package manager color"
              aria-label="Package manager color"
            />
            <input
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              className={inputClass}
              placeholder="#2563eb"
            />
          </div>
        </div>
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
            Built-ins are read-only; custom managers can be labeled and colored.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
            {managers.map((manager) => (
              <div
                key={manager.name}
                className="rounded-lg border border-border bg-slate-50/60 p-3 dark:bg-slate-900/30"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full border border-black/10 dark:border-white/20"
                        style={{ backgroundColor: manager.color || "#94a3b8" }}
                      />
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
                        {manager.scriptCount} scripts · {manager.operations.length} ops
                      </span>
                    </div>
                  </div>
                  {!manager.builtin && manager.registered && (
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
  const [showHelp, setShowHelp] = useState(false);
  const [showPackageManager, setShowPackageManager] = useState(false);
  const [editingPackageManager, setEditingPackageManager] = useState<CustomPackageManagerDefinition | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScriptDefinition | null>(null);
  const [deleteManagerTarget, setDeleteManagerTarget] = useState<ManagedPackageManager | null>(null);
  const [packageManagerDraft, setPackageManagerDraft] = useState(emptyPackageManager());

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
        color: "",
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
        color: manager.color ?? "",
        builtin: false,
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
    const labels = new Map<string, string>();
    for (const manager of managedPackageManagers) {
      labels.set(manager.name, manager.label);
    }
    return Array.from(labels.entries())
      .map(([name, label]) => ({ name, label }))
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

  const handleSavePackageManager = () => {
    const payload = {
      ...packageManagerDraft,
      color: packageManagerDraft.color.trim() || null,
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
      color: existing.color ?? "",
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

  const handleCopy = (script: ScriptDefinition) => {
    setEditing(copyScriptDraft(script));
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
                      {script.pkgManager ? <Badge variant="muted" small>{script.pkgManager}</Badge> : null}
                      {scriptUsesSudo(script) ? <Badge variant="warning" small>sudo</Badge> : null}
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {OPERATION_LABELS[script.operation]} · {script.description || "No description"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => handleCopy(script)}
                      className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      title="Copy script"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
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
                      <pre className="overflow-x-auto rounded-lg bg-slate-900 px-3 py-2 text-xs text-slate-100 whitespace-pre-wrap break-all">{step.command}</pre>
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
            onSave={saveScript}
            onCancel={() => setEditing(null)}
            onShowHelp={() => setShowHelp(true)}
            busy={createScript.isPending || updateScript.isPending}
          />
        )}
      </Modal>

      <Modal open={showHelp} onClose={() => setShowHelp(false)} title="Script Placeholders">
        <PlaceholderHelpContent placeholders={data?.placeholders ?? []} />
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
        message={`Delete ${deleteTarget?.name ?? "this script"}? Assigned scripts cannot be deleted.`}
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
