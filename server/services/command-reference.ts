import {
  getManagerConfig,
  parsePackageManagerConfigs,
} from "../package-manager-configs";
import { getPackageManagerDetectionCommands } from "../ssh/detector";
import { getParser } from "../ssh/parsers";
import { getRebootCommand } from "../ssh/reboot";
import { SYSTEM_INFO_CMD } from "../ssh/system-info";
import * as systemService from "./system-service";

export type PotentialCommandCategory =
  | "detection"
  | "system_info"
  | "check"
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
  pkgManager: string | null;
  detectedPkgManagers: string | null;
  disabledPkgManagers: string | null;
  pkgManagerConfigs?: string | null;
}

const SINGLE_PACKAGE_PLACEHOLDER = "codex-package-placeholder";
const MULTI_PACKAGE_PLACEHOLDER_ONE = "codex-package-placeholder-one";
const MULTI_PACKAGE_PLACEHOLDER_TWO = "codex-package-placeholder-two";

const CHECK_LABEL_PURPOSES: Record<string, string> = {
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
  const configs = parsePackageManagerConfigs(system.pkgManagerConfigs ?? null);
  const exact: PotentialCommandEntry[] = [];

  for (const { name, command } of getPackageManagerDetectionCommands()) {
    exact.push({
      id: `detection:${name}`,
      category: "detection",
      label: `Detect ${managerLabel(name)}`,
      purpose: `Checks whether ${managerLabel(name)} is available on the remote system`,
      pkgManager: name,
      command,
    });
  }

  exact.push({
    id: "system-info",
    category: "system_info",
    label: "Collect system information",
    purpose: "Collects OS, kernel, uptime, resources, and reboot-related system details",
    pkgManager: null,
    command: SYSTEM_INFO_CMD,
  });

  const activeManagers = systemService.getActivePkgManagers(system);
  for (const manager of activeManagers) {
    const parser = getParser(manager);
    if (!parser) continue;

    const config = getManagerConfig(configs, manager);
    const checkCommands = parser.getCheckCommands(config).map(normalizeCommandTemplate);
    const checkLabels = parser.getCheckCommandLabels?.(config) ?? [];

    for (const [index, command] of checkCommands.entries()) {
      const label = checkLabels[index] || `Check ${managerLabel(manager)} updates`;
      exact.push({
        id: `check:${manager}:${index}`,
        category: "check",
        label,
        purpose: getCheckPurpose(label, manager),
        pkgManager: manager,
        command,
      });
    }

    exact.push({
      id: `upgrade-all:${manager}`,
      category: "upgrade_all",
      label: `Upgrade all ${managerLabel(manager)} packages`,
      purpose: `Installs all available ${managerLabel(manager)} updates for this system`,
      pkgManager: manager,
      command: normalizeCommandTemplate(parser.getUpgradeAllCommand(config)),
    });

    const fullUpgrade = parser.getFullUpgradeAllCommand(config);
    if (fullUpgrade) {
      exact.push({
        id: `full-upgrade:${manager}`,
        category: "full_upgrade_all",
        label: `Run ${managerLabel(manager)} full upgrade`,
        purpose: `Runs the fuller ${managerLabel(manager)} upgrade mode for this system`,
        pkgManager: manager,
        command: normalizeCommandTemplate(fullUpgrade),
      });
    }

    exact.push({
      id: `upgrade-selected-single:${manager}`,
      category: "upgrade_selected",
      label: `Upgrade one selected ${managerLabel(manager)} package`,
      purpose: `Upgrades a single selected package via ${managerLabel(manager)}`,
      pkgManager: manager,
      command: normalizeCommandTemplate(
        parser.getUpgradePackageCommand(SINGLE_PACKAGE_PLACEHOLDER),
      ),
    });

    exact.push({
      id: `upgrade-selected-multiple:${manager}`,
      category: "upgrade_selected",
      label: `Upgrade multiple selected ${managerLabel(manager)} packages`,
      purpose: `Upgrades multiple selected packages via ${managerLabel(manager)}`,
      pkgManager: manager,
      command: normalizeCommandTemplate(
        parser.getUpgradePackagesCommand([
          MULTI_PACKAGE_PLACEHOLDER_ONE,
          MULTI_PACKAGE_PLACEHOLDER_TWO,
        ]),
      ),
    });
  }

  exact.push({
    id: "reboot",
    category: "reboot",
    label: "Reboot system",
    purpose: "Reboots the remote system",
    pkgManager: null,
    command: getRebootCommand(),
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
