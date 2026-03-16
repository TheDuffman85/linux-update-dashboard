import type { PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName } from "./types";

// Example: linux 6.7.4.arch1-1 -> 6.7.5.arch1-1
const PATTERN = /^(\S+)\s+(\S+)\s+->\s+(\S+)/;

function buildListUpdatesCommand() {
  return [
    'errfile="$(mktemp)"',
    'updates="$(pacman -Qu 2>"$errfile")"',
    "rc=$?",
    'printf "%s\\n" "$updates"',
    'cat "$errfile" >&2',
    'if [ "$rc" -eq 1 ] && [ -z "$updates" ] && [ ! -s "$errfile" ]; then rc=0; fi',
    'rm -f "$errfile"',
    'exit "$rc"',
  ].join("; ");
}

export const pacmanParser: PackageParser = {
  name: "pacman",

  getCheckCommands() {
    return [
      sudo("pacman -Sy --noconfirm") + " 2>&1",
      buildListUpdatesCommand(),
    ];
  },

  getCheckCommandLabels() {
    return [
      "Refreshing package databases",
      "Listing available updates",
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
          isKeptBack: false,
          pkgManager: "pacman",
        });
      }
    }
    return updates;
  },

  getUpgradeAllCommand() {
    return sudo("pacman -Syu --noconfirm") + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    const safePkg = validatePackageName(pkg);
    return sudo(`pacman -S --noconfirm ${safePkg}`) + " 2>&1";
  },
};
