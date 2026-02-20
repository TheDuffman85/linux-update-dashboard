import type { PackageParser, ParsedUpdate } from "./types";
import { sudo } from "./types";

// Example: curl.x86_64    7.76.1-26.el9_3.3    baseos
const PATTERN = /^(\S+?)\.(\S+)\s+(\S+)\s+(\S+)/;

export const dnfParser: PackageParser = {
  name: "dnf",

  getCheckCommands() {
    return ['dnf check-update --quiet 2>/dev/null; echo "EXIT:$?"'];
  },

  parseCheckOutput(stdout, _stderr, exitCode) {
    const updates: ParsedUpdate[] = [];
    const lines = stdout.trim().split("\n");

    // dnf check-update returns exit code 100 when updates are available.
    // We append "EXIT:$?" so we can detect this even if the exit code is lost.
    let actualExit = exitCode;
    if (lines.length > 0 && lines[lines.length - 1].startsWith("EXIT:")) {
      const code = parseInt(lines[lines.length - 1].split(":")[1], 10);
      if (!isNaN(code)) actualExit = code;
      lines.pop();
    }

    // Exit code 0 = no updates, 100 = updates available, other = error
    if (actualExit !== 0 && actualExit !== 100) return [];

    for (const raw of lines) {
      const line = raw.trim();
      if (
        !line ||
        line.startsWith("Last metadata") ||
        line.startsWith("Obsoleting")
      )
        continue;
      const m = PATTERN.exec(line);
      if (m) {
        updates.push({
          packageName: m[1],
          currentVersion: null,
          newVersion: m[3],
          architecture: m[2],
          repository: m[4],
          isSecurity: false,
          pkgManager: "dnf",
        });
      }
    }
    return updates;
  },

  getUpgradeAllCommand() {
    return sudo("dnf upgrade -y") + " 2>&1";
  },

  getUpgradePackageCommand(pkg) {
    return sudo(`dnf upgrade -y ${pkg}`) + " 2>&1";
  },
};
