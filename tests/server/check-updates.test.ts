import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, hiddenUpdates, installedPackageCache, systems, updateCache, updateHistory } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { checkUpdates } from "../../server/services/update-service";
import { getVisibleCachedUpdates, getVisibleUpdateSummary } from "../../server/services/hidden-update-service";
import { createSystem } from "../../server/services/system-service";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";
import {
  buildOperationKey,
  createCustomPackageManager,
  createScript,
  resolveRuntimeSteps,
  setSystemOverrides,
} from "../../server/services/script-service";
import { APK_READ_WORLD_COMMAND } from "../../server/ssh/parsers/apk";
import { createCredential } from "../../server/services/credential-service";
import type { RunCommandOptions } from "../../server/ssh/connection";
import { APK_FAILED_SIMULATION, APK_PINNED_LIST, APK_PINNED_WORLD } from "../fixtures/apk-pins";
import { invalidateCache } from "../../server/services/cache-service";
import * as outputStream from "../../server/services/output-stream";
import { validateSelectedPackageUpgradeRequest } from "../../server/services/update-service";

const SYSTEM_INFO_OUTPUT = `===OS===
NAME="Debian GNU/Linux"
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
VERSION_ID="12"
===KERNEL===
6.1.0
===HOSTNAME===
debian-test
===UPTIME===
up 1 day
===ARCH===
x86_64
===CPU===
2
===MEM===
Mem:           1.9Gi       512Mi       1.0Gi
===DISK===
/dev/root        20G    5G   14G  27% /
===BOOT_ID===
boot-id
===REBOOT_FILE===
ABSENT
===NEEDS_RESTARTING===
0
===INSTALLED_KERNELS===
6.1.0
`;

describe("checkUpdates", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-check-updates-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createAptSystem(options?: {
    sudoPassword?: string;
  }): number {
    const db = getDb();
    const encryptor = getEncryptor();
    const credentialId = db.insert(credentials).values({
      name: "Debian password",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "testuser",
        password: encryptor.encrypt("testpass"),
      }),
    }).returning({ id: credentials.id }).get().id;

    const systemId = createSystem({
      name: "Debian",
      hostname: "127.0.0.1",
      port: 22,
      credentialId,
      sudoPassword: options?.sudoPassword ?? "testpass",
      hostKeyVerificationEnabled: false,
    });

    db.update(systems)
      .set({
        pkgManager: "apt",
        detectedPkgManagers: JSON.stringify(["apt"]),
      })
      .where(eq(systems.id, systemId))
      .run();

    return systemId;
  }

  function createAptAndSnapSystem(): number {
    const db = getDb();
    const systemId = createAptSystem();

    db.update(systems)
      .set({
        detectedPkgManagers: JSON.stringify(["apt", "snap"]),
      })
      .where(eq(systems.id, systemId))
      .run();

    return systemId;
  }

  function createDnfSystem(options?: {
    pkgManagerConfigs?: Record<string, unknown>;
  }): number {
    const db = getDb();
    return db.insert(systems).values({
      name: "Red Hat",
      hostname: "redhat.local",
      port: 22,
      authType: "password",
      username: "root",
      hostKeyVerificationEnabled: 0,
      pkgManager: "dnf",
      detectedPkgManagers: JSON.stringify(["dnf"]),
      pkgManagerConfigs: options?.pkgManagerConfigs ? JSON.stringify(options.pkgManagerConfigs) : null,
    }).returning({ id: systems.id }).get().id;
  }

  test.each([true, false])("preserves APK pin detection and records a simulation warning (auto-hide %s)", async (autoHide) => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "Custom OpenWrt",
      hostname: "openwrt.local",
      authType: "password",
      username: "root",
      hostKeyVerificationEnabled: 0,
      pkgManager: "apk",
      detectedPkgManagers: JSON.stringify(["apk"]),
      pkgManagerConfigs: JSON.stringify({ apk: { autoHideKeptBackUpdates: autoHide } }),
    }).returning({ id: systems.id }).get().id;
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    let world = APK_PINNED_WORLD;
    let simulation = APK_FAILED_SIMULATION;
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      let stdout: string;
      if (command === SYSTEM_INFO_CMD) stdout = SYSTEM_INFO_OUTPUT;
      else if (command.includes("apk update")) stdout = "OK: 11234 distinct packages available\n";
      else if (command.includes("apk list -u")) stdout = APK_PINNED_LIST;
      else if (command.includes("cat /etc/apk/world")) stdout = world + "\n===LUDASH_APK_WORLD_STATUS:0===\n";
      else if (command.includes("apk upgrade --simulate")) stdout = simulation;
      else if (command.includes("apk list --installed")) stdout = "";
      else throw new Error(`Unexpected command: ${command}`);
      return { stdout, stderr: "", exitCode: 0 };
    };

    const updates = await checkUpdates(systemId);
    expect(updates.map((update) => [update.packageName, update.isKeptBack])).toEqual([
      ["base-files", true], ["kernel", true], ["zlib", false],
    ]);
    expect(getVisibleCachedUpdates(systemId).map((update) => update.packageName))
      .toEqual(autoHide ? ["zlib"] : ["base-files", "kernel", "zlib"]);
    expect(db.select().from(hiddenUpdates).where(eq(hiddenUpdates.systemId, systemId)).all())
      .toHaveLength(autoHide ? 2 : 0);
    const history = db.select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    expect(history?.status).toBe("warning");
    expect(history?.error).toContain("APK upgrade simulation failed (exit code 99)");
    expect(history?.packageCount).toBe(autoHide ? 1 : 3);
    expect(JSON.parse(history?.steps || "[]")).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Reading pinned versions", status: "success" }),
      expect.objectContaining({
        label: "Detecting kept-back packages",
        status: "warning",
        error: expect.stringContaining("dependency-based holds could not be determined"),
        output: expect.stringContaining("stale/unavailable repositories"),
      }),
    ]));

    // Removing the pins and repairing the repository clears the warning and
    // brings previously hidden updates back without manual intervention.
    world = "base-files\nkernel\nzlib";
    simulation = [
      "(1/3) Upgrading base-files (1~981c978eff -> 1718~981c978eff)",
      "(2/3) Upgrading kernel (6.12.112~9bc94e3a8c8d88d519791e4b3c6ced9b-r1 -> 6.12.112~b4125196ecec75391093e1e2edeba490-r1)",
      "(3/3) Upgrading zlib (1.3.1-r1 -> 1.3.2-r0)",
      "OK: 11 MiB in 136 packages",
      "===LUDASH_APK_SIMULATION_STATUS:0===",
    ].join("\n");
    await checkUpdates(systemId);
    expect(getVisibleCachedUpdates(systemId).map((update) => update.packageName)).toEqual(["base-files", "kernel", "zlib"]);
    const recoveredHistory = db.select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    expect(recoveredHistory?.status).toBe("success");
    expect(recoveredHistory?.error).toBeNull();
  });

  test.each([
    {
      manager: "snap",
      lookup: "snap refresh --list",
      output: (healthy: boolean) => [
        "===INSTALLED===",
        `LUDASH_SNAP_LIST_STATUS:${healthy ? 0 : 42}`,
        ...(healthy ? ["Name Version Rev Tracking Publisher Notes", "example 1.0 1 latest/stable publisher held"] : []),
        "===UPDATES===", "Name Version Rev Publisher Notes", "example 2.0 2 publisher -",
      ].join("\n"),
      warning: "Could not list installed snaps",
    },
    {
      manager: "flatpak",
      lookup: "flatpak remote-ls --updates",
      output: (healthy: boolean) => [
        "===INSTALLED===", "org.example.App\t1.0", "===MASKED===",
        `LUDASH_FLATPAK_MASK_STATUS:${healthy ? 0 : 42}`,
        ...(healthy ? ["org.example.App"] : []),
        "===UPDATES===", "Example\torg.example.App\t2.0\tstable\tflathub\tapp/org.example.App/x86_64/stable",
      ].join("\n"),
      warning: "Could not read Flatpak masks",
    },
    {
      manager: "deb-get",
      lookup: "apt-mark showhold",
      output: (healthy: boolean) => [
        `LUDASH_DEBGET_HOLD_STATUS:${healthy ? 0 : 42}`,
        `LUDASH_DEBGET_UPDATE\texample\t1.0\t2.0\t${healthy ? "held" : ""}`,
      ].join("\n"),
      warning: "Could not read APT holds",
    },
  ])("records a partial $manager check as a warning and recovers pin detection", async ({ manager, lookup, output, warning }) => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: manager, hostname: "test.local", authType: "password", username: "root",
      hostKeyVerificationEnabled: 0, pkgManager: manager, detectedPkgManagers: JSON.stringify([manager]),
    }).returning({ id: systems.id }).get().id;
    const expectedCommands = new Set([
      ...resolveRuntimeSteps({ systemId, operation: "check_updates", pkgManager: manager }),
      ...resolveRuntimeSteps({ systemId, operation: "list_installed_packages", pkgManager: manager }),
    ].map((step) => step.command));
    let healthy = false;
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      if (!expectedCommands.has(command)) throw new Error(`Unexpected command: ${command}`);
      return command.includes(lookup)
        ? { stdout: output(healthy), stderr: healthy ? "" : "pin lookup failed\n", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };
    };

    const updates = await checkUpdates(systemId);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ newVersion: "2.0", isKeptBack: false });
    expect(getVisibleCachedUpdates(systemId)).toHaveLength(1);
    const history = db.select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    expect(history?.status).toBe("warning");
    expect(history?.error).toContain(warning);
    expect(JSON.parse(history?.steps || "[]")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "warning", error: expect.stringContaining(warning), output: expect.stringContaining("pin lookup failed"),
      }),
    ]));

    healthy = true;
    expect((await checkUpdates(systemId))[0].isKeptBack).toBe(true);
    expect(getVisibleCachedUpdates(systemId)).toHaveLength(0);
    const recovered = db.select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    expect(recovered?.status).toBe("success");
    expect(recovered?.error).toBeNull();
  });

  describe("failed pin lookups after a pin is known", () => {
    function createFlatpakSystem(autoHide: boolean) {
      const systemId = getDb().insert(systems).values({
        name: "Flatpak", hostname: "test.local", authType: "password", username: "root",
        hostKeyVerificationEnabled: 0, pkgManager: "flatpak", detectedPkgManagers: JSON.stringify(["flatpak"]),
        pkgManagerConfigs: JSON.stringify({ flatpak: { autoHideKeptBackUpdates: autoHide } }),
      }).returning({ id: systems.id }).get().id;
      const host = { maskStatus: 0, masks: ["org.example.App"], newVersion: "2.0", listingExitCode: 0 };
      const sshManager = initSSHManager(1, 1, 1, getEncryptor());
      (sshManager as any).connect = async () => ({});
      (sshManager as any).disconnect = () => {};
      (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
        if (command === SYSTEM_INFO_CMD) return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
        if (!command.includes("flatpak remote-ls")) return { stdout: "", stderr: "", exitCode: 0 };
        if (host.listingExitCode !== 0) return { stdout: "", stderr: "listing failed\n", exitCode: host.listingExitCode };
        return {
          stdout: [
            "===INSTALLED===", "org.example.App\t1.0", "org.example.Free\t1.0", "===MASKED===",
            `LUDASH_FLATPAK_MASK_STATUS:${host.maskStatus}`,
            ...(host.maskStatus === 0 ? host.masks : []),
            "===UPDATES===",
            `Example\torg.example.App\t${host.newVersion}\tstable\tflathub\tapp/org.example.App/x86_64/stable`,
            "Free\torg.example.Free\t2.0\tstable\tflathub\tapp/org.example.Free/x86_64/stable",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      };
      return { systemId, host };
    }

    const visibleNames = (systemId: number) =>
      getVisibleCachedUpdates(systemId).map((update) => update.packageName);

    test("keeps a known pin hidden across repeated failures and releases it only after detection recovers", async () => {
      const { systemId, host } = createFlatpakSystem(true);
      await checkUpdates(systemId);
      expect(visibleNames(systemId)).toEqual(["org.example.Free"]);

      host.maskStatus = 1;
      for (let attempt = 0; attempt < 2; attempt++) {
        const updates = await checkUpdates(systemId);
        expect(updates.map((update) => update.isKeptBack)).toEqual([true, false]);
        expect(visibleNames(systemId)).toEqual(["org.example.Free"]);
      }

      host.maskStatus = 0;
      host.masks = [];
      const recovered = await checkUpdates(systemId);
      expect(recovered.map((update) => update.isKeptBack)).toEqual([false, false]);
      expect(visibleNames(systemId)).toEqual(["org.example.App", "org.example.Free"]);
    });

    test("keeps refusing by-name upgrades of a known pin when auto-hide is off", async () => {
      const { systemId, host } = createFlatpakSystem(false);
      await checkUpdates(systemId);
      host.maskStatus = 1;
      await checkUpdates(systemId);

      expect(visibleNames(systemId)).toEqual(["org.example.App", "org.example.Free"]);
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["org.example.App"])).toThrow("pinned or held");
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["org.example.Free"])).not.toThrow();
    });

    test("carries a known pin over to a new version published during the failure", async () => {
      const { systemId, host } = createFlatpakSystem(true);
      await checkUpdates(systemId);
      host.maskStatus = 1;
      host.newVersion = "3.0";
      await checkUpdates(systemId);
      expect(visibleNames(systemId)).toEqual(["org.example.Free"]);
    });

    test.each([true, false])("keeps a known pin after the cache refresh clears the cache (auto-hide %s)", async (autoHide) => {
      const { systemId, host } = createFlatpakSystem(autoHide);
      await checkUpdates(systemId);
      expect(getDb().select().from(hiddenUpdates).where(eq(hiddenUpdates.systemId, systemId)).all())
        .toHaveLength(autoHide ? 1 : 0);

      invalidateCache();
      host.maskStatus = 1;
      const updates = await checkUpdates(systemId);

      expect(updates.map((update) => update.isKeptBack)).toEqual([true, false]);
      expect(visibleNames(systemId)).toEqual(autoHide ? ["org.example.Free"] : ["org.example.App", "org.example.Free"]);
      if (!autoHide) {
        expect(() => validateSelectedPackageUpgradeRequest(systemId, ["org.example.App"])).toThrow("pinned or held");
      }
    });

    test("keeps a known pin after a completely failed check emptied the cache", async () => {
      const { systemId, host } = createFlatpakSystem(false);
      await checkUpdates(systemId);

      host.listingExitCode = 1;
      await expect(checkUpdates(systemId)).rejects.toThrow("listing failed");
      expect(getDb().select().from(updateCache).where(eq(updateCache.systemId, systemId)).all()).toHaveLength(0);

      host.listingExitCode = 0;
      host.maskStatus = 1;
      await checkUpdates(systemId);
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["org.example.App"])).toThrow("pinned or held");
    });

    test("releases a pin removed during a cleared cache once detection recovers", async () => {
      const { systemId, host } = createFlatpakSystem(false);
      await checkUpdates(systemId);
      invalidateCache();
      host.maskStatus = 1;
      await checkUpdates(systemId);

      host.maskStatus = 0;
      host.masks = [];
      await checkUpdates(systemId);
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["org.example.App"])).not.toThrow();

      invalidateCache();
      host.maskStatus = 1;
      const updates = await checkUpdates(systemId);
      expect(updates.every((update) => !update.isKeptBack)).toBe(true);
    });

    test("keeps exact APK pins when a custom check without simulation fails to read the world", async () => {
      const systemId = getDb().insert(systems).values({
        name: "Custom APK", hostname: "apk.local", authType: "password", username: "root",
        hostKeyVerificationEnabled: 0, pkgManager: "apk", detectedPkgManagers: JSON.stringify(["apk"]),
        pkgManagerConfigs: JSON.stringify({ apk: { autoHideKeptBackUpdates: false } }),
      }).returning({ id: systems.id }).get().id;
      const script = createScript({
        name: "APK check without simulation",
        type: "package_manager",
        operation: "check_updates",
        pkgManager: "apk",
        steps: [
          { label: "List", command: "apk list -u 2>/dev/null" },
          { label: "World", command: APK_READ_WORLD_COMMAND },
        ],
      });
      setSystemOverrides(systemId, { [buildOperationKey("check_updates", "apk")]: script.id });

      let world = `${APK_PINNED_WORLD}\n===LUDASH_APK_WORLD_STATUS:0===\n`;
      const sshManager = initSSHManager(1, 1, 1, getEncryptor());
      (sshManager as any).connect = async () => ({});
      (sshManager as any).disconnect = () => {};
      (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
        if (command === SYSTEM_INFO_CMD) return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
        if (command.includes("apk list -u")) return { stdout: APK_PINNED_LIST, stderr: "", exitCode: 0 };
        if (command.includes("cat /etc/apk/world")) return { stdout: world, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      const kept = (updates: Awaited<ReturnType<typeof checkUpdates>>) =>
        updates.map((update) => [update.packageName, update.isKeptBack]);
      const pinned = [["base-files", true], ["kernel", true], ["zlib", false]];

      expect(kept(await checkUpdates(systemId))).toEqual(pinned);

      world = "cat: can't open '/etc/apk/world': Permission denied\n===LUDASH_APK_WORLD_STATUS:1===\n";
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(kept(await checkUpdates(systemId))).toEqual(pinned);
      }
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["kernel"])).toThrow("pinned or held");
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["zlib"])).not.toThrow();

      world = "base-files\nkernel\nzlib\n===LUDASH_APK_WORLD_STATUS:0===\n";
      expect((await checkUpdates(systemId)).every((update) => !update.isKeptBack)).toBe(true);
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["kernel"])).not.toThrow();
    });

    test("does not invent pins for packages no earlier check marked", async () => {
      const { systemId, host } = createFlatpakSystem(true);
      host.maskStatus = 1;
      const updates = await checkUpdates(systemId);
      expect(updates.map((update) => update.isKeptBack)).toEqual([false, false]);
    });

    test("ends a warning-only check as a warning rather than a failure", async () => {
      const { systemId, host } = createFlatpakSystem(true);
      const messages: Array<Record<string, unknown>> = [];
      const subscriber = { send: (data: string) => messages.push(JSON.parse(data)) };
      outputStream.subscribe(systemId, subscriber as any);
      const lastDone = () => messages.filter((message) => message.type === "done").at(-1);

      await checkUpdates(systemId);
      expect(lastDone()).toMatchObject({ success: true, warning: false });

      host.maskStatus = 1;
      await checkUpdates(systemId);
      expect(lastDone()).toMatchObject({ success: true, warning: true });
      outputStream.removeStream(systemId);
    });
  });

  test("fails the check when the sudo-backed refresh command exits non-zero", async () => {
    const db = getDb();
    const encryptor = getEncryptor();
    const systemId = createAptSystem({ sudoPassword: "wrongpass" });

    const sshManager = initSSHManager(1, 1, 1, encryptor);
    let aptListAttempted = false;
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return {
          stdout: SYSTEM_INFO_OUTPUT,
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("dpkg --audit")) {
        return {
          stdout: "sudo: a password is required\n",
          stderr: "",
          exitCode: 1,
        };
      }
      if (command.includes("apt list --upgradable")) {
        aptListAttempted = true;
        return {
          stdout: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await expect(checkUpdates(systemId)).rejects.toThrow("[apt] sudo: a password is required");
    expect(aptListAttempted).toBe(false);

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .at(-1);

    expect(history?.status).toBe("failed");
    expect(history?.packageCount).toBe(0);
    expect(history?.error).toContain("[apt] sudo: a password is required");
    expect(JSON.parse(history?.steps || "[]")).toMatchObject([
      {
        label: "Auditing dpkg state",
        pkgManager: "apt",
        status: "failed",
      },
    ]);
  });

  test("stores ordered per-step check history with labels and streamed output", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const privilegedSudoPasswords: string[] = [];

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (
      _conn: unknown,
      command: string,
      _timeout?: number,
      sudoPassword?: string,
      onData?: (chunk: string, stream: "stdout" | "stderr") => void,
    ) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        privilegedSudoPasswords.push(sudoPassword ?? "");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
        privilegedSudoPasswords.push(sudoPassword ?? "");
        onData?.("Hit:1 https://deb.debian.org stable InRelease\n", "stdout");
        return { stdout: "ignored-refresh", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt list --upgradable")) {
        onData?.("curl/stable 8.0 amd64 [upgradable from: 7.0]\n", "stdout");
        return {
          stdout: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("apt-get -s -o Debug::NoLocking=1 upgrade")) {
        onData?.("Inst curl [7.0] (8.0 stable [amd64])\n", "stdout");
        return {
          stdout: "Inst curl [7.0] (8.0 stable [amd64])\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await checkUpdates(systemId);

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .at(-1);

    const steps = JSON.parse(history?.steps || "[]");
    expect(steps).toHaveLength(4);
    expect(privilegedSudoPasswords).toEqual(["testpass", "testpass"]);
    expect(history?.startedAt).toBe(steps[0].startedAt);
    expect(history?.completedAt).not.toBe(history?.startedAt);
    expect(steps.map((step: { label: string }) => step.label)).toEqual([
      "Auditing dpkg state",
      "Fetching package lists",
      "Listing available updates",
      "Detecting kept-back packages",
    ]);
    expect(steps[0]).toMatchObject({
      pkgManager: "apt",
      status: "success",
      output: null,
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(steps[1]).toMatchObject({
      pkgManager: "apt",
      status: "success",
      output: "Hit:1 https://deb.debian.org stable InRelease\n",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(steps[2]).toMatchObject({
      command: expect.stringContaining("apt list --upgradable"),
      output: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(steps[3]).toMatchObject({
      command: expect.stringContaining("apt-get -s -o Debug::NoLocking=1 upgrade"),
      output: "Inst curl [7.0] (8.0 stable [amd64])\n",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
  });

  test("fails closed when dnf requires manual trust of a new repository signing key", async () => {
    const db = getDb();
    const systemId = createDnfSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (
      _conn: unknown,
      command: string,
    ) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dnf") && command.includes("check-update")) {
        return {
          stdout: [
            "Importing GPG key 0x51312F3F:",
            'Userid     : "GitLab B.V. (package repository signing key) <packages@gitlab.com>"',
            "Fingerprint: F640 3F65 44A3 8863 DAA0 B6E0 3F01 618A 5131 2F3F",
            "From       : https://packages.gitlab.com/gitlab/gitlab-ce/gpgkey",
            "Is this ok [y/N]: ",
            "---INSTALLED---",
            "EXIT:1",
          ].join("\n"),
          stderr: "",
          exitCode: 1,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await expect(checkUpdates(systemId)).rejects.toThrow(
      "[dnf] DNF update check requires manual trust of a new repository signing key.",
    );

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .at(-1);

    expect(history?.status).toBe("failed");
    expect(history?.packageCount).toBe(0);
    expect(history?.error).toContain("[dnf] DNF update check requires manual trust of a new repository signing key.");
    const steps = JSON.parse(history?.steps || "[]");
    expect(steps).toMatchObject([
      {
        label: "Checking for updates",
        pkgManager: "dnf",
        status: "failed",
      },
    ]);
    expect(steps[0].output).toContain("Importing GPG key 0x51312F3F:");
    expect(steps[0].output).toContain("Is this ok [y/N]:");
    expect(steps[0].error).toContain("manual trust of a new repository signing key");
  });

  test("fails closed when dnf prompt output is returned with wrapped exit 0", async () => {
    const db = getDb();
    const systemId = createDnfSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (
      _conn: unknown,
      command: string,
    ) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dnf") && command.includes("check-update")) {
        return {
          stdout: [
            "Importing OpenPGP key 0x05A12548:",
            ' UserID     : "Linux Update Dashboard Test Repo <devnull@example.invalid>"',
            " Fingerprint: 7F1FD66AB1D9860E5F1E86A06ABAAA7905A12548",
            " From       : file:///opt/localrepo/RPM-GPG-KEY-ludash-test",
            "Is this ok [y/N]: Is this ok [y/N]: ",
            "---INSTALLED---",
            "EXIT:0",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await expect(checkUpdates(systemId)).rejects.toThrow(
      "[dnf] DNF update check requires manual trust of a new repository signing key.",
    );

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .at(-1);

    expect(history?.status).toBe("failed");
    expect(history?.packageCount).toBe(0);
    expect(history?.error).toContain("[dnf] DNF update check requires manual trust of a new repository signing key.");
    const steps = JSON.parse(history?.steps || "[]");
    expect(steps[0]).toMatchObject({
      label: "Checking for updates",
      pkgManager: "dnf",
      status: "failed",
    });
    expect(steps[0].output).toContain("Importing OpenPGP key 0x05A12548:");
    expect(steps[0].output).toContain("EXIT:0");
    expect(steps[0].error).toContain("manual trust of a new repository signing key");
  });

  test("keeps successful apt updates when a second package manager refresh fails", async () => {
    const db = getDb();
    const systemId = createAptAndSnapSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    let snapCheckAttempted = false;

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt list --upgradable")) {
        return {
          stdout: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("apt-get -s -o Debug::NoLocking=1 upgrade")) {
        return {
          stdout: "Inst curl [7.0] (8.0 stable [amd64])\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("snap refresh --list")) {
        snapCheckAttempted = true;
        return {
          stdout: "",
          stderr: "cannot communicate with snapd\n",
          exitCode: 1,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await checkUpdates(systemId);

    expect(snapCheckAttempted).toBe(true);
    expect(result).toMatchObject([
      {
        packageName: "curl",
        pkgManager: "apt",
        isKeptBack: false,
      },
    ]);
    expect(getVisibleCachedUpdates(systemId).map((entry) => entry.packageName)).toEqual(["curl"]);
    expect(getVisibleUpdateSummary(systemId)).toEqual({
      updateCount: 1,
      securityCount: 0,
      keptBackCount: 0,
    });

    const cached = db.select()
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all();

    expect(cached).toHaveLength(1);
    expect(cached[0]).toMatchObject({
      packageName: "curl",
      pkgManager: "apt",
    });

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .at(-1);

    expect(history?.status).toBe("warning");
    expect(history?.packageCount).toBe(1);
    expect(history?.error).toContain("[snap] cannot communicate with snapd");

    const steps = JSON.parse(history?.steps || "[]");
    expect(steps).toMatchObject([
      {
        label: "Auditing dpkg state",
        pkgManager: "apt",
        status: "success",
      },
      {
        label: "Fetching package lists",
        pkgManager: "apt",
        status: "success",
      },
      {
        label: "Listing available updates",
        pkgManager: "apt",
        status: "success",
      },
      {
        label: "Detecting kept-back packages",
        pkgManager: "apt",
        status: "success",
      },
      {
        label: "Checking for updates",
        pkgManager: "snap",
        command: expect.stringContaining("snap refresh --list"),
        status: "failed",
      },
    ]);
  });

  test("keeps kept-back apt packages when filtering is disabled", async () => {
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    let simulationAttempted = false;

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt list --upgradable")) {
        return {
          stdout: [
            "curl/stable 8.0 amd64 [upgradable from: 7.0]",
            "libcamera-ipa/stable 1.0 amd64 [upgradable from: 0.9]",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("apt-get -s -o Debug::NoLocking=1 upgrade")) {
        simulationAttempted = true;
        return {
          stdout: "Inst curl [7.0] (8.0 stable [amd64])\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await checkUpdates(systemId);
    expect(result.map((entry) => entry.packageName)).toEqual(["curl", "libcamera-ipa"]);
    expect(result.find((entry) => entry.packageName === "curl")?.isKeptBack).toBe(false);
    expect(result.find((entry) => entry.packageName === "libcamera-ipa")?.isKeptBack).toBe(true);
    expect(simulationAttempted).toBe(true);

    const cached = getDb()
      .select({ packageName: updateCache.packageName, isKeptBack: updateCache.isKeptBack })
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all()
      .sort((left, right) => left.packageName.localeCompare(right.packageName));

    expect(cached).toEqual([
      { packageName: "curl", isKeptBack: 0 },
      { packageName: "libcamera-ipa", isKeptBack: 1 },
    ]);
  });

  test("auto-hides kept-back apt packages when the system setting is enabled", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    db.update(systems)
      .set({ autoHideKeptBackUpdates: 1 })
      .where(eq(systems.id, systemId))
      .run();

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt list --upgradable")) {
        return {
          stdout: [
            "curl/stable 8.0 amd64 [upgradable from: 7.0]",
            "libcamera-ipa/stable 1.0 amd64 [upgradable from: 0.9]",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("apt-get -s -o Debug::NoLocking=1 upgrade")) {
        return {
          stdout: "Inst curl [7.0] (8.0 stable [amd64])\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await checkUpdates(systemId);

    expect(result.map((entry) => entry.packageName)).toEqual(["curl", "libcamera-ipa"]);
    expect(getVisibleCachedUpdates(systemId).map((entry) => entry.packageName)).toEqual(["curl"]);
    expect(getVisibleUpdateSummary(systemId)).toEqual({
      updateCount: 1,
      securityCount: 0,
      keptBackCount: 0,
    });

    const hidden = db
      .select({
        packageName: hiddenUpdates.packageName,
        isKeptBack: hiddenUpdates.isKeptBack,
        hideReason: hiddenUpdates.hideReason,
        active: hiddenUpdates.active,
      })
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.systemId, systemId))
      .all();

    expect(hidden).toEqual([
      { packageName: "libcamera-ipa", isKeptBack: 1, hideReason: "kept_back", active: 1 },
    ]);
  });

  test("returns formerly kept-back packages when a later APT check can install them", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    let phase = 0;

    db.update(systems)
      .set({ autoHideKeptBackUpdates: 1 })
      .where(eq(systems.id, systemId))
      .run();

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt list --upgradable")) {
        return {
          stdout: [
            "curl/stable 8.0 amd64 [upgradable from: 7.0]",
            "apport/stable 2.0 amd64 [upgradable from: 1.0]",
            "python3-apport/stable 2.0 amd64 [upgradable from: 1.0]",
            "fwupd/stable 2.0 amd64 [upgradable from: 1.0]",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("apt-get -s -o Debug::NoLocking=1 upgrade")) {
        return {
          stdout: phase === 0
            ? "Inst curl [7.0] (8.0 stable [amd64])\n"
            : [
                "Inst curl [7.0] (8.0 stable [amd64])",
                "Inst apport [1.0] (2.0 stable [amd64])",
                "Inst python3-apport [1.0] (2.0 stable [amd64])",
              ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await checkUpdates(systemId);
    expect(getVisibleCachedUpdates(systemId).map((entry) => entry.packageName)).toEqual(["curl"]);

    phase = 1;
    await checkUpdates(systemId);

    expect(getVisibleCachedUpdates(systemId).map((entry) => entry.packageName)).toEqual([
      "apport",
      "curl",
      "python3-apport",
    ]);
    expect(getVisibleUpdateSummary(systemId)).toEqual({
      updateCount: 3,
      securityCount: 0,
      keptBackCount: 0,
    });
    expect(db
      .select({ packageName: hiddenUpdates.packageName })
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.active, 1))
      .all())
      .toEqual([{ packageName: "fwupd" }]);
  });

  test("stores installed packages and preserves the previous snapshot when inventory refresh fails", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    let inventoryFailure = false;

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt list --upgradable")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -s -o Debug::NoLocking=1 upgrade")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg-query -W")) {
        return inventoryFailure
          ? { stdout: "", stderr: "dpkg-query failed", exitCode: 1 }
          : { stdout: "curl\t8.0\tamd64\nbash\t5.2\tamd64\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await checkUpdates(systemId);
    expect(db.select()
      .from(installedPackageCache)
      .where(eq(installedPackageCache.systemId, systemId))
      .all()
      .map((pkg) => pkg.packageName)
      .sort()).toEqual(["bash", "curl"]);

    inventoryFailure = true;
    await checkUpdates(systemId);

    expect(db.select()
      .from(installedPackageCache)
      .where(eq(installedPackageCache.systemId, systemId))
      .all()
      .map((pkg) => pkg.packageName)
      .sort()).toEqual(["bash", "curl"]);

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .at(-1);
    expect(history?.status).toBe("warning");
    expect(history?.error).toContain("[apt installed packages] dpkg-query failed");
  });
  test("delivers secret config entries over stdin without storing them in history", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    const token = "ghp_checkTestTokenValue123456";
    createCustomPackageManager({
      name: "release-tool",
      label: "release-tool",
      configEntries: [{ key: "githubToken", defaultValue: "", secret: true, envVar: "RELEASE_TOOL_TOKEN", sudoEnvKeep: true }],
    });
    createScript({
      name: "Check release-tool",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "release-tool",
      isDefault: true,
      steps: [{ label: "Check release-tool", command: "{{sudo:release-tool-check}}" }],
      parserConfig: {
        updateRegex: "^LUDASH_UPDATE\\s+(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)\\s+(?<newVersion>\\S+)$",
      },
    });
    const secretId = createCredential({ name: "token", kind: "secret", payload: { value: token } });
    db.update(systems)
      .set({
        pkgManager: "release-tool",
        detectedPkgManagers: JSON.stringify(["release-tool"]),
        pkgManagerSecretRefs: JSON.stringify({ "release-tool": { githubToken: secretId } }),
      })
      .where(eq(systems.id, systemId))
      .run();

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const secretEnvVars: string[][] = [];
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (
      _conn: unknown,
      command: string,
      _timeout?: number,
      _sudoPassword?: string,
      _onData?: unknown,
      _signal?: unknown,
      options?: RunCommandOptions,
    ) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("release-tool-check")) {
        secretEnvVars.push(options?.secretInput?.envVars ?? []);
        expect(command).not.toContain(token);
        return { stdout: "LUDASH_UPDATE obsidian 1.12.7 1.13.4\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const updates = await checkUpdates(systemId);

    expect(updates.map((update) => update.packageName)).toEqual(["obsidian"]);
    expect(secretEnvVars).toEqual([["RELEASE_TOOL_TOKEN"]]);
    const history = db.select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    const serializedHistory = JSON.stringify(history);
    expect(serializedHistory).toContain("Secret environment (via stdin): RELEASE_TOOL_TOKEN");
    expect(serializedHistory).not.toContain(token);
  });
});
