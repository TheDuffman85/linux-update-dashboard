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
  'echo "===REBOOT==="; ' +
  'if [ -f /var/run/reboot-required ]; then echo "REBOOT_REQUIRED"; ' +
  'elif command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1; [ $? -eq 1 ] && echo "REBOOT_REQUIRED" || echo "NO_REBOOT"; ' +
  'else RUNNING=$(uname -r); LATEST=$(ls -1v /lib/modules/ 2>/dev/null | tail -1); ' +
  '[ -n "$LATEST" ] && [ "$RUNNING" != "$LATEST" ] && echo "REBOOT_REQUIRED" || echo "NO_REBOOT"; fi';

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
  needsReboot: boolean;
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

  const rebootLine = (sections["REBOOT"] || "").trim();
  info.needsReboot = rebootLine === "REBOOT_REQUIRED";

  return info;
}
