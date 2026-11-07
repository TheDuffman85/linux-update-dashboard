/**
 * Baseline for how command results become step, activity and operation outcomes.
 *
 * These tests describe the behavior that existing installations rely on. Output
 * rules must not change any of it for scripts that do not define rules, and a copy
 * of a built-in script must behave exactly like the built-in script it was copied from.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { installedPackageCache, upgradeBatchItems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { EXIT_MONITORING_LOST } from "../../server/ssh/connection";
import * as outputStream from "../../server/services/output-stream";
import {
  buildMaintenanceCommand,
  createCustomPackageManager,
  createScript,
  getBuiltinScripts,
  resolveRuntimeSteps,
  setSystemOverrides,
} from "../../server/services/script-service";
import {
  applyAutoremove,
  applyFullUpgradeAll,
  applyUpgradeAll,
  applyUpgradePackages,
  checkUpdates,
  solvePackageManagerIssue,
} from "../../server/services/update-service";
import { createUpgradeBatch, runUpgradeBatches } from "../../server/services/upgrade-batch-service";
import { upsertPackageManagerIssue } from "../../server/services/package-manager-issue-service";
import { APK_BROKEN_STATE_SIMULATION, APK_BROKEN_STATE_UPGRADE } from "../fixtures/apk-pins";
import {
  BUILTIN_APK_SIMULATION_WARNING,
  HEALTHY_APK_SIMULATION,
  PERSISTENT_INFO,
  POST_MARK,
  PRE_MARK,
  apkCheckReplies,
  builtin,
  cacheUpdate,
  copyOf,
  history,
  hookScript,
  insertSystem,
  installSsh,
  resetSystemCounter,
  useScript,
} from "../helpers/script-harness";

function installedPackages(systemId: number): Array<[string, string, string | null]> {
  return getDb().select().from(installedPackageCache).where(eq(installedPackageCache.systemId, systemId)).all()
    .map((row): [string, string, string | null] => [row.packageName, row.currentVersion, row.architecture])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

describe("script outcome baseline", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-outcome-baseline-"));
    resetSystemCounter();
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("update checks", () => {
    test("a healthy APK check succeeds on every step", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION);
      const systemId = insertSystem("apk");

      const updates = await checkUpdates(systemId);

      expect(updates.map((update) => [update.packageName, update.isKeptBack])).toEqual([
        ["base-files", true], ["kernel", true], ["zlib", false],
      ]);
      expect(history(systemId, "check")).toEqual([{
        status: "success",
        error: null,
        steps: [
          { label: "Refreshing package indexes", status: "success", error: null },
          { label: "Listing available updates", status: "success", error: null },
          { label: "Reading pinned versions", status: "success", error: null },
          { label: "Detecting kept-back packages", status: "success", error: null },
          { label: "Listing installed APK packages", status: "success", error: null },
        ],
      }]);
    });

    test("an APK simulation that counts pre-existing errors is a warning, and pins still come from the world file", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(APK_BROKEN_STATE_SIMULATION);
      const systemId = insertSystem("apk");
      const publish = vi.spyOn(outputStream, "publish");

      const updates = await checkUpdates(systemId);

      expect(updates.map((update) => [update.packageName, update.isKeptBack])).toEqual([
        ["base-files", true], ["kernel", true], ["zlib", false],
      ]);
      expect(history(systemId, "check")).toEqual([{
        status: "warning",
        error: `[apk] ${BUILTIN_APK_SIMULATION_WARNING}`,
        steps: [
          { label: "Refreshing package indexes", status: "success", error: null },
          { label: "Listing available updates", status: "success", error: null },
          { label: "Reading pinned versions", status: "success", error: null },
          { label: "Detecting kept-back packages", status: "warning", error: BUILTIN_APK_SIMULATION_WARNING },
          { label: "Listing installed APK packages", status: "success", error: null },
        ],
      }]);
      const messages = publish.mock.calls.map(([, message]) => message);
      expect(messages).toContainEqual({ type: "warning", message: BUILTIN_APK_SIMULATION_WARNING });
      expect(messages.at(-1)).toMatchObject({ type: "done", success: true, warning: true });
    });

    test("a failed check step fails that package manager's check with the command output", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk list -u": { stdout: "", stderr: "ERROR: unable to read database\n", exitCode: 1 },
      });
      const systemId = insertSystem("apk");
      const publish = vi.spyOn(outputStream, "publish");

      await expect(checkUpdates(systemId)).rejects.toThrow("ERROR: unable to read database");

      expect(history(systemId, "check")).toEqual([{
        status: "failed",
        error: "[apk] ERROR: unable to read database\n",
        steps: [
          { label: "Refreshing package indexes", status: "success", error: null },
          { label: "Listing available updates", status: "failed", error: "ERROR: unable to read database\n" },
          { label: "Listing installed APK packages", status: "success", error: null },
        ],
      }]);
      const messages = publish.mock.calls.map(([, message]) => message);
      expect(messages).toContainEqual({ type: "error", message: "ERROR: unable to read database\n" });
      expect(messages.at(-1)).toMatchObject({ type: "done", success: false, warning: false });
    });

    test("a check step with exit code 0 succeeds even when its output reports errors", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk update": { stdout: "ERROR: http://example.invalid: network error\n", exitCode: 0 },
      });
      const systemId = insertSystem("apk");

      await checkUpdates(systemId);

      expect(history(systemId, "check")[0].status).toBe("success");
    });

    test.each([
      ["the built-in script", (_systemId: number) => {}],
      ["an unmodified copy", (systemId: number) => useScript(systemId, copyOf(builtin("apk", "check_updates")))],
      ["a copy with renamed steps", (systemId: number) => {
        const source = builtin("apk", "check_updates");
        useScript(systemId, copyOf(source, source.steps.map((step) => ({ ...step, label: `Custom ${step.label}` }))));
      }],
    ])("%s parses and reports APK checks the same way", async (_name, configure) => {
      const harness = installSsh();
      const systemId = insertSystem("apk");
      configure(systemId);

      harness.run = apkCheckReplies(APK_BROKEN_STATE_SIMULATION);
      const updates = await checkUpdates(systemId);
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk list -u": { stdout: "", stderr: "ERROR: unable to read database\n", exitCode: 1 },
      });
      await checkUpdates(systemId).catch(() => {});

      expect(updates.map((update) => [update.packageName, update.isKeptBack, update.newVersion])).toEqual([
        ["base-files", true, "1718~981c978eff"],
        ["kernel", true, "6.12.112~b4125196ecec75391093e1e2edeba490-r1"],
        ["zlib", false, "1.3.2-r0"],
      ]);
      const outcomes = history(systemId, "check").map((entry) => ({
        status: entry.status,
        error: entry.error,
        steps: entry.steps.map((step) => [step.status, step.error]),
      }));
      expect(outcomes).toEqual([
        {
          status: "warning",
          error: `[apk] ${BUILTIN_APK_SIMULATION_WARNING}`,
          steps: [
            ["success", null], ["success", null], ["success", null],
            ["warning", BUILTIN_APK_SIMULATION_WARNING], ["success", null],
          ],
        },
        {
          status: "failed",
          error: "[apk] ERROR: unable to read database\n",
          steps: [["success", null], ["failed", "ERROR: unable to read database\n"], ["success", null]],
        },
      ]);
    });

    test("an unmodified copy runs the same check commands as the built-in script", () => {
      const builtinSystem = insertSystem("apk");
      const copySystem = insertSystem("apk");
      useScript(copySystem, copyOf(builtin("apk", "check_updates")));

      expect(resolveRuntimeSteps({ systemId: copySystem, operation: "check_updates", pkgManager: "apk" }))
        .toEqual(resolveRuntimeSteps({ systemId: builtinSystem, operation: "check_updates", pkgManager: "apk" }));
    });

    test("an unmodified copy of every built-in package-manager script runs the same commands", () => {
      const builtinSystem = insertSystem("apt");
      const scripts = getBuiltinScripts().filter((script) => script.pkgManager && script.operation !== "detect");
      expect(scripts.length).toBeGreaterThan(30);
      for (const source of scripts) {
        const copySystem = insertSystem(source.pkgManager!);
        useScript(copySystem, copyOf(source));
        const args = { operation: source.operation, pkgManager: source.pkgManager, packages: ["zlib"] };
        expect(resolveRuntimeSteps({ systemId: copySystem, ...args }), source.id)
          .toEqual(resolveRuntimeSteps({ systemId: builtinSystem, ...args }));
      }
    });

    // Edited copies used to lose the built-in parser and failed with "Installed-package
    // parser requires installedPackageRegex", although the Scripts page offers no regex
    // for built-in package managers. Update checks always kept their built-in parser.
    test("an edited copy of a built-in installed-package script keeps the built-in parser", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk list --installed": { stdout: "zlib-1.3.1-r1 x86_64 {zlib} (Zlib) [installed]\nmusl-1.2.5-r9 x86_64 {musl} (MIT) [installed]\n" },
      });
      const systemId = insertSystem("apk");
      useScript(systemId, copyOf(builtin("apk", "list_installed_packages"), [
        { label: "Inventory", command: "apk list --installed 2>/dev/null | sort" },
      ]));

      await checkUpdates(systemId);

      expect(installedPackages(systemId)).toEqual([["musl", "1.2.5-r9", "x86_64"], ["zlib", "1.3.1-r1", "x86_64"]]);
      expect(history(systemId, "check")[0].status).toBe("success");
      expect(history(systemId, "check")[0].steps.at(-1)).toEqual({ label: "Inventory", status: "success", error: null });
    });

    test("an installed-package regex set on a copy still replaces the built-in parser", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk list --installed": { stdout: "zlib 1.3.1-r1\n" },
      });
      const systemId = insertSystem("apk");
      useScript(systemId, copyOf(builtin("apk", "list_installed_packages"), [
        { label: "Inventory", command: "apk list --installed" },
      ], {
        parserConfig: { installedPackageRegex: "^(?<packageName>\\S+) (?<currentVersion>\\S+)$" },
      }));

      await checkUpdates(systemId);

      expect(installedPackages(systemId)).toEqual([["zlib", "1.3.1-r1", null]]);
    });

    test("custom package managers treat configured exit codes as success and fail on others", async () => {
      const harness = installSsh();
      createCustomPackageManager({
        name: "brew",
        label: "Homebrew",
        parserConfig: { updateRegex: "^(?<packageName>\\S+) (?<currentVersion>\\S+) -> (?<newVersion>\\S+)$" },
      });
      const script = createScript({
        name: "Brew check",
        type: "package_manager",
        operation: "check_updates",
        pkgManager: "brew",
        steps: [
          { label: "Refresh", command: "brew update" },
          { label: "List", command: "brew outdated --verbose" },
        ],
        parserConfig: {
          updateRegex: "^(?<packageName>\\S+) (?<currentVersion>\\S+) -> (?<newVersion>\\S+)$",
          successExitCodes: [2],
          updatesExitCodes: [100],
        },
      });
      const systemId = insertSystem("brew");
      useScript(systemId, script);

      let refreshExit = 2;
      harness.run = (command) => {
        if (command === "brew update") return { stdout: "Already up-to-date.\n", stderr: "refresh noise\n", exitCode: refreshExit };
        if (command === "brew outdated --verbose") return { stdout: "wget 1.0 -> 1.1\n", exitCode: 100 };
        return undefined;
      };

      const updates = await checkUpdates(systemId);
      expect(updates.map((update) => update.packageName)).toEqual(["wget"]);
      expect(history(systemId, "check")[0]).toEqual({
        status: "success",
        error: null,
        steps: [
          { label: "Refresh", status: "success", error: null },
          { label: "List", status: "success", error: null },
        ],
      });

      refreshExit = 3;
      await expect(checkUpdates(systemId)).rejects.toThrow("refresh noise");
      expect(history(systemId, "check")[1]).toEqual({
        status: "failed",
        error: "[brew] refresh noise\n",
        steps: [{ label: "Refresh", status: "failed", error: "refresh noise\n" }],
      });
    });

    test("a failed installed-package step keeps the check usable and reports a warning", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk list --installed": { stdout: "", stderr: "inventory failed\n", exitCode: 4 },
      });
      const systemId = insertSystem("apk");

      const updates = await checkUpdates(systemId);

      expect(updates).toHaveLength(3);
      expect(history(systemId, "check")[0]).toEqual({
        status: "warning",
        error: "[apk installed packages] inventory failed\n",
        steps: [
          { label: "Refreshing package indexes", status: "success", error: null },
          { label: "Listing available updates", status: "success", error: null },
          { label: "Reading pinned versions", status: "success", error: null },
          { label: "Detecting kept-back packages", status: "success", error: null },
          { label: "Listing installed APK packages", status: "failed", error: "inventory failed\n" },
        ],
      });
    });
  });

  describe("upgrades", () => {
    test.each([
      ["upgrade all", "upgrade_all", (id: number) => applyUpgradeAll(id)],
      ["full upgrade", "full_upgrade_all", (id: number) => applyFullUpgradeAll(id)],
      ["selected packages", "upgrade_package", (id: number) => applyUpgradePackages(id, ["zlib"])],
    ])("%s: exit code 0 succeeds and reports success to the post-upgrade script", async (_name, action, run) => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(POST_MARK)
        ? { stdout: "post ok" }
        : { stdout: "(1/1) Upgrading zlib (1.3.1-r1 -> 1.3.2-r0)\nOK: 11 MiB in 136 packages\n" };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Report", command: POST_MARK }]).id,
      });
      const publish = vi.spyOn(outputStream, "publish");

      const result = await run(systemId);

      expect(result).toMatchObject({ success: true });
      expect(result.warning).toBeFalsy();
      expect(result.output).toBe("[apk] (1/1) Upgrading zlib (1.3.1-r1 -> 1.3.2-r0)\nOK: 11 MiB in 136 packages\n");
      expect(history(systemId, action)).toEqual([{
        status: "success",
        error: null,
        steps: [{ label: null, status: "success", error: null }],
      }]);
      const post = harness.persistentCommands.find((command) => command.includes(POST_MARK));
      expect(post).toContain("LUDASH_UPGRADE_RESULT=success;");
      expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ type: "done", success: true });
    });

    test.each([
      ["upgrade all", "upgrade_all", (id: number) => applyUpgradeAll(id)],
      ["full upgrade", "full_upgrade_all", (id: number) => applyFullUpgradeAll(id)],
      ["selected packages", "upgrade_package", (id: number) => applyUpgradePackages(id, ["openssh-client"])],
    ])("%s: a non-zero exit code fails even when every package was upgraded", async (_name, action, run) => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(POST_MARK)
        ? { stdout: "post ok" }
        : { stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Report", command: POST_MARK }]).id,
      });
      const publish = vi.spyOn(outputStream, "publish");

      const result = await run(systemId);

      expect(result).toMatchObject({ success: false, output: `[apk] ${APK_BROKEN_STATE_UPGRADE}` });
      expect(result.warning).toBeFalsy();
      expect(history(systemId, action)).toEqual([{
        status: "failed",
        error: APK_BROKEN_STATE_UPGRADE,
        steps: [{ label: null, status: "failed", error: APK_BROKEN_STATE_UPGRADE }],
      }]);
      const post = harness.persistentCommands.find((command) => command.includes(POST_MARK));
      expect(post).toContain("LUDASH_UPGRADE_RESULT=failed;");
      expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ type: "done", success: false });
    });

    test("a non-zero exit code with no output reports the exit code", async () => {
      const harness = installSsh();
      harness.persistent = () => ({ exitCode: 5 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");

      const result = await applyUpgradeAll(systemId);

      expect(result).toMatchObject({ success: false, output: "[apk] Upgrade failed" });
      expect(history(systemId, "upgrade_all")[0]).toEqual({
        status: "failed",
        error: "Upgrade failed",
        steps: [{ label: null, status: "failed", error: "Upgrade failed" }],
      });
    });

    test("an upgrade that exits 0 succeeds even when its output reports errors", async () => {
      const harness = installSsh();
      harness.persistent = () => ({ stdout: "ERROR: something odd\n", exitCode: 0 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");

      const result = await applyUpgradeAll(systemId);

      expect(result.success).toBe(true);
      expect(history(systemId, "upgrade_all")[0].status).toBe("success");
    });

    test.each([
      ["the built-in script", (_systemId: number) => {}],
      ["an unmodified copy", (systemId: number) => useScript(systemId, copyOf(builtin("apk", "upgrade_all")))],
    ])("%s runs and reports APK upgrades the same way", async (_name, configure) => {
      const harness = installSsh();
      harness.persistent = () => ({ stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      configure(systemId);

      const result = await applyUpgradeAll(systemId);

      expect(harness.persistentCommands).toEqual([buildMaintenanceCommand(builtin("apk", "upgrade_all").steps)]);
      expect(result).toMatchObject({ success: false, output: `[apk] ${APK_BROKEN_STATE_UPGRADE}` });
      expect(history(systemId, "upgrade_all")[0].status).toBe("failed");
    });

    test("multi-step upgrade scripts run as one command that stops at the first failed step", () => {
      expect(buildMaintenanceCommand([
        { label: "One", command: "echo one" },
        { label: "Two", command: "echo two" },
      ])).toBe([
        "(",
        "echo one",
        ")",
        "ludash_step_status=$?",
        'if [ "$ludash_step_status" -ne 0 ]; then exit "$ludash_step_status"; fi',
        "(",
        "echo two",
        ")",
        "ludash_step_status=$?",
        'if [ "$ludash_step_status" -ne 0 ]; then exit "$ludash_step_status"; fi',
      ].join("\n"));
      expect(buildMaintenanceCommand([{ label: "One", command: "echo one" }])).toBe("echo one");
    });

    // Intentional change: post-upgrade scripts used to receive "success" here. Every
    // upgrade that ends as a warning now reports LUDASH_UPGRADE_RESULT=warning.
    test("an upgrade that lost SSH and reconnected is a warning and reports it to the post-upgrade script", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.persistent = (command) => command.includes(POST_MARK)
        ? { stdout: "post ok" }
        : { stderr: "lost", exitCode: EXIT_MONITORING_LOST, persistentInfo: PERSISTENT_INFO };
      harness.resume = () => ({ stdout: "upgraded\n", exitCode: 0 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Report", command: POST_MARK }]).id,
      });

      const running = applyUpgradeAll(systemId);
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await running;

      expect(result).toMatchObject({ success: true, warning: true });
      expect(history(systemId, "upgrade_all")[0]).toEqual({
        status: "warning",
        error: null,
        steps: [{ label: null, status: "warning", error: null }],
      });
      const post = harness.persistentCommands.find((command) => command.includes(POST_MARK));
      expect(post).toContain("LUDASH_UPGRADE_RESULT=warning;");
    });

    test("Upgrade All Systems records failed and successful items", async () => {
      const harness = installSsh();
      const failing = insertSystem("apk");
      const passing = insertSystem("apk");
      cacheUpdate(failing, "apk", "openssh-client");
      cacheUpdate(passing, "apk", "zlib");
      harness.persistent = () => harness.persistentCommands.length === 1
        ? { stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 }
        : { stdout: "OK\n" };
      const { batchId } = createUpgradeBatch([{ systemId: failing }, { systemId: passing }], { autoRun: false });

      await runUpgradeBatches();

      const items = getDb().select().from(upgradeBatchItems).where(eq(upgradeBatchItems.batchId, batchId)).all();
      expect(items.map((item) => [item.systemId, item.status])).toEqual([[failing, "failed"], [passing, "success"]]);
      expect(items[0].error).toBe(`[apk] ${APK_BROKEN_STATE_UPGRADE}`);
    });
  });

  describe("autoremove", () => {
    test.each([
      [0, "success", true],
      [1, "failed", false],
    ])("exit code %i is %s", async (exitCode, status, success) => {
      const harness = installSsh();
      harness.persistent = () => ({ stdout: "Removing packages\n", stderr: exitCode ? "E: lock\n" : "", exitCode });
      const systemId = insertSystem("apt");

      const result = await applyAutoremove(systemId);

      expect(result.success).toBe(success);
      expect(result.warning).toBeFalsy();
      expect(result.output).toBe(success ? "[apt] Removing packages\n" : "[apt] E: lock\n");
      expect(history(systemId, "autoremove")).toEqual([{
        status,
        error: success ? null : "E: lock\n",
        steps: [{ label: null, status, error: success ? null : "E: lock\n" }],
      }]);
    });
  });

  describe("repairs", () => {
    test("a failed repair step stops the repair with its error output", async () => {
      const harness = installSsh();
      harness.run = (command) => command.includes("dpkg --configure -a")
        ? { stdout: "Setting up\n", stderr: "dpkg: error processing\n", exitCode: 1 }
        : undefined;
      const systemId = insertSystem("apt");
      const issue = upsertPackageManagerIssue(systemId, {
        pkgManager: "apt",
        issueKey: "apt_dpkg_interrupted",
        title: "APT needs repair",
        message: "dpkg was interrupted",
        repairCommand: "dpkg --configure -a",
      });

      const result = await solvePackageManagerIssue(systemId, issue.id);

      expect(result).toEqual({ success: false, output: "dpkg: error processing\n" });
      expect(history(systemId, "package_manager_repair")).toEqual([{
        status: "failed",
        error: "dpkg: error processing\n",
        steps: [{ label: "Repair APT issue", status: "failed", error: "dpkg: error processing\n" }],
      }]);
    });
  });

  describe("pre- and post-upgrade scripts", () => {
    test("a failed pre-upgrade step vetoes the upgrade and records the failed step", async () => {
      const harness = installSsh();
      harness.persistent = (command) => {
        if (command.includes(`${PRE_MARK} check`)) return { stdout: "cluster busy\n", stderr: "not ready\n", exitCode: 3 };
        return { stdout: "ok\n" };
      };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      setSystemOverrides(systemId, {
        "system/pre_upgrade": hookScript("pre_upgrade", [
          { label: "Drain", command: `${PRE_MARK} drain` },
          { label: "Check", command: `${PRE_MARK} check` },
          { label: "Never", command: `${PRE_MARK} never` },
        ]).id,
      });

      const result = await applyUpgradeAll(systemId);

      expect(result).toMatchObject({ success: false, hookFailed: true });
      expect(result.output).toBe('Pre-upgrade script failed at "Check" with exit code 3: not ready');
      expect(harness.persistentCommands.some((command) => command.includes(`${PRE_MARK} never`))).toBe(false);
      expect(history(systemId, "pre_upgrade")).toEqual([{
        status: "failed",
        error: 'Pre-upgrade script failed at "Check" with exit code 3: not ready',
        steps: [
          { label: "Pre-upgrade script: Drain", status: "success", error: null },
          {
            label: "Pre-upgrade script: Check",
            status: "failed",
            error: 'Pre-upgrade script failed at "Check" with exit code 3: not ready',
          },
        ],
      }]);
      expect(history(systemId, "upgrade_all")).toEqual([]);
    });

    test("a failed post-upgrade step fails the upgrade result", async () => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(POST_MARK)
        ? { stderr: "service did not start\n", exitCode: 2 }
        : { stdout: "OK\n" };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Start", command: POST_MARK }]).id,
      });

      const result = await applyUpgradeAll(systemId);

      expect(result).toMatchObject({ success: false, warning: false, hookFailed: true });
      expect(result.output).toBe('[apk] OK\n\n\nPost-upgrade script failed at "Start" with exit code 2: service did not start');
      expect(history(systemId, "upgrade_all")[0].status).toBe("success");
      expect(history(systemId, "post_upgrade")[0].status).toBe("failed");
    });
  });
});
