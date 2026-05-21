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
}

export interface CommandReference {
  exact: PotentialCommandEntry[];
  sudoers: PotentialCommandEntry[];
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
  "Fetching package lists": "Audits dpkg state, then refreshes APT package list metadata before checking updates",
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

function extractSudoCommand(command: string): string | null {
  const match = /then sudo -S -p '' (.+?); else /.exec(command);
  return match?.[1]?.trim() || null;
}

function normalizeForSudoers(entry: PotentialCommandEntry): PotentialCommandEntry | null {
  const command = extractSudoCommand(entry.command);
  if (!command) return null;

  return {
    ...entry,
    command: normalizeCommandTemplate(command),
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

  const systemInfo = getBuiltinSteps("system_info", null)[0];
  if (systemInfo) {
  exact.push({
    id: "system-info",
    category: "system_info",
    label: systemInfo.label,
    purpose: "Collects OS, kernel, uptime, resources, and reboot-related system details",
    pkgManager: null,
    command: systemInfo.command,
  });
  }

  const activeManagers = systemService.getActivePkgManagers(system);
  if (system.id && system.id > 0) {
    for (const manager of activeManagers) {
      if (exact.some((entry) => entry.id === `detection:${manager}`)) continue;
      const detectionStep = resolveRuntimeSteps({
        systemId: system.id,
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
  }

  for (const manager of activeManagers) {
    const systemId = system.id ?? 0;
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

      const repairIssue = resolveRuntimeSteps({
        systemId,
        operation: "repair_issue",
        pkgManager: manager,
        pkgManagerConfig: config,
      })[0];
      if (repairIssue) {
        exact.push({
          id: `repair-issue:${manager}`,
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

    const repairIssue = getBuiltinSteps("repair_issue", manager, { config })[0];
    if (repairIssue) {
      exact.push({
        id: `repair-issue:${manager}`,
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

  const rebootSteps = getBuiltinSteps("reboot", null);
  const reboot = rebootSteps[rebootSteps.length - 1];
  if (reboot) exact.push({
    id: "reboot",
    category: "reboot",
    label: reboot.label,
    purpose: "Reboots the remote system",
    pkgManager: null,
    command: reboot.command,
  });

  return {
    exact,
    sudoers: dedupeCommands(
      exact
        .map((entry) => normalizeForSudoers(entry))
        .filter((entry): entry is PotentialCommandEntry => entry != null),
    ),
  };
}

export function normalizeCommandForSudoers(command: string): string | null {
  const normalized = extractSudoCommand(command);
  return normalized ? normalizeCommandTemplate(normalized) : null;
}
