import {
  getManagerConfig,
  parsePackageManagerConfigs,
} from "../package-manager-configs";
import type { PackageManagerConfigValue } from "../package-manager-configs";
import {
  getBuiltinScripts,
  listPackageManagerDefinitions,
  renderCommandTemplate,
  resolveRuntimeSteps,
  type ScriptOperation,
  type ScriptStep,
} from "./script-service";
import * as systemService from "./system-service";

export type PotentialCommandCategory =
  | "detection"
  | "system_info"
  | "check"
  | "repair_issue"
  | "upgrade_all"
  | "full_upgrade_all"
  | "upgrade_selected"
  | "reboot";

export interface PotentialCommandEntry {
  id: string;
  category: PotentialCommandCategory;
  label: string;
  purpose: string;
  pkgManager: string | null;
  command: string;
  sourceCommand?: string;
  sudoersSafety?: "exact" | "package_placeholder" | "unsafe";
  requiresWildcard?: boolean;
  requiresPasswordLauncher?: boolean;
  warnings?: string[];
}

export interface CommandReferenceWarning {
  id: string;
  category: PotentialCommandCategory;
  label: string;
  pkgManager: string | null;
  message: string;
  command?: string;
}

export interface CommandReference {
  exact: PotentialCommandEntry[];
  sudoers: PotentialCommandEntry[];
  warnings: CommandReferenceWarning[];
}

interface CommandReferenceSystem {
  id?: number | null;
  pkgManager: string | null;
  detectedPkgManagers: string | null;
  disabledPkgManagers: string | null;
  pkgManagerConfigs?: string | null;
}

const SINGLE_PACKAGE_PLACEHOLDER = "codex-package-placeholder";
const MULTI_PACKAGE_PLACEHOLDER_ONE = "codex-package-placeholder-one";
const MULTI_PACKAGE_PLACEHOLDER_TWO = "codex-package-placeholder-two";

const CHECK_LABEL_PURPOSES: Record<string, string> = {
  "Auditing dpkg state": "Checks for interrupted dpkg package configuration before refreshing APT metadata",
  "Fetching package lists": "Refreshes APT package list metadata before checking updates",
  "Listing available updates": "Lists packages that have updates available",
  "Detecting kept-back packages": "Checks which APT updates are being kept back",
  "Checking for updates": "Checks for available updates on the remote system",
  "Refreshing package databases": "Refreshes package databases before checking updates",
  "Refreshing package indexes": "Refreshes package indexes before checking updates",
  "Refreshing appstream data": "Refreshes Flatpak appstream metadata before checking updates",
};

function managerLabel(manager: string): string {
  return manager.toUpperCase();
}

function normalizeCommandTemplate(command: string): string {
  return command
    .replaceAll(MULTI_PACKAGE_PLACEHOLDER_ONE, "<package1>")
    .replaceAll(MULTI_PACKAGE_PLACEHOLDER_TWO, "<package2>")
    .replaceAll(SINGLE_PACKAGE_PLACEHOLDER, "<package>");
}

function getCheckPurpose(label: string, manager: string): string {
  return CHECK_LABEL_PURPOSES[label] || `Runs a ${managerLabel(manager)} update check step`;
}

function getBuiltinSteps(
  operation: ScriptOperation,
  pkgManager: string | null,
  options: {
    config?: PackageManagerConfigValue;
    packages?: string[];
  } = {},
): ScriptStep[] {
  const script = getBuiltinScripts().find((candidate) =>
    candidate.operation === operation && candidate.pkgManager === pkgManager
  );
  return script?.steps.map((step) => ({
    label: step.label,
    command: renderCommandTemplate(step.command, {
      pkgManager,
      config: options.config,
      packages: options.packages,
    }),
  })) ?? [];
}

function stripShellRedirects(command: string): string {
  let next = command.trim();
  let previous = "";
  while (next !== previous) {
    previous = next;
    next = next
      .replace(/\s+\d?>&\d\s*$/g, "")
      .replace(/\s+\d?>\/dev\/null\s*$/g, "")
      .replace(/\s+\d?>\/dev\/null\s*\|\|\s*true\s*$/g, "")
      .trim();
  }
  return next;
}

function extractSudoCommands(command: string): string[] {
  const commands: string[] = [];
  const sudoInvocation = /\bsudo\s+(?:-S(?:\s+-p\s+(?:''|""))?|-n)\s+([^\n;]+)/g;
  let match: RegExpExecArray | null;
  while ((match = sudoInvocation.exec(command)) !== null) {
    const extracted = stripShellRedirects(match[1] ?? "");
    if (extracted) commands.push(extracted);
  }
  return commands;
}

function getSudoersWarnings(command: string): string[] {
  const warnings: string[] = [];
  if (/^(?:sh|bash|dash|zsh|fish)\s/.test(command)) {
    warnings.push("Runs a shell under sudo; prefer allowing the atomic command instead of a writable script or shell wrapper.");
  }
  if (/(?:^|\s)(?:\/tmp\/|\$\(|`)/.test(command)) {
    warnings.push("Contains a writable path or command substitution, so it cannot be represented as a narrow sudoers rule safely.");
  }
  if (/\$(?:\{[^}]+\}|[a-zA-Z_][a-zA-Z0-9_]*)/.test(command)) {
    warnings.push("Contains a shell variable expansion, so it cannot be represented as an exact sudoers rule safely.");
  }
  if (/\*/.test(command)) {
    warnings.push("Contains a wildcard; review the sudoers rule manually before using it.");
  }
  return warnings;
}

function normalizeForSudoers(entry: PotentialCommandEntry): {
  entries: PotentialCommandEntry[];
  warnings: CommandReferenceWarning[];
} {
  const entries: PotentialCommandEntry[] = [];
  const warnings: CommandReferenceWarning[] = [];
  const sudoCommands = extractSudoCommands(entry.command);
  if (sudoCommands.length === 0) return { entries, warnings };

  for (const [index, rawCommand] of sudoCommands.entries()) {
    const command = normalizeCommandTemplate(rawCommand);
    if (command === "-v") continue;
    const commandWarnings = getSudoersWarnings(command);
    const warningId = `${entry.id}:sudo:${index}`;
    if (commandWarnings.length > 0) {
      for (const message of commandWarnings) {
        warnings.push({
          id: warningId,
          category: entry.category,
          label: entry.label,
          pkgManager: entry.pkgManager,
          message,
          command,
        });
      }
      continue;
    }

    const requiresWildcard = /<package\d?>/.test(command);
    entries.push({
      ...entry,
      id: warningId,
      command,
      sourceCommand: entry.command,
      sudoersSafety: requiresWildcard ? "package_placeholder" : "exact",
      requiresWildcard,
      requiresPasswordLauncher: false,
      warnings: requiresWildcard
        ? ["Selected-package sudoers rules need package-specific entries or a carefully reviewed argument wildcard."]
        : undefined,
    });
  }
  return {
    entries,
    warnings,
  };
}

function dedupeCommands(entries: PotentialCommandEntry[]): PotentialCommandEntry[] {
  const seen = new Set<string>();
  const unique: PotentialCommandEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.category}:${entry.pkgManager || ""}:${entry.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

export function buildCommandReference(system: CommandReferenceSystem): CommandReference {
  const configs = parsePackageManagerConfigs(system.pkgManagerConfigs ?? null, listPackageManagerDefinitions());
  const exact: PotentialCommandEntry[] = [];
  const systemId = system.id ?? 0;

  if (systemId > 0) {
    for (const { name: manager } of listPackageManagerDefinitions()) {
      const detectionStep = resolveRuntimeSteps({
        systemId,
        operation: "detect",
        pkgManager: manager,
      })[0];
      if (!detectionStep) continue;
      exact.push({
        id: `detection:${manager}`,
        category: "detection",
        label: detectionStep.label || `Detect ${managerLabel(manager)}`,
        purpose: `Checks whether ${managerLabel(manager)} is available on the remote system`,
        pkgManager: manager,
        command: detectionStep.command,
      });
    }
  } else {
    for (const script of getBuiltinScripts().filter((entry) => entry.operation === "detect" && entry.pkgManager)) {
      const step = getBuiltinSteps("detect", script.pkgManager)[0];
      if (!step || !script.pkgManager) continue;
      exact.push({
        id: `detection:${script.pkgManager}`,
        category: "detection",
        label: step.label || `Detect ${managerLabel(script.pkgManager)}`,
        purpose: `Checks whether ${managerLabel(script.pkgManager)} is available on the remote system`,
        pkgManager: script.pkgManager,
        command: step.command,
      });
    }
  }

  const systemInfoSteps = systemId > 0
    ? resolveRuntimeSteps({ systemId, operation: "system_info" })
    : getBuiltinSteps("system_info", null);
  for (const [index, systemInfo] of systemInfoSteps.entries()) {
    exact.push({
      id: index === 0 ? "system-info" : `system-info:${index}`,
      category: "system_info",
      label: systemInfo.label,
      purpose: "Collects OS, kernel, uptime, resources, and reboot-related system details",
      pkgManager: null,
      command: systemInfo.command,
    });
  }

  const activeManagers = systemService.getActivePkgManagers(system);
  for (const manager of activeManagers) {
    const config = getManagerConfig(configs, manager);
    if (systemId > 0) {
      const checkSteps = resolveRuntimeSteps({
        systemId,
        operation: "check_updates",
        pkgManager: manager,
        pkgManagerConfig: config,
      });
      for (const [index, step] of checkSteps.entries()) {
        exact.push({
          id: `check:${manager}:${index}`,
          category: "check",
          label: step.label || `Check ${managerLabel(manager)} updates`,
          purpose: getCheckPurpose(step.label || "", manager),
          pkgManager: manager,
          command: normalizeCommandTemplate(step.command),
        });
      }

      const repairIssueSteps = resolveRuntimeSteps({
        systemId,
        operation: "repair_issue",
        pkgManager: manager,
        pkgManagerConfig: config,
      });
      for (const [index, repairIssue] of repairIssueSteps.entries()) {
        exact.push({
          id: `repair-issue:${manager}:${index}`,
          category: "repair_issue",
          label: `Repair ${managerLabel(manager)} issue`,
          purpose: `Runs the package manager issue repair action for ${managerLabel(manager)}`,
          pkgManager: manager,
          command: normalizeCommandTemplate(repairIssue.command),
        });
      }

      const upgradeAll = resolveRuntimeSteps({
        systemId,
        operation: "upgrade_all",
        pkgManager: manager,
        pkgManagerConfig: config,
      })[0];
      if (upgradeAll) {
        exact.push({
          id: `upgrade-all:${manager}`,
          category: "upgrade_all",
          label: `Upgrade all ${managerLabel(manager)} packages`,
          purpose: `Installs all available ${managerLabel(manager)} updates for this system`,
          pkgManager: manager,
          command: normalizeCommandTemplate(upgradeAll.command),
        });
      }

      const fullUpgrade = resolveRuntimeSteps({
        systemId,
        operation: "full_upgrade_all",
        pkgManager: manager,
        pkgManagerConfig: config,
      })[0];
      if (fullUpgrade) {
        exact.push({
          id: `full-upgrade:${manager}`,
          category: "full_upgrade_all",
          label: `Run ${managerLabel(manager)} full upgrade`,
          purpose: `Runs the fuller ${managerLabel(manager)} upgrade mode for this system`,
          pkgManager: manager,
          command: normalizeCommandTemplate(fullUpgrade.command),
        });
      }

      const upgradeOne = resolveRuntimeSteps({
        systemId,
        operation: "upgrade_selected",
        pkgManager: manager,
        pkgManagerConfig: config,
        packages: [SINGLE_PACKAGE_PLACEHOLDER],
      })[0];
      if (upgradeOne) {
        exact.push({
          id: `upgrade-selected-single:${manager}`,
          category: "upgrade_selected",
          label: `Upgrade one selected ${managerLabel(manager)} package`,
          purpose: `Upgrades a single selected package via ${managerLabel(manager)}`,
          pkgManager: manager,
          command: normalizeCommandTemplate(upgradeOne.command),
        });
      }

      const upgradeMultiple = resolveRuntimeSteps({
        systemId,
        operation: "upgrade_selected",
        pkgManager: manager,
        pkgManagerConfig: config,
        packages: [MULTI_PACKAGE_PLACEHOLDER_ONE, MULTI_PACKAGE_PLACEHOLDER_TWO],
      })[0];
      if (upgradeMultiple) {
        exact.push({
          id: `upgrade-selected-multiple:${manager}`,
          category: "upgrade_selected",
          label: `Upgrade multiple selected ${managerLabel(manager)} packages`,
          purpose: `Upgrades multiple selected packages via ${managerLabel(manager)}`,
          pkgManager: manager,
          command: normalizeCommandTemplate(upgradeMultiple.command),
        });
      }
      continue;
    }

    const checkSteps = getBuiltinSteps("check_updates", manager, { config });
    for (const [index, step] of checkSteps.entries()) {
      const label = step.label || `Check ${managerLabel(manager)} updates`;
      exact.push({
        id: `check:${manager}:${index}`,
        category: "check",
        label,
        purpose: getCheckPurpose(label, manager),
        pkgManager: manager,
        command: normalizeCommandTemplate(step.command),
      });
    }

    const repairIssueSteps = getBuiltinSteps("repair_issue", manager, { config });
    for (const [index, repairIssue] of repairIssueSteps.entries()) {
      exact.push({
        id: `repair-issue:${manager}:${index}`,
        category: "repair_issue",
        label: `Repair ${managerLabel(manager)} issue`,
        purpose: `Runs the package manager issue repair action for ${managerLabel(manager)}`,
        pkgManager: manager,
        command: normalizeCommandTemplate(repairIssue.command),
      });
    }

    const upgradeAll = getBuiltinSteps("upgrade_all", manager, { config })[0];
    if (upgradeAll) {
    exact.push({
      id: `upgrade-all:${manager}`,
      category: "upgrade_all",
      label: `Upgrade all ${managerLabel(manager)} packages`,
      purpose: `Installs all available ${managerLabel(manager)} updates for this system`,
      pkgManager: manager,
      command: normalizeCommandTemplate(upgradeAll.command),
    });
    }

    const fullUpgrade = getBuiltinSteps("full_upgrade_all", manager, { config })[0];
    if (fullUpgrade) {
      exact.push({
        id: `full-upgrade:${manager}`,
        category: "full_upgrade_all",
        label: `Run ${managerLabel(manager)} full upgrade`,
        purpose: `Runs the fuller ${managerLabel(manager)} upgrade mode for this system`,
        pkgManager: manager,
        command: normalizeCommandTemplate(fullUpgrade.command),
      });
    }

    const upgradeOne = getBuiltinSteps("upgrade_selected", manager, {
      config,
      packages: [SINGLE_PACKAGE_PLACEHOLDER],
    })[0];
    if (upgradeOne) {
    exact.push({
      id: `upgrade-selected-single:${manager}`,
      category: "upgrade_selected",
      label: `Upgrade one selected ${managerLabel(manager)} package`,
      purpose: `Upgrades a single selected package via ${managerLabel(manager)}`,
      pkgManager: manager,
      command: normalizeCommandTemplate(upgradeOne.command),
    });
    }

    const upgradeMultiple = getBuiltinSteps("upgrade_selected", manager, {
      config,
      packages: [MULTI_PACKAGE_PLACEHOLDER_ONE, MULTI_PACKAGE_PLACEHOLDER_TWO],
    })[0];
    if (upgradeMultiple) {
    exact.push({
      id: `upgrade-selected-multiple:${manager}`,
      category: "upgrade_selected",
      label: `Upgrade multiple selected ${managerLabel(manager)} packages`,
      purpose: `Upgrades multiple selected packages via ${managerLabel(manager)}`,
      pkgManager: manager,
      command: normalizeCommandTemplate(upgradeMultiple.command),
    });
    }
  }

  const rebootSteps = systemId > 0
    ? resolveRuntimeSteps({ systemId, operation: "reboot" })
    : getBuiltinSteps("reboot", null);
  for (const [index, reboot] of rebootSteps.entries()) {
    exact.push({
      id: index === rebootSteps.length - 1 ? "reboot" : `reboot:${index}`,
      category: "reboot",
      label: reboot.label,
      purpose: index === rebootSteps.length - 1
        ? "Reboots the remote system"
        : "Runs a pre-reboot safety check",
      pkgManager: null,
      command: reboot.command,
    });
  }

  const sudoersResults = exact.map((entry) => normalizeForSudoers(entry));
  const sudoers = dedupeCommands(sudoersResults.flatMap((result) => result.entries));
  const warnings = sudoersResults.flatMap((result) => result.warnings);

  return {
    exact,
    sudoers,
    warnings,
  };
}

export function normalizeCommandForSudoers(command: string): string | null {
  const normalized = extractSudoCommands(command)[0];
  return normalized ? normalizeCommandTemplate(normalized) : null;
}
