import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import {
  SERVICE_RESTART_CLASSIFIER_AWK,
  SERVICE_RESTART_SCAN_COMMAND,
  SYSTEM_INFO_CMD,
  parseServiceRestartSection,
  parseSystemInfo,
} from "../../server/ssh/system-info";
import { buildCommandReference, normalizeCommandForSudoers } from "../../server/services/command-reference";
import { renderCommandTemplate, resolveRuntimeSteps } from "../../server/services/script-service";
import { buildSudoersPreview } from "../../server/services/sudoers-preview";
import * as systemService from "../../server/services/system-service";
import { RestartServicesRequestError, restartServices } from "../../server/services/update-service";
import systemsRoutes from "../../server/routes/systems";
import { createCredential } from "../../server/services/credential-service";
import type { ServiceRestartInfo } from "../../shared/service-restart";

const OS_SECTION = "===OS===\nNAME=\"Debian\"\nPRETTY_NAME=\"Debian GNU/Linux 12\"\nID=debian\n";

function restartSection(lines: string[], status = "ok"): string {
  return ["===RESTART_SERVICES===", "INIT=systemd", `STATUS=${status}`, ...lines].join("\n") + "\n";
}

function scan(units: string[]): ServiceRestartInfo {
  return {
    status: "ok",
    init: "systemd",
    services: units.map((unit, index) => ({
      unit,
      processes: [{ pid: 100 + index, comm: unit.replace(/\.service$/, "") }],
      files: ["/usr/lib/libssl.so.3"],
    })),
    managerNeedsReexec: false,
    sessionProcessCount: 0,
    otherProcesses: [],
  };
}

describe("service restart detection", () => {
  test("runs the scan first and keeps its elevated command extractable for sudoers", () => {
    expect(SYSTEM_INFO_CMD.indexOf("===RESTART_SERVICES===")).toBeLessThan(SYSTEM_INFO_CMD.indexOf("===OS==="));
    expect(SYSTEM_INFO_CMD).toContain(`sudo -S -p '' ${SERVICE_RESTART_SCAN_COMMAND} 2>/dev/null\n`);
    expect(normalizeCommandForSudoers(SYSTEM_INFO_CMD)).toBe(SERVICE_RESTART_SCAN_COMMAND);
  });

  test("runs grep by absolute path and prints a sentinel that proves the scan ran", () => {
    expect(SERVICE_RESTART_SCAN_COMMAND).toContain("-exec /bin/grep ");
    expect(SERVICE_RESTART_SCAN_COMMAND).toMatch(/-o -path \/proc\/1\/root -print$/);
    // Denials are detected by the missing sentinel, not by matching sudo's wording.
    expect(SYSTEM_INFO_CMD).not.toContain("'^sudo: '");
    expect(SYSTEM_INFO_CMD).toContain("grep -qxF '/proc/1/root'");
  });

  test("parses services, the service manager, sessions, and other processes", () => {
    const result = parseServiceRestartSection([
      "INIT=systemd",
      "STATUS=ok",
      "SERVICE\tnginx.service\t812\tnginx\t/usr/lib/libssl.so.3\t/usr/sbin/nginx",
      "SERVICE\tnginx.service\t813\tnginx\t/usr/lib/libssl.so.3",
      "SERVICE\tbad;name.service\t9\tx\t/usr/lib/x.so",
      "SERVICE\tapache2.service\tnot-a-pid\tapache2",
      "MANAGER\t-\t1\tsystemd\t/usr/lib/libc.so.6",
      "SESSION\t-\t4000\tbash\t/usr/lib/libc.so.6",
      "SESSION\t-\t4001\tvim\t/usr/lib/libc.so.6",
      "PROCESS\t-\t3000\tqemu-system-x86\t/usr/bin/qemu-system-x86_64",
    ].join("\n"));

    expect(result).toEqual({
      status: "ok",
      init: "systemd",
      services: [{
        unit: "nginx.service",
        processes: [{ pid: 812, comm: "nginx" }, { pid: 813, comm: "nginx" }],
        files: ["/usr/lib/libssl.so.3", "/usr/sbin/nginx"],
      }],
      managerNeedsReexec: true,
      sessionProcessCount: 2,
      otherProcesses: [{ pid: 3000, comm: "qemu-system-x86" }],
    });
  });

  test("produces a script that sh can parse", () => {
    // The classifier is single-quoted in the script; a quote in it breaks everything.
    expect(SERVICE_RESTART_CLASSIFIER_AWK).not.toContain("'");
    execFileSync("sh", ["-n"], { input: SYSTEM_INFO_CMD });
  });

  test("classifies processes by cgroup and skips guests", () => {
    const proc = mkdtempSync(join(tmpdir(), "ludash-fake-proc-"));
    try {
      const processes: Array<[number, string, string]> = [
        [1, "systemd", "0::/init.scope"],
        [812, "nginx", "0::/system.slice/nginx.service"],
        [813, "getty", "0::/system.slice/system-getty.slice/getty@tty1.service"],
        [900, "systemd", "0::/machine.slice/machine-demo.scope/init.scope"],
        [901, "nginx", "0::/lxc/101/ns/system.slice/nginx.service"],
        [902, "nginx", "0::/system.slice/docker-abc.scope"],
        [903, "nginx", "0::/machine.slice/libpod-abc.scope/container/init.scope"],
        [904, "sshd", "0::/openrc.sshd"],
        [905, "crond", "1:name=openrc:/crond\n0::/"],
        [906, "bash", "0::/user.slice/user-1000.slice/session-1.scope"],
        [907, "qemu", "0::/qemu.slice/100.scope"],
      ];
      for (const [pid, comm, cgroup] of processes) {
        mkdirSync(join(proc, String(pid)));
        writeFileSync(join(proc, String(pid), "cgroup"), `${cgroup}\n`);
        writeFileSync(join(proc, String(pid), "comm"), `${comm}\n`);
      }
      const input = processes
        .map(([pid]) => `/proc/${pid}/maps:7f00-7f01 r-xp 00000000 08:01 123 /usr/lib/libssl.so.3 (deleted)`)
        .concat(["/proc/1/root", "/proc/812/maps:7f00-7f01 rw-s 00000000 00:01 9 /memfd:x (deleted)"])
        .join("\n");

      const output = execFileSync("awk", ["-v", "self=0", "-v", `proc=${proc}`, SERVICE_RESTART_CLASSIFIER_AWK], { input })
        .toString().trim().split("\n").map((line) => line.split("\t").slice(0, 3).join(" "));

      expect(output).toEqual([
        "MANAGER - 1",
        "SERVICE nginx.service 812",
        "SERVICE getty@tty1.service 813",
        "SERVICE sshd 904",
        "SERVICE crond 905",
        "SESSION - 906",
        "PROCESS - 907",
      ]);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });

  test("reports a refused or partial scan", () => {
    expect(parseServiceRestartSection("INIT=systemd\nSTATUS=denied").status).toBe("denied");
    expect(parseServiceRestartSection("INIT=openrc\nSTATUS=partial")).toMatchObject({ status: "partial", init: "openrc" });
    expect(parseServiceRestartSection("INIT=other\nSTATUS=unsupported").status).toBe("unsupported");
    expect(parseServiceRestartSection("INIT=other\nSTATUS=bogus").status).toBe("ok");
  });

  test("leaves the field empty when a system-info script prints no scan", () => {
    expect(parseSystemInfo(OS_SECTION).serviceRestart).toBeNull();
    expect(parseSystemInfo(OS_SECTION + restartSection([])).serviceRestart?.status).toBe("ok");
  });
});

describe("restart services script", () => {
  test("substitutes only valid service names", () => {
    expect(renderCommandTemplate("systemctl restart -- {{service}}", { service: "nginx.service" }))
      .toBe("systemctl restart -- nginx.service");
    expect(() => renderCommandTemplate("systemctl restart -- {{service}}", { service: "x; reboot" }))
      .toThrow(/Invalid service name/);
  });

  test("lists restart commands as commented sudoers rules with exact rules for flagged services", () => {
    const reference = buildCommandReference({
      pkgManager: "apt",
      detectedPkgManagers: JSON.stringify(["apt"]),
      disabledPkgManagers: null,
    });
    const restartEntries = reference.sudoers.filter((entry) => entry.category === "restart_services");
    expect(restartEntries.map((entry) => entry.command)).toEqual([
      "systemctl try-restart -- <service>",
      "rc-service --ifstarted <service> restart",
    ]);
    expect(reference.sudoers.some((entry) => entry.command === SERVICE_RESTART_SCAN_COMMAND)).toBe(true);

    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: reference,
      executablePaths: new Map([
        ["find", "/usr/bin/find"],
        ["apt-get", "/usr/bin/apt-get"],
        ["dpkg", "/usr/bin/dpkg"],
        ["reboot", "/usr/sbin/reboot"],
        ["systemctl", "/usr/bin/systemctl"],
      ]),
      restartServices: ["nginx.service", "bad name"],
    });

    expect(preview.content).toContain(
      `\nupdater ALL=(root) NOPASSWD: /usr/bin/${SERVICE_RESTART_SCAN_COMMAND}\n`,
    );
    expect(preview.content).toContain("# updater ALL=(root) NOPASSWD: /usr/bin/systemctl try-restart -- nginx.service\n");
    expect(preview.content).toContain("# updater ALL=(root) NOPASSWD: /usr/bin/systemctl try-restart -- *\n");
    expect(preview.content).not.toMatch(/^updater .*systemctl/m);
    // rc-service is not on this host, and invalid names never become rules.
    expect(preview.content).not.toContain("rc-service");
    expect(preview.content).not.toContain("bad name");
  });
});

describe("restart sudoers rules", () => {
  test("keeps a fixed restart command from a custom script commented", () => {
    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: {
        exact: [],
        warnings: [],
        envKeep: [],
        sudoers: [
          {
            id: "restart-services:sudo:0",
            category: "restart_services",
            label: "Restart nginx",
            purpose: "",
            pkgManager: null,
            command: "systemctl restart nginx.service",
            sudoersSafety: "exact",
          },
          {
            id: "reboot:sudo:0",
            category: "reboot",
            label: "Reboot",
            purpose: "",
            pkgManager: null,
            command: "reboot",
            sudoersSafety: "exact",
          },
        ],
      },
      executablePaths: new Map([["systemctl", "/usr/bin/systemctl"], ["reboot", "/usr/sbin/reboot"]]),
      restartServices: ["nginx.service"],
    });

    expect(preview.content).toContain("\nupdater ALL=(root) NOPASSWD: /usr/sbin/reboot \"\"\n");
    expect(preview.content).toContain("# updater ALL=(root) NOPASSWD: /usr/bin/systemctl restart nginx.service\n");
    expect(preview.content).not.toMatch(/^updater .*systemctl/m);
  });
});

describe("restartServices", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-service-restart-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSystem(units: string[]): number {
    return getDb().insert(systems).values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
      encryptedPassword: getEncryptor().encrypt("secret"),
      serviceRestartInfo: JSON.stringify(scan(units)),
      serviceRestartCount: units.length,
    }).returning({ id: systems.id }).get().id;
  }

  function mockSsh(handler: (command: string) => { stdout: string; stderr: string; exitCode: number }) {
    const commands: string[] = [];
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      return handler(command);
    };
    return commands;
  }

  test("restarts each service separately and refreshes the list", async () => {
    const systemId = createSystem(["nginx.service", "php-fpm.service"]);
    const commands = mockSsh((command) => command.includes("===OS===")
      ? { stdout: restartSection([]) + OS_SECTION, stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 });

    const result = await restartServices(systemId, ["nginx.service", "php-fpm.service"]);

    expect(result).toMatchObject({ success: true, status: "success", restarted: ["nginx.service", "php-fpm.service"], failed: [] });
    const restartCommands = commands.filter((command) => command.includes("systemctl try-restart"));
    expect(restartCommands).toHaveLength(2);
    expect(restartCommands[0]).toContain("systemctl try-restart -- nginx.service");
    expect(restartCommands[1]).toContain("systemctl try-restart -- php-fpm.service");

    const system = systemService.getSystem(systemId);
    expect(system?.serviceRestartCount).toBe(0);
    expect(systemService.parseServiceRestartInfo(system?.serviceRestartInfo)?.services).toEqual([]);
    const history = getDb().select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    expect(history).toMatchObject({ action: "restart_services", status: "success" });
    expect(JSON.parse(history?.packages ?? "[]")).toEqual(["nginx.service", "php-fpm.service"]);
    expect(JSON.parse(history?.steps ?? "[]").map((step: { label: string }) => step.label)).toEqual([
      "Connect over SSH",
      "Restart service: nginx.service",
      "Restart service: php-fpm.service",
    ]);
  });

  test("keeps going after one service fails and reports a warning", async () => {
    const systemId = createSystem(["nginx.service", "php-fpm.service"]);
    mockSsh((command) => {
      if (command.includes("===OS===")) return { stdout: OS_SECTION, stderr: "", exitCode: 0 };
      if (command.includes("nginx.service")) {
        return { stdout: "Job for nginx.service failed.\n", stderr: "", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await restartServices(systemId, ["nginx.service", "php-fpm.service"]);

    expect(result).toMatchObject({ success: false, status: "warning", restarted: ["php-fpm.service"], failed: ["nginx.service"] });
    const history = getDb().select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    expect(history).toMatchObject({ status: "warning", error: "Could not restart: nginx.service" });
  });

  test("stops after the SSH connection drops", async () => {
    const systemId = createSystem(["a.service", "b.service"]);
    const commands = mockSsh(() => ({ stdout: "", stderr: "SSH connection closed", exitCode: -1 }));

    const result = await restartServices(systemId, ["a.service", "b.service"]);

    expect(result).toMatchObject({ status: "failed", restarted: [], failed: ["a.service", "b.service"] });
    expect(result.message).toContain("Lost the SSH connection");
    expect(commands.filter((command) => command.includes("systemctl try-restart"))).toHaveLength(1);
    expect(commands.some((command) => command.includes("===OS==="))).toBe(false);
  });

  test("fails only the service whose restart timed out", async () => {
    const systemId = createSystem(["slow.service", "fast.service"]);
    const commands = mockSsh((command) => {
      if (command.includes("===OS===")) return { stdout: OS_SECTION, stderr: "", exitCode: 0 };
      if (command.includes("slow.service")) return { stdout: "", stderr: "Command timed out after 180s", exitCode: -1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const result = await restartServices(systemId, ["slow.service", "fast.service"]);

    expect(result).toMatchObject({ status: "warning", restarted: ["fast.service"], failed: ["slow.service"] });
    expect(result.message).not.toContain("Lost the SSH connection");
    expect(commands.some((command) => command.includes("===OS==="))).toBe(true);
  });

  test("lists every requested service as failed when SSH cannot connect", async () => {
    const systemId = createSystem(["a.service", "b.service"]);
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = async () => { throw new Error("Connection refused"); };
    (sshManager as any).disconnect = () => {};

    const result = await restartServices(systemId, ["a.service", "b.service"]);

    expect(result).toMatchObject({ status: "failed", restarted: [], failed: ["a.service", "b.service"] });
  });

  test("keeps the list marked out of date when the scan after a restart fails", async () => {
    const systemId = createSystem(["a.service", "b.service"]);
    mockSsh((command) => command.includes("===OS===")
      ? { stdout: "", stderr: "Command timed out after 120s", exitCode: -1 }
      : { stdout: "", stderr: "", exitCode: 0 });

    const result = await restartServices(systemId, ["a.service"]);

    expect(result.status).toBe("success");
    const system = systemService.getSystem(systemId);
    const info = systemService.parseServiceRestartInfo(system?.serviceRestartInfo);
    expect(info?.stale).toBe(true);
    expect(info?.services.map((service) => service.unit)).toEqual(["b.service"]);
    expect(system?.serviceRestartCount).toBe(1);
    await expect(restartServices(systemId, ["b.service"])).rejects.toThrow(/out of date/);
  });

  test("clears the out-of-date mark with the scan after a restart", async () => {
    const systemId = createSystem(["a.service"]);
    mockSsh((command) => command.includes("===OS===")
      ? { stdout: restartSection(["SERVICE\tb.service\t5\tb\t/usr/lib/x.so"]) + OS_SECTION, stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 });

    await restartServices(systemId, ["a.service"]);

    const info = systemService.parseServiceRestartInfo(systemService.getSystem(systemId)?.serviceRestartInfo);
    expect(info?.stale).toBeUndefined();
    expect(info?.services.map((service) => service.unit)).toEqual(["b.service"]);
  });

  test("forgets the scan when the system points at another host", () => {
    const systemId = createSystem(["nginx.service"]);
    const system = systemService.getSystem(systemId)!;
    const credentialId = createCredential({
      name: "Root",
      kind: "usernamePassword",
      payload: { username: "root", password: "secret" },
    });
    getDb().update(systems).set({ credentialId }).where(eq(systems.id, systemId)).run();

    systemService.updateSystem(systemId, { name: system.name, hostname: system.hostname, port: system.port, credentialId });
    expect(systemService.getSystem(systemId)?.serviceRestartCount).toBe(1);

    systemService.updateSystem(systemId, { name: system.name, hostname: "other.local", port: system.port, credentialId });
    const updated = systemService.getSystem(systemId);
    expect(updated?.serviceRestartInfo).toBeNull();
    expect(updated?.serviceRestartCount).toBe(0);
  });

  test("ignores a scan from a host the system no longer points at", async () => {
    const systemId = createSystem([]);
    const oldTarget = { ...systemService.getSystem(systemId)! };
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).runCommand = async () => {
      getDb().update(systems).set({ hostname: "other.local" }).where(eq(systems.id, systemId)).run();
      return {
        stdout: restartSection(["SERVICE\tnginx.service\t812\tnginx\t/usr/lib/libssl.so.3"]) + OS_SECTION,
        stderr: "",
        exitCode: 0,
      };
    };

    await systemService.updateSystemInfo(systemId, sshManager, {} as never, oldTarget);

    const system = systemService.getSystem(systemId);
    expect(systemService.parseServiceRestartInfo(system?.serviceRestartInfo)?.services).toEqual([]);
    expect(system?.serviceRestartCount).toBe(0);
  });

  test("refuses services the last scan did not flag", async () => {
    const systemId = createSystem(["nginx.service"]);
    const commands = mockSsh(() => ({ stdout: "", stderr: "", exitCode: 0 }));

    await expect(restartServices(systemId, ["sshd.service"])).rejects.toBeInstanceOf(RestartServicesRequestError);
    await expect(restartServices(systemId, [])).rejects.toThrow(/at least one/);
    await expect(restartServices(systemId, "nginx.service")).rejects.toThrow(/at least one/);
    expect(commands).toEqual([]);
  });

  test("runs a custom restart script with the selected service", () => {
    const systemId = createSystem(["nginx.service"]);
    const [step] = resolveRuntimeSteps({ systemId, operation: "restart_services", service: "nginx.service" });
    expect(step.command).toContain("systemctl try-restart -- nginx.service");
    expect(step.command).toContain("rc-service --ifstarted nginx.service restart");
  });

  test("recounts flagged services when the skip list changes", () => {
    const systemId = createSystem(["dbus.service", "nginx.service"]);
    systemService.setServiceRestartSkipPatterns(systemId, null);
    expect(systemService.getSystem(systemId)?.serviceRestartCount).toBe(1);
    systemService.setServiceRestartSkipPatterns(systemId, ["nginx"]);
    expect(systemService.getSystem(systemId)?.serviceRestartCount).toBe(1);
    expect(systemService.parseServiceRestartSkipPatterns(systemService.getSystem(systemId)?.serviceRestartSkipPatterns)).toEqual(["nginx"]);
    systemService.setServiceRestartSkipPatterns(systemId, []);
    expect(systemService.getSystem(systemId)?.serviceRestartCount).toBe(2);
  });

  test("counts with a skip list saved while the scan was running", async () => {
    const systemId = createSystem([]);
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).runCommand = async () => {
      systemService.setServiceRestartSkipPatterns(systemId, ["nginx"]);
      return {
        stdout: restartSection(["SERVICE\tnginx.service\t812\tnginx\t/usr/lib/libssl.so.3"]) + OS_SECTION,
        stderr: "",
        exitCode: 0,
      };
    };

    await systemService.updateSystemInfo(systemId, sshManager, {} as never);

    expect(systemService.getSystem(systemId)?.serviceRestartCount).toBe(0);
  });

  test("stores the scan and the count from system info", async () => {
    const systemId = createSystem([]);
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).runCommand = async () => ({
      stdout: restartSection([
        "SERVICE\tdbus.service\t500\tdbus-daemon\t/usr/lib/libc.so.6",
        "SERVICE\tnginx.service\t812\tnginx\t/usr/lib/libssl.so.3",
      ]) + OS_SECTION,
      stderr: "",
      exitCode: 0,
    });

    await systemService.updateSystemInfo(systemId, sshManager, {} as never);

    const system = systemService.getSystem(systemId);
    // dbus is on the default skip list.
    expect(system?.serviceRestartCount).toBe(1);
    expect(systemService.parseServiceRestartInfo(system?.serviceRestartInfo)?.services.map((service) => service.unit))
      .toEqual(["dbus.service", "nginx.service"]);
  });
});

describe("service restart routes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-service-restart-routes-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function app() {
    const hono = new Hono();
    hono.route("/api/systems", systemsRoutes);
    return hono;
  }

  function createSystem(): number {
    return getDb().insert(systems).values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
      serviceRestartInfo: JSON.stringify(scan(["nginx.service"])),
      serviceRestartCount: 1,
    }).returning({ id: systems.id }).get().id;
  }

  test("serializes the scan and the skip list", async () => {
    const systemId = createSystem();
    const body = await (await app().request(`/api/systems/${systemId}`)).json();
    expect(body.system.serviceRestartInfo.services[0].unit).toBe("nginx.service");
    expect(body.system.serviceRestartCount).toBe(1);
    expect(body.system.serviceRestartSkipPatterns).toBeNull();
  });

  test("rejects a restart of a service that is not flagged", async () => {
    const systemId = createSystem();
    const response = await app().request(`/api/systems/${systemId}/restart-services`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ services: ["sshd.service"] }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Not flagged for restart: sshd.service");
  });

  test("validates and saves the skip list", async () => {
    const systemId = createSystem();
    const put = (patterns: unknown) => app().request(`/api/systems/${systemId}/service-restart-skip-patterns`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ patterns }),
    });

    expect((await put(["bad pattern"])).status).toBe(400);
    const saved = await put(["nginx", " nginx "]);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ patterns: ["nginx"] });
    expect(systemService.getSystem(systemId)?.serviceRestartCount).toBe(0);

    const reset = await put(null);
    expect(await reset.json()).toEqual({ patterns: null });
    expect(systemService.getSystem(systemId)?.serviceRestartCount).toBe(1);
  });
});
