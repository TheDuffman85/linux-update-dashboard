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
 * Wrap a command to use sudo if available, otherwise run directly.
 * Handles: root user, sudo available, no root/no sudo.
 */
export function sudo(cmd: string): string {
  return `if [ "$(id -u)" = "0" ]; then ${cmd}; elif command -v sudo >/dev/null 2>&1; then sudo -S ${cmd}; else ${cmd}; fi`;
}
