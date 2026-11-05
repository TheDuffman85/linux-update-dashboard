import type { PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName, validatePackageNames } from "./types";
import { anyCheckProbeFailed, checkProbeFailed, optionalCheckProbe } from "./check-probes";

const INSTALLED_MARKER = "===INSTALLED===";
const UPDATES_MARKER = "===UPDATES===";
const LIST_STATUS_MARKER = "LUDASH_SNAP_LIST_STATUS";

// `snap refresh --list` writes "All snaps up to date." to stderr, which would be
// displayed as an error. Stdout streams through fd 3; stderr is only shown on failure.
export const SNAP_CHECK_COMMAND = [
  `echo "${INSTALLED_MARKER}"`,
  optionalCheckProbe("snap list --color=never", LIST_STATUS_MARKER),
  `echo "${UPDATES_MARKER}"`,
  "ludash_refresh_status=0",
  '{ ludash_refresh_stderr="$(snap refresh --list 2>&1 >&3)" || ludash_refresh_status=$?; } 3>&1',
  'if [ "$ludash_refresh_status" -ne 0 ]; then printf "%s\\n" "$ludash_refresh_stderr" >&2; exit "$ludash_refresh_status"; fi',
].join("\n");

export const snapParser: PackageParser = {
  name: "snap",

  getCheckCommands() {
    return [SNAP_CHECK_COMMAND];
  },

  getCheckCommandLabels() {
    return ["Checking for updates"];
  },

  getCheckWarningMessage({ stdout }) {
    return checkProbeFailed(stdout, LIST_STATUS_MARKER)
      ? "Could not list installed snaps. Installed versions and refresh holds could not be determined. Holds found by earlier checks are kept, but newly held snaps may appear as available updates. See the step output for details."
      : null;
  },

  isPinDetectionIncomplete(commandResults) {
    return anyCheckProbeFailed(commandResults, LIST_STATUS_MARKER);
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const installedIdx = stdout.indexOf(INSTALLED_MARKER);
    const updatesIdx = stdout.indexOf(UPDATES_MARKER);

    // Build a map of installed snap name → version
    const installedVersions = new Map<string, string>();
    // `snap refresh --list` still lists held snaps; `snap list` marks them in Notes.
    const heldSnaps = new Set<string>();
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
          if (parts[parts.length - 1].split(",").includes("held")) {
            heldSnaps.add(parts[0]);
          }
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
          isKeptBack: heldSnaps.has(name),
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
    const safePkg = validatePackageName(pkg);
    return sudo(`snap refresh ${safePkg}`) + " 2>&1";
  },

  getUpgradePackagesCommand(pkgs) {
    const safePkgs = validatePackageNames(pkgs).join(" ");
    return sudo(`snap refresh ${safePkgs}`) + " 2>&1";
  },
};
