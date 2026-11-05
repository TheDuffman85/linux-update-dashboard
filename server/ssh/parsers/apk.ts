import type { CheckCommandResult, PackageParser, ParsedUpdate } from "./types";
import { findCommandResult, sudo, validatePackageName, validatePackageNames } from "./types";
import type { ApkPackageManagerConfig } from "../../package-manager-configs";

const PATTERN =
  /^(\S+)\s+(\S+)\s+\{([^}]+)\}(?:\s+\([^)]*\))?\s+\[upgradable from:\s+(\S+)\]$/;
// apk 2 prints "(1/5) Upgrading musl (1.2.5-r1 -> 1.2.5-r4)", apk 3 pads the counter as "( 1/65)",
// and a tagged world entry prints the tag: "Upgrading zlib@edge (...)".
const SIMULATION_UPGRADE_PATTERN = /^\(\s*\d+\/\d+\)\s+Upgrading\s+([^\s@]+)(?:@\S+)?\s+\(\S+\s+->\s+(\S+)\)/;
const SIMULATION_SUCCESS_PATTERN = /^OK:/m;
const WORLD_STATUS_PATTERN = /^===LUDASH_APK_WORLD_STATUS:(\d+)===\s*$/m;
const SIMULATION_STATUS_PATTERN = /^===LUDASH_APK_SIMULATION_STATUS:(\d+)===\s*$/m;

// Preserve each optional probe's real status without aborting a usable listing.
export const APK_READ_WORLD_COMMAND = [
  "cat /etc/apk/world 2>&1",
  "ludash_apk_world_status=$?",
  'printf "\\n===LUDASH_APK_WORLD_STATUS:%s===\\n" "$ludash_apk_world_status"',
].join("\n");

/**
 * `apk list -u` ignores /etc/apk/world, so it also lists versions that
 * `apk upgrade` will not install. The simulation honors pins, including packages
 * held back only because a pin blocks one of their dependencies. It needs no
 * root. A contradictory world or unavailable repository can make it fail. Keep
 * exact installed-version pins in that case and warn about incomplete detection.
 */
export const APK_SIMULATE_UPGRADE_COMMAND = [
  "apk upgrade --simulate 2>&1",
  "ludash_apk_simulation_status=$?",
  'printf "\\n===LUDASH_APK_SIMULATION_STATUS:%s===\\n" "$ludash_apk_simulation_status"',
].join("\n");

function probeExitCode(result: CheckCommandResult, pattern: RegExp): number {
  const match = pattern.exec(result.stdout);
  return result.exitCode || (match ? Number(match[1]) : 0);
}

function simulationSucceeded(result: CheckCommandResult): boolean {
  return probeExitCode(result, SIMULATION_STATUS_PATTERN) === 0
    && SIMULATION_SUCCESS_PATTERN.test(result.stdout);
}

function parseExactPins(result: CheckCommandResult | undefined): Map<string, string> {
  const pins = new Map<string, string>();
  if (!result || probeExitCode(result, WORLD_STATUS_PATTERN) !== 0) return pins;
  for (const line of result.stdout.split("\n")) {
    // Only exact equality, including repository tags. Do not treat >=, <=, ~,
    // or =~ constraints as frozen versions; those can still permit upgrades.
    const match = /^([a-zA-Z0-9][a-zA-Z0-9+_.-]*)(?:@[a-zA-Z0-9][a-zA-Z0-9_.-]*)?=([0-9][a-zA-Z0-9._+~:-]*)$/.exec(line.trim());
    if (match) pins.set(match[1], match[2]);
  }
  return pins;
}

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
    commands.push(APK_READ_WORLD_COMMAND);
    commands.push(APK_SIMULATE_UPGRADE_COMMAND);
    return commands;
  },

  getCheckCommandLabels(config) {
    const apkConfig = config as ApkPackageManagerConfig | undefined;
    if (apkConfig?.refreshIndexesOnCheck === false) {
      return ["Listing available updates", "Reading pinned versions", "Detecting kept-back packages"];
    }
    return ["Refreshing package indexes", "Listing available updates", "Reading pinned versions", "Detecting kept-back packages"];
  },

  getCheckWarningMessage(result, context) {
    if (result.command.includes("cat /etc/apk/world") && probeExitCode(result, WORLD_STATUS_PATTERN) !== 0) {
      return "Could not read /etc/apk/world. Exact-version pins cannot be detected independently of the upgrade simulation. See the step output for details.";
    }
    if (result.command.includes("apk upgrade --simulate") && !simulationSucceeded(result)) {
      const code = probeExitCode(result, SIMULATION_STATUS_PATTERN);
      const reason = code ? `failed (exit code ${code})` : "did not report a successful result";
      const world = findCommandResult([...(context?.commandResults ?? []), result], "cat /etc/apk/world");
      const detection = world && probeExitCode(world, WORLD_STATUS_PATTERN) === 0
        ? "Only exact pins matching installed versions can be detected from /etc/apk/world; dependency-based holds could not be determined."
        : "/etc/apk/world was not read, so neither exact pins nor dependency-based holds could be determined.";
      return `APK upgrade simulation ${reason}. ${detection} Pins found by earlier checks are kept until detection succeeds. See the step output for details.`;
    }
    return null;
  },

  // A successful simulation covers every kind of pin, so an unreadable world loses
  // nothing next to one. A custom script without a simulation step relies on the world
  // read alone, and a script with neither step has no detection that could have failed.
  isPinDetectionIncomplete(commandResults) {
    const simulation = findCommandResult(commandResults, "apk upgrade --simulate");
    if (simulation) return !simulationSucceeded(simulation);
    const world = findCommandResult(commandResults, "cat /etc/apk/world");
    return !!world && probeExitCode(world, WORLD_STATUS_PATTERN) !== 0;
  },

  parseCheckOutput(stdout, _stderr, _exitCode, context) {
    const listStdout = findCommandResult(context?.commandResults, "apk list -u")?.stdout ?? stdout;
    const simulation = findCommandResult(context?.commandResults, "apk upgrade --simulate");
    const pins = parseExactPins(findCommandResult(context?.commandResults, "cat /etc/apk/world"));
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
        isKeptBack: pins.get(next.name) === current.version,
        pkgManager: "apk",
      });
    }

    if (!simulation || !simulationSucceeded(simulation)) {
      return updates;
    }
    const targetVersions = new Map<string, string>();
    for (const raw of simulation.stdout.split("\n")) {
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
        newVersion: update.isKeptBack ? update.newVersion : target ?? update.newVersion,
        isKeptBack: update.isKeptBack || target === undefined,
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
