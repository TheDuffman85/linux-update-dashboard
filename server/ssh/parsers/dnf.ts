import type { PackageParser, ParsedUpdate } from "./types";
import { sudo, validatePackageName } from "./types";
import type { DnfPackageManagerConfig, YumPackageManagerConfig } from "../../package-manager-configs";

// Example: curl.x86_64    7.76.1-26.el9_3.3    baseos
const PATTERN = /^(\S+?)\.(\S+)\s+(\S+)\s+(\S+)/;

const INSTALLED_SEPARATOR = "---INSTALLED---";
const DNF_YUM_GPG_PROMPT_PATTERN = /(Importing GPG key|Is this ok \[y\/N\]:)/i;

function isSkippableDnfLine(line: string): boolean {
  return (
    line.startsWith("Last metadata") ||
    line.startsWith("Obsoleting") ||
    line.startsWith("Importing GPG key") ||
    line.startsWith("Userid") ||
    line.startsWith("Fingerprint:") ||
    line.startsWith("From") ||
    line.startsWith("Key imported successfully")
  );
}

function isGpgPromptLine(line: string): boolean {
  return /^Is this ok \[y\/N\]:/i.test(line);
}

function getParserLabel(tool: "dnf" | "yum"): string {
  return tool.toUpperCase();
}

export function hasDnfLikeRepoKeyPrompt(output: string): boolean {
  return DNF_YUM_GPG_PROMPT_PATTERN.test(output);
}

export function getDnfLikeRepoKeyPromptMessage(tool: "dnf" | "yum"): string {
  const label = getParserLabel(tool);
  return `${label} update check requires manual trust of a new repository signing key. Verify the repository and accept the key on the target system, or enable automatic key acceptance for ${label} checks if you fully trust that repository.`;
}

export function getDnfLikeCheckErrorMessage(
  tool: "dnf" | "yum",
  stdout: string,
  stderr: string,
  exitCode: number,
): string | null {
  const combinedOutput = `${stdout}\n${stderr}`.trim();
  if (combinedOutput && hasDnfLikeRepoKeyPrompt(combinedOutput)) {
    return getDnfLikeRepoKeyPromptMessage(tool);
  }
  if (exitCode !== 0) {
    return combinedOutput || `Command exited with code ${exitCode}`;
  }
  return null;
}

/**
 * Build a compound shell command that runs a check-update command and then
 * queries rpm for the installed versions of any packages that have updates.
 */
export function buildCheckCommand(
  tool: "dnf" | "yum",
  options?: {
    refreshMetadata?: boolean;
    autoAcceptNewSigningKeys?: boolean;
  },
): string {
  const refreshMetadata = options?.refreshMetadata === true;
  const autoAcceptNewSigningKeys = options?.autoAcceptNewSigningKeys === true;
  const checkUpdateCommand =
    tool === "dnf" && refreshMetadata
      ? `${tool}${autoAcceptNewSigningKeys ? " -y" : ""} check-update --refresh --quiet 2>&1`
      : `${tool}${autoAcceptNewSigningKeys ? " -y" : ""} check-update --quiet 2>&1`;
  // 1. Capture check-update output and its exit code
  // 2. Echo the update list for parsing
  // 3. Echo a separator, then query rpm for installed versions
  // 4. Echo the original exit code so the parser can detect updates-available (100)
  // 5. Preserve real failures while keeping 0/100 as successful shell exits
  return [
    `updates=$(${checkUpdateCommand}); rc=$?`,
    'echo "$updates"',
    `echo "${INSTALLED_SEPARATOR}"`,
    // Only query rpm when updates exist (rc=100); strip "(none):" epoch prefix
    `if [ $rc -eq 100 ] && command -v rpm >/dev/null 2>&1; then echo "$updates" | awk 'NF>=3 && $1 ~ /^[[:alnum:]_+.-]+\\.[[:alnum:]_+-]+$/ {print $1}' | xargs -r rpm -q --qf '%{NAME}.%{ARCH}\\t%{EPOCH}:%{VERSION}-%{RELEASE}\\n' 2>/dev/null | sed 's/\\t(none):/\\t/'; fi`,
    'echo "EXIT:$rc"',
    'if [ "$rc" -ne 0 ] && [ "$rc" -ne 100 ]; then exit "$rc"; fi',
  ].join("; ");
}

export const dnfParser: PackageParser = {
  name: "dnf",

  getCheckCommands(config) {
    const dnfConfig = config as DnfPackageManagerConfig | undefined;
    return [buildCheckCommand("dnf", {
      refreshMetadata: dnfConfig?.refreshMetadataOnCheck === true,
      autoAcceptNewSigningKeys: dnfConfig?.autoAcceptNewSigningKeysOnCheck === true,
    })];
  },

  getCheckCommandLabels() {
    return ["Checking for updates"];
  },

  getCheckErrorMessage(stdout, stderr, exitCode) {
    return getDnfLikeCheckErrorMessage("dnf", stdout, stderr, exitCode);
  },

  parseCheckOutput(stdout, _stderr, exitCode) {
    const updates: ParsedUpdate[] = [];

    // Split into update list and installed-versions section
    const sepIdx = stdout.indexOf(INSTALLED_SEPARATOR);
    const updatePart = sepIdx >= 0 ? stdout.slice(0, sepIdx) : stdout;
    const installedPart = sepIdx >= 0 ? stdout.slice(sepIdx + INSTALLED_SEPARATOR.length) : "";

    // Build a map of name.arch → installed version from rpm output
    const installedVersions = new Map<string, string>();
    for (const line of installedPart.trim().split("\n")) {
      const tab = line.indexOf("\t");
      if (tab > 0) {
        const key = line.slice(0, tab).trim();
        const ver = line.slice(tab + 1).trim();
        if (key && ver && !key.startsWith("EXIT:")) {
          installedVersions.set(key, ver);
        }
      }
    }

    const lines = updatePart.trim().split("\n");

    // dnf check-update returns exit code 100 when updates are available.
    // We append "EXIT:$?" so we can detect this even if the exit code is lost.
    // The EXIT marker is at the very end (after the installed section).
    let actualExit = exitCode;
    const allLines = stdout.trim().split("\n");
    const lastLine = allLines[allLines.length - 1];
    if (lastLine?.startsWith("EXIT:")) {
      const code = parseInt(lastLine.split(":")[1], 10);
      if (!isNaN(code)) actualExit = code;
    }

    // Exit code 0 = no updates, 100 = updates available, other = error
    if (actualExit !== 0 && actualExit !== 100) return [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || isSkippableDnfLine(line) || isGpgPromptLine(line)) continue;
      const m = PATTERN.exec(line);
      if (m) {
        const nameArch = `${m[1]}.${m[2]}`;
        updates.push({
          packageName: m[1],
          currentVersion: installedVersions.get(nameArch) ?? null,
          newVersion: m[3],
          architecture: m[2],
          repository: m[4],
          isSecurity: false,
          isKeptBack: false,
          pkgManager: "dnf",
        });
      }
    }
    return updates;
  },

  getUpgradeAllCommand(config) {
    const dnfConfig = config as DnfPackageManagerConfig | undefined;
    const subcommand = dnfConfig?.defaultUpgradeMode === "distro-sync" ? "distro-sync" : "upgrade";
    return sudo(`dnf ${subcommand} -y`) + " 2>&1";
  },

  getFullUpgradeAllCommand() {
    return sudo("dnf distro-sync -y") + " 2>&1";
  },

  getUpgradePackageCommand(pkg) {
    const safePkg = validatePackageName(pkg);
    return sudo(`dnf upgrade -y ${safePkg}`) + " 2>&1";
  },
};

export function getYumCheckCommands(config?: YumPackageManagerConfig): string[] {
  return [buildCheckCommand("yum", {
    autoAcceptNewSigningKeys: config?.autoAcceptNewSigningKeysOnCheck === true,
  })];
}
