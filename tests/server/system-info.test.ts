import { describe, test, expect } from "vitest";
import {
  hasPendingKernelUpdate,
  parseSystemInfo,
  resolveRebootRequired,
} from "../../server/ssh/system-info";

describe("parseSystemInfo", () => {
  test("parse full output", () => {
    const stdout = `===OS===
NAME="Ubuntu"
VERSION="24.04 LTS (Noble Numbat)"
PRETTY_NAME="Ubuntu 24.04 LTS"
VERSION_ID="24.04"
ID=ubuntu
===KERNEL===
6.8.0-45-generic
===HOSTNAME===
web-server-01
===UPTIME===
up 14 days, 3 hours, 22 minutes
===UPTIME_SECONDS===
1234567.89
===ARCH===
x86_64
===CPU===
4
===MEM===
Mem:           7.7Gi       2.1Gi       4.2Gi       256Mi       1.4Gi       5.3Gi
===DISK===
/dev/sda1        50G   12G   35G  26% /
===BOOT_ID===
boot-123
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
0
===INSTALLED_KERNELS===
6.8.0-45-generic
6.8.0-47-generic
`;
    const info = parseSystemInfo(stdout);
    expect(info.osName).toBe("Ubuntu 24.04 LTS");
    expect(info.osVersion).toBe("24.04");
    expect(info.kernel).toBe("6.8.0-45-generic");
    expect(info.hostname).toBe("web-server-01");
    expect(info.uptime).toContain("14 days");
    expect(info.uptimeSeconds).toBe(1234567.89);
    expect(info.arch).toBe("x86_64");
    expect(info.cpuCores).toBe("4");
    expect(info.memory).toBe("7.7Gi");
    expect(info.disk).toContain("/");
    expect(info.bootId).toBe("boot-123");
    expect(info.rebootRequiredFilePresent).toBe(true);
    expect(info.needsRestartingStatus).toBe("not_required");
    expect(info.installedKernels).toEqual([
      "6.8.0-45-generic",
      "6.8.0-47-generic",
    ]);
  });

  test("parse minimal output", () => {
    const stdout = `===OS===
NAME="Unknown"
===KERNEL===
5.0
===HOSTNAME===
srv
===UPTIME===
up 1 hour
===UPTIME_SECONDS===
3600.12
===ARCH===
aarch64
===CPU===
2
===MEM===
===DISK===
`;
    const info = parseSystemInfo(stdout);
    expect(info.osName).toBe("Unknown");
    expect(info.kernel).toBe("5.0");
    expect(info.hostname).toBe("srv");
    expect(info.uptimeSeconds).toBe(3600.12);
    expect(info.arch).toBe("aarch64");
  });

  test("parse empty output", () => {
    const info = parseSystemInfo("");
    expect(info.osName).toBe("Unknown");
    expect(info.kernel).toBe("");
  });

  test("prefers Raspberry Pi OS when the image exposes /etc/rpi-issue", () => {
    const stdout = `===OS===
NAME="Debian GNU/Linux"
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
VERSION="12 (bookworm)"
VERSION_ID="12"
ID=debian
===RPI_ISSUE===
Raspberry Pi reference 2025-02-12
===PVE_VERSION===
===KERNEL===
6.6.74+rpt-rpi-v8
===HOSTNAME===
pi
===UPTIME===
up 2 days
===UPTIME_SECONDS===
172800
===ARCH===
aarch64
===CPU===
4
===MEM===
Mem: 7.7Gi
===DISK===
/dev/root 50G 12G 35G 26% /
`;

    const info = parseSystemInfo(stdout);
    expect(info.osName).toBe("Raspberry Pi OS 12 (bookworm)");
    expect(info.osVersion).toBe("12");
  });

  test("prefers Proxmox VE when pveversion is available", () => {
    const stdout = `===OS===
NAME="Debian GNU/Linux"
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
VERSION="13 (trixie)"
VERSION_ID="13"
ID=debian
===RPI_ISSUE===
===PVE_VERSION===
pve-manager/9.0.3/abc12345
===KERNEL===
6.14.8-2-pve
===HOSTNAME===
proxmox
===UPTIME===
up 7 days
===UPTIME_SECONDS===
604800
===ARCH===
x86_64
===CPU===
8
===MEM===
Mem: 31Gi
===DISK===
/dev/mapper/pve-root 94G 17G 72G 20% /
`;

    const info = parseSystemInfo(stdout);
    expect(info.osName).toBe("Proxmox VE 9.0.3");
    expect(info.osVersion).toBe("9.0.3");
  });

  test("keeps Debian for LXC containers that only inherit a -pve host kernel", () => {
    const stdout = `===OS===
NAME="Debian GNU/Linux"
PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
VERSION="13 (trixie)"
VERSION_ID="13"
ID=debian
===RPI_ISSUE===
===PVE_VERSION===
===KERNEL===
6.17.13-2-pve
===HOSTNAME===
domain
===UPTIME===
up 3 days
===UPTIME_SECONDS===
259200
===ARCH===
x86_64
===CPU===
2
===MEM===
Mem: 8.0Gi
===DISK===
/dev/sda 49G 11G 36G 24% /
`;

    const info = parseSystemInfo(stdout);
    expect(info.osName).toBe("Debian GNU/Linux 13 (trixie)");
    expect(info.osVersion).toBe("13");
  });
});

describe("hasPendingKernelUpdate", () => {
  test("detects newer installed kernel in same family", () => {
    expect(
      hasPendingKernelUpdate("6.8.0-45-generic", [
        "6.8.0-45-generic",
        "6.8.0-47-generic",
      ])
    ).toBe(true);
  });

  test("ignores unrelated kernel families", () => {
    expect(
      hasPendingKernelUpdate("6.6.74+rpt-rpi-v8", [
        "6.6.74+rpt-rpi-v8",
        "6.6.80+rpt-rpi-2712",
      ])
    ).toBe(false);
  });
});

describe("resolveRebootRequired", () => {
  test("honors reboot-required file on first observation", () => {
    const info = parseSystemInfo(`===OS===
NAME="Debian"
===KERNEL===
6.1.0-30-amd64
===HOSTNAME===
pi
===UPTIME===
up 1 hour
===UPTIME_SECONDS===
3600
===ARCH===
x86_64
===CPU===
4
===MEM===
Mem: 1Gi
===DISK===
/dev/root 20G 5G 15G 25% /
===BOOT_ID===
boot-a
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.1.0-30-amd64
`);

    expect(resolveRebootRequired(null, info)).toBe(true);
  });

  test("clears stale reboot-required file after a new boot", () => {
    const info = parseSystemInfo(`===OS===
NAME="Debian"
===KERNEL===
6.1.0-30-amd64
===HOSTNAME===
pi
===UPTIME===
up 4 minutes
===UPTIME_SECONDS===
240
===ARCH===
x86_64
===CPU===
4
===MEM===
Mem: 1Gi
===DISK===
/dev/root 20G 5G 15G 25% /
===BOOT_ID===
boot-b
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.1.0-30-amd64
`);

    expect(resolveRebootRequired({ bootId: "boot-a" }, info)).toBe(false);
  });

  test("clears stale reboot-required file when boot id is unchanged but uptime proves a reboot", () => {
    const info = parseSystemInfo(`===OS===
NAME="Debian"
===KERNEL===
6.1.0-30-amd64
===HOSTNAME===
pi
===UPTIME===
up 4 minutes
===UPTIME_SECONDS===
240
===ARCH===
x86_64
===CPU===
4
===MEM===
Mem: 1Gi
===DISK===
/dev/root 20G 5G 15G 25% /
===BOOT_ID===
boot-a
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.1.0-30-amd64
`);

    const now = Date.UTC(2026, 3, 14, 12, 0, 0);
    expect(
      resolveRebootRequired(
        { bootId: "boot-a", lastSeenAt: "2026-04-14 11:50:00" },
        info,
        now
      )
    ).toBe(false);
  });

  test("keeps reboot required when boot id is unchanged and uptime does not prove a reboot", () => {
    const info = parseSystemInfo(`===OS===
NAME="Debian"
===KERNEL===
6.1.0-30-amd64
===HOSTNAME===
pi
===UPTIME===
up 9 minutes
===UPTIME_SECONDS===
540
===ARCH===
x86_64
===CPU===
4
===MEM===
Mem: 1Gi
===DISK===
/dev/root 20G 5G 15G 25% /
===BOOT_ID===
boot-a
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.1.0-30-amd64
`);

    const now = Date.UTC(2026, 3, 14, 12, 0, 0);
    expect(
      resolveRebootRequired(
        { bootId: "boot-a", lastSeenAt: "2026-04-14 11:50:00" },
        info,
        now
      )
    ).toBe(true);
  });

  test("keeps reboot required for pending kernel updates even if uptime suggests a reboot", () => {
    const info = parseSystemInfo(`===OS===
NAME="Debian"
===KERNEL===
6.1.0-30-amd64
===HOSTNAME===
pi
===UPTIME===
up 4 minutes
===UPTIME_SECONDS===
240
===ARCH===
x86_64
===CPU===
4
===MEM===
Mem: 1Gi
===DISK===
/dev/root 20G 5G 15G 25% /
===BOOT_ID===
boot-a
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.1.0-30-amd64
6.1.0-31-amd64
`);

    const now = Date.UTC(2026, 3, 14, 12, 0, 0);
    expect(
      resolveRebootRequired(
        { bootId: "boot-a", lastSeenAt: "2026-04-14 11:50:00" },
        info,
        now
      )
    ).toBe(true);
  });

  test("keeps reboot required when needs-restarting reports it", () => {
    const info = parseSystemInfo(`===OS===
NAME="Rocky Linux"
===KERNEL===
5.14.0-503.14.1.el9_5.x86_64
===HOSTNAME===
db
===UPTIME===
up 1 day
===UPTIME_SECONDS===
240
===ARCH===
x86_64
===CPU===
2
===MEM===
Mem: 2Gi
===DISK===
/dev/vda1 40G 10G 30G 25% /
===BOOT_ID===
boot-c
===REBOOT_FILE===
ABSENT
===NEEDS_RESTARTING===
1
===INSTALLED_KERNELS===
5.14.0-503.14.1.el9_5.x86_64
`);

    const now = Date.UTC(2026, 3, 14, 12, 0, 0);
    expect(
      resolveRebootRequired(
        { bootId: "boot-b", lastSeenAt: "2026-04-14 11:50:00" },
        info,
        now
      )
    ).toBe(true);
  });
});
