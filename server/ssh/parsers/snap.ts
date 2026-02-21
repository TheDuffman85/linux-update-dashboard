import type { PackageParser, ParsedUpdate } from "./types";
import { sudo } from "./types";

export const snapParser: PackageParser = {
  name: "snap",

  getCheckCommands() {
    return ["snap refresh --list 2>/dev/null"];
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const updates: ParsedUpdate[] = [];
    const lines = stdout.trim().split("\n");
    if (!lines.length) return [];

    // First line is the header: Name  Version  Rev  Publisher  Notes — skip it
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line || line.startsWith("All snaps")) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        updates.push({
          packageName: parts[0],
          currentVersion: null,
          newVersion: parts[1] || "available",
          architecture: null,
          repository: "snap",
          isSecurity: false,
          pkgManager: "snap",
        });
      }
    }
    return updates;
  },

  getUpgradeAllCommand() {
    return sudo("snap refresh") + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    return sudo(`snap refresh ${pkg}`) + " 2>&1";
  },
};
