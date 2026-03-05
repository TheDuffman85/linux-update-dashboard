import { describe, test, expect } from "bun:test";
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
    expect(info.arch).toBe("aarch64");
  });

  test("parse empty output", () => {
    const info = parseSystemInfo("");
    expect(info.osName).toBe("Unknown");
    expect(info.kernel).toBe("");
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

  test("keeps reboot required when needs-restarting reports it", () => {
    const info = parseSystemInfo(`===OS===
NAME="Rocky Linux"
===KERNEL===
5.14.0-503.14.1.el9_5.x86_64
===HOSTNAME===
db
===UPTIME===
up 1 day
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

    expect(resolveRebootRequired({ bootId: "boot-b" }, info)).toBe(true);
  });
});
