import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq, sql } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systemScriptOverrides, systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { sanitizeCommand } from "../../server/utils/sanitize";
import {
  buildOperationKey,
  createCustomPackageManager,
  createScript,
  deleteCustomPackageManager,
  deleteScript,
  exportCustomPackageManagerBundle,
  formatShellCommand,
  getBuiltinScripts,
  getSystemOverrides,
  importCustomPackageManagerBundle,
  listScriptUsages,
  listScripts,
  parseCustomInstalledPackages,
  parseCustomUpdates,
  replaceSystemOverrides,
  renderCommandTemplate,
  resolveRuntimeSteps,
  setSystemOverrides,
  updateScript,
  updateCustomPackageManager,
} from "../../server/services/script-service";
import { APT_DPKG_AUDIT_SCRIPT, APT_UPDATE_COMMAND } from "../../server/ssh/parsers/apt";

describe("script service", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-scripts-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function insertSystem(id: number): void {
    getDb().insert(systems).values({
      id,
      name: `system-${id}`,
      hostname: `system-${id}.local`,
      port: 22,
      authType: "password",
      username: "root",
    }).run();
  }

  function createBuiltinCopy(scriptId: string) {
    const source = getBuiltinScripts().find((script) => script.id === scriptId);
    if (!source) throw new Error(`Missing built-in script ${scriptId}`);
    return createScript({
      ...source,
      id: undefined,
      readonly: false,
      name: `${source.name} (Copy)`,
      sourceScriptId: source.id,
    });
  }

  test("exposes built-in package manager and system scripts as read-only", () => {
    const scripts = getBuiltinScripts();

    expect(scripts.some((script) => script.id === "builtin:apt:check_updates" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:apt:list_installed_packages" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:apt:repair_issue" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:dnf:repair_issue" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:snap:detect" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:system:system_info" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:system:reboot" && script.readonly)).toBe(true);
  });

  test("shows separate elevated APT audit and refresh commands in built-in scripts", () => {
    const checkApt = getBuiltinScripts().find((script) => script.id === "builtin:apt:check_updates");

    expect(checkApt?.steps[0]?.command).toBe(APT_DPKG_AUDIT_SCRIPT);
    expect(checkApt?.steps[1]?.command).toBe(APT_UPDATE_COMMAND);
    expect(checkApt?.steps[0]?.command).toContain("sudo -S -p '' dpkg --audit");
    expect(checkApt?.steps[1]?.command).toContain("sudo -S -p '' apt-get -o DPkg::Lock::Timeout=60 update -qq");
    expect(checkApt?.steps[0]?.command).not.toContain("sudo -S -p '' sh \"$apt_check_script\"");
    expect(checkApt?.steps[0]?.command).not.toContain("LUDASH_APT_CHECK");
    expect(checkApt?.steps[0]?.command).not.toContain("dpkg --audit 2>&1 || true");
  });

  test("labels sudoers-relevant commands in built-in scripts", () => {
    for (const script of getBuiltinScripts()) {
      for (const step of script.steps) {
        const lines = step.command.split("\n");
        for (const [index, line] of lines.entries()) {
          if (!line.includes("sudo -S")) continue;
          expect(
            lines[index - 1],
            `${script.id}/${step.label}`,
          ).toContain("# Sudoers-relevant command:");
        }
      }
    }
  });

  test("resolves built-in runtime steps from the canonical script templates", () => {
    insertSystem(12);
    const cases: Array<{
      operation: "detect" | "check_updates" | "list_installed_packages" | "repair_issue" | "autoremove" | "upgrade_all" | "full_upgrade_all" | "upgrade_selected" | "system_info" | "reboot";
      pkgManager: string | null;
      pkgManagerConfig?: Record<string, unknown>;
      packages?: string[];
    }> = [
      { operation: "detect", pkgManager: "apt" },
      { operation: "check_updates", pkgManager: "apt" },
      { operation: "list_installed_packages", pkgManager: "apt" },
      { operation: "repair_issue", pkgManager: "apt" },
      { operation: "autoremove", pkgManager: "apt" },
      { operation: "upgrade_all", pkgManager: "apt", pkgManagerConfig: { defaultUpgradeMode: "full-upgrade" } },
      { operation: "full_upgrade_all", pkgManager: "dnf", pkgManagerConfig: { autoAcceptEulaOnUpgrade: true } },
      { operation: "upgrade_selected", pkgManager: "apt", packages: ["curl", "openssl"] },
      { operation: "system_info", pkgManager: null },
      { operation: "reboot", pkgManager: null },
    ];

    for (const entry of cases) {
      const source = getBuiltinScripts().find((script) =>
        script.operation === entry.operation && script.pkgManager === entry.pkgManager
      );
      expect(source, `${entry.pkgManager ?? "system"}/${entry.operation}`).toBeDefined();

      expect(resolveRuntimeSteps({
        systemId: 12,
        operation: entry.operation,
        pkgManager: entry.pkgManager,
        pkgManagerConfig: entry.pkgManagerConfig,
        packages: entry.packages,
      })).toEqual(source!.steps.map((step) => ({
        label: step.label,
        command: renderCommandTemplate(step.command, {
          pkgManager: entry.pkgManager,
          config: entry.pkgManagerConfig,
          packages: entry.packages,
        }),
      })));
    }
  });

  test("exposes the same built-in reboot steps to the Scripts page that runtime executes", () => {
    insertSystem(13);
    const scriptPageReboot = listScripts().scripts.find((script) => script.id === "builtin:system:reboot");
    const runtimeSteps = resolveRuntimeSteps({
      systemId: 13,
      operation: "reboot",
    });

    expect(scriptPageReboot).toBeDefined();
    expect(scriptPageReboot?.steps).toEqual(runtimeSteps);
    expect(scriptPageReboot?.steps[0]?.command).toContain("pvesh get /cluster/tasks --output-format json");
    expect(scriptPageReboot?.steps[0]?.command).not.toContain("--typefilter");
    expect(scriptPageReboot?.steps[0]?.command).not.toContain("--statusfilter");
  });

  test("preserves activity commands for every built-in operation and package manager", () => {
    insertSystem(14);
    const packages = ["curl", "openssl"];
    const configs: Record<string, Record<string, unknown>> = {
      apt: { defaultUpgradeMode: "full-upgrade" },
      dnf: {
        autoAcceptEulaOnUpgrade: true,
        autoAcceptNewSigningKeysOnCheck: true,
        defaultUpgradeMode: "upgrade",
        refreshMetadataOnCheck: true,
      },
      yum: {
        autoAcceptEulaOnUpgrade: true,
        autoAcceptNewSigningKeysOnCheck: true,
      },
      pacman: { refreshDatabasesOnCheck: true },
      apk: { refreshIndexesOnCheck: true },
      flatpak: { refreshAppstreamOnCheck: true },
    };

    for (const script of getBuiltinScripts()) {
      const runtimeSteps = resolveRuntimeSteps({
        systemId: 14,
        operation: script.operation,
        pkgManager: script.pkgManager,
        pkgManagerConfig: script.pkgManager ? configs[script.pkgManager] : undefined,
        packages: script.operation === "upgrade_selected" ? packages : undefined,
      });

      expect(runtimeSteps.length, script.id).toBeGreaterThan(0);
      for (const step of runtimeSteps) {
        expect(sanitizeCommand(step.command), `${script.id}/${step.label}`).toBe(step.command);
      }
    }
  });

  test("preserves compact custom script commands after placeholder rendering", () => {
    insertSystem(15);
    const script = createScript({
      name: "Compact custom APT upgrade",
      type: "package_manager",
      operation: "upgrade_all",
      pkgManager: "apt",
      steps: [{ label: "Upgrade", command: "{{sudo:apt-get upgrade -y}}" }],
    });
    setSystemOverrides(15, {
      [buildOperationKey("upgrade_all", "apt")]: script.id,
    });

    const command = resolveRuntimeSteps({
      systemId: 15,
      operation: "upgrade_all",
      pkgManager: "apt",
    })[0]?.command;

    expect(command).toBeDefined();
    expect(sanitizeCommand(command ?? "")).toBe(command);
  });

  test("drafted built-in copies are editable custom scripts and assigned scripts cannot be deleted", () => {
    const copy = createBuiltinCopy("builtin:apt:check_updates");
    expect(copy.readonly).toBe(false);
    expect(copy.sourceScriptId).toBe("builtin:apt:check_updates");

    insertSystem(1);
    setSystemOverrides(1, {
      [buildOperationKey("check_updates", "apt")]: copy.id,
    });

    expect(() => deleteScript(copy.id)).toThrow(/assigned/);
  });

  test("does not allow assigned scripts to change operation scope", () => {
    const script = createBuiltinCopy("builtin:apt:check_updates");
    insertSystem(20);
    setSystemOverrides(20, {
      [buildOperationKey("check_updates", "apt")]: script.id,
    });

    expect(() => updateScript(script.id, {
      operation: "upgrade_all",
      steps: [{ label: "Upgrade", command: "echo changed" }],
    })).toThrow(/cannot be changed while assigned/);

    expect(resolveRuntimeSteps({
      systemId: 20,
      operation: "check_updates",
      pkgManager: "apt",
    })[0]?.command).not.toBe("echo changed");
  });

  test("ignores stale incompatible overrides at runtime", () => {
    const script = createScript({
      name: "APT upgrade script",
      type: "package_manager",
      operation: "upgrade_all",
      pkgManager: "apt",
      steps: [{ label: "Upgrade", command: "echo should-not-run" }],
    });
    insertSystem(21);
    getDb().insert(systemScriptOverrides).values({
      systemId: 21,
      operationKey: buildOperationKey("check_updates", "apt"),
      scriptId: script.id,
    }).run();

    const steps = resolveRuntimeSteps({
      systemId: 21,
      operation: "check_updates",
      pkgManager: "apt",
    });

    expect(steps.length).toBeGreaterThan(0);
    expect(steps.map((step) => step.command)).not.toContain("echo should-not-run");
  });

  test("rejects updates and deletes for built-in scripts", () => {
    expect(() => updateScript("builtin:apt:detect", {
      name: "Edited built-in",
      type: "package_manager",
      operation: "detect",
      pkgManager: "apt",
      steps: [{ label: "Detect", command: "command -v apt" }],
    })).toThrow(/read-only/);
    expect(() => deleteScript("builtin:apt:detect")).toThrow(/read-only/);
  });

  test("rejects invalid and oversized custom script payloads", () => {
    expect(() => createScript({
      name: "Bad manager",
      type: "package_manager",
      operation: "detect",
      pkgManager: "Apt",
      steps: [{ label: "Detect", command: "command -v apt" }],
    })).toThrow(/pkgManager/);

    expect(() => createScript({
      name: "Wrong operation",
      type: "system",
      operation: "detect",
      steps: [{ label: "Detect", command: "true" }],
    })).toThrow(/system_info or reboot/);

    expect(() => createScript({
      name: "Too many steps",
      type: "package_manager",
      operation: "detect",
      pkgManager: "apt",
      steps: Array.from({ length: 9 }, (_entry, index) => ({
        label: `Step ${index}`,
        command: "true",
      })),
    })).toThrow(/at most 8/);

    expect(() => createScript({
      name: "Ambiguous detection",
      type: "package_manager",
      operation: "detect",
      pkgManager: "apt",
      steps: [
        { label: "Detect apt", command: "command -v apt" },
        { label: "Detect apt-get", command: "command -v apt-get" },
      ],
    })).toThrow(/exactly one step/);

    expect(() => createScript({
      name: "Bad step",
      type: "package_manager",
      operation: "detect",
      pkgManager: "apt",
      steps: [{ label: "Detect", command: "x".repeat(8001) }],
    })).toThrow(/command max 8000/);
  });

  test("rejects unsafe or incomplete parser regexes", () => {
    expect(() => createScript({
      name: "Missing parser groups",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      steps: [{ label: "Check", command: "apt list --upgradable" }],
      parserConfig: {
        updateRegex: "^(?<packageName>\\S+)$",
      },
    })).toThrow(/packageName and newVersion/);

    expect(() => createScript({
      name: "Unsafe parser",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      steps: [{ label: "Check", command: "apt list --upgradable" }],
      parserConfig: {
        updateRegex: "^(?<packageName>(a+)+)\\s+(?<newVersion>\\S+)$",
      },
    })).toThrow(/unsafe regular expression/);

    expect(() => createCustomPackageManager({
      name: "brewlinux",
      label: "Linuxbrew",
      parserConfig: {
        updateRegex: "^(?<packageName>\\S+)\\s+->\\s+(?<newVersion>\\S+)$",
      },
    })).not.toThrow();
  });

  test("validates parser output step against check script steps", () => {
    expect(() => createScript({
      name: "Two-step check",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      steps: [
        { label: "Refresh", command: "apt-get update" },
        { label: "List", command: "apt list --upgradable" },
      ],
      parserConfig: {
        parseStep: 1,
        updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
      },
    })).not.toThrow();

    expect(() => createScript({
      name: "Missing parser step",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      steps: [{ label: "List", command: "apt list --upgradable" }],
      parserConfig: {
        parseStep: 1,
        updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
      },
    })).toThrow(/reference an existing step/);
  });

  test("rejects oversized and invalid formatter input", async () => {
    await expect(formatShellCommand("")).rejects.toThrow(/Command is required/);
    await expect(formatShellCommand("x".repeat(8001))).rejects.toThrow(/too long/);
  });

  test("lists system usage for assigned custom scripts", () => {
    const copy = createBuiltinCopy("builtin:apt:detect");
    insertSystem(2);
    setSystemOverrides(2, {
      [buildOperationKey("detect", "apt")]: copy.id,
    });

    expect(listScriptUsages(copy.id)).toEqual([
      {
        systemId: 2,
        systemName: "system-2",
        operationKey: "apt/detect",
      },
    ]);

    const listed = listScripts().scripts.find((script) => script.id === copy.id);
    expect(listed?.usageCount).toBe(1);
    expect(listed?.usages?.[0]?.systemName).toBe("system-2");
  });

  test("deletes scripts with only stale override rows", () => {
    const copy = createBuiltinCopy("builtin:apt:detect");

    getDb().run(sql`PRAGMA foreign_keys=OFF`);
    getDb().insert(systemScriptOverrides).values({
      systemId: 999,
      operationKey: buildOperationKey("detect", "apt"),
      scriptId: copy.id,
    }).run();
    getDb().run(sql`PRAGMA foreign_keys=ON`);

    expect(listScriptUsages(copy.id)).toEqual([]);
    expect(() => deleteScript(copy.id)).not.toThrow();
    expect(getDb().select().from(systemScriptOverrides).where(eq(systemScriptOverrides.scriptId, copy.id)).all()).toEqual([]);
  });

  test("does not count disabled package manager overrides as active usage", () => {
    createCustomPackageManager({ name: "custom-apt", label: "Custom APT" });
    const script = createScript({
      name: "Detect Custom APT",
      type: "package_manager",
      operation: "detect",
      pkgManager: "custom-apt",
      steps: [{ label: "Detect", command: "command -v apt" }],
    });
    insertSystem(3);
    getDb()
      .update(systems)
      .set({ disabledPkgManagers: JSON.stringify(["custom-apt"]) })
      .where(eq(systems.id, 3))
      .run();
    setSystemOverrides(3, {
      [buildOperationKey("detect", "custom-apt")]: script.id,
    });

    expect(listScriptUsages(script.id)).toEqual([]);
    expect(listScripts().scripts.find((entry) => entry.id === script.id)?.usageCount).toBe(0);
    expect(() => deleteScript(script.id)).not.toThrow();
  });

  test("counts default scripts for enabled custom package managers as active usage", () => {
    createCustomPackageManager({ name: "aaa", label: "AAA" });
    const defaultScript = createScript({
      name: "Detect APT (AAA)",
      type: "package_manager",
      operation: "detect",
      pkgManager: "aaa",
      steps: [{ label: "Detect", command: "command -v apt" }],
    });
    const alternateScript = createScript({
      name: "Alternate Detect APT (AAA)",
      type: "package_manager",
      operation: "detect",
      pkgManager: "aaa",
      steps: [{ label: "Detect", command: "command -v apt-get" }],
    });
    insertSystem(5);
    getDb()
      .update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["aaa"]), disabledPkgManagers: JSON.stringify([]) })
      .where(eq(systems.id, 5))
      .run();

    expect(listScriptUsages(defaultScript.id)).toEqual([
      {
        systemId: 5,
        systemName: "system-5",
        operationKey: "aaa/detect",
      },
    ]);
    expect(listScriptUsages(alternateScript.id)).toEqual([]);
    expect(() => deleteScript(defaultScript.id)).toThrow(/assigned/);
  });

  test("does not count default custom scripts when an operation override is set", () => {
    createCustomPackageManager({ name: "aaa", label: "AAA" });
    const defaultScript = createScript({
      name: "Detect APT (AAA)",
      type: "package_manager",
      operation: "detect",
      pkgManager: "aaa",
      steps: [{ label: "Detect", command: "command -v apt" }],
    });
    const overrideScript = createScript({
      name: "Override Detect APT (AAA)",
      type: "package_manager",
      operation: "detect",
      pkgManager: "aaa",
      steps: [{ label: "Detect", command: "command -v apt-get" }],
    });
    insertSystem(6);
    getDb()
      .update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["aaa"]), disabledPkgManagers: JSON.stringify([]) })
      .where(eq(systems.id, 6))
      .run();
    setSystemOverrides(6, {
      [buildOperationKey("detect", "aaa")]: overrideScript.id,
    });

    expect(listScriptUsages(defaultScript.id)).toEqual([]);
    expect(listScriptUsages(overrideScript.id)).toEqual([
      {
        systemId: 6,
        systemName: "system-6",
        operationKey: "aaa/detect",
      },
    ]);
  });

  test("replaces system overrides so omitted keys are unassigned", () => {
    const copy = createBuiltinCopy("builtin:apt:detect");
    insertSystem(4);
    setSystemOverrides(4, {
      [buildOperationKey("detect", "apt")]: copy.id,
    });

    expect(getSystemOverrides(4)).toEqual({ "apt/detect": copy.id });
    replaceSystemOverrides(4, {});

    expect(getSystemOverrides(4)).toEqual({});
  });

  test("unmodified built-in copies keep built-in runtime behavior", () => {
    const copy = createBuiltinCopy("builtin:apt:upgrade_all");
    insertSystem(7);
    setSystemOverrides(7, {
      [buildOperationKey("upgrade_all", "apt")]: copy.id,
    });

    const steps = resolveRuntimeSteps({
      systemId: 7,
      operation: "upgrade_all",
      pkgManager: "apt",
      pkgManagerConfig: { defaultUpgradeMode: "full-upgrade" },
    });

    expect(copy.systemInfoConfig).toBeNull();
    expect(steps[0]?.command).toContain("apt-get -o DPkg::Lock::Timeout=60 full-upgrade -y");
    expect(steps[0]?.command).not.toContain("$upgrade_mode");

    const systemInfoCopy = createBuiltinCopy("builtin:system:system_info");
    expect(systemInfoCopy.systemInfoConfig).toEqual({ mode: "builtin" });
  });

  test("built-in copies moved to custom managers use their saved detection script", () => {
    createCustomPackageManager({ name: "custom-apt", label: "Custom APT" });
    createScript({
      name: "Detect Custom APT",
      type: "package_manager",
      operation: "detect",
      pkgManager: "custom-apt",
      steps: [{ label: "Detect Custom APT", command: "command -v apt >/dev/null 2>&1 && echo 'found'" }],
      sourceScriptId: "builtin:apt:detect",
    });
    insertSystem(9);

    const steps = resolveRuntimeSteps({
      systemId: 9,
      operation: "detect",
      pkgManager: "custom-apt",
    });

    expect(steps).toEqual([
      { label: "Detect Custom APT", command: "command -v apt >/dev/null 2>&1 && echo 'found'" },
    ]);
  });

  test("edited built-in copies use their custom step commands", () => {
    const copy = createBuiltinCopy("builtin:apt:upgrade_all");
    const edited = createScript({
      name: "Custom upgrade",
      type: copy.type,
      operation: copy.operation,
      pkgManager: copy.pkgManager,
      steps: [{ label: "Custom", command: "echo custom" }],
      sourceScriptId: copy.sourceScriptId,
    });
    insertSystem(8);
    setSystemOverrides(8, {
      [buildOperationKey("upgrade_all", "apt")]: edited.id,
    });

    const steps = resolveRuntimeSteps({
      systemId: 8,
      operation: "upgrade_all",
      pkgManager: "apt",
      pkgManagerConfig: { defaultUpgradeMode: "full-upgrade" },
    });

    expect(steps[0]?.command).toBe("echo custom");
  });


  test("provides autoremove built-ins only for managers with cleanup semantics", () => {
    const autoremoveScripts = getBuiltinScripts()
      .filter((script) => script.operation === "autoremove");

    expect(autoremoveScripts.map((script) => script.pkgManager)).toEqual([
      "apt",
      "dnf",
      "yum",
      "pacman",
      "flatpak",
    ]);
    expect(autoremoveScripts.find((script) => script.pkgManager === "apt")?.steps[0]?.command)
      .toContain("apt-get -o DPkg::Lock::Timeout=60 autoremove -y");
    expect(autoremoveScripts.find((script) => script.pkgManager === "pacman")?.steps[0]?.command)
      .toContain("pacman -Qtdq");
    expect(autoremoveScripts.find((script) => script.pkgManager === "pacman")?.steps[0]?.command)
      .toContain("pacman -Rns --noconfirm -");
    expect(autoremoveScripts.find((script) => script.pkgManager === "pacman")?.steps[0]?.command)
      .toContain(`{ cat; printf '%s\\n' "$orphans"; } | sudo -S -p '' pacman -Rns --noconfirm -`);
  });

  test("renders package and sudo placeholders", () => {
    const command = renderCommandTemplate(
      "{{sudo:custom upgrade {{packages}}}} --manager {{manager}} --mode {{config.defaultUpgradeMode}}",
      {
        pkgManager: "apt",
        packages: ["curl", "openssl"],
        config: { defaultUpgradeMode: "full-upgrade" },
      },
    );

    expect(command).toContain("custom upgrade curl openssl");
    expect(command).toContain("--manager apt");
    expect(command).toContain("--mode full-upgrade");
    expect(command).toContain("sudo -S -p ''");
  });

  test("formats compact built-in shell commands for display", async () => {
    const aptUpgrade = getBuiltinScripts().find((script) => script.id === "builtin:apt:upgrade_all");
    const aptCheck = getBuiltinScripts().find((script) => script.id === "builtin:apt:check_updates");
    const reboot = getBuiltinScripts().find((script) => script.id === "builtin:system:reboot");

    const formattedApt = await formatShellCommand(aptUpgrade?.steps[0]?.command ?? "");
    const formattedAptAudit = await formatShellCommand(aptCheck?.steps[0]?.command ?? "");
    const formattedAptRefresh = await formatShellCommand(aptCheck?.steps[1]?.command ?? "");
    const formattedRebootGuard = await formatShellCommand(reboot?.steps[0]?.command ?? "");
    const formattedReboot = await formatShellCommand(reboot?.steps[1]?.command ?? "");

    expect(formattedApt).toContain("apt-get -o DPkg::Lock::Timeout=60 {{config.defaultUpgradeMode}} -y");
    expect(formattedApt).toContain('elif command -v sudo > /dev/null 2>&1; then\n  sudo -S -p');
    expect(formattedAptAudit).toContain("sudo -S -p '' dpkg --audit");
    expect(formattedAptRefresh).toContain("Sudoers-relevant command: apt-get -o DPkg::Lock::Timeout=60 update -qq");
    expect(formattedAptRefresh).toContain("sudo -S -p '' apt-get -o DPkg::Lock::Timeout=60 update -qq");
    expect(formattedAptAudit).not.toContain("LUDASH_APT_CHECK");
    expect(formattedAptRefresh).toContain("sudo -S -p");
    expect(reboot?.steps.map((step) => step.label)).toEqual([
      "Pre-reboot safety checks",
      "Reboot system",
    ]);
    expect(formattedRebootGuard).toContain("pvesh get /cluster/tasks");
    expect(formattedRebootGuard).toContain("Sudoers-relevant command: pvesh get /cluster/tasks --output-format json");
    expect(formattedReboot).toContain("Sudoers-relevant command: reboot");
    expect(formattedReboot).toContain('if [ "$(id -u)" = "0" ]; then\n  reboot\nelif command -v sudo > /dev/null 2>&1; then');
  });

  test("resolves per-system custom script overrides before built-ins", () => {
    const script = createScript({
      name: "Quiet APT check",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      steps: [{ label: "Custom check", command: "echo custom" }],
    });

    insertSystem(42);
    setSystemOverrides(42, {
      [buildOperationKey("check_updates", "apt")]: script.id,
    });

    expect(resolveRuntimeSteps({
      systemId: 42,
      operation: "check_updates",
      pkgManager: "apt",
    })[0]?.command).toBe("echo custom");
  });

  test("uses one explicit default script per package-manager operation", () => {
    const first = createScript({
      name: "Quiet APT check",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      isDefault: true,
      steps: [{ label: "Custom check", command: "echo first" }],
    });
    const second = createScript({
      name: "Verbose APT check",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      isDefault: true,
      steps: [{ label: "Custom check", command: "echo second" }],
    });
    insertSystem(43);
    insertSystem(45);
    getDb()
      .update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["apt"]) })
      .where(eq(systems.id, 43))
      .run();
    getDb()
      .update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["dnf"]) })
      .where(eq(systems.id, 45))
      .run();

    expect(resolveRuntimeSteps({
      systemId: 43,
      operation: "check_updates",
      pkgManager: "apt",
    })[0]?.command).toBe("echo second");
    expect(listScripts().scripts.find((script) => script.id === first.id)?.isDefault).toBe(false);
    expect(listScripts().scripts.find((script) => script.id === second.id)?.isDefault).toBe(true);
    expect(listScriptUsages(second.id)).toEqual([
      {
        systemId: 43,
        systemName: "system-43",
        operationKey: "apt/check_updates",
      },
    ]);
  });

  test("uses explicit default scripts for system operations", () => {
    const script = createScript({
      name: "Custom reboot",
      type: "system",
      operation: "reboot",
      isDefault: true,
      steps: [{ label: "Reboot", command: "echo reboot" }],
    });
    insertSystem(44);

    expect(resolveRuntimeSteps({
      systemId: 44,
      operation: "reboot",
    })[0]?.command).toBe("echo reboot");
    expect(listScriptUsages(script.id)).toEqual([
      {
        systemId: 44,
        systemName: "system-44",
        operationKey: "system/reboot",
      },
    ]);
    expect(() => deleteScript(script.id)).toThrow(/assigned/);
  });

  test("supports user-defined package managers with generic parser rules", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    const parserConfig = {
      updateRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)\\s+->\\s+(?<newVersion>\\S+)$",
    };
    createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew outdated" }],
      parserConfig,
    });

    const scripts = listScripts();
    expect(scripts.packageManagers.some((manager) => manager.name === "brewlinux")).toBe(true);

    const updates = parseCustomUpdates("brewlinux", parserConfig, [{
      command: "brew outdated",
      stdout: "openssl 3.2 -> 3.3\n",
      stderr: "",
      exitCode: 0,
    }]);

    expect(updates).toEqual([
      expect.objectContaining({
        packageName: "openssl",
        currentVersion: "3.2",
        newVersion: "3.3",
        pkgManager: "brewlinux",
      }),
    ]);
  });

  test("exports and imports custom package managers with their custom scripts", () => {
    createCustomPackageManager({
      name: "brewlinux",
      label: "Linuxbrew",
      configEntries: [
        { key: "channel", description: "Release channel", defaultValue: "stable" },
      ],
    });
    createScript({
      name: "Detect Linuxbrew",
      type: "package_manager",
      operation: "detect",
      pkgManager: "brewlinux",
      isDefault: true,
      steps: [{ label: "Detect", command: "command -v brew >/dev/null && echo found" }],
    });
    createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew outdated" }],
      parserConfig: {
        updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
      },
    });

    const bundle = exportCustomPackageManagerBundle("brewlinux");
    expect(bundle.packageManager).toMatchObject({
      name: "brewlinux",
      label: "Linuxbrew",
      configEntries: [
        { key: "channel", description: "Release channel", defaultValue: "stable" },
      ],
    });
    expect(bundle.scripts.map((script) => script.name)).toEqual([
      "Check Linuxbrew",
      "Detect Linuxbrew",
    ]);

    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = mkdtempSync(join(tmpdir(), "ludash-scripts-import-"));
    initDatabase(join(tempDir, "dashboard.db"));

    const firstImport = importCustomPackageManagerBundle(bundle);
    expect(firstImport.createdScripts).toBe(2);
    expect(firstImport.updatedScripts).toBe(0);
    expect(listScripts().packageManagers.find((manager) => manager.name === "brewlinux")).toMatchObject({
      label: "Linuxbrew",
      configEntries: [
        { key: "channel", description: "Release channel", defaultValue: "stable" },
      ],
    });
    expect(listScripts().scripts.filter((script) => script.pkgManager === "brewlinux" && !script.readonly)).toHaveLength(2);

    const updatedBundle = {
      ...bundle,
      scripts: bundle.scripts.map((script) =>
        script.name === "Check Linuxbrew"
          ? { ...script, steps: [{ label: "Check", command: "brew outdated --json" }] }
          : script
      ),
    };
    const secondImport = importCustomPackageManagerBundle(updatedBundle);
    expect(secondImport.createdScripts).toBe(0);
    expect(secondImport.updatedScripts).toBe(2);
    expect(listScripts().scripts.filter((script) => script.pkgManager === "brewlinux" && !script.readonly)).toHaveLength(2);
    expect(listScripts().scripts.find((script) => script.name === "Check Linuxbrew")?.steps[0]?.command)
      .toBe("brew outdated --json");
  });

  test("normalizes custom parser config fields to the script operation", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    const checkScript = createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew outdated" }],
      parserConfig: {
        updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
        installedPackageRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)$",
        successExitCodes: [0],
        updatesExitCodes: [100],
      },
    });
    const listScript = createScript({
      name: "List Linuxbrew",
      type: "package_manager",
      operation: "list_installed_packages",
      pkgManager: "brewlinux",
      steps: [{ label: "List", command: "brew list --versions" }],
      parserConfig: {
        updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
        installedPackageRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)$",
        successExitCodes: [0],
        updatesExitCodes: [100],
      },
    });

    expect(checkScript.parserConfig).toEqual({
      updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
      successExitCodes: [0],
      updatesExitCodes: [100],
    });
    expect(listScript.parserConfig).toEqual({
      installedPackageRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)$",
      successExitCodes: [0],
    });

    const bundle = exportCustomPackageManagerBundle("brewlinux");
    expect(bundle.scripts.find((script) => script.name === "Check Linuxbrew")?.parserConfig).toEqual({
      updateRegex: "^(?<packageName>\\S+)\\s+(?<newVersion>\\S+)$",
      successExitCodes: [0],
      updatesExitCodes: [100],
    });
    expect(bundle.scripts.find((script) => script.name === "List Linuxbrew")?.parserConfig).toEqual({
      installedPackageRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)$",
      successExitCodes: [0],
    });
  });

  test("imports custom package manager bundles with an overridden key and label", () => {
    const result = importCustomPackageManagerBundle({
      format: "ludash.custom-package-manager.v1",
      exportedAt: "2026-06-05T00:00:00.000Z",
      packageManager: {
        name: "brewlinux-dev",
        label: "Linuxbrew Dev",
        parserConfig: null,
        configEntries: [],
      },
      scripts: [
        {
          name: "Detect Linuxbrew",
          description: null,
          type: "package_manager",
          operation: "detect",
          pkgManager: "brewlinux",
          isDefault: true,
          steps: [{ label: "Detect", command: "command -v brew && echo found" }],
          parserConfig: null,
          systemInfoConfig: null,
          sourceScriptId: null,
        },
      ],
    });

    expect(result.manager).toMatchObject({
      name: "brewlinux-dev",
      label: "Linuxbrew Dev",
    });
    expect(result.scripts[0]).toMatchObject({
      pkgManager: "brewlinux-dev",
      name: "Detect Linuxbrew",
    });
  });

  test("parses installed-package snapshots for user-defined package managers", () => {
    const parserConfig = {
      installedPackageRegex: "^(?<packageName>\\S+)\\s+(?<currentVersion>\\S+)\\s+(?<architecture>\\S+)$",
    };

    expect(parseCustomInstalledPackages("brewlinux", parserConfig, [{
      command: "brew list --versions",
      stdout: "openssl 3.3 x86_64\nmalformed\n",
      stderr: "",
      exitCode: 0,
    }])).toEqual([
      {
        packageName: "openssl",
        currentVersion: "3.3",
        architecture: "x86_64",
        repository: null,
        pkgManager: "brewlinux",
      },
    ]);
  });

  test("updates custom package manager display metadata", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });

    const updated = updateCustomPackageManager("brewlinux", {
      label: "Homebrew",
      configEntries: [
        { key: "channel", description: "Release channel", defaultValue: "stable" },
      ],
    });

    expect(updated).toMatchObject({
      name: "brewlinux",
      label: "Homebrew",
      configEntries: [
        { key: "channel", description: "Release channel", defaultValue: "stable" },
      ],
    });
  });

  test("updates built-in package manager custom config metadata only", () => {
    const updated = updateCustomPackageManager("apt", {
      label: "Changed APT",
      parserConfig: {
        updateRegex: "ignored",
      },
      configEntries: [
        { key: "mirror", description: "APT mirror", defaultValue: "internal" },
      ],
    });

    expect(updated).toMatchObject({
      builtin: true,
      name: "apt",
      label: "APT",
      parserConfig: null,
      configEntries: [
        { key: "mirror", description: "APT mirror", defaultValue: "internal" },
      ],
    });
    expect(listScripts().packageManagers.find((manager) => manager.name === "apt")).toMatchObject({
      builtin: true,
      configEntries: [
        { key: "mirror", description: "APT mirror", defaultValue: "internal" },
      ],
    });
  });

  test("renders custom config values with defaults without adding them to placeholder help", () => {
    createCustomPackageManager({
      name: "brewlinux",
      label: "Linuxbrew",
      configEntries: [
        { key: "channel", description: "Release channel", defaultValue: "stable" },
      ],
    });
    const script = createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew update --{{config.channel}}" }],
    });
    insertSystem(10);
    getDb()
      .update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["brewlinux"]) })
      .where(eq(systems.id, 10))
      .run();

    expect(listScripts().placeholders).not.toContainEqual(expect.objectContaining({
      name: "{{config.channel}}",
    }));
    expect(listScripts().scripts.find((entry) => entry.id === script.id)?.steps[0]?.command)
      .toBe("brew update --{{config.channel}}");
    expect(listScripts().placeholders).not.toContainEqual(expect.objectContaining({
      name: "{{config.someKey}}",
    }));
    expect(resolveRuntimeSteps({
      systemId: 10,
      operation: "check_updates",
      pkgManager: "brewlinux",
    })[0]?.command).toBe("brew update --stable");

    getDb()
      .update(systems)
      .set({ pkgManagerConfigs: JSON.stringify({ brewlinux: { channel: "edge" } }) })
      .where(eq(systems.id, 10))
      .run();
    expect(resolveRuntimeSteps({
      systemId: 10,
      operation: "check_updates",
      pkgManager: "brewlinux",
      pkgManagerConfig: { channel: "edge" },
    })[0]?.command).toBe("brew update --edge");
    expect(resolveRuntimeSteps({
      systemId: 10,
      operation: "check_updates",
      pkgManager: "brewlinux",
      pkgManagerConfig: { channel: "beta" },
    })[0]?.command).toBe("brew update --beta");
    expect(script.pkgManager).toBe("brewlinux");
  });

  test("renders built-in package manager custom config values without dropping built-in config", () => {
    updateCustomPackageManager("apt", {
      configEntries: [
        { key: "mirror", description: "APT mirror", defaultValue: "internal" },
      ],
    });
    const script = createScript({
      name: "Custom APT check",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "apt",
      steps: [{ label: "Check", command: "echo {{config.defaultUpgradeMode}} {{config.mirror}}" }],
    });
    insertSystem(11);
    setSystemOverrides(11, {
      [buildOperationKey("check_updates", "apt")]: script.id,
    });

    expect(resolveRuntimeSteps({
      systemId: 11,
      operation: "check_updates",
      pkgManager: "apt",
      pkgManagerConfig: { defaultUpgradeMode: "full-upgrade" },
    })[0]?.command).toBe("echo full-upgrade internal");
    expect(listScripts().scripts.find((entry) => entry.id === script.id)?.steps[0]?.command)
      .toBe("echo {{config.defaultUpgradeMode}} {{config.mirror}}");
    expect(listScripts().placeholders).not.toContainEqual(expect.objectContaining({
      name: "{{config.mirror}}",
    }));
  });

  test("does not delete custom package managers that still have scripts", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew outdated" }],
    });

    expect(() => deleteCustomPackageManager("brewlinux")).toThrow(/used by one or more scripts/);
  });

  test("deletes custom package managers with scripts when explicitly requested", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    const script = createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew outdated" }],
    });
    insertSystem(16);
    setSystemOverrides(16, {
      [buildOperationKey("check_updates", "brewlinux")]: script.id,
    });

    deleteCustomPackageManager("brewlinux", { deleteScripts: true });

    expect(listScripts().packageManagers.some((manager) => manager.name === "brewlinux")).toBe(false);
    expect(listScripts().scripts.some((entry) => entry.id === script.id)).toBe(false);
    expect(getDb().select().from(systemScriptOverrides).where(eq(systemScriptOverrides.scriptId, script.id)).all()).toEqual([]);
  });

  test("does not delete package manager scripts that are still assigned to active systems", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    const script = createScript({
      name: "Check Linuxbrew",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "brewlinux",
      steps: [{ label: "Check", command: "brew outdated" }],
    });
    insertSystem(17);
    getDb()
      .update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["brewlinux"]) })
      .where(eq(systems.id, 17))
      .run();
    setSystemOverrides(17, {
      [buildOperationKey("check_updates", "brewlinux")]: script.id,
    });

    expect(() => deleteCustomPackageManager("brewlinux", { deleteScripts: true }))
      .toThrow(/scripts assigned to one or more systems/);
    expect(listScripts().packageManagers.some((manager) => manager.name === "brewlinux")).toBe(true);
    expect(listScripts().scripts.some((entry) => entry.id === script.id)).toBe(true);
    expect(getDb().select().from(systemScriptOverrides).where(eq(systemScriptOverrides.scriptId, script.id)).all()).toHaveLength(1);
  });

  test("does not delete custom package managers that are still active on systems", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    insertSystem(18);
    getDb()
      .update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["brewlinux"]) })
      .where(eq(systems.id, 18))
      .run();

    expect(() => deleteCustomPackageManager("brewlinux"))
      .toThrow(/enabled or detected on 1 system: system-18/);
    expect(listScripts().packageManagers.some((manager) => manager.name === "brewlinux")).toBe(true);
  });

  test("deletes custom package managers that are detected but disabled on systems", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    insertSystem(19);
    getDb()
      .update(systems)
      .set({
        pkgManager: "brewlinux",
        detectedPkgManagers: JSON.stringify(["brewlinux"]),
        disabledPkgManagers: JSON.stringify(["brewlinux"]),
        pkgManagerConfigs: JSON.stringify({
          apt: { autoHideKeptBackUpdates: true },
          brewlinux: { channel: "edge" },
        }),
      })
      .where(eq(systems.id, 19))
      .run();
    getDb()
      .insert(systemScriptOverrides)
      .values({
        systemId: 19,
        operationKey: "brewlinux/check_updates",
        scriptId: "custom:999",
      })
      .run();

    deleteCustomPackageManager("brewlinux");

    expect(listScripts().packageManagers.some((manager) => manager.name === "brewlinux")).toBe(false);
    const system = getDb()
      .select({
        pkgManager: systems.pkgManager,
        detectedPkgManagers: systems.detectedPkgManagers,
        disabledPkgManagers: systems.disabledPkgManagers,
        pkgManagerConfigs: systems.pkgManagerConfigs,
      })
      .from(systems)
      .where(eq(systems.id, 19))
      .get();
    expect(system).toEqual({
      pkgManager: null,
      detectedPkgManagers: null,
      disabledPkgManagers: null,
      pkgManagerConfigs: JSON.stringify({ apt: { autoHideKeptBackUpdates: true } }),
    });
    expect(getDb()
      .select()
      .from(systemScriptOverrides)
      .where(eq(systemScriptOverrides.systemId, 19))
      .all()).toHaveLength(0);
  });

  test("deletes unused custom package managers", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });

    deleteCustomPackageManager("brewlinux");

    expect(listScripts().packageManagers.some((manager) => manager.name === "brewlinux")).toBe(false);
  });
});
