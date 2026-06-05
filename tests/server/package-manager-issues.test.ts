import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, packageManagerIssues, systems } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";
import { checkUpdates, solvePackageManagerIssue } from "../../server/services/update-service";
import {
  dismissPackageManagerIssue,
  listVisiblePackageManagerIssues,
  upsertPackageManagerIssue,
} from "../../server/services/package-manager-issue-service";
import { createSystem } from "../../server/services/system-service";
import {
  buildOperationKey,
  createCustomPackageManager,
  createScript,
  setSystemOverrides,
} from "../../server/services/script-service";

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
===UPTIME_SECONDS===
3600
===ARCH===
x86_64
===CPU===
2
===MEM===
Mem:           1.9Gi       512Mi       1.0Gi
===DISK===
/dev/root        20G    5G   14G  27% /
===BOOT_ID===
boot-a
===REBOOT_FILE===
ABSENT
===NEEDS_RESTARTING===
0
===INSTALLED_KERNELS===
6.1.0
`;

describe("package manager issues", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-package-issues-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createAptSystem(): number {
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
      sudoPassword: "testpass",
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

  function createDnfSystem(): number {
    return getDb().insert(systems).values({
      name: "Fedora",
      hostname: "fedora.local",
      port: 22,
      authType: "password",
      username: "root",
      hostKeyVerificationEnabled: 0,
      pkgManager: "dnf",
      detectedPkgManagers: JSON.stringify(["dnf"]),
    }).returning({ id: systems.id }).get().id;
  }

  function createCustomSystem(): number {
    const systemId = getDb().insert(systems).values({
      name: "Brew",
      hostname: "brew.local",
      port: 22,
      authType: "password",
      username: "root",
      hostKeyVerificationEnabled: 0,
      pkgManager: "brewlinux",
      detectedPkgManagers: JSON.stringify(["brewlinux"]),
    }).returning({ id: systems.id }).get().id;

    createCustomPackageManager({
      name: "brewlinux",
      label: "Linuxbrew",
    });
    createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew check" }],
    });
    createScript({
      name: "Repair Linuxbrew",
      type: "package_manager",
      operation: "repair_issue",
      pkgManager: "brewlinux",
      steps: [{ label: "Repair", command: "brew repair" }],
      parserConfig: {
        issueRegex: "database needs repair",
        issueTitle: "Linuxbrew needs repair",
        issueMessage: "Linuxbrew database needs repair before updates can be checked.",
      },
    });

    return systemId;
  }

  test("detects interrupted dpkg from apt check failures", async () => {
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return {
          stdout: "dpkg was interrupted, you must manually run 'sudo dpkg --configure -a' to correct the problem.\n",
          stderr: "",
          exitCode: 100,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await expect(checkUpdates(systemId)).rejects.toThrow("[apt] dpkg was interrupted");

    const issues = listVisiblePackageManagerIssues(systemId);
    expect(issues).toMatchObject([
      {
        pkgManager: "apt",
        issueKey: "apt_dpkg_interrupted",
        active: 1,
      },
    ]);
    expect(issues[0].repairCommand).toContain("dpkg --configure -a");
  });

  test("does not detect interrupted dpkg when apt audit cannot read dpkg state", async () => {
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return {
          stdout: "dpkg: error: unable to check lock file for dpkg database directory /var/lib/dpkg: Permission denied\n",
          stderr: "",
          exitCode: 2,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await expect(checkUpdates(systemId)).rejects.toThrow("Permission denied");

    expect(listVisiblePackageManagerIssues(systemId)).toHaveLength(0);
  });

  test("detects interrupted dpkg from successful apt audit output while keeping updates", async () => {
    const systemId = createAptSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dpkg --audit")) {
        return {
          stdout: "dpkg was interrupted, you must manually run 'sudo dpkg --configure -a' to correct the problem.\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command.includes("apt list --upgradable")) {
        return {
          stdout: "curl/oldstable 8.0 amd64 [upgradable from: 7.0]\n",
          stderr: "",
          exitCode: 0,
        };
      }
      if (command.includes("apt-get -s -o Debug::NoLocking=1 upgrade")) {
        return {
          stdout: "Inst curl [7.0] (8.0 oldstable [amd64])\n",
          stderr: "",
          exitCode: 0,
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const updates = await checkUpdates(systemId);

    expect(updates).toMatchObject([{ packageName: "curl", pkgManager: "apt" }]);
    expect(listVisiblePackageManagerIssues(systemId)).toMatchObject([
      {
        pkgManager: "apt",
        issueKey: "apt_dpkg_interrupted",
        active: 1,
      },
    ]);
  });

  test("dismisses package manager issues for the current boot and expires after reboot", () => {
    const db = getDb();
    const systemId = createAptSystem();
    db.update(systems)
      .set({ bootId: "boot-a", uptimeSeconds: 3600 })
      .where(eq(systems.id, systemId))
      .run();
    const issue = upsertPackageManagerIssue(systemId, {
      pkgManager: "apt",
      issueKey: "apt_dpkg_interrupted",
      title: "APT needs repair",
      message: "dpkg was interrupted",
      repairCommand: "dpkg --configure -a",
    });

    dismissPackageManagerIssue(systemId, issue.id);
    expect(listVisiblePackageManagerIssues(systemId)).toHaveLength(0);

    db.update(systems)
      .set({ bootId: "boot-b", uptimeSeconds: 60 })
      .where(eq(systems.id, systemId))
      .run();
    expect(listVisiblePackageManagerIssues(systemId)).toHaveLength(1);
  });

  test("detects dnf signing-key prompts as package manager issues", async () => {
    const systemId = createDnfSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command.includes("dnf") && command.includes("check-update")) {
        return {
          stdout: [
            "Importing GPG key 0x51312F3F:",
            "Fingerprint: F640 3F65 44A3 8863 DAA0 B6E0 3F01 618A 5131 2F3F",
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
      "[dnf] DNF update check requires manual trust",
    );

    expect(listVisiblePackageManagerIssues(systemId)).toMatchObject([
      {
        pkgManager: "dnf",
        issueKey: "dnf_repo_key_prompt",
        active: 1,
      },
    ]);
  });

  test("detects and solves custom package manager issues through configured repair scripts", async () => {
    const systemId = createCustomSystem();
    let repaired = false;
    const commands: string[] = [];
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());

    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      if (command === SYSTEM_INFO_CMD) {
        return { stdout: SYSTEM_INFO_OUTPUT, stderr: "", exitCode: 0 };
      }
      if (command === "brew check") {
        return repaired
          ? { stdout: "", stderr: "", exitCode: 0 }
          : { stdout: "database needs repair\n", stderr: "", exitCode: 1 };
      }
      if (command === "brew repair") {
        repaired = true;
        return { stdout: "repaired\n", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    await expect(checkUpdates(systemId)).rejects.toThrow(
      "[brewlinux] Linuxbrew database needs repair",
    );

    const [issue] = listVisiblePackageManagerIssues(systemId);
    expect(issue).toMatchObject({
      pkgManager: "brewlinux",
      issueKey: "custom_issue_detected",
      title: "Linuxbrew needs repair",
      message: "Linuxbrew database needs repair before updates can be checked.",
      active: 1,
    });

    const result = await solvePackageManagerIssue(systemId, issue.id);

    expect(result.success).toBe(true);
    expect(commands).toContain("brew repair");
    expect(listVisiblePackageManagerIssues(systemId)).toHaveLength(0);
  });

  test("solves apt dpkg issues by running repair and rechecking", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    db.update(systems)
      .set({ bootId: "boot-a", uptimeSeconds: 3600 })
      .where(eq(systems.id, systemId))
      .run();
    const issue = upsertPackageManagerIssue(systemId, {
      pkgManager: "apt",
      issueKey: "apt_dpkg_interrupted",
      title: "APT needs repair",
      message: "dpkg was interrupted",
      repairCommand: "dpkg --configure -a",
    });

    const commands: string[] = [];
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      if (command.includes("dpkg --configure -a")) {
        return { stdout: "Setting up packages\n", stderr: "", exitCode: 0 };
      }
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

    const result = await solvePackageManagerIssue(systemId, issue.id);

    expect(result.success).toBe(true);
    expect(commands.some((command) => command.includes("dpkg --configure -a"))).toBe(true);
    expect(commands.some((command) => command.includes("apt list --upgradable"))).toBe(true);
    const row = db.select().from(packageManagerIssues).where(eq(packageManagerIssues.id, issue.id)).get();
    expect(row?.active).toBe(0);
  });

  test("solves package manager issues through the configured repair script override", async () => {
    const db = getDb();
    const systemId = createAptSystem();
    db.update(systems)
      .set({ bootId: "boot-a", uptimeSeconds: 3600 })
      .where(eq(systems.id, systemId))
      .run();
    const script = createScript({
      name: "Custom APT repair",
      type: "package_manager",
      operation: "repair_issue",
      pkgManager: "apt",
      steps: [{ label: "Custom repair", command: "echo custom-repair" }],
    });
    setSystemOverrides(systemId, {
      [buildOperationKey("repair_issue", "apt")]: script.id,
    });
    const issue = upsertPackageManagerIssue(systemId, {
      pkgManager: "apt",
      issueKey: "apt_dpkg_interrupted",
      title: "APT needs repair",
      message: "dpkg was interrupted",
      repairCommand: "dpkg --configure -a",
    });

    const commands: string[] = [];
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      if (command === "echo custom-repair") {
        return { stdout: "custom-repair\n", stderr: "", exitCode: 0 };
      }
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

    const result = await solvePackageManagerIssue(systemId, issue.id);

    expect(result.success).toBe(true);
    expect(commands[0]).toBe("echo custom-repair");
  });
});
