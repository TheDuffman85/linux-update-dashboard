import type { CheckCommandResult, PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName } from "./types";
import type { AptPackageManagerConfig } from "../../package-manager-configs";

// Example: curl/jammy-updates 7.81.0-1ubuntu1.18 amd64 [upgradable from: 7.81.0-1ubuntu1.16]
const PATTERN =
  /^(\S+?)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s+(\S+)\]/;
const SIMULATION_PATTERN = /^Inst\s+(\S+)\s+/;

function parseListOutput(stdout: string): ParsedUpdate[] {
  const updates: ParsedUpdate[] = [];
  for (const raw of stdout.trim().split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = PATTERN.exec(line);
    if (!m) continue;
    updates.push({
      packageName: m[1],
      currentVersion: m[5],
      newVersion: m[3],
      architecture: m[4],
      repository: m[2],
      isSecurity: m[2].toLowerCase().includes("security"),
      isKeptBack: false,
      pkgManager: "apt",
    });
  }
  return updates;
}

function parseSimulationPackages(stdout: string): Set<string> {
  const packages = new Set<string>();
  for (const raw of stdout.trim().split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const match = SIMULATION_PATTERN.exec(line);
    if (match) {
      packages.add(match[1]);
    }
  }
  return packages;
}

function findCommandResult(
  commandResults: CheckCommandResult[] | undefined,
  pattern: string,
): CheckCommandResult | undefined {
  return commandResults?.find((result) => result.command.includes(pattern));
}

export const APT_LOCK_WAIT = "-o DPkg::Lock::Timeout=60";

export const aptParser: PackageParser = {
  name: "apt",

  getCheckCommands() {
    return [
      sudo(`apt-get ${APT_LOCK_WAIT} update -qq`) + " 2>&1",
      "DEBIAN_FRONTEND=noninteractive apt list --upgradable 2>/dev/null | tail -n +2",
      "DEBIAN_FRONTEND=noninteractive apt-get -s -o Debug::NoLocking=1 upgrade 2>&1",
    ];
  },

  getCheckCommandLabels() {
    return [
      "Fetching package lists",
      "Listing available updates",
      "Detecting kept-back packages",
    ];
  },

  parseCheckOutput(stdout, _stderr, _exitCode, context) {
    const listStdout = findCommandResult(
      context?.commandResults,
      "apt list --upgradable",
    )?.stdout ?? stdout;
    const updates = parseListOutput(listStdout);
    const simulationStdout = findCommandResult(
      context?.commandResults,
      "apt-get -s -o Debug::NoLocking=1 upgrade",
    )?.stdout;
    if (!simulationStdout) {
      return updates;
    }

    const simulationPackages = parseSimulationPackages(simulationStdout);
    for (const update of updates) {
      if (!simulationPackages.has(update.packageName)) {
        update.isKeptBack = true;
      }
    }
    return updates;
  },

  getUpgradeAllCommand(config) {
    const aptConfig = config as AptPackageManagerConfig | undefined;
    const upgradeMode = aptConfig?.defaultUpgradeMode === "full-upgrade" ? "full-upgrade" : "upgrade";
    return (
      "export DEBIAN_FRONTEND=noninteractive; " +
      sudo(`apt-get ${APT_LOCK_WAIT} ${upgradeMode} -y`) +
      " 2>&1"
    );
  },

  getFullUpgradeAllCommand() {
    return (
      "export DEBIAN_FRONTEND=noninteractive; " +
      sudo(`apt-get ${APT_LOCK_WAIT} full-upgrade -y`) +
      " 2>&1"
    );
  },

  getUpgradePackageCommand(pkg) {
    const safePkg = validatePackageName(pkg);
    return (
      "export DEBIAN_FRONTEND=noninteractive; " +
      sudo(`apt-get ${APT_LOCK_WAIT} install --only-upgrade -y ${safePkg}`) +
      " 2>&1"
    );
  },
};
