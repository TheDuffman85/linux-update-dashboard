// Each section is separated by ; so a missing tool (e.g. hostname on minimal
// containers) does not break the entire chain via &&.
export const SYSTEM_INFO_CMD =
  'echo "===OS==="; cat /etc/os-release 2>/dev/null; ' +
  'echo "===KERNEL==="; uname -r 2>/dev/null; ' +
  'echo "===HOSTNAME==="; (hostname 2>/dev/null || cat /etc/hostname 2>/dev/null); ' +
  'echo "===UPTIME==="; (uptime -p 2>/dev/null || uptime 2>/dev/null); ' +
  'echo "===ARCH==="; uname -m 2>/dev/null; ' +
  'echo "===CPU==="; nproc 2>/dev/null; ' +
  'echo "===MEM==="; free -h 2>/dev/null | grep Mem; ' +
  'echo "===DISK==="; df -h / 2>/dev/null | tail -1; ' +
  'echo "===BOOT_ID==="; cat /proc/sys/kernel/random/boot_id 2>/dev/null; ' +
  'echo "===REBOOT_FILE==="; if [ -f /run/reboot-required ] || [ -f /var/run/reboot-required ]; then echo "PRESENT"; else echo "ABSENT"; fi; ' +
  'echo "===NEEDS_RESTARTING==="; if command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1; echo $?; else echo "UNAVAILABLE"; fi; ' +
  'echo "===INSTALLED_KERNELS==="; ls -1 /lib/modules 2>/dev/null';

export type NeedsRestartingStatus =
  | "required"
  | "not_required"
  | "unsupported";

export interface SystemInfo {
  osName: string;
  osVersion: string;
  kernel: string;
  hostname: string;
  uptime: string;
  arch: string;
  cpuCores: string;
  memory: string;
  disk: string;
  bootId: string;
  rebootRequiredFilePresent: boolean;
  needsRestartingStatus: NeedsRestartingStatus;
  installedKernels: string[];
  needsReboot: boolean;
}

export interface PreviousRebootState {
  bootId?: string | null;
}

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

export function resolveRebootRequired(
  previous: PreviousRebootState | null | undefined,
  info: SystemInfo
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

  return true;
}

export function parseSystemInfo(stdout: string): SystemInfo {
  const info: SystemInfo = {
    osName: "",
    osVersion: "",
    kernel: "",
    hostname: "",
    uptime: "",
    arch: "",
    cpuCores: "",
    memory: "",
    disk: "",
    bootId: "",
    rebootRequiredFilePresent: false,
    needsRestartingStatus: "unsupported",
    installedKernels: [],
    needsReboot: false,
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

  info.osName =
    osFields["PRETTY_NAME"] || osFields["NAME"] || "Unknown";
  info.osVersion = osFields["VERSION_ID"] || osFields["VERSION"] || "";
  info.kernel = (sections["KERNEL"] || "").trim();
  info.hostname = (sections["HOSTNAME"] || "").trim();
  info.uptime = (sections["UPTIME"] || "").trim();
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

  return info;
}
