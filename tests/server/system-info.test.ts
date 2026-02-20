import { describe, test, expect } from "bun:test";
import { parseSystemInfo } from "../../server/ssh/system-info";

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
