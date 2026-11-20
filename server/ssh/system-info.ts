import type {
  ServiceRestartInfo,
  ServiceRestartProcess,
  ServiceRestartService,
} from "../../shared/service-restart";
import { isValidServiceName } from "../../shared/service-restart";

/**
 * Always listed by the scan, so its absence means the scan did not run, for
 * example because sudo refused it. Exit codes cannot tell this apart: find and
 * grep also fail when a process exits during the scan.
 */
export const SERVICE_RESTART_SCAN_SENTINEL = "/proc/1/root";

/**
 * Exact command run with root rights to find processes that still map deleted
 * (replaced) files. It is fixed so it fits one exact sudoers rule. grep has an
 * absolute path because find runs it as root, and a PATH lookup could pick a
 * user's binary; /bin/grep exists on merged-/usr, older Debian, and BusyBox
 * systems. `{} +` keeps it free of the `;` that ends a sudoers-relevant command.
 */
export const SERVICE_RESTART_SCAN_COMMAND =
  `find /proc -mindepth 2 -maxdepth 2 -name maps -exec /bin/grep -HsF deleted {} + -o -path ${SERVICE_RESTART_SCAN_SENTINEL} -print`;

/**
 * Turns scan output into one line per process: KIND, unit, PID, name, files.
 * Reads each process's cgroup and name below the awk variable `proc`, so tests
 * can point it at a fixture tree. It is single-quoted in the shell script, so
 * it must not contain a single quote, not even in a comment.
 */
export const SERVICE_RESTART_CLASSIFIER_AWK = `
  # Input: /proc/PID/maps:ADDRESS PERMS OFFSET DEVICE INODE PATH (deleted)
  / \\(deleted\\)$/ && index($0, "/proc/") == 1 {
    split($1, head, "/"); pid = head[3]
    if (pid == self) next
    path = $6; for (i = 7; i < NF; i++) path = path " " $i
    if (path !~ /^\\/(usr|lib|lib32|lib64|libx32|bin|sbin|opt)\\//) next
    if (path ~ /locale-archive$|\\.cache$|^\\/usr\\/share\\//) next
    if (!(pid in files)) order[++n] = pid
    if (index(files[pid], "\\t" path) == 0 && count[pid]++ < 5) files[pid] = files[pid] "\\t" path
  }
  END {
    for (k = 1; k <= n; k++) {
      pid = order[k]; cgroup = ""; openrc = ""
      file = proc "/" pid "/cgroup"
      while ((getline line < file) > 0) {
        if (line ~ /^0::/ || line ~ /:name=systemd:/) { sub(/^[^:]*:[^:]*:/, "", line); cgroup = line }
        # OpenRC on cgroup v1 keeps its own hierarchy: N:name=openrc:/SERVICE
        else if (line ~ /:name=openrc:/) { sub(/^[^:]*:[^:]*:/, "", line); openrc = line }
      }
      close(file)
      comm = ""; file = proc "/" pid "/comm"; getline comm < file; close(file)
      gsub(/[\\t\\r\\n]/, " ", comm)
      parts = split(cgroup, segment, "/"); leaf = segment[parts]
      # Guests come first: their processes, including their own init in
      # machine.slice/*/init.scope or /lxc/101/ns/init.scope, belong to the guest.
      if (cgroup ~ /^\\/(lxc|lxc\\.payload|machine\\.slice|docker|kubepods)/ || cgroup ~ /\\/(docker|libpod)-[^\\/]*\\.scope/) continue
      # Only PID 1 of this host is the service manager.
      else if (pid == 1) { kind = "MANAGER"; unit = "-" }
      else if (cgroup ~ /^\\/user\\.slice\\//) { kind = "SESSION"; unit = "-" }
      # Host units sit directly under slices.
      else if (cgroup ~ /^\\/([^\\/]+\\.slice\\/)*[^\\/]+\\.service$/) { kind = "SERVICE"; unit = leaf }
      else if (cgroup ~ /^\\/openrc\\.[^\\/]+$/) { kind = "SERVICE"; unit = substr(leaf, 8) }
      else if (openrc ~ /^\\/[^\\/]+$/) { kind = "SERVICE"; unit = substr(openrc, 2) }
      else { kind = "PROCESS"; unit = "-" }
      print kind "\\t" unit "\\t" pid "\\t" comm files[pid]
    }
  }`;

// Runs first so no other section can read the sudo password from stdin.
// Only the find command is elevated; filtering and the PID-to-service mapping
// (from the world-readable /proc/PID/cgroup) run as the SSH user.
const SERVICE_RESTART_SECTION = `echo "===RESTART_SERVICES==="
if [ -d /run/systemd/system ]; then
  echo "INIT=systemd"
elif command -v rc-service >/dev/null 2>&1; then
  echo "INIT=openrc"
else
  echo "INIT=other"
fi
ludash_restart_status=ok
ludash_restart_scan=
if [ ! -x /bin/grep ] || ! command -v find >/dev/null 2>&1; then
  ludash_restart_status=unsupported
elif [ "$(id -u)" = "0" ]; then
  ludash_restart_scan=$(${SERVICE_RESTART_SCAN_COMMAND} 2>/dev/null)
elif command -v sudo >/dev/null 2>&1; then
  ludash_restart_scan=$(
    # Sudoers-relevant command: ${SERVICE_RESTART_SCAN_COMMAND}
    sudo -S -p '' ${SERVICE_RESTART_SCAN_COMMAND} 2>/dev/null
  )
  # sudo prints refusals in several forms; the missing sentinel covers them all.
  if ! printf '%s\\n' "$ludash_restart_scan" | grep -qxF '${SERVICE_RESTART_SCAN_SENTINEL}'; then
    ludash_restart_status=denied
  fi
else
  ludash_restart_status=partial
  ludash_restart_scan=$(${SERVICE_RESTART_SCAN_COMMAND} 2>/dev/null)
fi
if [ "$ludash_restart_status" != denied ] && ! printf '%s\\n' "$ludash_restart_scan" | grep -qxF '${SERVICE_RESTART_SCAN_SENTINEL}'; then
  ludash_restart_status=unsupported
fi
case $ludash_restart_status in denied|unsupported) ludash_restart_scan= ;; esac
echo "STATUS=$ludash_restart_status"
printf '%s\\n' "$ludash_restart_scan" | awk -v self="$$" -v proc=/proc '${SERVICE_RESTART_CLASSIFIER_AWK}' | head -n 1000`;

// Each section is intentionally independent so a missing tool (e.g. hostname
// on minimal containers) does not break the rest of the collection script.
export const SYSTEM_INFO_CMD = `# Collect OS, hardware, uptime, boot, reboot-required, and service-restart details for the dashboard.
# Section markers are parsed by the built-in system-info parser.
${SERVICE_RESTART_SECTION}

echo "===OS==="
cat /etc/os-release 2>/dev/null

echo "===RPI_ISSUE==="
cat /etc/rpi-issue 2>/dev/null

echo "===PVE_VERSION==="
if command -v pveversion >/dev/null 2>&1; then
  pveversion 2>/dev/null | head -1
fi

echo "===KERNEL==="
uname -r 2>/dev/null

echo "===HOSTNAME==="
hostname 2>/dev/null || cat /etc/hostname 2>/dev/null

echo "===UPTIME==="
uptime -p 2>/dev/null || uptime 2>/dev/null

echo "===UPTIME_SECONDS==="
cut -d " " -f1 /proc/uptime 2>/dev/null

echo "===ARCH==="
uname -m 2>/dev/null

echo "===CPU==="
nproc 2>/dev/null

echo "===MEM==="
free -h 2>/dev/null | grep Mem

echo "===DISK==="
df -h / 2>/dev/null | tail -1

echo "===BOOT_ID==="
cat /proc/sys/kernel/random/boot_id 2>/dev/null

echo "===REBOOT_FILE==="
if [ -f /run/reboot-required ] || [ -f /var/run/reboot-required ]; then
  echo "PRESENT"
else
  echo "ABSENT"
fi

echo "===REBOOT_PACKAGES==="
if [ -f /run/reboot-required.pkgs ]; then
  head -100 /run/reboot-required.pkgs 2>/dev/null
elif [ -f /var/run/reboot-required.pkgs ]; then
  head -100 /var/run/reboot-required.pkgs 2>/dev/null
fi

echo "===NEEDS_RESTARTING==="
if command -v needs-restarting >/dev/null 2>&1; then
  needs-restarting -r >/dev/null 2>&1
  echo $?
else
  echo "UNAVAILABLE"
fi

echo "===INSTALLED_KERNELS==="
ls -1 /lib/modules 2>/dev/null`;

export type NeedsRestartingStatus =
  | "required"
  | "not_required"
  | "unsupported";

export interface SystemInfo {
  osId: string;
  osIdLike: string;
  osName: string;
  osVersion: string;
  osVersionCodename: string;
  kernel: string;
  hostname: string;
  uptime: string;
  uptimeSeconds: number | null;
  arch: string;
  cpuCores: string;
  memory: string;
  disk: string;
  bootId: string;
  rebootRequiredFilePresent: boolean;
  rebootRequiredPackages: string[];
  needsRestartingStatus: NeedsRestartingStatus;
  installedKernels: string[];
  needsReboot: boolean;
  /** Null when the script printed no service-restart section. */
  serviceRestart: ServiceRestartInfo | null;
}

export interface PreviousRebootState {
  bootId?: string | null;
  uptimeSeconds?: number | null;
  lastSeenAt?: string | null;
  rebootDismissedBootId?: string | null;
  rebootDismissedUptimeSeconds?: number | null;
  rebootDismissedAt?: string | null;
}

export interface RebootDismissalResolution {
  needsReboot: boolean;
  dismissalActive: boolean;
  dismissalExpired: boolean;
}

const STALE_REBOOT_UPTIME_TOLERANCE_SECONDS = 120;

const KERNEL_VERSION_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function normalizeKernelFamily(kernel: string): string {
  const trimmed = kernel.trim();
  if (!trimmed) return "";

  const match = trimmed.match(/(?:[-+.][A-Za-z][A-Za-z0-9_+-]*)+$/);
  if (!match) return "";

  return match[0].toLowerCase().replace(/\d+/g, "#");
}

function buildRaspberryPiOsName(osFields: Record<string, string>): string {
  const prettyName = osFields["PRETTY_NAME"] || osFields["NAME"] || "";
  if (/raspberry pi os|raspbian/i.test(prettyName)) {
    return prettyName;
  }

  const versionLabel = osFields["VERSION"] || osFields["VERSION_ID"] || "";
  return versionLabel ? `Raspberry Pi OS ${versionLabel}` : "Raspberry Pi OS";
}

function extractProxmoxVersion(pveVersion: string): string {
  const match = pveVersion.match(/pve-manager\/([0-9][^/\s]*)/i);
  return match?.[1] || "";
}

function resolveOsDisplayName(
  osFields: Record<string, string>,
  sections: Record<string, string>
): { osName: string; osVersion: string } {
  const prettyName = osFields["PRETTY_NAME"] || osFields["NAME"] || "Unknown";
  const defaultVersion = osFields["VERSION_ID"] || osFields["VERSION"] || "";
  const rpiIssue = (sections["RPI_ISSUE"] || "").trim();
  const pveVersion = (sections["PVE_VERSION"] || "").trim();

  if (pveVersion) {
    const proxmoxVersion = extractProxmoxVersion(pveVersion);
    return {
      osName: proxmoxVersion ? `Proxmox VE ${proxmoxVersion}` : "Proxmox VE",
      osVersion: proxmoxVersion || defaultVersion,
    };
  }

  if (rpiIssue) {
    return {
      osName: buildRaspberryPiOsName(osFields),
      osVersion: defaultVersion,
    };
  }

  return {
    osName: prettyName,
    osVersion: defaultVersion,
  };
}

function resolveOsVersionCodename(osFields: Record<string, string>): string {
  const explicit = osFields["VERSION_CODENAME"] || osFields["UBUNTU_CODENAME"] || "";
  if (explicit.trim()) return explicit.trim().toLowerCase();

  const version = osFields["VERSION"] || "";
  const match = version.match(/\(([^)]+)\)/);
  const codename = match?.[1]?.split(/\s+/)[0] ?? "";
  return codename.trim().toLowerCase();
}

export function hasPendingKernelUpdate(
  runningKernel: string,
  installedKernels: string[]
): boolean {
  const running = runningKernel.trim();
  if (!running) return false;

  const runningFamily = normalizeKernelFamily(running);
  if (!runningFamily) return false;

  const familyKernels = [...new Set(installedKernels
    .map((kernel) => kernel.trim())
    .filter((kernel) => kernel && normalizeKernelFamily(kernel) === runningFamily))];

  if (!familyKernels.includes(running)) {
    familyKernels.push(running);
  }

  if (familyKernels.length <= 1) return false;

  familyKernels.sort((a, b) => KERNEL_VERSION_COLLATOR.compare(a, b));
  return familyKernels[familyKernels.length - 1] !== running;
}

function parseDbTimestampAsUtcMillis(value: string | null | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
}

function rebootCanBeInferredFromUptime(
  previous: PreviousRebootState | null | undefined,
  info: SystemInfo,
  now = Date.now()
): boolean {
  if (info.uptimeSeconds == null) return false;

  if (
    previous?.uptimeSeconds != null &&
    previous.uptimeSeconds > info.uptimeSeconds + STALE_REBOOT_UPTIME_TOLERANCE_SECONDS
  ) {
    return true;
  }

  const lastSeenAtMs = parseDbTimestampAsUtcMillis(previous?.lastSeenAt);
  if (lastSeenAtMs == null) return false;

  const elapsedSeconds = (now - lastSeenAtMs) / 1000;
  return elapsedSeconds > info.uptimeSeconds + STALE_REBOOT_UPTIME_TOLERANCE_SECONDS;
}

export function resolveRebootRequired(
  previous: PreviousRebootState | null | undefined,
  info: SystemInfo,
  now = Date.now()
): boolean {
  if (info.needsRestartingStatus === "required") {
    return true;
  }

  if (hasPendingKernelUpdate(info.kernel, info.installedKernels)) {
    return true;
  }

  if (!info.rebootRequiredFilePresent) {
    return false;
  }

  const previousBootId = previous?.bootId?.trim() || "";
  const currentBootId = info.bootId.trim();

  if (previousBootId && currentBootId && previousBootId !== currentBootId) {
    return false;
  }

  if (
    (!previousBootId || !currentBootId || previousBootId === currentBootId) &&
    rebootCanBeInferredFromUptime(previous, info, now)
  ) {
    return false;
  }

  return true;
}

export function resolveRebootDismissal(
  previous: PreviousRebootState | null | undefined,
  info: SystemInfo,
  rawNeedsReboot: boolean
): RebootDismissalResolution {
  const dismissedBootId = previous?.rebootDismissedBootId?.trim() || "";
  const dismissedUptimeSeconds = previous?.rebootDismissedUptimeSeconds ?? null;
  const currentBootId = info.bootId.trim();
  const hasDismissal =
    !!previous?.rebootDismissedAt ||
    !!dismissedBootId ||
    dismissedUptimeSeconds != null;

  if (!hasDismissal) {
    return {
      needsReboot: rawNeedsReboot,
      dismissalActive: false,
      dismissalExpired: false,
    };
  }

  if (dismissedBootId && currentBootId && dismissedBootId !== currentBootId) {
    return {
      needsReboot: rawNeedsReboot,
      dismissalActive: false,
      dismissalExpired: true,
    };
  }

  if (
    dismissedUptimeSeconds != null &&
    info.uptimeSeconds != null &&
    info.uptimeSeconds < dismissedUptimeSeconds
  ) {
    return {
      needsReboot: rawNeedsReboot,
      dismissalActive: false,
      dismissalExpired: true,
    };
  }

  return {
    needsReboot: false,
    dismissalActive: true,
    dismissalExpired: false,
  };
}

export function parseSystemInfo(stdout: string): SystemInfo {
  const info: SystemInfo = {
    osId: "",
    osIdLike: "",
    osName: "",
    osVersion: "",
    osVersionCodename: "",
    kernel: "",
    hostname: "",
    uptime: "",
    uptimeSeconds: null,
    arch: "",
    cpuCores: "",
    memory: "",
    disk: "",
    bootId: "",
    rebootRequiredFilePresent: false,
    rebootRequiredPackages: [],
    needsRestartingStatus: "unsupported",
    installedKernels: [],
    needsReboot: false,
    serviceRestart: null,
  };

  const sections: Record<string, string> = {};
  let currentKey: string | null = null;
  let currentLines: string[] = [];

  for (const line of stdout.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("===") && stripped.endsWith("===")) {
      if (currentKey) {
        sections[currentKey] = currentLines.join("\n").trim();
      }
      currentKey = stripped.replace(/^=+|=+$/g, "");
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentKey) {
    sections[currentKey] = currentLines.join("\n").trim();
  }

  // Parse OS
  const osData = sections["OS"] || "";
  const osFields: Record<string, string> = {};
  for (const line of osData.split("\n")) {
    if (line.includes("=")) {
      const idx = line.indexOf("=");
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
      osFields[key] = val;
    }
  }

  const osDisplay = resolveOsDisplayName(osFields, sections);
  const pveVersion = (sections["PVE_VERSION"] || "").trim();
  const rpiIssue = (sections["RPI_ISSUE"] || "").trim();
  info.osId = pveVersion
    ? "proxmox"
    : rpiIssue
      ? "raspbian"
      : (osFields["ID"] || "").trim().toLowerCase();
  info.osIdLike = (osFields["ID_LIKE"] || "").trim().toLowerCase();
  info.osName = osDisplay.osName;
  info.osVersion = osDisplay.osVersion;
  info.osVersionCodename = resolveOsVersionCodename(osFields);
  info.kernel = (sections["KERNEL"] || "").trim();
  info.hostname = (sections["HOSTNAME"] || "").trim();
  info.uptime = (sections["UPTIME"] || "").trim();

  const uptimeSeconds = Number.parseFloat((sections["UPTIME_SECONDS"] || "").trim());
  if (Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0) {
    info.uptimeSeconds = uptimeSeconds;
  }

  info.arch = (sections["ARCH"] || "").trim();
  info.cpuCores = (sections["CPU"] || "").trim();

  const memLine = (sections["MEM"] || "").trim();
  if (memLine) {
    const parts = memLine.split(/\s+/);
    if (parts.length >= 2) {
      info.memory = parts[1]; // Total memory
    }
  }

  const diskLine = (sections["DISK"] || "").trim();
  if (diskLine) {
    const parts = diskLine.split(/\s+/);
    if (parts.length >= 5) {
      info.disk = `${parts[2]}/${parts[1]} (${parts[4]})`;
    } else if (parts.length >= 2) {
      info.disk = parts[1];
    }
  }

  info.bootId = (sections["BOOT_ID"] || "").trim();
  info.rebootRequiredFilePresent = (sections["REBOOT_FILE"] || "").trim() === "PRESENT";
  info.rebootRequiredPackages = [...new Set((sections["REBOOT_PACKAGES"] || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9.+_:-]*$/.test(line)))]
    .slice(0, 50);

  const needsRestartingLine = (sections["NEEDS_RESTARTING"] || "").trim();
  if (needsRestartingLine === "1") {
    info.needsRestartingStatus = "required";
  } else if (needsRestartingLine === "0") {
    info.needsRestartingStatus = "not_required";
  }

  info.installedKernels = (sections["INSTALLED_KERNELS"] || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if ("RESTART_SERVICES" in sections) {
    info.serviceRestart = parseServiceRestartSection(sections["RESTART_SERVICES"]);
  }

  return info;
}

const MAX_RESTART_SERVICES = 200;
const MAX_PROCESSES_PER_SERVICE = 20;
const MAX_FILES_PER_SERVICE = 5;
const MAX_OTHER_PROCESSES = 50;
const MAX_FILE_PATH_LENGTH = 512;

function sanitizeComm(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 64);
}

function sanitizeFilePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.length > MAX_FILE_PATH_LENGTH) return null;
  return /[\x00-\x1f\x7f]/.test(trimmed) ? null : trimmed;
}

/** Parses the `===RESTART_SERVICES===` section into bounded, validated data. */
export function parseServiceRestartSection(section: string): ServiceRestartInfo {
  const result: ServiceRestartInfo = {
    status: "ok",
    init: "other",
    services: [],
    managerNeedsReexec: false,
    sessionProcessCount: 0,
    otherProcesses: [],
  };
  const services = new Map<string, ServiceRestartService>();

  for (const rawLine of section.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("INIT=")) {
      const init = line.slice("INIT=".length).trim();
      if (init === "systemd" || init === "openrc") result.init = init;
      continue;
    }
    if (line.startsWith("STATUS=")) {
      const status = line.slice("STATUS=".length).trim();
      if (status === "partial" || status === "denied" || status === "unsupported") result.status = status;
      continue;
    }

    const [kind, unit, pidText, comm = "", ...files] = line.split("\t");
    const pid = Number.parseInt(pidText ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const process: ServiceRestartProcess = { pid, comm: sanitizeComm(comm) };

    if (kind === "MANAGER") {
      result.managerNeedsReexec = true;
    } else if (kind === "SESSION") {
      result.sessionProcessCount += 1;
    } else if (kind === "PROCESS") {
      if (result.otherProcesses.length < MAX_OTHER_PROCESSES) result.otherProcesses.push(process);
    } else if (kind === "SERVICE" && isValidServiceName(unit)) {
      let service = services.get(unit);
      if (!service) {
        if (services.size >= MAX_RESTART_SERVICES) continue;
        service = { unit, processes: [], files: [] };
        services.set(unit, service);
      }
      if (service.processes.length < MAX_PROCESSES_PER_SERVICE) service.processes.push(process);
      for (const file of files) {
        const path = sanitizeFilePath(file);
        if (path && service.files.length < MAX_FILES_PER_SERVICE && !service.files.includes(path)) {
          service.files.push(path);
        }
      }
    }
  }

  result.services = [...services.values()].sort((a, b) => a.unit.localeCompare(b.unit));
  return result;
}
