import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, hiddenUpdates, systems, updateCache, updateHistory } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { checkUpdates } from "../../server/services/update-service";
import { getVisibleCachedUpdates, getVisibleUpdateSummary } from "../../server/services/hidden-update-service";
import { createSystem } from "../../server/services/system-service";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";

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
      hostKeyVerificationEnabled: false,
      pkgManager: "dnf",
      detectedPkgManagers: JSON.stringify(["dnf"]),
      pkgManagerConfigs: options?.pkgManagerConfigs ? JSON.stringify(options.pkgManagerConfigs) : null,
    }).returning({ id: systems.id }).get().id;
  }

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
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
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
        label: "Fetching package lists",
        pkgManager: "apt",
        status: "failed",
      },
    ]);
  });

  test("stores ordered per-step check history with labels and streamed output", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (
      _conn: unknown,
      command: string,
      _timeout?: number,
      _sudoPassword?: string,
      onData?: (chunk: string, stream: "stdout" | "stderr") => void,
    ) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
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
    expect(steps).toHaveLength(3);
    expect(history?.startedAt).toBe(steps[0].startedAt);
    expect(history?.completedAt).not.toBe(history?.startedAt);
    expect(steps.map((step: { label: string }) => step.label)).toEqual([
      "Fetching package lists",
      "Listing available updates",
      "Detecting kept-back packages",
    ]);
    expect(steps[0]).toMatchObject({
      pkgManager: "apt",
      status: "success",
      output: "Hit:1 https://deb.debian.org stable InRelease\n",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(steps[1]).toMatchObject({
      command: expect.stringContaining("apt list --upgradable"),
      output: "curl/stable 8.0 amd64 [upgradable from: 7.0]\n",
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
    expect(steps[2]).toMatchObject({
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
      if (command.includes("dnf check-update --quiet 2>&1")) {
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
      if (command.includes("dnf check-update --quiet 2>&1")) {
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
        active: hiddenUpdates.active,
      })
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.systemId, systemId))
      .all();

    expect(hidden).toEqual([
      { packageName: "libcamera-ipa", isKeptBack: 1, active: 1 },
    ]);
  });
});
