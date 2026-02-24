import type { PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName } from "./types";

// Example: curl/jammy-updates 7.81.0-1ubuntu1.18 amd64 [upgradable from: 7.81.0-1ubuntu1.16]
const PATTERN =
  /^(\S+?)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from:\s+(\S+)\]/;

const LOCK_WAIT = "-o DPkg::Lock::Timeout=60";

export const aptParser: PackageParser = {
  name: "apt",

  getCheckCommands() {
    return [
      sudo(`apt-get ${LOCK_WAIT} update -qq`) + " 2>&1",
      "DEBIAN_FRONTEND=noninteractive apt list --upgradable 2>/dev/null | tail -n +2",
    ];
  },

  getCheckCommandLabels() {
    return [
      "Fetching package lists…",
      "Listing available updates…",
    ];
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const updates: ParsedUpdate[] = [];
    for (const raw of stdout.trim().split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const m = PATTERN.exec(line);
      if (m) {
        updates.push({
          packageName: m[1],
          currentVersion: m[5],
          newVersion: m[3],
          architecture: m[4],
          repository: m[2],
          isSecurity: m[2].toLowerCase().includes("security"),
          pkgManager: "apt",
        });
      }
    }
    return updates;
  },

  getUpgradeAllCommand() {
    return (
      "export DEBIAN_FRONTEND=noninteractive; " +
      sudo(`apt-get ${LOCK_WAIT} upgrade -y`) +
      " 2>&1"
    );
  },

  getFullUpgradeAllCommand() {
    return (
      "export DEBIAN_FRONTEND=noninteractive; " +
      sudo(`apt-get ${LOCK_WAIT} full-upgrade -y`) +
      " 2>&1"
    );
  },

  getUpgradePackageCommand(pkg) {
    const safePkg = validatePackageName(pkg);
    return (
      "export DEBIAN_FRONTEND=noninteractive; " +
      sudo(`apt-get ${LOCK_WAIT} install --only-upgrade -y ${safePkg}`) +
      " 2>&1"
    );
  },
};
