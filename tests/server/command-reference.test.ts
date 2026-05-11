import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildCommandReference, normalizeCommandForSudoers } from "../../server/services/command-reference";
import { getPackageManagerDetectionCommands } from "../../server/ssh/detector";
import { aptParser } from "../../server/ssh/parsers/apt";
import { dnfParser } from "../../server/ssh/parsers/dnf";
import { yumParser } from "../../server/ssh/parsers/yum";
import { pacmanParser } from "../../server/ssh/parsers/pacman";
import { apkParser } from "../../server/ssh/parsers/apk";
import { flatpakParser } from "../../server/ssh/parsers/flatpak";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";
import { getRebootCommand } from "../../server/ssh/reboot";
import { closeDatabase, initDatabase } from "../../server/db";
import { initEncryptor } from "../../server/security";
import { copyBuiltinPackageManager, createCustomPackageManager, createScript } from "../../server/services/script-service";

function createSystem(overrides?: Partial<{
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

    for (const detection of getPackageManagerDetectionCommands()) {
      expect(reference.exact.some((entry) => entry.id === `detection:${detection.name}` && entry.command === detection.command)).toBe(true);
    }

    for (const command of aptParser.getCheckCommands()) {
      expect(reference.exact.some((entry) => entry.command === command)).toBe(true);
    }

    expect(reference.exact.some((entry) => entry.command === aptParser.getUpgradeAllCommand())).toBe(true);
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
    expect(aptReference.exact.some((entry) => entry.category === "upgrade_all" && entry.command.includes("full-upgrade -y"))).toBe(true);

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
    expect(dnfReference.exact.some((entry) => entry.category === "check" && entry.command === dnfParser.getCheckCommands({
      refreshMetadataOnCheck: true,
      autoAcceptNewSigningKeysOnCheck: true,
    })[0])).toBe(true);
    expect(dnfReference.exact.some((entry) => entry.category === "upgrade_all" && entry.command === dnfParser.getUpgradeAllCommand({
      defaultUpgradeMode: "distro-sync",
      autoAcceptEulaOnUpgrade: true,
    }))).toBe(true);
    expect(dnfReference.exact.some((entry) =>
      entry.category === "upgrade_selected" &&
      entry.command.includes("ACCEPT_EULA=Y dnf upgrade -y <package>")
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
    expect(yumReference.exact.some((entry) => entry.category === "check" && entry.command === yumParser.getCheckCommands({
      autoAcceptNewSigningKeysOnCheck: true,
    })[0])).toBe(true);
    expect(yumReference.exact.some((entry) =>
      entry.category === "upgrade_all" &&
      entry.command === yumParser.getUpgradeAllCommand({ autoAcceptEulaOnUpgrade: true })
    )).toBe(true);
    expect(yumReference.exact.some((entry) =>
      entry.category === "upgrade_selected" &&
      entry.command.includes("ACCEPT_EULA=Y yum update -y <package>")
    )).toBe(true);

    const pacmanReference = buildCommandReference(createSystem({
      pkgManager: "pacman",
      detectedPkgManagers: JSON.stringify(["pacman"]),
      pkgManagerConfigs: JSON.stringify({
        pacman: { refreshDatabasesOnCheck: false },
      }),
    }));
    expect(pacmanReference.exact.filter((entry) => entry.category === "check" && entry.pkgManager === "pacman")).toHaveLength(1);
    expect(pacmanReference.exact.some((entry) => entry.command === pacmanParser.getCheckCommands({
      refreshDatabasesOnCheck: false,
    })[0])).toBe(true);

    const apkReference = buildCommandReference(createSystem({
      pkgManager: "apk",
      detectedPkgManagers: JSON.stringify(["apk"]),
      pkgManagerConfigs: JSON.stringify({
        apk: { refreshIndexesOnCheck: false },
      }),
    }));
    expect(apkReference.exact.filter((entry) => entry.category === "check" && entry.pkgManager === "apk")).toHaveLength(1);
    expect(apkReference.exact.some((entry) => entry.command === apkParser.getCheckCommands({
      refreshIndexesOnCheck: false,
    })[0])).toBe(true);

    const flatpakReference = buildCommandReference(createSystem({
      pkgManager: "flatpak",
      detectedPkgManagers: JSON.stringify(["flatpak"]),
      pkgManagerConfigs: JSON.stringify({
        flatpak: { refreshAppstreamOnCheck: false },
      }),
    }));
    expect(flatpakReference.exact.filter((entry) => entry.category === "check" && entry.pkgManager === "flatpak")).toHaveLength(1);
    expect(flatpakReference.exact.some((entry) => entry.command === flatpakParser.getCheckCommands({
      refreshAppstreamOnCheck: false,
    })[0])).toBe(true);
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

    expect(reference.sudoers.some((entry) => entry.category === "check" && entry.command.includes("apt list --upgradable"))).toBe(false);
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
    copyBuiltinPackageManager({
      sourceManager: "apt",
      name: "custom-apt",
      label: "Custom APT",
    });
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
      detectedPkgManagers: JSON.stringify(["apt", "custom-apt", "brewlinux"]),
      disabledPkgManagers: JSON.stringify([]),
      id: 42,
    } as Parameters<typeof createSystem>[0] & { id: number }));

    expect(reference.exact.some((entry) =>
      entry.category === "detection" &&
      entry.pkgManager === "custom-apt" &&
      entry.command.includes("command -v apt")
    )).toBe(true);
    expect(reference.exact.some((entry) =>
      entry.category === "check" &&
      entry.pkgManager === "custom-apt" &&
      entry.command.includes("apt list --upgradable")
    )).toBe(true);
    expect(reference.exact.some((entry) =>
      entry.category === "upgrade_selected" &&
      entry.pkgManager === "custom-apt" &&
      entry.command.includes("install --only-upgrade -y <package1> <package2>")
    )).toBe(true);
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
});
