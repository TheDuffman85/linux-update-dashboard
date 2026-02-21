import type { PackageParser, ParsedUpdate } from "./types";

export const flatpakParser: PackageParser = {
  name: "flatpak",

  getCheckCommands() {
    return [
      "flatpak remote-ls --updates --columns=name,application,version,branch,origin 2>/dev/null",
    ];
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const updates: ParsedUpdate[] = [];
    for (const raw of stdout.trim().split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const name = parts[0].trim();
        const appId = parts[1]?.trim() || name;
        const version = parts[2]?.trim() || "";
        const origin = parts[4]?.trim() || "";
        updates.push({
          packageName: appId || name,
          currentVersion: null,
          newVersion: version || "available",
          architecture: null,
          repository: origin,
          isSecurity: false,
          pkgManager: "flatpak",
        });
      }
    }
    return updates;
  },

  getUpgradeAllCommand() {
    return "flatpak update -y 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    return `flatpak update -y ${pkg} 2>&1`;
  },
};
