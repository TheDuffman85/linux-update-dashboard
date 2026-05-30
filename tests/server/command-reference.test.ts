import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCommandReference, normalizeCommandForSudoers } from "../../server/services/command-reference";
import { getPackageManagerDetectionCommands } from "../../server/ssh/detector";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";
import { getRebootCommand } from "../../server/ssh/reboot";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { buildOperationKey, createCustomPackageManager, createScript, setSystemOverrides } from "../../server/services/script-service";

function createSystem(overrides?: Partial<{
  id: number | null;
  pkgManager: string | null;
  detectedPkgManagers: string | null;
  disabledPkgManagers: string | null;
  pkgManagerConfigs: string | null;
}>) {
  return {
    pkgManager: "apt",
    detectedPkgManagers: JSON.stringify(["apt"]),
    disabledPkgManagers: null,
    pkgManagerConfigs: null,
    ...overrides,
  };
}

describe("buildCommandReference", () => {
  test("reuses detection, system-info, parser, and reboot builders for exact commands", () => {
    const reference = buildCommandReference(createSystem());

    expect(reference.exact.find((entry) => entry.id === "system-info")?.command).toBe(SYSTEM_INFO_CMD);
    expect(reference.exact.find((entry) => entry.id === "reboot")?.command).toBe(getRebootCommand());
    expect(reference.exact.some((entry) =>
      entry.category === "reboot" &&
      entry.id === "reboot:0" &&
      entry.command.includes("pvesh get /cluster/tasks --output-format json")
    )).toBe(true);

    for (const detection of getPackageManagerDetectionCommands()) {
      expect(reference.exact.some((entry) => entry.id === `detection:${detection.name}` && entry.command.includes(detection.command))).toBe(true);
    }

    expect(reference.exact.some((entry) => entry.command.includes("apt-get -o DPkg::Lock::Timeout=60 update -qq"))).toBe(true);
    expect(reference.exact.some((entry) => entry.command.includes("apt list --upgradable"))).toBe(true);
    expect(reference.exact.some((entry) => entry.command.includes("apt-get -o DPkg::Lock::Timeout=60 upgrade -y"))).toBe(true);
    expect(reference.exact.some((entry) => entry.command.includes("apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y"))).toBe(true);
    expect(reference.exact.some((entry) => entry.command.includes("install --only-upgrade -y <package>"))).toBe(true);
    expect(reference.exact.some((entry) => entry.command.includes("install --only-upgrade -y <package1> <package2>"))).toBe(true);
  });

  test("threads manager-specific config into generated commands", () => {
    const aptReference = buildCommandReference(createSystem({
      pkgManagerConfigs: JSON.stringify({
        apt: { defaultUpgradeMode: "full-upgrade" },
      }),
    }));
    expect(aptReference.exact.some((entry) =>
      entry.category === "upgrade_all" &&
      entry.command.includes("apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y")
    )).toBe(true);

    const dnfReference = buildCommandReference(createSystem({
      pkgManager: "dnf",
      detectedPkgManagers: JSON.stringify(["dnf"]),
      pkgManagerConfigs: JSON.stringify({
        dnf: {
          refreshMetadataOnCheck: true,
          autoAcceptNewSigningKeysOnCheck: true,
          defaultUpgradeMode: "distro-sync",
          autoAcceptEulaOnUpgrade: true,
        },
      }),
    }));
    expect(dnfReference.exact.some((entry) =>
      entry.category === "check" &&
      entry.command.includes("sudo -S -p '' dnf -y check-update --refresh --quiet")
    )).toBe(true);
    expect(dnfReference.exact.some((entry) =>
      entry.category === "upgrade_all" &&
      entry.command.includes("env ACCEPT_EULA=Y dnf distro-sync -y")
    )).toBe(true);
    expect(dnfReference.exact.some((entry) =>
      entry.category === "upgrade_selected" &&
      entry.command.includes("env ACCEPT_EULA=Y dnf upgrade -y <package>")
    )).toBe(true);

    const yumReference = buildCommandReference(createSystem({
      pkgManager: "yum",
      detectedPkgManagers: JSON.stringify(["yum"]),
      pkgManagerConfigs: JSON.stringify({
        yum: {
          autoAcceptNewSigningKeysOnCheck: true,
          autoAcceptEulaOnUpgrade: true,
        },
      }),
    }));
    expect(yumReference.exact.some((entry) => entry.category === "check" && entry.command.includes("sudo -S -p '' yum -y check-update --quiet"))).toBe(true);
    expect(yumReference.exact.some((entry) =>
      entry.category === "upgrade_all" &&
      entry.command.includes("env ACCEPT_EULA=Y yum update -y")
    )).toBe(true);
    expect(yumReference.exact.some((entry) =>
      entry.category === "upgrade_selected" &&
      entry.command.includes("env ACCEPT_EULA=Y yum update -y <package>")
    )).toBe(true);

    const pacmanReference = buildCommandReference(createSystem({
      pkgManager: "pacman",
      detectedPkgManagers: JSON.stringify(["pacman"]),
      pkgManagerConfigs: JSON.stringify({
        pacman: { refreshDatabasesOnCheck: false },
      }),
    }));
    expect(pacmanReference.exact.filter((entry) => entry.category === "check" && entry.pkgManager === "pacman")).toHaveLength(2);
    expect(pacmanReference.exact.some((entry) => entry.command.includes('if [ "false" != "false" ]; then') && entry.command.includes("pacman -Sy"))).toBe(true);

    const apkReference = buildCommandReference(createSystem({
      pkgManager: "apk",
      detectedPkgManagers: JSON.stringify(["apk"]),
      pkgManagerConfigs: JSON.stringify({
        apk: { refreshIndexesOnCheck: false },
      }),
    }));
    expect(apkReference.exact.filter((entry) => entry.category === "check" && entry.pkgManager === "apk")).toHaveLength(2);
    expect(apkReference.exact.some((entry) => entry.command.includes('if [ "false" != "false" ]; then') && entry.command.includes("apk update"))).toBe(true);

    const flatpakReference = buildCommandReference(createSystem({
      pkgManager: "flatpak",
      detectedPkgManagers: JSON.stringify(["flatpak"]),
      pkgManagerConfigs: JSON.stringify({
        flatpak: { refreshAppstreamOnCheck: false },
      }),
    }));
    expect(flatpakReference.exact.filter((entry) => entry.category === "check" && entry.pkgManager === "flatpak")).toHaveLength(2);
    expect(flatpakReference.exact.some((entry) => entry.command.includes('if [ "false" != "false" ]; then') && entry.command.includes("flatpak update --appstream"))).toBe(true);
  });

  test("excludes disabled managers and only includes full upgrades when supported", () => {
    const multiReference = buildCommandReference(createSystem({
      pkgManager: "apt",
      detectedPkgManagers: JSON.stringify(["apt", "snap", "yum"]),
      disabledPkgManagers: JSON.stringify(["snap"]),
    }));

    expect(multiReference.exact.some((entry) => entry.pkgManager === "snap" && entry.category !== "detection")).toBe(false);
    expect(multiReference.exact.some((entry) => entry.pkgManager === "apt" && entry.category === "full_upgrade_all")).toBe(true);
    expect(multiReference.exact.some((entry) => entry.pkgManager === "yum" && entry.category === "full_upgrade_all")).toBe(false);
  });

  test("derives sudoers commands from exact commands instead of hand-authored strings", () => {
    const reference = buildCommandReference(createSystem());
    const aptUpgrade = reference.exact.find((entry) => entry.category === "upgrade_all" && entry.pkgManager === "apt");
    expect(aptUpgrade).toBeDefined();

    const normalized = normalizeCommandForSudoers(aptUpgrade!.command);
    expect(normalized).toBe("apt-get -o DPkg::Lock::Timeout=60 upgrade -y");
    expect(reference.sudoers.some((entry) => entry.command === normalized && entry.purpose === aptUpgrade!.purpose)).toBe(true);
    expect(reference.sudoers.some((entry) => entry.category === "check" && entry.command === "dpkg --audit")).toBe(true);
    expect(reference.sudoers.some((entry) => entry.category === "check" && entry.command === "apt-get -o DPkg::Lock::Timeout=60 update -qq")).toBe(true);
    expect(reference.sudoers.some((entry) => entry.command === "-v")).toBe(false);

    expect(reference.sudoers.some((entry) => entry.category === "check" && entry.command.includes("apt list --upgradable"))).toBe(false);
  });

  test("marks selected-package sudoers entries as package placeholders", () => {
    const reference = buildCommandReference(createSystem());
    const selected = reference.sudoers.find((entry) =>
      entry.category === "upgrade_selected" &&
      entry.pkgManager === "apt" &&
      entry.command.includes("<package>")
    );

    expect(selected).toMatchObject({
      sudoersSafety: "package_placeholder",
      requiresWildcard: true,
    });
    expect(selected?.warnings?.join("\n")).toContain("Selected-package sudoers rules");
  });

  test("generates sudoers entries for privileged operations across built-in managers", () => {
    const cases = [
      {
        manager: "apt",
        configs: { apt: { defaultUpgradeMode: "full-upgrade" } },
        expected: [
          ["check", "dpkg --audit"],
          ["check", "apt-get -o DPkg::Lock::Timeout=60 update -qq"],
          ["repair_issue", "dpkg --configure -a"],
          ["upgrade_all", "apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y"],
          ["full_upgrade_all", "apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y"],
          ["upgrade_selected", "apt-get -o DPkg::Lock::Timeout=60 install --only-upgrade -y <package>"],
        ],
      },
      {
        manager: "dnf",
        configs: {
          dnf: {
            refreshMetadataOnCheck: true,
            autoAcceptNewSigningKeysOnCheck: true,
            defaultUpgradeMode: "distro-sync",
            autoAcceptEulaOnUpgrade: true,
          },
        },
        expected: [
          ["check", "dnf -y check-update --refresh --quiet"],
          ["repair_issue", "dnf -y check-update --quiet"],
          ["upgrade_all", "env ACCEPT_EULA=Y dnf distro-sync -y"],
          ["full_upgrade_all", "env ACCEPT_EULA=Y dnf distro-sync -y"],
          ["upgrade_selected", "env ACCEPT_EULA=Y dnf upgrade -y <package>"],
        ],
      },
      {
        manager: "yum",
        configs: {
          yum: {
            autoAcceptNewSigningKeysOnCheck: true,
            autoAcceptEulaOnUpgrade: true,
          },
        },
        expected: [
          ["check", "yum -y check-update --quiet"],
          ["repair_issue", "yum -y check-update --quiet"],
          ["upgrade_all", "env ACCEPT_EULA=Y yum update -y"],
          ["upgrade_selected", "env ACCEPT_EULA=Y yum update -y <package>"],
        ],
      },
      {
        manager: "pacman",
        configs: { pacman: { refreshDatabasesOnCheck: true } },
        expected: [
          ["check", "pacman -Sy --noconfirm"],
          ["upgrade_all", "pacman -Syu --noconfirm"],
          ["upgrade_selected", "pacman -S --noconfirm <package>"],
        ],
      },
      {
        manager: "apk",
        configs: { apk: { refreshIndexesOnCheck: true } },
        expected: [
          ["check", "apk update"],
          ["upgrade_all", "apk upgrade"],
          ["upgrade_selected", "apk upgrade <package>"],
        ],
      },
      {
        manager: "flatpak",
        configs: { flatpak: { refreshAppstreamOnCheck: true } },
        expected: [
          ["check", "flatpak update --appstream"],
          ["upgrade_all", "flatpak update -y"],
          ["upgrade_selected", "flatpak update -y <package>"],
        ],
      },
      {
        manager: "snap",
        configs: {},
        expected: [
          ["upgrade_all", "snap refresh"],
          ["upgrade_selected", "snap refresh <package>"],
        ],
      },
    ] as const;

    for (const entry of cases) {
      const reference = buildCommandReference(createSystem({
        pkgManager: entry.manager,
        detectedPkgManagers: JSON.stringify([entry.manager]),
        pkgManagerConfigs: JSON.stringify(entry.configs),
      }));

      for (const [category, command] of entry.expected) {
        expect(
          reference.sudoers.some((sudoersEntry) =>
            sudoersEntry.pkgManager === entry.manager &&
            sudoersEntry.category === category &&
            sudoersEntry.command === command
          ),
          `${entry.manager} ${category} ${command}`,
        ).toBe(true);
      }
      expect(reference.sudoers.every((sudoersEntry) =>
        !/\$(?:\{[^}]+\}|[a-zA-Z_][a-zA-Z0-9_]*)/.test(sudoersEntry.command)
      )).toBe(true);
    }

    const rebootReference = buildCommandReference(createSystem());
    expect(rebootReference.sudoers.some((entry) =>
      entry.category === "reboot" &&
      entry.command === "pvesh get /cluster/tasks --output-format json"
    )).toBe(true);
    expect(rebootReference.sudoers.some((entry) =>
      entry.category === "reboot" &&
      entry.command === "reboot"
    )).toBe(true);
  });
});

describe("buildCommandReference with custom scripts", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-command-reference-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("includes custom package-manager commands through runtime scripts", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    createScript({
      name: "Detect Linuxbrew",
      type: "package_manager",
      operation: "detect",
      pkgManager: "brewlinux",
      steps: [{ label: "Detect Linuxbrew", command: "command -v brew >/dev/null 2>&1 && echo 'found'" }],
    });
    createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check Linuxbrew", command: "brew outdated" }],
      parserConfig: {
        updateRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$",
      },
    });

    const reference = buildCommandReference(createSystem({
      pkgManager: "apt",
      detectedPkgManagers: JSON.stringify(["apt", "brewlinux"]),
      disabledPkgManagers: JSON.stringify([]),
      id: 42,
    } as Parameters<typeof createSystem>[0] & { id: number }));

    expect(reference.exact.some((entry) =>
      entry.category === "detection" &&
      entry.pkgManager === "brewlinux" &&
      entry.command.includes("command -v brew")
    )).toBe(true);
    expect(reference.exact.some((entry) =>
      entry.category === "check" &&
      entry.pkgManager === "brewlinux" &&
      entry.command === "brew outdated"
    )).toBe(true);
  });

  test("includes custom package-manager detection before the manager is detected", () => {
    createCustomPackageManager({ name: "aaa", label: "AAA" });
    createScript({
      name: "Detect AAA",
      type: "package_manager",
      operation: "detect",
      pkgManager: "aaa",
      steps: [{ label: "Detect AAA", command: "command -v aaa >/dev/null 2>&1 && echo 'found'" }],
    });

    const reference = buildCommandReference(createSystem({
      pkgManager: "apt",
      detectedPkgManagers: JSON.stringify(["apt"]),
      disabledPkgManagers: JSON.stringify([]),
      id: 43,
    } as Parameters<typeof createSystem>[0] & { id: number }));

    expect(reference.exact.some((entry) =>
      entry.category === "detection" &&
      entry.pkgManager === "aaa" &&
      entry.command.includes("command -v aaa")
    )).toBe(true);
    expect(reference.exact.some((entry) =>
      entry.category !== "detection" &&
      entry.pkgManager === "aaa"
    )).toBe(false);
  });

  test("uses per-system script overrides for referenced commands", () => {
    getDb().insert(systems).values({
      id: 44,
      name: "Override reference",
      hostname: "override-reference.local",
      port: 22,
      authType: "password",
      username: "root",
      pkgManager: "apt",
      detectedPkgManagers: JSON.stringify(["apt"]),
    }).run();
    const detect = createScript({
      name: "Custom APT detection",
      type: "package_manager",
      operation: "detect",
      pkgManager: "apt",
      steps: [{ label: "Detect custom APT", command: "echo custom-apt-detection" }],
    });
    const repair = createScript({
      name: "Custom APT repair",
      type: "package_manager",
      operation: "repair_issue",
      pkgManager: "apt",
      steps: [
        { label: "Repair APT one", command: "echo custom-apt-repair-one" },
        { label: "Repair APT two", command: "echo custom-apt-repair-two" },
      ],
    });
    const systemInfo = createScript({
      name: "Custom system info",
      type: "system",
      operation: "system_info",
      steps: [{ label: "Custom system info", command: "echo custom-system-info" }],
    });
    const reboot = createScript({
      name: "Custom reboot",
      type: "system",
      operation: "reboot",
      steps: [{ label: "Custom reboot", command: "echo custom-reboot" }],
    });
    setSystemOverrides(44, {
      [buildOperationKey("detect", "apt")]: detect.id,
      [buildOperationKey("repair_issue", "apt")]: repair.id,
      [buildOperationKey("system_info", null)]: systemInfo.id,
      [buildOperationKey("reboot", null)]: reboot.id,
    });

    const reference = buildCommandReference(createSystem({ id: 44 }));
    const commands = reference.exact.map((entry) => entry.command);

    expect(commands).toContain("echo custom-apt-detection");
    expect(commands).toContain("echo custom-apt-repair-one");
    expect(commands).toContain("echo custom-apt-repair-two");
    expect(commands).toContain("echo custom-system-info");
    expect(commands).toContain("echo custom-reboot");
  });

  test("extracts sudoers commands from custom scripts", () => {
    createScript({
      name: "Custom APT upgrade",
      type: "package_manager",
      operation: "upgrade_all",
      pkgManager: "apt",
      isDefault: true,
      steps: [{ label: "Upgrade", command: "if [ \"$(id -u)\" = \"0\" ]; then apt-get upgrade -y; elif command -v sudo >/dev/null 2>&1; then sudo -S -p '' apt-get upgrade -y; else apt-get upgrade -y; fi 2>&1" }],
    });

    const reference = buildCommandReference(createSystem({
      id: 51,
      detectedPkgManagers: JSON.stringify(["apt"]),
    } as Parameters<typeof createSystem>[0] & { id: number }));

    expect(reference.sudoers.some((entry) =>
      entry.category === "upgrade_all" &&
      entry.pkgManager === "apt" &&
      entry.command === "apt-get upgrade -y"
    )).toBe(true);
  });

  test("warns instead of producing sudoers entries for unsafe shell sudo patterns", () => {
    createScript({
      name: "Unsafe APT upgrade",
      type: "package_manager",
      operation: "upgrade_all",
      pkgManager: "apt",
      isDefault: true,
      steps: [{ label: "Upgrade", command: "sudo -S -p '' sh /tmp/ludash-upgrade.sh" }],
    });

    const reference = buildCommandReference(createSystem({
      id: 52,
      detectedPkgManagers: JSON.stringify(["apt"]),
    } as Parameters<typeof createSystem>[0] & { id: number }));

    expect(reference.sudoers.some((entry) => entry.command === "sh /tmp/ludash-upgrade.sh")).toBe(false);
    expect(reference.warnings.some((warning) =>
      warning.category === "upgrade_all" &&
      warning.command === "sh /tmp/ludash-upgrade.sh" &&
      warning.message.includes("Runs a shell under sudo")
    )).toBe(true);
  });

  test("warns instead of producing sudoers entries with shell variable expansions", () => {
    createScript({
      name: "Variable APT upgrade",
      type: "package_manager",
      operation: "upgrade_all",
      pkgManager: "apt",
      isDefault: true,
      steps: [{ label: "Upgrade", command: "sudo -S -p '' apt-get $mode -y" }],
    });

    const reference = buildCommandReference(createSystem({
      id: 53,
      detectedPkgManagers: JSON.stringify(["apt"]),
    } as Parameters<typeof createSystem>[0] & { id: number }));

    expect(reference.sudoers.some((entry) => entry.command === "apt-get $mode -y")).toBe(false);
    expect(reference.warnings.some((warning) =>
      warning.category === "upgrade_all" &&
      warning.command === "apt-get $mode -y" &&
      warning.message.includes("shell variable expansion")
    )).toBe(true);
  });
});
