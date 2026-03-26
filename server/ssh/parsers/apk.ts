import type { PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName, validatePackageNames } from "./types";
import type { ApkPackageManagerConfig } from "../../package-manager-configs";

const PATTERN =
  /^(\S+)\s+(\S+)\s+\{([^}]+)\}(?:\s+\([^)]*\))?\s+\[upgradable from:\s+(\S+)\]$/;

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
    return commands;
  },

  getCheckCommandLabels(config) {
    const apkConfig = config as ApkPackageManagerConfig | undefined;
    if (apkConfig?.refreshIndexesOnCheck === false) {
      return ["Listing available updates"];
    }
    return ["Refreshing package indexes", "Listing available updates"];
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const updates: ParsedUpdate[] = [];

    for (const raw of stdout.trim().split("\n")) {
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

    return updates;
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
