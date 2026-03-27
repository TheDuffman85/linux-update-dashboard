import type { PackageParser } from "./types";
import { sudo, validatePackageName, validatePackageNames } from "./types";
import type { YumPackageManagerConfig } from "../../package-manager-configs";
import { dnfParser, getDnfLikeCheckErrorMessage, getYumCheckCommands } from "./dnf";

export const yumParser: PackageParser = {
  name: "yum",

  getCheckCommands(config) {
    return getYumCheckCommands(config as YumPackageManagerConfig | undefined);
  },

  getCheckCommandLabels() {
    return ["Checking for updates"];
  },

  getCheckErrorMessage(stdout, stderr, exitCode) {
    return getDnfLikeCheckErrorMessage("yum", stdout, stderr, exitCode);
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
    const safePkg = validatePackageName(pkg);
    return sudo(`yum update -y ${safePkg}`) + " 2>&1";
  },

  getUpgradePackagesCommand(pkgs) {
    const safePkgs = validatePackageNames(pkgs).join(" ");
    return sudo(`yum update -y ${safePkgs}`) + " 2>&1";
  },
};
