import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { customScripts, installedPackageCache, systems, upgradeBatchItems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { EXIT_MONITORING_LOST } from "../../server/ssh/connection";
import * as outputStream from "../../server/services/output-stream";
import {
  createCustomPackageManager,
  createScript,
  exportCustomPackageManagerBundle,
  getBuiltinScripts,
  getScriptById,
  importCustomPackageManagerBundle,
  normalizeCustomPackageManagerBundle,
  resolveRuntimeSteps,
  setSystemOverrides,
  updateScript,
  type OutputRule,
  type ScriptDefinition,
} from "../../server/services/script-service";
import {
  applyAutoremove,
  applyFullUpgradeAll,
  applyUpgradeAll,
  applyUpgradePackages,
  checkUpdates,
  runPendingPostUpgradeScript,
  solvePackageManagerIssue,
} from "../../server/services/update-service";
import { createUpgradeBatch, runUpgradeBatches } from "../../server/services/upgrade-batch-service";
import { upsertPackageManagerIssue } from "../../server/services/package-manager-issue-service";
import { APK_BROKEN_STATE_SIMULATION, APK_BROKEN_STATE_UPGRADE } from "../fixtures/apk-pins";
import {
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

/** The rules the reporter of issue #314 needs on a self-compiled OpenWrt image. */
const APK_SIMULATION_RULE: OutputRule = {
  step: "Detecting kept-back packages",
  match: "^\\d+ errors?;",
  notMatch: "^ERROR:",
  outcome: "success",
};
const APK_UPGRADE_RULE: OutputRule = {
  match: "^(?<count>\\d+) errors?;",
  notMatch: "^ERROR:",
  outcome: "warning",
  message: "apk counted $<count> pre-existing error(s)",
};

function packageManagerScript(input: Partial<ScriptDefinition>): ScriptDefinition {
  return createScript({
    name: "Rules",
    type: "package_manager",
    pkgManager: "apk",
    operation: "upgrade_all",
    steps: [{ label: "Upgrade", command: "apk upgrade" }],
    ...input,
  });
}

describe("output rules", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-output-rules-"));
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

  describe("scripts", () => {
    test("adds the rules column to existing databases and reads old scripts without rules", () => {
      closeDatabase();
      const path = join(tempDir, "legacy.db");
      const legacy = new Database(path);
      legacy.exec(`CREATE TABLE custom_scripts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        operation TEXT NOT NULL,
        pkg_manager TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        steps TEXT NOT NULL,
        parser_config TEXT,
        system_info_config TEXT,
        source_script_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
      legacy.prepare("INSERT INTO custom_scripts (name, type, operation, pkg_manager, steps) VALUES (?, ?, ?, ?, ?)")
        .run("Old upgrade", "package_manager", "upgrade_all", "apk", JSON.stringify([{ label: "Upgrade", command: "apk upgrade" }]));
      legacy.close();

      initDatabase(path);

      expect(getScriptById("custom:1")).toMatchObject({ name: "Old upgrade", outputRules: [] });
      expect(updateScript("custom:1", { outputRules: [APK_UPGRADE_RULE] }).outputRules).toEqual([APK_UPGRADE_RULE]);
    });

    test("built-in scripts and their copies start without rules", () => {
      expect(getBuiltinScripts().every((script) => Array.isArray(script.outputRules) && script.outputRules.length === 0))
        .toBe(true);
      expect(copyOf(builtin("apk", "upgrade_all")).outputRules).toEqual([]);
    });

    test("stores normalized rules and returns them", () => {
      const script = packageManagerScript({
        outputRules: [
          { match: "  ^\\d+ errors?;  ", notMatch: "", outcome: "warning", message: "  counted  ", exitCodes: [] },
          { exitCodes: [1, 2], outcome: "success", message: "" },
        ],
      });

      expect(script.outputRules).toEqual([
        { match: "^\\d+ errors?;", outcome: "warning", message: "counted" },
        { exitCodes: [1, 2], outcome: "success" },
      ]);
      expect(getScriptById(script.id)?.outputRules).toEqual(script.outputRules);
      const row = getDb().select().from(customScripts).all()[0];
      expect(JSON.parse(row.outputRules!)).toEqual(script.outputRules);
    });

    test("scripts without rules store nothing and keep their rules on partial updates", () => {
      const script = packageManagerScript({});
      expect(getDb().select().from(customScripts).all()[0].outputRules).toBeNull();

      const withRules = updateScript(script.id, { outputRules: [APK_UPGRADE_RULE] });
      expect(withRules.outputRules).toEqual([APK_UPGRADE_RULE]);
      expect(updateScript(script.id, { name: "Renamed" }).outputRules).toEqual([APK_UPGRADE_RULE]);
      expect(updateScript(script.id, { outputRules: [] }).outputRules).toEqual([]);
      expect(getDb().select().from(customScripts).all()[0].outputRules).toBeNull();
    });

    test.each<[string, Partial<ScriptDefinition>, string]>([
      ["not an array", { outputRules: "x" as unknown as OutputRule[] }, "outputRules must be an array"],
      ["an unsupported operation", {
        operation: "detect",
        steps: [{ label: "Detect", command: "echo found" }],
        outputRules: [{ exitCodes: [1], outcome: "success" }],
      }, "outputRules are not supported for detect scripts"],
      ["a missing condition", { outputRules: [{ outcome: "success" }] }, "outputRules.0 needs exit codes, a match pattern, or a not-match pattern"],
      ["an unknown outcome", { outputRules: [{ exitCodes: [1], outcome: "ignored" as OutputRule["outcome"] }] }, "outputRules.0.outcome must be success, warning, or failed"],
      ["an unknown key", { outputRules: [{ exitCodes: [1], outcome: "success", level: 1 } as OutputRule] }, "outputRules.0.level is not supported"],
      ["invalid exit codes", { outputRules: [{ exitCodes: [300], outcome: "success" }] }, "outputRules.0.exitCodes must contain exit codes between 0 and 255"],
      ["an invalid pattern", { outputRules: [{ match: "(", outcome: "success" }] }, "outputRules.0.match is not a valid regular expression"],
      ["an unsafe pattern", { outputRules: [{ notMatch: "(a+)+", outcome: "success" }] }, "outputRules.0.notMatch contains an unsafe regular expression pattern"],
      ["a long message", { outputRules: [{ exitCodes: [1], outcome: "warning", message: "x".repeat(501) }] }, "outputRules.0.message must be 500 characters or less"],
      ["too many rules", { outputRules: Array.from({ length: 21 }, () => ({ exitCodes: [1], outcome: "success" as const })) }, "outputRules must include at most 20 rules"],
      ["a step on an operation that runs as one command", { outputRules: [{ step: "Upgrade", exitCodes: [1], outcome: "success" }] }, "outputRules.0.step is not supported because upgrade_all steps run as one command"],
      ["an unknown step label", {
        operation: "check_updates",
        outputRules: [{ step: "Missing", exitCodes: [1], outcome: "success" }],
      }, "outputRules.0.step must match a step label"],
      ["an ambiguous step label", {
        operation: "check_updates",
        steps: [{ label: "Same", command: "true" }, { label: "Same", command: "false" }],
        outputRules: [{ step: "Same", exitCodes: [1], outcome: "success" }],
      }, "outputRules.0.step matches more than one step; give the steps distinct labels"],
      ["a step position out of range", {
        operation: "check_updates",
        outputRules: [{ step: 1, exitCodes: [1], outcome: "success" }],
      }, "outputRules.0.step must reference an existing step"],
    ])("rejects %s", (_name, input, message) => {
      expect(() => packageManagerScript(input)).toThrow(message);
    });

    test("renaming a step that a rule refers to is rejected", () => {
      const script = packageManagerScript({
        operation: "check_updates",
        steps: [{ label: "List", command: "apk list -u" }],
        outputRules: [{ step: "List", exitCodes: [1], outcome: "success" }],
      });
      expect(() => updateScript(script.id, { steps: [{ label: "Listing", command: "apk list -u" }] }))
        .toThrow("outputRules.0.step must match a step label");
    });

    test("runtime steps carry the rules, so a snapshot of the steps keeps them", () => {
      const systemId = insertSystem("apk");
      const script = hookScript("pre_upgrade", [{ label: "Drain", command: PRE_MARK }], {
        outputRules: [{ step: "Drain", exitCodes: [3], outcome: "warning" }],
      });
      setSystemOverrides(systemId, { "system/pre_upgrade": script.id });
      expect(resolveRuntimeSteps({ systemId, operation: "pre_upgrade" })).toEqual([{
        label: "Drain",
        command: PRE_MARK,
        outputRules: [{ step: "Drain", exitCodes: [3], outcome: "warning" }],
      }]);
      expect(resolveRuntimeSteps({ systemId, operation: "check_updates", pkgManager: "apk" })[0])
        .not.toHaveProperty("outputRules");
    });

    test("bundles export rules only for scripts that have them and import them again", () => {
      createCustomPackageManager({ name: "brew", label: "Homebrew", parserConfig: null });
      createScript({
        name: "Brew upgrade",
        type: "package_manager",
        operation: "upgrade_all",
        pkgManager: "brew",
        steps: [{ label: "Upgrade", command: "brew upgrade" }],
        outputRules: [{ exitCodes: [1], match: "already installed", outcome: "success" }],
      });
      createScript({
        name: "Brew autoremove",
        type: "package_manager",
        operation: "autoremove",
        pkgManager: "brew",
        steps: [{ label: "Clean", command: "brew autoremove" }],
      });

      const bundle = exportCustomPackageManagerBundle("brew");
      const byName = Object.fromEntries(bundle.scripts.map((script) => [script.name, script]));
      expect(byName["Brew upgrade"].outputRules).toEqual([{ exitCodes: [1], match: "already installed", outcome: "success" }]);
      expect(byName["Brew autoremove"]).not.toHaveProperty("outputRules");

      const renamed = JSON.parse(JSON.stringify(bundle).replaceAll("brew", "linuxbrew"));
      const imported = importCustomPackageManagerBundle(normalizeCustomPackageManagerBundle(renamed));
      const importedRules = Object.fromEntries(imported.scripts.map((script) => [script.name, script.outputRules]));
      expect(imported.manager.name).toBe("linuxbrew");
      expect(importedRules).toEqual({
        "Brew upgrade": [{ exitCodes: [1], match: "already installed", outcome: "success" }],
        "Brew autoremove": [],
      });
    });

    test("importing a bundle without rules clears the rules of the script it replaces", () => {
      createCustomPackageManager({ name: "brew", label: "Homebrew", parserConfig: null });
      const script = createScript({
        name: "Brew upgrade",
        type: "package_manager",
        operation: "upgrade_all",
        pkgManager: "brew",
        steps: [{ label: "Upgrade", command: "brew upgrade" }],
        outputRules: [{ exitCodes: [1], outcome: "success" }],
      });
      const bundle = exportCustomPackageManagerBundle("brew");
      delete bundle.scripts[0].outputRules;

      importCustomPackageManagerBundle(bundle);

      expect(getScriptById(script.id)?.outputRules).toEqual([]);
    });
  });

  describe("update checks", () => {
    test("rules that do not match change nothing", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(APK_BROKEN_STATE_SIMULATION);
      harness.persistent = () => ({ stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 });
      const builtinSystem = insertSystem("apk");
      const copySystem = insertSystem("apk");
      const neverMatches: OutputRule[] = [{ exitCodes: [42], outcome: "success" }, { match: "^never$", outcome: "failed" }];
      useScript(copySystem, copyOf(builtin("apk", "check_updates"), undefined, { outputRules: neverMatches }));
      useScript(copySystem, copyOf(builtin("apk", "upgrade_all"), undefined, { outputRules: neverMatches }));
      cacheUpdate(builtinSystem, "apk", "openssh-client");
      cacheUpdate(copySystem, "apk", "openssh-client");

      const outcomes = [];
      for (const systemId of [builtinSystem, copySystem]) {
        const updates = await checkUpdates(systemId);
        const result = await applyUpgradeAll(systemId);
        outcomes.push({
          updates: updates.map((update) => [update.packageName, update.isKeptBack]),
          result,
          check: history(systemId, "check"),
          upgrade: history(systemId, "upgrade_all"),
        });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(outcomes[0].result.success).toBe(false);
    });

    test("a success rule accepts an APK simulation that counts pre-existing errors", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(APK_BROKEN_STATE_SIMULATION);
      const systemId = insertSystem("apk");
      useScript(systemId, copyOf(builtin("apk", "check_updates"), undefined, { outputRules: [APK_SIMULATION_RULE] }));
      const publish = vi.spyOn(outputStream, "publish");

      const updates = await checkUpdates(systemId);

      // The parser still reads the output as usual, so exact pins still come from the world file.
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
      expect(publish.mock.calls.some(([, message]) => message.type === "warning")).toBe(false);
    });

    test("rules limited to one step do not affect the other steps", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk list -u": { stderr: "1 error; listing failed\n", exitCode: 1 },
      });
      const systemId = insertSystem("apk");
      useScript(systemId, copyOf(builtin("apk", "check_updates"), undefined, { outputRules: [APK_SIMULATION_RULE] }));

      await expect(checkUpdates(systemId)).rejects.toThrow("listing failed");
      expect(history(systemId, "check")[0].status).toBe("failed");
    });

    test("a warning rule replaces the parser warning with its message", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(APK_BROKEN_STATE_SIMULATION);
      const systemId = insertSystem("apk");
      useScript(systemId, copyOf(builtin("apk", "check_updates"), undefined, {
        outputRules: [{ ...APK_SIMULATION_RULE, outcome: "warning", message: "Known apk errors on this image" }],
      }));

      await checkUpdates(systemId);

      expect(history(systemId, "check")[0]).toMatchObject({
        status: "warning",
        error: "[apk] Known apk errors on this image",
      });
      expect(history(systemId, "check")[0].steps[3]).toEqual({
        label: "Detecting kept-back packages",
        status: "warning",
        error: "Known apk errors on this image",
      });
    });

    test("a warning rule without a message keeps the parser warning", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(APK_BROKEN_STATE_SIMULATION);
      const systemId = insertSystem("apk");
      useScript(systemId, copyOf(builtin("apk", "check_updates"), undefined, {
        outputRules: [{ ...APK_SIMULATION_RULE, outcome: "warning" }],
      }));

      await checkUpdates(systemId);

      expect(history(systemId, "check")[0].steps[3].error).toContain("APK upgrade simulation failed (exit code 1)");
    });

    test("a failed rule fails a step that exited with 0", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk update": { stdout: "WARNING: fetching http://example.invalid: network error\n" },
      });
      const systemId = insertSystem("apk");
      useScript(systemId, copyOf(builtin("apk", "check_updates"), undefined, {
        outputRules: [{ step: "Refreshing package indexes", match: "network error", outcome: "failed" }],
      }));

      await expect(checkUpdates(systemId)).rejects.toThrow("Output rule 1 marked the result as failed.");
      expect(history(systemId, "check")[0]).toMatchObject({
        status: "failed",
        error: "[apk] Output rule 1 marked the result as failed.",
      });
    });

    test("rules take precedence over the exit-code lists of custom package managers", async () => {
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
        steps: [{ label: "List", command: "brew outdated --verbose" }],
        parserConfig: {
          updateRegex: "^(?<packageName>\\S+) (?<currentVersion>\\S+) -> (?<newVersion>\\S+)$",
          successExitCodes: [2],
        },
        outputRules: [
          { exitCodes: [2], match: "rate limit", outcome: "failed", message: "GitHub rate limit reached" },
          { exitCodes: [3], outcome: "success" },
        ],
      });
      const systemId = insertSystem("brew");
      useScript(systemId, script);
      let reply = { stdout: "wget 1.0 -> 1.1\n", stderr: "", exitCode: 3 };
      harness.run = (command) => command === "brew outdated --verbose" ? reply : undefined;

      expect((await checkUpdates(systemId)).map((update) => update.packageName)).toEqual(["wget"]);

      reply = { stdout: "wget 1.0 -> 1.1\n", stderr: "API rate limit exceeded\n", exitCode: 2 };
      await expect(checkUpdates(systemId)).rejects.toThrow("GitHub rate limit reached");

      reply = { stdout: "wget 1.0 -> 1.1\n", stderr: "", exitCode: 2 };
      expect((await checkUpdates(systemId)).map((update) => update.packageName)).toEqual(["wget"]);
    });

    test("an installed-package rule can turn a failed listing into a warning and still read it", async () => {
      const harness = installSsh();
      harness.run = apkCheckReplies(HEALTHY_APK_SIMULATION, {
        "apk list --installed": {
          stdout: "zlib-1.3.1-r1 x86_64 {zlib} (Zlib) [installed]\n",
          stderr: "1 error\n",
          exitCode: 1,
        },
      });
      const systemId = insertSystem("apk");
      const source = builtin("apk", "list_installed_packages");
      useScript(systemId, copyOf(source, undefined, {
        outputRules: [{ exitCodes: [1], outcome: "warning", message: "Inventory reported errors" }],
      }));

      await checkUpdates(systemId);

      // An unmodified copy keeps the built-in inventory parser, rules or not.
      expect(getDb().select().from(installedPackageCache).where(eq(installedPackageCache.systemId, systemId)).all()
        .map((row) => [row.packageName, row.currentVersion])).toEqual([["zlib", "1.3.1-r1"]]);
      expect(history(systemId, "check")[0]).toMatchObject({
        status: "warning",
        error: "[apk installed packages] Inventory reported errors",
      });
      expect(history(systemId, "check")[0].steps.at(-1)).toEqual({
        label: "Listing installed APK packages",
        status: "warning",
        error: "Inventory reported errors",
      });
    });
  });

  describe("upgrades", () => {
    test.each([
      ["upgrade all", "upgrade_all", "upgrade_all", (id: number) => applyUpgradeAll(id)],
      ["full upgrade, which falls back to the upgrade-all script", "upgrade_all", "full_upgrade_all", (id: number) => applyFullUpgradeAll(id)],
      ["selected packages", "upgrade_selected", "upgrade_package", (id: number) => applyUpgradePackages(id, ["openssh-client"])],
    ] as const)("%s: a warning rule turns the issue #314 failure into a warning", async (_name, operation, action, run) => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(POST_MARK)
        ? { stdout: "post ok" }
        : { stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      useScript(systemId, copyOf(builtin("apk", operation), undefined, { outputRules: [APK_UPGRADE_RULE] }));
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Report", command: POST_MARK }]).id,
      });
      const publish = vi.spyOn(outputStream, "publish");

      const result = await run(systemId);

      expect(result).toEqual({
        success: true,
        warning: true,
        output: `[apk] ${APK_BROKEN_STATE_UPGRADE}apk counted 1 pre-existing error(s)`,
      });
      expect(history(systemId, action)).toEqual([{
        status: "warning",
        error: "apk counted 1 pre-existing error(s)",
        steps: [{ label: null, status: "warning", error: "apk counted 1 pre-existing error(s)" }],
      }]);
      const post = harness.persistentCommands.find((command) => command.includes(POST_MARK));
      expect(post).toContain("LUDASH_UPGRADE_RESULT=warning;");
      const messages = publish.mock.calls.map(([, message]) => message);
      expect(messages).toContainEqual({ type: "warning", message: "apk counted 1 pre-existing error(s)" });
      expect(messages.at(-1)).toMatchObject({ type: "done", success: true, warning: true });
    });

    test("a slow pattern is stopped and skipped instead of blocking the server", async () => {
      const harness = installSsh();
      harness.persistent = () => ({ stdout: `${"a".repeat(45)}!\n${APK_BROKEN_STATE_UPGRADE}`, exitCode: 1 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      useScript(systemId, copyOf(builtin("apk", "upgrade_all"), undefined, {
        outputRules: [{ match: "^(a|aa)+$", outcome: "success" }, APK_UPGRADE_RULE],
      }));
      const publish = vi.spyOn(outputStream, "publish");
      const started = Date.now();

      const result = await applyUpgradeAll(systemId);

      expect(Date.now() - started).toBeLessThan(5000);
      expect(result).toMatchObject({ success: true, warning: true });
      expect(result.output).toContain("apk counted 1 pre-existing error(s)");
      expect(publish.mock.calls.map(([, message]) => message)).toContainEqual({
        type: "warning",
        message: "Output rule 1 took longer than 100 ms to match and was skipped. Simplify its patterns.",
      });
    });

    test("a real apk error still fails the upgrade", async () => {
      const harness = installSsh();
      const output = "ERROR: unable to select packages:\n  so:libc.musl (no such package)\n";
      harness.persistent = () => ({ stdout: output, exitCode: 1 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      useScript(systemId, copyOf(builtin("apk", "upgrade_all"), undefined, { outputRules: [APK_UPGRADE_RULE] }));

      const result = await applyUpgradeAll(systemId);

      expect(result).toMatchObject({ success: false, output: `[apk] ${output}` });
      expect(history(systemId, "upgrade_all")[0].status).toBe("failed");
    });

    test("a success rule makes the upgrade succeed", async () => {
      const harness = installSsh();
      harness.persistent = () => ({ stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      useScript(systemId, copyOf(builtin("apk", "upgrade_all"), undefined, {
        outputRules: [{ ...APK_UPGRADE_RULE, outcome: "success" }],
      }));

      const result = await applyUpgradeAll(systemId);

      expect(result).toEqual({ success: true, warning: false, output: `[apk] ${APK_BROKEN_STATE_UPGRADE}` });
      expect(history(systemId, "upgrade_all")[0]).toEqual({
        status: "success",
        error: null,
        steps: [{ label: null, status: "success", error: null }],
      });
    });

    test("a failed rule fails an upgrade that exited with 0", async () => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(POST_MARK)
        ? { stdout: "post ok" }
        : { stdout: "Error: Failed to download metadata for repo 'epel'\n", exitCode: 0 };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      useScript(systemId, copyOf(builtin("apk", "upgrade_all"), undefined, {
        outputRules: [{ exitCodes: [0], match: "^Error:", outcome: "failed" }],
      }));
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Report", command: POST_MARK }]).id,
      });

      const result = await applyUpgradeAll(systemId);

      expect(result).toMatchObject({ success: false, output: "[apk] Output rule 1 marked the result as failed." });
      expect(history(systemId, "upgrade_all")[0]).toMatchObject({
        status: "failed",
        error: "Output rule 1 marked the result as failed.",
      });
      expect(harness.persistentCommands.find((command) => command.includes(POST_MARK)))
        .toContain("LUDASH_UPGRADE_RESULT=failed;");
    });

    test("rules apply to the exit code reported after reconnecting", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.persistent = () => ({ stderr: "lost", exitCode: EXIT_MONITORING_LOST, persistentInfo: PERSISTENT_INFO });
      harness.resume = () => ({ stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      useScript(systemId, copyOf(builtin("apk", "upgrade_all"), undefined, {
        outputRules: [{ ...APK_UPGRADE_RULE, outcome: "success" }],
      }));

      const running = applyUpgradeAll(systemId);
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await running;

      expect(result).toMatchObject({ success: true, warning: true });
      expect(history(systemId, "upgrade_all")[0].status).toBe("warning");
    });

    test("Upgrade All Systems records a rule warning as a warning item", async () => {
      const harness = installSsh();
      harness.persistent = () => ({ stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 });
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      useScript(systemId, copyOf(builtin("apk", "upgrade_all"), undefined, { outputRules: [APK_UPGRADE_RULE] }));
      const { batchId } = createUpgradeBatch([{ systemId }], { autoRun: false });

      await runUpgradeBatches();

      const item = getDb().select().from(upgradeBatchItems).where(eq(upgradeBatchItems.batchId, batchId)).get();
      expect(item).toMatchObject({ status: "warning", error: null });
    });

    test("autoremove: a warning rule makes the result a warning", async () => {
      const harness = installSsh();
      // Persistent commands write both streams to one log, which is returned as stdout.
      harness.persistent = () => ({ stdout: "Removing\nW: something odd\n", exitCode: 100 });
      const systemId = insertSystem("apt");
      useScript(systemId, copyOf(builtin("apt", "autoremove"), undefined, {
        outputRules: [{ exitCodes: [100], match: "^W:", outcome: "warning" }],
      }));

      const result = await applyAutoremove(systemId);

      const warning = "Command exited with code 100. Output rule 1 marked the result as a warning.";
      expect(result).toEqual({ success: true, warning: true, output: `[apt] Removing\nW: something odd\n${warning}` });
      expect(history(systemId, "autoremove")[0]).toEqual({
        status: "warning",
        error: warning,
        steps: [{ label: null, status: "warning", error: warning }],
      });
    });
  });

  describe("repairs", () => {
    // The dpkg audit in the recheck mentions the repair command in its message.
    const isRepairCommand = (command: string) =>
      command.includes("dpkg --configure -a") && !command.includes("dpkg --audit");

    function repairSystem(rules: OutputRule[]): { systemId: number; issueId: number } {
      const systemId = insertSystem("apt");
      const source = builtin("apt", "repair_issue");
      useScript(systemId, copyOf(source, undefined, { outputRules: rules }));
      const issue = upsertPackageManagerIssue(systemId, {
        pkgManager: "apt",
        issueKey: "apt_dpkg_interrupted",
        title: "APT needs repair",
        message: "dpkg was interrupted",
        repairCommand: "dpkg --configure -a",
      });
      return { systemId, issueId: issue.id };
    }

    test("a warning rule lets the repair continue and records the warning", async () => {
      const harness = installSsh();
      harness.run = (command) => isRepairCommand(command)
        ? { stdout: "Setting up\n", stderr: "dpkg: warning: odd\n", exitCode: 1 }
        : undefined;
      const { systemId, issueId } = repairSystem([{ exitCodes: [1], match: "dpkg: warning", outcome: "warning", message: "dpkg warned" }]);

      const publish = vi.spyOn(outputStream, "publish");

      const result = await solvePackageManagerIssue(systemId, issueId);

      expect(result).toEqual({ success: true, warning: true, output: "Package manager issue repaired\n\ndpkg warned" });
      expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ type: "done", success: true, warning: true });
      expect(history(systemId, "package_manager_repair")).toEqual([{
        status: "warning",
        error: "dpkg warned",
        steps: [{ label: "Repair APT issue", status: "warning", error: "dpkg warned" }],
      }]);
    });

    test("a failed rule stops a repair that exited with 0", async () => {
      const harness = installSsh();
      harness.run = (command) => isRepairCommand(command)
        ? { stdout: "dpkg: error processing package foo\n" }
        : undefined;
      const { systemId, issueId } = repairSystem([{ match: "error processing", outcome: "failed", message: "dpkg could not configure a package" }]);

      const result = await solvePackageManagerIssue(systemId, issueId);

      expect(result).toEqual({ success: false, output: "dpkg could not configure a package" });
      expect(history(systemId, "package_manager_repair")[0]).toMatchObject({ status: "failed", error: "dpkg could not configure a package" });
    });
  });

  describe("pre- and post-upgrade scripts", () => {
    test("a warning rule on a pre-upgrade step lets the upgrade run and makes the result a warning", async () => {
      const harness = installSsh();
      harness.persistent = (command) => {
        if (command.includes(PRE_MARK)) return { stdout: "node already drained\n", exitCode: 3 };
        if (command.includes(POST_MARK)) return { stdout: "post ok\n" };
        return { stdout: "OK\n" };
      };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      setSystemOverrides(systemId, {
        "system/pre_upgrade": hookScript("pre_upgrade", [{ label: "Drain", command: PRE_MARK }], {
          outputRules: [{ step: "Drain", exitCodes: [3], outcome: "warning", message: "Node was already drained" }],
        }).id,
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Report", command: POST_MARK }]).id,
      });

      const result = await applyUpgradeAll(systemId);

      const warning = 'Pre-upgrade script step "Drain": Node was already drained';
      expect(result).toEqual({ success: true, warning: true, output: `[apk] OK\n\n\n${warning}` });
      expect(history(systemId, "pre_upgrade")).toEqual([{
        status: "warning",
        error: warning,
        steps: [{ label: "Pre-upgrade script: Drain", status: "warning", error: warning }],
      }]);
      expect(history(systemId, "upgrade_all")[0].status).toBe("success");
      expect(harness.persistentCommands.find((command) => command.includes(POST_MARK)))
        .toContain("LUDASH_UPGRADE_RESULT=warning;");
      expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.postUpgradePendingAt).toBeNull();
    });

    test.each([
      ["warned", { stdout: APK_BROKEN_STATE_UPGRADE, exitCode: 1 }, { success: true, warning: true }],
      ["failed", { stdout: "ERROR: unable to select packages\n", exitCode: 1 }, { success: false }],
    ])("the pre-upgrade warning stays in the output when the upgrade itself %s", async (_name, upgrade, expected) => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(PRE_MARK) ? { stdout: "drained\n", exitCode: 3 } : upgrade;
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "openssh-client");
      useScript(systemId, copyOf(builtin("apk", "upgrade_all"), undefined, { outputRules: [APK_UPGRADE_RULE] }));
      setSystemOverrides(systemId, {
        "system/pre_upgrade": hookScript("pre_upgrade", [{ label: "Drain", command: PRE_MARK }], {
          outputRules: [{ exitCodes: [3], outcome: "warning", message: "Node was already drained" }],
        }).id,
      });

      const result = await applyUpgradeAll(systemId);

      expect(result).toMatchObject(expected);
      expect(result.output).toContain('Pre-upgrade script step "Drain": Node was already drained');
      if (expected.success) expect(result.output).toContain("apk counted 1 pre-existing error(s)");
    });

    test("a failed rule on a pre-upgrade step that exited with 0 vetoes the upgrade", async () => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(PRE_MARK)
        ? { stdout: "cluster: degraded\n", exitCode: 0 }
        : { stdout: "OK\n" };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      setSystemOverrides(systemId, {
        "system/pre_upgrade": hookScript("pre_upgrade", [{ label: "Check", command: PRE_MARK }], {
          outputRules: [{ match: "degraded", outcome: "failed", message: "The cluster is degraded" }],
        }).id,
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Report", command: POST_MARK }]).id,
      });

      const result = await applyUpgradeAll(systemId);

      expect(result).toEqual({
        success: false,
        hookFailed: true,
        output: 'Pre-upgrade script failed at "Check": The cluster is degraded',
      });
      expect(harness.persistentCommands.some((command) => command.includes(POST_MARK))).toBe(false);
      expect(history(systemId, "upgrade_all")).toEqual([]);
      // The script finished, so nothing is left for the post-upgrade script to recover.
      expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.postUpgradePendingAt).toBeNull();
    });

    test("a warning rule on a post-upgrade step makes the result a warning and clears the pending script", async () => {
      const harness = installSsh();
      harness.persistent = (command) => command.includes(POST_MARK)
        ? { stdout: "service restarted slowly\n", exitCode: 4 }
        : { stdout: "OK\n" };
      const systemId = insertSystem("apk");
      cacheUpdate(systemId, "apk", "zlib");
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Start", command: POST_MARK }], {
          outputRules: [{ exitCodes: [4], outcome: "warning" }],
        }).id,
      });

      const result = await applyUpgradeAll(systemId);

      const warning = 'Post-upgrade script step "Start": Command exited with code 4. Output rule 1 marked the result as a warning.';
      expect(result).toEqual({ success: true, warning: true, output: `[apk] OK\n\n\n${warning}` });
      expect(history(systemId, "post_upgrade")[0]).toMatchObject({ status: "warning", error: warning });
      expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.postUpgradePendingAt).toBeNull();
    });

    test("running a pending post-upgrade script with a warning counts as done", async () => {
      const harness = installSsh();
      harness.persistent = () => ({ stdout: "slow\n", exitCode: 4 });
      const systemId = insertSystem("apk");
      setSystemOverrides(systemId, {
        "system/post_upgrade": hookScript("post_upgrade", [{ label: "Start", command: POST_MARK }], {
          outputRules: [{ exitCodes: [4], outcome: "warning", message: "slow start" }],
        }).id,
      });
      getDb().update(systems).set({ postUpgradePendingAt: "2026-01-01 00:00:00" }).where(eq(systems.id, systemId)).run();

      const result = await runPendingPostUpgradeScript(systemId);

      expect(result).toEqual({
        success: true,
        warning: true,
        cancelled: false,
        hookFailed: false,
        output: 'Post-upgrade script step "Start": slow start',
      });
      expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.postUpgradePendingAt).toBeNull();
    });
  });
});
