import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  buildOperationKey,
  createCustomPackageManager,
  createScript,
  deleteCustomPackageManager,
  deleteScript,
  getBuiltinScripts,
  listScripts,
  parseCustomUpdates,
  renderCommandTemplate,
  resolveRuntimeSteps,
  setSystemOverrides,
  updateCustomPackageManager,
} from "../../server/services/script-service";

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
    expect(scripts.some((script) => script.id === "builtin:snap:detect" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:system:system_info" && script.readonly)).toBe(true);
    expect(scripts.some((script) => script.id === "builtin:system:reboot" && script.readonly)).toBe(true);
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
    expect(steps[0]?.command).toContain("full-upgrade -y");

    const systemInfoCopy = createBuiltinCopy("builtin:system:system_info");
    expect(systemInfoCopy.systemInfoConfig).toEqual({ mode: "builtin" });
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

  test("updates custom package manager display metadata", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });

    const updated = updateCustomPackageManager("brewlinux", {
      label: "Homebrew",
      color: "#0f766e",
    });

    expect(updated).toMatchObject({
      name: "brewlinux",
      label: "Homebrew",
      color: "#0f766e",
    });
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

  test("deletes unused custom package managers", () => {
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });

    deleteCustomPackageManager("brewlinux");

    expect(listScripts().packageManagers.some((manager) => manager.name === "brewlinux")).toBe(false);
  });
});
