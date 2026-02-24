import type { PackageParser, ParsedUpdate } from "./types";
import { sudo } from "./types";

const INSTALLED_MARKER = "===INSTALLED===";
const UPDATES_MARKER = "===UPDATES===";

export const snapParser: PackageParser = {
  name: "snap",

  getCheckCommands() {
    return [
      `echo "${INSTALLED_MARKER}"; snap list --color=never 2>/dev/null; echo "${UPDATES_MARKER}"; snap refresh --list 2>/dev/null`,
    ];
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const installedIdx = stdout.indexOf(INSTALLED_MARKER);
    const updatesIdx = stdout.indexOf(UPDATES_MARKER);

    // Build a map of installed snap name → version
    const installedVersions = new Map<string, string>();
    if (installedIdx !== -1 && updatesIdx !== -1) {
      const installedSection = stdout
        .slice(installedIdx + INSTALLED_MARKER.length, updatesIdx)
        .trim();
      for (const raw of installedSection.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split(/\s+/);
        // Skip header line (starts with "Name")
        if (parts[0] === "Name") continue;
        if (parts.length >= 2) {
          installedVersions.set(parts[0], parts[1]);
        }
      }
    }

    // Parse the updates section
    const updatesSection =
      updatesIdx !== -1
        ? stdout.slice(updatesIdx + UPDATES_MARKER.length).trim()
        : stdout.trim();

    const updates: ParsedUpdate[] = [];
    const lines = updatesSection.split("\n");
    if (!lines.length) return [];

    // First line is the header: Name  Version  Rev  Publisher  Notes — skip it
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (!line || line.startsWith("All snaps")) continue;
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const name = parts[0];
        updates.push({
          packageName: name,
          currentVersion: installedVersions.get(name) ?? null,
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
