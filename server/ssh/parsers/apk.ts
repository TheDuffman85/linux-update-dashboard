import type { PackageParser, ParsedUpdate } from "./types";
import { findCommandResult, sudo, validatePackageName, validatePackageNames } from "./types";
import type { ApkPackageManagerConfig } from "../../package-manager-configs";

const PATTERN =
  /^(\S+)\s+(\S+)\s+\{([^}]+)\}(?:\s+\([^)]*\))?\s+\[upgradable from:\s+(\S+)\]$/;
// apk 2 prints "(1/5) Upgrading musl (1.2.5-r1 -> 1.2.5-r4)", apk 3 pads the counter as "( 1/65)",
// and a tagged world entry prints the tag: "Upgrading zlib@edge (...)".
const SIMULATION_UPGRADE_PATTERN = /^\(\s*\d+\/\d+\)\s+Upgrading\s+([^\s@]+)(?:@\S+)?\s+\(\S+\s+->\s+(\S+)\)/;
const SIMULATION_SUCCESS_PATTERN = /^OK:/m;

/**
 * `apk list -u` ignores /etc/apk/world, so it also lists versions that
 * `apk upgrade` will not install. The simulation honors pins, including packages
 * held back only because a pin blocks one of their dependencies. It needs no
 * root. A contradictory world makes it fail, which must not fail the whole check
 * when `apk list -u` still works, so failure is detected from the missing OK line.
 */
export const APK_SIMULATE_UPGRADE_COMMAND = "apk upgrade --simulate 2>&1 || true";

function splitApkNameVersion(value: string): { name: string; version: string } | null {
  for (let i = value.length - 2; i >= 0; i--) {
    if (value[i] === "-" && value[i + 1] >= "0" && value[i + 1] <= "9") {
      return {
        name: value.slice(0, i),
        version: value.slice(i + 1),
      };
    }
  }
  return null;
}

export const apkParser: PackageParser = {
  name: "apk",

  getCheckCommands(config) {
    const apkConfig = config as ApkPackageManagerConfig | undefined;
    const commands: string[] = [];
    if (apkConfig?.refreshIndexesOnCheck !== false) {
      commands.push(sudo("apk update") + " 2>&1");
    }
    commands.push("apk list -u 2>/dev/null");
    commands.push(APK_SIMULATE_UPGRADE_COMMAND);
    return commands;
  },

  getCheckCommandLabels(config) {
    const apkConfig = config as ApkPackageManagerConfig | undefined;
    if (apkConfig?.refreshIndexesOnCheck === false) {
      return ["Listing available updates", "Detecting kept-back packages"];
    }
    return ["Refreshing package indexes", "Listing available updates", "Detecting kept-back packages"];
  },

  parseCheckOutput(stdout, _stderr, _exitCode, context) {
    const listStdout = findCommandResult(context?.commandResults, "apk list -u")?.stdout ?? stdout;
    const simulationStdout = findCommandResult(context?.commandResults, "apk upgrade --simulate")?.stdout;
    const updates: ParsedUpdate[] = [];

    for (const raw of listStdout.trim().split("\n")) {
      const line = raw.trim();
      if (!line) continue;

      const match = PATTERN.exec(line);
      if (!match) continue;

      const next = splitApkNameVersion(match[1]);
      const current = splitApkNameVersion(match[4]);
      if (!next || !current || next.name !== current.name) continue;

      updates.push({
        packageName: next.name,
        currentVersion: current.version,
        newVersion: next.version,
        architecture: match[2],
        repository: match[3],
        isSecurity: false,
        isKeptBack: false,
        pkgManager: "apk",
      });
    }

    if (!simulationStdout || !SIMULATION_SUCCESS_PATTERN.test(simulationStdout)) {
      return updates;
    }
    const targetVersions = new Map<string, string>();
    for (const raw of simulationStdout.split("\n")) {
      const match = SIMULATION_UPGRADE_PATTERN.exec(raw.trim());
      if (match) targetVersions.set(match[1], match[2]);
    }
    // The simulation decides what a package's update is. With several repositories
    // the listing can show several versions of one package, and a constraint or tag
    // can select a version it does not show. The update cache holds one row per
    // package, so return one: the version to install, or else the newest listed.
    const resolved = new Map<string, ParsedUpdate>();
    for (const update of updates) {
      const target = targetVersions.get(update.packageName);
      resolved.set(update.packageName, {
        ...update,
        newVersion: target ?? update.newVersion,
        isKeptBack: target === undefined,
      });
    }

    return Array.from(resolved.values());
  },

  getUpgradeAllCommand() {
    return sudo("apk upgrade") + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    const safePkg = validatePackageName(pkg);
    return sudo(`apk upgrade ${safePkg}`) + " 2>&1";
  },

  getUpgradePackagesCommand(pkgs) {
    const safePkgs = validatePackageNames(pkgs).join(" ");
    return sudo(`apk upgrade ${safePkgs}`) + " 2>&1";
  },
};
