import type { PackageParser, ParsedUpdate } from "./types";
import { sudo } from "./types";

// Example: linux 6.7.4.arch1-1 -> 6.7.5.arch1-1
const PATTERN = /^(\S+)\s+(\S+)\s+->\s+(\S+)/;

export const pacmanParser: PackageParser = {
  name: "pacman",

  getCheckCommands() {
    return [
      sudo("pacman -Sy --noconfirm") + " 2>&1",
      "pacman -Qu 2>/dev/null",
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
          currentVersion: m[2],
          newVersion: m[3],
          architecture: null,
          repository: null,
          isSecurity: false,
          pkgManager: "pacman",
        });
      }
    }
    return updates;
  },

  getUpgradeAllCommand() {
    return sudo("pacman -Syu --noconfirm") + " 2>&1";
  },

  getUpgradePackageCommand(pkg) {
    return sudo(`pacman -S --noconfirm ${pkg}`) + " 2>&1";
  },
};
