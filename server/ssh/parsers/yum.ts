import type { PackageParser } from "./types";
import { sudo } from "./types";
import { buildCheckCommand, dnfParser } from "./dnf";

export const yumParser: PackageParser = {
  name: "yum",

  getCheckCommands() {
    return [buildCheckCommand("yum")];
  },

  // Same output format as DNF
  parseCheckOutput(stdout, stderr, exitCode) {
    const updates = dnfParser.parseCheckOutput(stdout, stderr, exitCode);
    return updates.map((u) => ({ ...u, pkgManager: "yum" }));
  },

  getUpgradeAllCommand() {
    return sudo("yum update -y") + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    return sudo(`yum update -y ${pkg}`) + " 2>&1";
  },
};
