import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";

// Lets a test edit the system while restartServices awaits the notification sync.
const syncHook = vi.hoisted(() => ({ current: null as null | (() => void) }));
vi.mock("../../server/services/notification-runtime-events", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/services/notification-runtime-events")>();
  return {
    ...original,
    requestNotificationRuntimeSystemSync: async () => {
      const hook = syncHook.current;
      syncHook.current = null;
      hook?.();
    },
  };
});

import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems } from "../../server/db/schema";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import * as systemService from "../../server/services/system-service";
import { RestartServicesRequestError, restartServices } from "../../server/services/update-service";
import type { ServiceRestartInfo } from "../../shared/service-restart";

const OS_SECTION = "===OS===\nNAME=\"Debian\"\nPRETTY_NAME=\"Debian GNU/Linux 12\"\nID=debian\n";

function scan(units: string[]): ServiceRestartInfo {
  return {
    status: "ok",
    init: "systemd",
    services: units.map((unit, index) => ({ unit, processes: [{ pid: 100 + index, comm: "x" }], files: [] })),
    managerNeedsReexec: false,
    sessionProcessCount: 0,
    otherProcesses: [],
  };
}

describe("service restart target checks", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-service-restart-target-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    syncHook.current = null;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSystem(units: string[], fingerprint: string | null = null, hostname = "a.local"): number {
    return getDb().insert(systems).values({
      name: "Host A",
      hostname,
      port: 22,
      authType: "password",
      username: "root",
      encryptedSudoPassword: getEncryptor().encrypt("password-of-a"),
      trustedHostKeyFingerprintSha256: fingerprint,
      serviceRestartInfo: JSON.stringify(scan(units)),
      serviceRestartCount: units.length,
    }).returning({ id: systems.id }).get().id;
  }

  test("does not connect when the host changes while the restart is starting", async () => {
    const systemId = createSystem(["nginx.service"]);
    const connected: string[] = [];
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = async (system: { hostname: string }) => {
      connected.push(system.hostname);
      return {};
    };
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    syncHook.current = () => {
      // What PUT /api/systems/:id does when the hostname changes.
      getDb().update(systems)
        .set({ hostname: "b.local", serviceRestartInfo: null, serviceRestartCount: 0 })
        .where(eq(systems.id, systemId))
        .run();
    };

    await expect(restartServices(systemId, ["nginx.service"])).rejects.toBeInstanceOf(RestartServicesRequestError);
    expect(connected).toEqual([]);
  });

  test("sends no command or password once the entry points at another host", async () => {
    const systemId = createSystem([]);
    const connectedRecord = systemService.getSystem(systemId)!;
    getDb().update(systems)
      .set({ hostname: "b.local", encryptedSudoPassword: getEncryptor().encrypt("password-of-b") })
      .where(eq(systems.id, systemId))
      .run();
    const sent: Array<string | undefined> = [];
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).runCommand = async (_conn: unknown, _command: string, _timeout: unknown, password?: string) => {
      sent.push(password);
      return { stdout: OS_SECTION, stderr: "", exitCode: 0 };
    };

    await systemService.updateSystemInfo(systemId, sshManager, {} as never, connectedRecord);

    expect(sent).toEqual([]);
  });

  test("uses the sudo password of the record the connection was opened with", async () => {
    const systemId = createSystem([]);
    const connectedRecord = systemService.getSystem(systemId)!;
    const sent: Array<string | undefined> = [];
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).runCommand = async (_conn: unknown, _command: string, _timeout: unknown, password?: string) => {
      sent.push(password);
      return { stdout: OS_SECTION, stderr: "", exitCode: 0 };
    };

    await systemService.updateSystemInfo(systemId, sshManager, {} as never, connectedRecord);

    expect(sent).toEqual(["password-of-a"]);
  });

  test("discards the scan when the trusted host key changes", () => {
    const fingerprintA = "SHA256:aaaa";
    const keyB = {
      role: "target" as const,
      host: "a.local",
      port: 22,
      rawKey: "AAAAB",
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:bbbb",
    };

    const kept = createSystem(["nginx.service"], fingerprintA);
    systemService.persistTrustedHostKey(kept, { ...keyB, fingerprintSha256: fingerprintA });
    expect(systemService.getSystem(kept)?.serviceRestartCount).toBe(1);

    const replaced = createSystem(["nginx.service"], fingerprintA, "rebuilt.local");
    systemService.clearTrustedHostKey(replaced);
    systemService.persistTrustedHostKey(replaced, keyB);
    const system = systemService.getSystem(replaced);
    expect(system?.serviceRestartInfo).toBeNull();
    expect(system?.serviceRestartCount).toBe(0);
  });

  test("ignores a scan when the host key changes while it runs", async () => {
    const systemId = createSystem([], "SHA256:aaaa");
    const connectedRecord = systemService.getSystem(systemId)!;
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).runCommand = async () => {
      systemService.persistTrustedHostKey(systemId, {
        role: "target",
        host: "a.local",
        port: 22,
        rawKey: "AAAAB",
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:bbbb",
      });
      return {
        stdout: "===RESTART_SERVICES===\nINIT=systemd\nSTATUS=ok\nSERVICE\tnginx.service\t812\tnginx\t/usr/lib/x.so\n" + OS_SECTION,
        stderr: "",
        exitCode: 0,
      };
    };

    await systemService.updateSystemInfo(systemId, sshManager, {} as never, connectedRecord);

    const system = systemService.getSystem(systemId);
    expect(system?.serviceRestartInfo).toBeNull();
    expect(system?.serviceRestartCount).toBe(0);
  });
});
