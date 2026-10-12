import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import BetterSqlite3 from "better-sqlite3";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import {
  customPackageManagers,
  customScripts,
  installedPackageCache,
  systemScriptOverrides,
  systems,
} from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { debGetParser, DEB_GET_UPDATE_MARKER, debGetCheckScript } from "../../server/ssh/parsers/deb-get";
import { getParser } from "../../server/ssh/parsers";
import { getPackageManagerDetectionCommands } from "../../server/ssh/detector";
import { parseBuiltinInstalledPackages } from "../../server/ssh/installed-packages";
import {
  buildCommandReference,
  normalizeCommandForSudoers,
} from "../../server/services/command-reference";
import { buildSudoersPreview } from "../../server/services/sudoers-preview";
import {
  createCustomPackageManager,
  createScript,
  getBuiltinScripts,
  listPackageManagerDefinitions,
  updateCustomPackageManager,
} from "../../server/services/script-service";
import { applyPackageOwnershipClaims } from "../../server/services/package-ownership";
import { replaceInstalledPackagesForManager } from "../../server/services/installed-package-service";
import type { ParsedUpdate } from "../../server/ssh/parsers";

function referenceSystem(managers: string[]) {
  return {
    pkgManager: managers[0],
    detectedPkgManagers: JSON.stringify(managers),
    disabledPkgManagers: null,
    pkgManagerConfigs: null,
  };
}

function update(pkgManager: string, packageName: string): ParsedUpdate {
  return {
    packageName,
    currentVersion: "1.0.0",
    newVersion: "2.0.0",
    architecture: null,
    repository: null,
    isSecurity: false,
    isKeptBack: false,
    pkgManager,
  };
}

describe("deb-get built-in package manager", () => {
  test("parses marked update lines and ignores everything else", () => {
    const stdout = [
      `${DEB_GET_UPDATE_MARKER}\tobsidian\t1.12.7\t1.13.4`,
      "  [+] obsidian (1.12.7) has an update pending. 1.13.4 is available.",
      `${DEB_GET_UPDATE_MARKER}\tdrawio\t1:24.0\t1:24.1`,
      `${DEB_GET_UPDATE_MARKER}\tbroken`,
    ].join("\n");

    expect(debGetParser.parseCheckOutput(stdout, "", 0)).toEqual([
      expect.objectContaining({ packageName: "obsidian", currentVersion: "1.12.7", newVersion: "1.13.4", pkgManager: "deb-get", repository: "deb-get" }),
      expect.objectContaining({ packageName: "drawio", currentVersion: "1:24.0", newVersion: "1:24.1" }),
    ]);
    expect(getParser("deb-get")).toBe(debGetParser);
  });

  test("checks only apps deb-get owns and never runs deb-get update", () => {
    const script = debGetCheckScript();

    expect(script).toContain("$3 !~ /^(apt|ppa)$/");
    expect(script).toContain(`sudo -S -p '' deb-get show "$app"`);
    expect(script).toContain("dpkg --compare-versions");
    const commands = script.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(commands).not.toMatch(/deb-get update/);
  });

  test("ships detection, check, inventory, upgrade-all, and selected-upgrade scripts", () => {
    expect(getPackageManagerDetectionCommands().some((entry) => entry.name === "deb-get")).toBe(true);
    const operations = getBuiltinScripts()
      .filter((script) => script.pkgManager === "deb-get")
      .map((script) => script.operation)
      .sort();
    expect(operations).toEqual(["check_updates", "detect", "list_installed_packages", "upgrade_all", "upgrade_selected"]);
    expect(parseBuiltinInstalledPackages("deb-get", "obsidian\t1.12.7\tamd64\n")).toEqual([
      { pkgManager: "deb-get", packageName: "obsidian", currentVersion: "1.12.7", architecture: "amd64", repository: "deb-get" },
    ]);
  });

  test("ships the GitHub token as a built-in secret entry that survives sudo", () => {
    const definition = listPackageManagerDefinitions().find((entry) => entry.name === "deb-get");

    expect(definition?.builtin).toBe(true);
    expect(definition?.configEntries).toEqual([
      expect.objectContaining({ key: "githubToken", secret: true, envVar: "DEBGET_TOKEN", sudoEnvKeep: true, builtin: true }),
    ]);
  });
});

describe("read-only wildcard sudoers rules", () => {
  test("generates exact, read-only wildcard, and commented selected-package rules for deb-get", () => {
    const reference = buildCommandReference(referenceSystem(["deb-get"]));
    const debGetRules = reference.sudoers
      .filter((entry) => entry.pkgManager === "deb-get")
      .map((entry) => [entry.category, entry.command, entry.sudoersSafety]);

    expect(debGetRules).toEqual(expect.arrayContaining([
      ["check", "deb-get show *", "read_only_wildcard"],
      ["upgrade_all", "deb-get upgrade --dg-only", "exact"],
      ["upgrade_selected", "deb-get install <package>", "package_placeholder"],
    ]));
    expect(reference.warnings.filter((warning) => warning.pkgManager === "deb-get")).toEqual([]);
    expect(reference.envKeep).toEqual([{ envVar: "DEBGET_TOKEN", pkgManager: "deb-get", key: "githubToken" }]);

    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: reference,
      executablePaths: new Map([["deb-get", "/usr/local/bin/deb-get"], ["reboot", "/usr/sbin/reboot"]]),
    });
    const lines = preview.content.split("\n");
    const readOnlyHeader = lines.findIndex((line) => line.startsWith("# Read-only lookups."));

    expect(lines).toContain('Defaults:updater env_keep += "DEBGET_TOKEN"');
    expect(lines).toContain("updater ALL=(root) NOPASSWD: /usr/local/bin/deb-get upgrade --dg-only");
    expect(readOnlyHeader).toBeGreaterThan(-1);
    expect(lines.slice(readOnlyHeader)).toContain("updater ALL=(root) NOPASSWD: /usr/local/bin/deb-get show *");
    expect(lines).toContain("# updater ALL=(root) NOPASSWD: /usr/local/bin/deb-get install *");
  });

  test("leaves sudoers output unchanged for systems without deb-get", () => {
    const preview = buildSudoersPreview({
      username: "updater",
      commandReference: buildCommandReference(referenceSystem(["apt"])),
    });

    expect(preview.content).not.toContain("Read-only lookups");
    expect(preview.content).not.toContain("env_keep");
    expect(preview.content).not.toContain("deb-get");
  });

  test("treats positional and special shell parameters as unsafe", () => {
    expect(normalizeCommandForSudoers("sudo -S -p '' apt-get install \"$@\"")).toBe("apt-get install \"$@\"");
  });
});

describe("deb-get with a database", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-deb-get-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  let systemCounter = 0;
  function insertSystem(values: Partial<typeof systems.$inferInsert> = {}): number {
    systemCounter += 1;
    return getDb().insert(systems).values({
      name: `desktop-${systemCounter}`,
      hostname: `desktop-${systemCounter}.local`,
      port: 22,
      authType: "password",
      username: "updater",
      ...values,
    }).returning({ id: systems.id }).get().id;
  }

  test("only grants the read-only wildcard to listed commands in check and inventory steps", () => {
    createCustomPackageManager({ name: "tool", label: "Tool" });
    createScript({
      name: "Check tool",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "tool",
      isDefault: true,
      steps: [{ label: "Check", command: 'for app in a b; do {{sudo:apt-get install "$app"}}; done' }],
      parserConfig: { updateRegex: "^(?<packageName>\\S+) (?<currentVersion>\\S+) (?<newVersion>\\S+)$" },
    });
    createScript({
      name: "Upgrade tool",
      type: "package_manager",
      operation: "upgrade_all",
      pkgManager: "tool",
      isDefault: true,
      steps: [{ label: "Upgrade", command: 'for app in a b; do {{sudo:deb-get show "$app"}}; done' }],
    });
    const systemId = insertSystem({ detectedPkgManagers: JSON.stringify(["tool"]) });
    const reference = buildCommandReference(getDb().select().from(systems).where(eq(systems.id, systemId)).get()!);

    expect(reference.sudoers.filter((entry) => entry.pkgManager === "tool")).toEqual([]);
    expect(reference.warnings.filter((warning) => warning.pkgManager === "tool").map((warning) => warning.command))
      .toEqual(expect.arrayContaining(['apt-get install "$app"', 'deb-get show "$app"']));
  });

  test("keeps built-in entries out of stored config entries", () => {
    updateCustomPackageManager("deb-get", {
      configEntries: [
        { key: "githubToken", defaultValue: "", secret: true, envVar: "DEBGET_TOKEN", sudoEnvKeep: true, builtin: true },
        { key: "channel", defaultValue: "stable" },
      ],
    });

    const row = getDb().select().from(customPackageManagers).where(eq(customPackageManagers.name, "deb-get")).get();
    expect(JSON.parse(row?.configEntries ?? "[]")).toEqual([{ key: "channel", defaultValue: "stable" }]);
    expect(listPackageManagerDefinitions().find((entry) => entry.name === "deb-get")?.configEntries.map((entry) => entry.key))
      .toEqual(["githubToken", "channel"]);
    expect(() => createCustomPackageManager({ name: "deb-get", label: "deb-get" })).toThrow("built-in");
  });

  test("removes deb-get apps from APT updates and inventory", () => {
    const systemId = insertSystem();
    replaceInstalledPackagesForManager(systemId, "deb-get", [
      { pkgManager: "deb-get", packageName: "obsidian", currentVersion: "1.0.0", architecture: "amd64", repository: "deb-get" },
    ]);
    replaceInstalledPackagesForManager(systemId, "apt", [
      { pkgManager: "apt", packageName: "obsidian", currentVersion: "1.0.0", architecture: "amd64", repository: null },
      { pkgManager: "apt", packageName: "curl", currentVersion: "8.0", architecture: "amd64", repository: null },
    ]);
    const updates = [update("apt", "obsidian"), update("apt", "curl"), update("deb-get", "drawio"), update("apt", "drawio")];

    const result = applyPackageOwnershipClaims(systemId, ["apt", "deb-get"], updates);

    expect(result.map((entry) => `${entry.pkgManager}:${entry.packageName}`)).toEqual(["apt:curl", "deb-get:drawio"]);
    const aptInventory = getDb().select().from(installedPackageCache)
      .where(eq(installedPackageCache.pkgManager, "apt")).all().map((pkg) => pkg.packageName);
    expect(aptInventory).toEqual(["curl"]);
    expect(applyPackageOwnershipClaims(systemId, ["apt"], updates)).toBe(updates);
  });

  test("renames a pre-existing custom deb-get package manager once", () => {
    const dbPath = join(tempDir, "dashboard.db");
    getDb().insert(customPackageManagers).values({ name: "deb-get", label: "deb-get (custom)" }).run();
    getDb().insert(customScripts).values({
      name: "Check",
      type: "package_manager",
      operation: "check_updates",
      pkgManager: "deb-get",
      steps: JSON.stringify([{ label: "Check", command: "deb-get update" }]),
    }).run();
    const systemId = insertSystem({
      pkgManager: "deb-get",
      detectedPkgManagers: JSON.stringify(["apt", "deb-get"]),
      pkgManagerConfigs: JSON.stringify({ "deb-get": { token: "x" } }),
    });
    getDb().insert(systemScriptOverrides).values({
      systemId,
      operationKey: "deb-get/check_updates",
      scriptId: "custom:1",
    }).run();
    closeDatabase();

    const sqlite = new BetterSqlite3(dbPath);
    sqlite.prepare("DELETE FROM settings WHERE key = 'builtin_deb_get_name_migrated'").run();
    sqlite.close();
    initDatabase(dbPath);

    expect(getDb().select().from(customPackageManagers).all().map((row) => row.name)).toEqual(["deb-get-custom"]);
    expect(getDb().select().from(customScripts).get()?.pkgManager).toBe("deb-get-custom");
    expect(getDb().select().from(systemScriptOverrides).get()?.operationKey).toBe("deb-get-custom/check_updates");
    const system = getDb().select().from(systems).where(eq(systems.id, systemId)).get();
    expect(system?.pkgManager).toBe("deb-get-custom");
    expect(JSON.parse(system?.detectedPkgManagers ?? "[]")).toEqual(["apt", "deb-get-custom"]);
    expect(JSON.parse(system?.pkgManagerConfigs ?? "{}")).toEqual({ "deb-get-custom": { token: "x" } });

    // A later built-in config row named deb-get is left alone.
    getDb().insert(customPackageManagers).values({ name: "deb-get", label: "deb-get" }).run();
    closeDatabase();
    initDatabase(dbPath);
    expect(getDb().select().from(customPackageManagers).all().map((row) => row.name).sort())
      .toEqual(["deb-get", "deb-get-custom"]);
  });
});
