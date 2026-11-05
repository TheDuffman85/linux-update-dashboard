import type { PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName, validatePackageNames } from "./types";
import type { FlatpakPackageManagerConfig } from "../../package-manager-configs";
import { anyCheckProbeFailed, checkProbeFailed, optionalCheckProbe } from "./check-probes";

const INSTALLED_MARKER = "===INSTALLED===";
const MASKED_MARKER = "===MASKED===";
const UPDATES_MARKER = "===UPDATES===";
const LIST_STATUS_MARKER = "LUDASH_FLATPAK_LIST_STATUS";
const MASK_STATUS_MARKER = "LUDASH_FLATPAK_MASK_STATUS";

/**
 * `flatpak remote-ls --updates` ignores masks, while `flatpak update` skips
 * masked refs. Masks are read from the system installation, which is the one
 * the dashboard upgrades through sudo. `flatpak mask --user` is avoided because
 * it creates a per-user repository as a side effect.
 */
export const FLATPAK_CHECK_COMMAND = [
  `echo "${INSTALLED_MARKER}"`,
  optionalCheckProbe("flatpak list --columns=application,version", LIST_STATUS_MARKER),
  `echo "${MASKED_MARKER}"`,
  optionalCheckProbe("flatpak mask", MASK_STATUS_MARKER),
  `echo "${UPDATES_MARKER}"`,
  "flatpak remote-ls --updates --columns=name,application,version,branch,origin,ref",
].join("\n");

const REF_SEGMENT_CHARS = "[.\\-_a-zA-Z0-9]*";

/**
 * Compiles a mask to match full refs the way Flatpak does. A pattern is
 * [app/|runtime/]ID[/ARCH[/BRANCH]], where * stays within one segment and an
 * empty or missing segment matches anything.
 */
function maskToRefRegExp(pattern: string): RegExp | null {
  let kind = "(app|runtime)";
  let rest = pattern;
  for (const prefix of ["app", "runtime"]) {
    if (rest.startsWith(`${prefix}/`)) {
      kind = prefix;
      rest = rest.slice(prefix.length + 1);
    }
  }
  const segments = rest.split("/");
  if (segments.length > 3) return null;
  while (segments.length < 3) segments.push("");
  const source = segments
    .map((segment) =>
      segment
        ? segment
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\/-]/g, "\\$&"))
            .join(REF_SEGMENT_CHARS)
        : REF_SEGMENT_CHARS,
    )
    .join("/");
  return new RegExp(`^${kind}/${source}$`);
}

function parseMaskPatterns(section: string): RegExp[] {
  const masks: RegExp[] = [];
  for (const raw of section.split("\n")) {
    const pattern = raw.trim();
    // Anything with spaces is a message, not a pattern.
    if (!pattern || pattern.startsWith(`${MASK_STATUS_MARKER}:`) || /\s/.test(pattern)) continue;
    const mask = maskToRefRegExp(pattern);
    if (mask) masks.push(mask);
  }
  return masks;
}

export const flatpakParser: PackageParser = {
  name: "flatpak",

  getCheckCommands(config) {
    const flatpakConfig = config as FlatpakPackageManagerConfig | undefined;
    const commands: string[] = [];
    if (flatpakConfig?.refreshAppstreamOnCheck !== false) {
      commands.push(sudo("flatpak update --appstream") + " 2>/dev/null; true");
    }
    commands.push(FLATPAK_CHECK_COMMAND);
    return commands;
  },

  getCheckCommandLabels(config) {
    const flatpakConfig = config as FlatpakPackageManagerConfig | undefined;
    if (flatpakConfig?.refreshAppstreamOnCheck === false) {
      return ["Checking for updates"];
    }
    return ["Refreshing appstream data", "Checking for updates"];
  },

  getCheckWarningMessage({ stdout }) {
    const warnings: string[] = [];
    if (checkProbeFailed(stdout, LIST_STATUS_MARKER)) {
      warnings.push("Could not list installed Flatpaks. Installed versions could not be determined.");
    }
    if (checkProbeFailed(stdout, MASK_STATUS_MARKER)) {
      warnings.push("Could not read Flatpak masks. Masks found by earlier checks are kept, but newly masked packages may appear as available updates.");
    }
    return warnings.length ? `${warnings.join(" ")} See the step output for details.` : null;
  },

  isPinDetectionIncomplete(commandResults) {
    return anyCheckProbeFailed(commandResults, MASK_STATUS_MARKER);
  },

  parseCheckOutput(stdout, _stderr, _exitCode) {
    const installedIdx = stdout.indexOf(INSTALLED_MARKER);
    const maskedIdx = stdout.indexOf(MASKED_MARKER);
    const updatesIdx = stdout.indexOf(UPDATES_MARKER);
    const masks = maskedIdx !== -1 && updatesIdx !== -1
      ? parseMaskPatterns(stdout.slice(maskedIdx + MASKED_MARKER.length, updatesIdx))
      : [];

    // Build a map of installed flatpak app ID → version
    const installedVersions = new Map<string, string>();
    if (installedIdx !== -1 && updatesIdx !== -1) {
      const installedSection = stdout
        .slice(installedIdx + INSTALLED_MARKER.length, maskedIdx !== -1 ? maskedIdx : updatesIdx)
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
        const ref = parts[5]?.trim() || "";
        const origin = parts[4]?.trim() || "";
        const pkgId = appId || name;
        updates.push({
          packageName: pkgId,
          currentVersion: installedVersions.get(pkgId) ?? null,
          newVersion: remoteVersion || null,
          architecture: null,
          repository: origin,
          isSecurity: false,
          isKeptBack: !!ref && masks.some((mask) => mask.test(ref)),
          pkgManager: "flatpak",
        });
      }
    }

    // The update cache holds one row per ID, so a masked branch must not replace
    // an unmasked branch of the same ID.
    const upgradableIds = new Set(
      updates.filter((update) => !update.isKeptBack).map((update) => update.packageName),
    );
    return updates.filter((update) => !update.isKeptBack || !upgradableIds.has(update.packageName));
  },

  getUpgradeAllCommand() {
    return sudo("flatpak update -y") + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return null;
  },

  getUpgradePackageCommand(pkg) {
    const safePkg = validatePackageName(pkg);
    return sudo(`flatpak update -y ${safePkg}`) + " 2>&1";
  },

  getUpgradePackagesCommand(pkgs) {
    const safePkgs = validatePackageNames(pkgs).join(" ");
    return sudo(`flatpak update -y ${safePkgs}`) + " 2>&1";
  },
};
