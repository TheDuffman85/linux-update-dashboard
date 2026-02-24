export interface ParsedUpdate {
  packageName: string;
  currentVersion: string | null;
  newVersion: string | null;
  architecture: string | null;
  repository: string | null;
  isSecurity: boolean;
  pkgManager: string;
}

export interface PackageParser {
  name: string;
  parseCheckOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): ParsedUpdate[];
  getCheckCommands(): string[];
  /** Human-readable label for each check command step, shown in live output. */
  getCheckCommandLabels?(): string[];
  getUpgradeAllCommand(): string;
  getFullUpgradeAllCommand(): string | null;
  getUpgradePackageCommand(pkg: string): string;
}

/**
 * Validate a package name to prevent shell injection.
 * Allows alphanumeric, dots, hyphens, underscores, plus, colon, tilde.
 * Throws if the name contains shell metacharacters or is empty.
 */
const VALID_PKG_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+:~-]*$/;

export function validatePackageName(pkg: string): string {
  if (!pkg || !VALID_PKG_NAME.test(pkg)) {
    throw new Error(`Invalid package name: ${pkg.slice(0, 80)}`);
  }
  return pkg;
}

/**
 * Wrap a command to use sudo if available, otherwise run directly.
 * Handles: root user, sudo available, no root/no sudo.
 */
export function sudo(cmd: string): string {
  return `if [ "$(id -u)" = "0" ]; then ${cmd}; elif command -v sudo >/dev/null 2>&1; then sudo -S ${cmd}; else ${cmd}; fi`;
}
