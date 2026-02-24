import type { PackageParser, ParsedUpdate } from "./types";
import { sudo } from "./types";

const INSTALLED_MARKER = "===INSTALLED===";
const UPDATES_MARKER = "===UPDATES===";

export const flatpakParser: PackageParser = {
  name: "flatpak",

  getCheckCommands() {
    return [
      sudo("flatpak update --appstream") + " 2>/dev/null; true",
      `echo "${INSTALLED_MARKER}"; flatpak list --columns=application,version 2>/dev/null; echo "${UPDATES_MARKER}"; flatpak remote-ls --updates --columns=name,application,version,branch,origin 2>/dev/null`,
    ];
  },

  getCheckCommandLabels() {
    return ["Refreshing appstream data…", "Checking for updates…"];
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const installedIdx = stdout.indexOf(INSTALLED_MARKER);
    const updatesIdx = stdout.indexOf(UPDATES_MARKER);

    // Build a map of installed flatpak app ID → version
    const installedVersions = new Map<string, string>();
    if (installedIdx !== -1 && updatesIdx !== -1) {
      const installedSection = stdout
        .slice(installedIdx + INSTALLED_MARKER.length, updatesIdx)
        .trim();
      for (const raw of installedSection.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        const parts = line.split("\t");
        const appId = parts[0]?.trim();
        const version = parts[1]?.trim();
        if (appId && version) {
          installedVersions.set(appId, version);
        }
      }
    }

    // Parse the updates section
    const updatesSection =
      updatesIdx !== -1
        ? stdout.slice(updatesIdx + UPDATES_MARKER.length).trim()
        : stdout.trim();

    const updates: ParsedUpdate[] = [];
    for (const raw of updatesSection.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split("\t");
      if (parts.length >= 3) {
        const name = parts[0].trim();
        const appId = parts[1]?.trim() || name;
        const remoteVersion = parts[2]?.trim() || "";
        const origin = parts[4]?.trim() || "";
        const pkgId = appId || name;
        updates.push({
          packageName: pkgId,
          currentVersion: installedVersions.get(pkgId) ?? null,
          newVersion: remoteVersion || null,
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
    return sudo("flatpak update -y") + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    return sudo(`flatpak update -y ${pkg}`) + " 2>&1";
  },
};
