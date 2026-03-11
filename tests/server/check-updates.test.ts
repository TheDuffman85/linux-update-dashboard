import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, systems, updateCache, updateHistory } from "../../server/db/schema";
import { logger } from "../../server/logger";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { checkUpdates } from "../../server/services/update-service";
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
  let originalWarn: typeof logger.warn;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-check-updates-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    originalWarn = logger.warn;
  });

  afterEach(() => {
    logger.warn = originalWarn;
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createAptSystem(options?: {
    sudoPassword?: string;
    ignoreKeptBackPackages?: boolean;
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
      name: options?.ignoreKeptBackPackages ? "Debian Filtered" : "Debian",
      hostname: "127.0.0.1",
      port: 22,
      credentialId,
      sudoPassword: options?.sudoPassword ?? "testpass",
      hostKeyVerificationEnabled: false,
      ignoreKeptBackPackages: options?.ignoreKeptBackPackages ?? false,
    });

    db.update(systems)
      .set({
        pkgManager: "apt",
        detectedPkgManagers: JSON.stringify(["apt"]),
        ignoreKeptBackPackages: options?.ignoreKeptBackPackages ? 1 : 0,
      })
      .where(eq(systems.id, systemId))
      .run();

    return systemId;
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
  });

  test("keeps kept-back apt packages when filtering is disabled", async () => {
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

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
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await checkUpdates(systemId);
    expect(result.map((entry) => entry.packageName)).toEqual(["curl", "libcamera-ipa"]);

    const cached = getDb()
      .select({ packageName: updateCache.packageName })
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all()
      .map((entry) => entry.packageName)
      .sort();

    expect(cached).toEqual(["curl", "libcamera-ipa"]);
  });

  test("filters kept-back apt packages when enabled", async () => {
    const systemId = createAptSystem({ ignoreKeptBackPackages: true });
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

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
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 -s upgrade")) {
        return {
          stdout: [
            "Reading package lists...",
            "The following packages have been kept back:",
            "  libcamera-ipa",
            "1 upgraded, 0 newly installed, 0 to remove and 1 not upgraded.",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await checkUpdates(systemId);
    expect(result.map((entry) => entry.packageName)).toEqual(["curl"]);

    const cached = getDb()
      .select({ packageName: updateCache.packageName })
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all()
      .map((entry) => entry.packageName);

    expect(cached).toEqual(["curl"]);
  });

  test("keeps unfiltered apt packages when kept-back detection fails", async () => {
    const systemId = createAptSystem({ ignoreKeptBackPackages: true });
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const warnings: string[] = [];
    logger.warn = (msg: string) => {
      warnings.push(msg);
    };

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
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 -s upgrade")) {
        return {
          stdout: "E: Could not get lock",
          stderr: "",
          exitCode: 100,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await checkUpdates(systemId);
    expect(result.map((entry) => entry.packageName)).toEqual(["curl", "libcamera-ipa"]);
    expect(warnings).toContain("APT kept-back detection failed");
  });
});
