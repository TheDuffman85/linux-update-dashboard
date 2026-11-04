import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, systems, updateCache, updateHistory } from "../../server/db/schema";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";
import { applyUpgradePackages, validateSelectedPackageUpgradeRequest } from "../../server/services/update-service";
import { createSystem } from "../../server/services/system-service";

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

function createPasswordSystem(options?: {
  pkgManager?: string;
  detectedPkgManagers?: string[];
}): number {
  const db = getDb();
  const encryptor = getEncryptor();
  const credentialId = db.insert(credentials).values({
    name: "Test password",
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
    sudoPassword: "testpass",
    hostKeyVerificationEnabled: false,
  });

  db.update(systems)
    .set({
      pkgManager: options?.pkgManager ?? "apt",
      detectedPkgManagers: JSON.stringify(options?.detectedPkgManagers ?? ["apt"]),
    })
    .where(eq(systems.id, systemId))
    .run();

  return systemId;
}

function seedCachedUpdate(systemId: number, input: {
  pkgManager: string;
  packageName: string;
  currentVersion?: string;
  newVersion?: string;
  repository?: string | null;
}) {
  getDb().insert(updateCache).values({
    systemId,
    pkgManager: input.pkgManager,
    packageName: input.packageName,
    currentVersion: input.currentVersion ?? "1.0",
    newVersion: input.newVersion ?? "1.1",
    architecture: null,
    repository: input.repository ?? null,
    isSecurity: 0,
    isKeptBack: 0,
  }).run();
}

describe("selected package upgrades", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-selected-package-upgrade-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("applies a single selected package through the canonical bulk service", async () => {
    const systemId = createPasswordSystem();
    seedCachedUpdate(systemId, { pkgManager: "apt", packageName: "curl", repository: "stable" });

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const persistentCommands: string[] = [];

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runPersistentCommand = async (
      _conn: unknown,
      command: string,
      _timeout?: number,
      _sudoPassword?: string,
      onData?: (chunk: string, stream: "stdout" | "stderr") => void,
    ) => {
      persistentCommands.push(command);
      expect(command).toContain("install --only-upgrade -y curl");
      onData?.("Upgrading curl\n", "stdout");
      return {
        stdout: "curl upgraded",
        stderr: "",
        exitCode: 0,
      };
    };
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
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await applyUpgradePackages(systemId, ["curl"]);

    expect(result.success).toBe(true);
    expect(persistentCommands).toHaveLength(1);

    const historyRows = getDb()
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .filter((entry) => entry.action === "upgrade_package");

    expect(historyRows).toHaveLength(1);
    expect(historyRows[0]).toMatchObject({
      status: "success",
      packageCount: 1,
      packages: JSON.stringify(["curl"]),
    });
    expect(historyRows[0]?.command).toContain("install --only-upgrade -y curl");
  });

  test("groups selected packages by package manager and records the full selection on each step", async () => {
    const systemId = createPasswordSystem({
      pkgManager: "apt",
      detectedPkgManagers: ["apt", "snap"],
    });
    seedCachedUpdate(systemId, { pkgManager: "apt", packageName: "curl", repository: "stable" });
    seedCachedUpdate(systemId, { pkgManager: "snap", packageName: "firefox", repository: "snap" });

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const persistentCommands: string[] = [];

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runPersistentCommand = async (
      _conn: unknown,
      command: string,
      _timeout?: number,
      _sudoPassword?: string,
      onData?: (chunk: string, stream: "stdout" | "stderr") => void,
    ) => {
      persistentCommands.push(command);
      onData?.(`Running ${command}\n`, "stdout");
      if (command.includes("apt-get")) {
        return { stdout: "apt upgraded", stderr: "", exitCode: 0 };
      }
      if (command.includes("snap refresh")) {
        return { stdout: "snap upgraded", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected persistent command: ${command}`);
    };
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
      if (command.includes('echo "===INSTALLED==="; snap list --color=never')) {
        return {
          stdout: "===INSTALLED===\nName Version Rev Publisher Notes\n===UPDATES===\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = await applyUpgradePackages(systemId, ["curl", "firefox"]);

    expect(result.success).toBe(true);
    expect(persistentCommands).toHaveLength(2);
    expect(persistentCommands[0]).toContain("curl");
    expect(persistentCommands[1]).toContain("firefox");

    const historyRows = getDb()
      .select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, systemId))
      .all()
      .filter((entry) => entry.action === "upgrade_package");

    expect(historyRows).toHaveLength(2);
    expect(historyRows.map((entry) => entry.pkgManager).sort()).toEqual(["apt", "snap"]);
    for (const row of historyRows) {
      expect(row.packageCount).toBe(2);
      expect(row.packages).toBe(JSON.stringify(["curl", "firefox"]));
      expect(row.status).toBe("success");
    }
  });

  test.each(["apk", "pacman", "flatpak", "snap", "deb-get"])(
    "refuses to upgrade a pinned %s package by name",
    async (pkgManager) => {
      const systemId = createPasswordSystem({ pkgManager, detectedPkgManagers: [pkgManager] });
      getDb().insert(updateCache).values([
        { systemId, pkgManager, packageName: "pinned-pkg", currentVersion: "1", newVersion: "2", isKeptBack: 1 },
        { systemId, pkgManager, packageName: "free-pkg", currentVersion: "1", newVersion: "2", isKeptBack: 0 },
      ]).run();

      const result = await applyUpgradePackages(systemId, ["free-pkg", "pinned-pkg"]);

      expect(result.success).toBe(false);
      expect(result.output).toContain("pinned or held");
      expect(result.output).toContain("pinned-pkg");
      expect(result.output).not.toContain("free-pkg");
      expect(() => validateSelectedPackageUpgradeRequest(systemId, ["pinned-pkg"])).toThrow("pinned or held");
      expect(validateSelectedPackageUpgradeRequest(systemId, ["free-pkg"]).packageNames).toEqual(["free-pkg"]);
    },
  );

  test("refuses a pinned name even when another manager offers it unpinned", () => {
    const systemId = createPasswordSystem({ pkgManager: "apt", detectedPkgManagers: ["apt", "pacman"] });
    getDb().insert(updateCache).values([
      { systemId, pkgManager: "apt", packageName: "foo", currentVersion: "1", newVersion: "2", isKeptBack: 0 },
      { systemId, pkgManager: "pacman", packageName: "foo", currentVersion: "1", newVersion: "2", isKeptBack: 1 },
    ]).run();

    expect(() => validateSelectedPackageUpgradeRequest(systemId, ["foo"])).toThrow("pinned or held");
  });

  test("still allows upgrading a kept-back APT package by name", () => {
    const systemId = createPasswordSystem();
    getDb().insert(updateCache).values({
      systemId, pkgManager: "apt", packageName: "kept", currentVersion: "1", newVersion: "2", isKeptBack: 1,
    }).run();

    expect(validateSelectedPackageUpgradeRequest(systemId, ["kept"]).packageNames).toEqual(["kept"]);
  });
});
