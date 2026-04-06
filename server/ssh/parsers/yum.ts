import type { PackageParser } from "./types";
import { sudo, validatePackageName, validatePackageNames } from "./types";
import type { YumPackageManagerConfig } from "../../package-manager-configs";
import { dnfParser, getDnfLikeCheckErrorMessage, getYumCheckCommands } from "./dnf";

function applyYumUpgradeEnv(command: string, config: YumPackageManagerConfig | undefined): string {
  return config?.autoAcceptEulaOnUpgrade === true ? `ACCEPT_EULA=Y ${command}` : command;
}

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

  getUpgradeAllCommand(config) {
    const yumConfig = config as YumPackageManagerConfig | undefined;
    return sudo(applyYumUpgradeEnv("yum update -y", yumConfig)) + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg, config) {
    const safePkg = validatePackageName(pkg);
    const yumConfig = config as YumPackageManagerConfig | undefined;
    return sudo(applyYumUpgradeEnv(`yum update -y ${safePkg}`, yumConfig)) + " 2>&1";
  },

  getUpgradePackagesCommand(pkgs, config) {
    const safePkgs = validatePackageNames(pkgs).join(" ");
    const yumConfig = config as YumPackageManagerConfig | undefined;
    return sudo(applyYumUpgradeEnv(`yum update -y ${safePkgs}`, yumConfig)) + " 2>&1";
  },
};
