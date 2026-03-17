import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateCache } from "../../server/db/schema";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { applyFullUpgradeAll, applyUpgradeAll, checkUpdates } from "../../server/services/update-service";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";

const SYSTEM_INFO_OUTPUT = `===OS===
NAME="Debian GNU/Linux"
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
VERSION_ID="12"
===KERNEL===
6.1.0
===HOSTNAME===
config-test
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

describe("update service package manager configs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-pm-configs-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function insertSystem(data: {
    pkgManager: string;
    pkgManagerConfigs?: Record<string, unknown>;
  }): number {
    return getDb().insert(systems).values({
      name: `${data.pkgManager}-system`,
      hostname: `${data.pkgManager}.local`,
      port: 22,
      authType: "password",
      username: "root",
      pkgManager: data.pkgManager,
      detectedPkgManagers: JSON.stringify([data.pkgManager]),
      pkgManagerConfigs: data.pkgManagerConfigs ? JSON.stringify(data.pkgManagerConfigs) : null,
    }).returning({ id: systems.id }).get().id;
  }

  test("applyUpgradeAll uses configured apt and dnf upgrade defaults", async () => {
    const db = getDb();
    const aptSystemId = insertSystem({
      pkgManager: "apt",
      pkgManagerConfigs: {
        apt: { defaultUpgradeMode: "full-upgrade" },
      },
    });
    const dnfSystemId = insertSystem({
      pkgManager: "dnf",
      pkgManagerConfigs: {
        dnf: { defaultUpgradeMode: "distro-sync" },
      },
    });

    db.insert(updateCache).values([
      { systemId: aptSystemId, pkgManager: "apt", packageName: "curl", newVersion: "2.0" },
      { systemId: dnfSystemId, pkgManager: "dnf", packageName: "curl", newVersion: "2.0" },
    ]).run();

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const commands: string[] = [];
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runPersistentCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
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
      if (command.includes("dnf check-update --quiet")) {
        return { stdout: "EXIT:0\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await applyUpgradeAll(aptSystemId);
    await applyUpgradeAll(dnfSystemId);

    expect(commands.some((command) => command.includes("apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y"))).toBe(true);
    expect(commands.some((command) => command.includes("dnf distro-sync -y"))).toBe(true);
  });

  test("applyFullUpgradeAll still forces full-upgrade semantics", async () => {
    const db = getDb();
    const systemId = insertSystem({
      pkgManager: "apt",
      pkgManagerConfigs: {
        apt: { defaultUpgradeMode: "upgrade" },
      },
    });
    db.insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "curl",
      newVersion: "2.0",
    }).run();

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const commands: string[] = [];
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runPersistentCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
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

    await applyFullUpgradeAll(systemId);

    expect(commands.some((command) => command.includes("apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y"))).toBe(true);
  });

  test("checkUpdates threads package-manager refresh config into commands", async () => {
    const dnfSystemId = insertSystem({
      pkgManager: "dnf",
      pkgManagerConfigs: {
        dnf: { refreshMetadataOnCheck: true },
      },
    });
    const pacmanSystemId = insertSystem({
      pkgManager: "pacman",
      pkgManagerConfigs: {
        pacman: { refreshDatabasesOnCheck: false },
      },
    });
    const apkSystemId = insertSystem({
      pkgManager: "apk",
      pkgManagerConfigs: {
        apk: { refreshIndexesOnCheck: false },
      },
    });
    const flatpakSystemId = insertSystem({
      pkgManager: "flatpak",
      pkgManagerConfigs: {
        flatpak: { refreshAppstreamOnCheck: false },
      },
    });

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    const commands: string[] = [];
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (
      _conn: unknown,
      command: string,
      _timeout?: number,
      _sudoPassword?: string,
      _onData?: (chunk: string, stream: "stdout" | "stderr") => void,
    ) => {
      commands.push(command);
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dnf check-update --refresh --quiet")) {
        return { stdout: "EXIT:0\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("pacman -Qu")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apk list -u")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("flatpak remote-ls --updates")) {
        return { stdout: "===INSTALLED===\n===UPDATES===\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await checkUpdates(dnfSystemId);
    expect(commands.some((command) => command.includes("dnf check-update --refresh --quiet"))).toBe(true);

    commands.length = 0;
    await checkUpdates(pacmanSystemId);
    expect(commands.some((command) => command.includes("pacman -Sy"))).toBe(false);

    commands.length = 0;
    await checkUpdates(apkSystemId);
    expect(commands.some((command) => command.includes("apk update"))).toBe(false);

    commands.length = 0;
    await checkUpdates(flatpakSystemId);
    expect(commands.some((command) => command.includes("flatpak update --appstream"))).toBe(false);
  });
});
