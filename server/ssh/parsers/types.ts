export interface ParsedUpdate {
  packageName: string;
  currentVersion: string | null;
  newVersion: string;
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
  getUpgradeAllCommand(): string;
  getUpgradePackageCommand(pkg: string): string;
}

/**
 * Wrap a command to use sudo if available, otherwise run directly.
 * Handles: root user, sudo available, no root/no sudo.
 */
export function sudo(cmd: string): string {
  return `if [ "$(id -u)" = "0" ]; then ${cmd}; elif command -v sudo >/dev/null 2>&1; then sudo ${cmd}; else ${cmd}; fi`;
}
