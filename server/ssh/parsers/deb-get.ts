import type { PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName, validatePackageNames } from "./types";

export const DEB_GET_UPDATE_MARKER = "LUDASH_DEBGET_UPDATE";
export const DEB_GET_INSTALLED_FILE = "/etc/deb-get/installed";

/**
 * Read-only lookup that runs as root. It is the only deb-get command that the
 * check needs, and the only one allowed with an argument wildcard in sudoers.
 */
export const DEB_GET_SHOW_COMMAND = "deb-get show";

// /etc/deb-get/installed lines are "<app> <definition-version> <method>".
// apt and ppa entries come from APT repositories, so APT reports and upgrades
// them; deb-get owns only the methods it downloads itself.
const DEB_GET_OWNED_APPS_AWK =
  "awk '$1 ~ /^[a-z0-9][a-z0-9._+-]*$/ && $3 !~ /^(apt|ppa)$/ {print $1}'";

export function debGetOwnedAppsCommand(): string {
  return `${DEB_GET_OWNED_APPS_AWK} "${DEB_GET_INSTALLED_FILE}"`;
}

export function debGetCheckScript(): string {
  return [
    "# Check each app that deb-get installed itself (direct, GitHub, GitLab, or website",
    "# downloads). apt and ppa entries stay with APT. `deb-get show` is read-only, but",
    "# deb-get requires root for it; `deb-get update` is avoided because it also runs",
    "# apt-get update and re-validates every known app in the background.",
    `if [ ! -r "${DEB_GET_INSTALLED_FILE}" ]; then`,
    '  echo "No deb-get apps are installed."',
    "  exit 0",
    "fi",
    `apps="$(${debGetOwnedAppsCommand()})"`,
    'checked=0; failed=""; failed_count=0',
    "for app in $apps; do",
    "  checked=$((checked + 1))",
    "  # Sudoers-relevant command: deb-get show <app>",
    `  if ! info="$(${sudo(`${DEB_GET_SHOW_COMMAND} "$app"`)} 2>&1)"; then`,
    "    printf '%s\\n' \"$info\" >&2",
    '    failed="$failed $app"; failed_count=$((failed_count + 1))',
    "    continue",
    "  fi",
    "  fields=\"$(printf '%s\\n' \"$info\" | awk -F '\\t' '$1 ~ /Updater:$/ {u=$2} $1 ~ /Installed:$/ {i=$2} $1 ~ /Published:$/ {p=$2} END {print u \" \" i \" \" p}')\"",
    "  read -r updater current latest <<LUDASH_EOF",
    "$fields",
    "LUDASH_EOF",
    '  [ "$updater" = "deb-get" ] || continue',
    '  if [ -z "$current" ] || [ "$current" = "No" ] || [ -z "$latest" ]; then',
    '    echo "deb-get could not determine the installed and published versions of $app" >&2',
    "    continue",
    "  fi",
    '  if dpkg --compare-versions "$latest" gt "$current"; then',
    `    printf '${DEB_GET_UPDATE_MARKER}\\t%s\\t%s\\t%s\\n' "$app" "$current" "$latest"`,
    "  fi",
    "done",
    'if [ -n "$failed" ]; then',
    '  echo "deb-get show failed for:$failed" >&2',
    "  # Fail only when nothing could be checked, so one broken definition does not hide other updates.",
    '  [ "$checked" -gt "$failed_count" ] || exit 1',
    "fi",
  ].join("\n");
}

export function debGetInstalledPackagesCommand(): string {
  return [
    `[ -r "${DEB_GET_INSTALLED_FILE}" ] || exit 0`,
    `${debGetOwnedAppsCommand()} | while read -r app; do`,
    "  dpkg-query -W -f='${Package}\\t${Version}\\t${Architecture}\\n' \"$app\" 2>/dev/null",
    "done",
    "true",
  ].join("\n");
}

export const debGetParser: PackageParser = {
  name: "deb-get",

  getCheckCommands() {
    return [debGetCheckScript()];
  },

  getCheckCommandLabels() {
    return ["Checking for updates"];
  },

  parseCheckOutput(stdout) {
    const updates: ParsedUpdate[] = [];
    for (const raw of stdout.split("\n")) {
      const [marker, packageName, currentVersion, newVersion] = raw.trim().split("\t");
      if (marker !== DEB_GET_UPDATE_MARKER || !packageName || !newVersion) continue;
      updates.push({
        packageName,
        currentVersion: currentVersion || null,
        newVersion,
        architecture: null,
        repository: "deb-get",
        isSecurity: false,
        isKeptBack: false,
        pkgManager: "deb-get",
      });
    }
    return updates;
  },

  getUpgradeAllCommand() {
    return sudo("deb-get upgrade --dg-only") + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    return sudo(`deb-get install ${validatePackageName(pkg)}`) + " 2>&1";
  },

  getUpgradePackagesCommand(pkgs) {
    return sudo(`deb-get install ${validatePackageNames(pkgs).join(" ")}`) + " 2>&1";
  },
};
