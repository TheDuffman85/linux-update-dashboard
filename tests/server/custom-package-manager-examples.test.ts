import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { closeDatabase, initDatabase } from "../../server/db";
import { initEncryptor } from "../../server/security";
import {
  importCustomPackageManagerBundle,
  parseCustomInstalledPackages,
  parseCustomUpdates,
  type CustomPackageManagerBundle,
} from "../../server/services/script-service";
import { validatePackageName } from "../../server/ssh/parsers/types";

const examplesDir = fileURLToPath(new URL("../../examples", import.meta.url));

function loadExampleBundles(): CustomPackageManagerBundle[] {
  return readdirSync(examplesDir)
    .filter((file) => file.endsWith("package-manager.json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(examplesDir, file), "utf8")) as CustomPackageManagerBundle);
}

describe("custom package manager examples", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-custom-pm-examples-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("example bundles import and their stable parser lines parse", () => {
    const bundles = loadExampleBundles();
    expect(bundles.map((bundle) => bundle.packageManager.name)).toEqual(
      expect.arrayContaining(["npm-global", "npm-project", "pip-user", "pip-venv", "pipx"]),
    );

    for (const bundle of bundles) {
      const result = importCustomPackageManagerBundle(bundle);
      expect(result.manager.name).toBe(bundle.packageManager.name);
      expect(result.scripts.length).toBe(bundle.scripts.length);

      const checkScript = bundle.scripts.find((script) => script.operation === "check_updates");
      if (checkScript?.parserConfig?.updateRegex?.includes("LUDASH_UPDATE")) {
        expect(parseCustomUpdates(bundle.packageManager.name, checkScript.parserConfig, [{
          command: "sample",
          stdout: "LUDASH_UPDATE sample-package 1.0.0 1.1.0\n",
          stderr: "",
          exitCode: 0,
        }])).toEqual([
          expect.objectContaining({
            pkgManager: bundle.packageManager.name,
            packageName: "sample-package",
            currentVersion: "1.0.0",
            newVersion: "1.1.0",
          }),
        ]);
      }

      const listScript = bundle.scripts.find((script) => script.operation === "list_installed_packages");
      if (listScript?.parserConfig?.installedPackageRegex?.includes("LUDASH_PACKAGE")) {
        expect(parseCustomInstalledPackages(bundle.packageManager.name, listScript.parserConfig, [{
          command: "sample",
          stdout: "LUDASH_PACKAGE sample-package 1.0.0\n",
          stderr: "",
          exitCode: 0,
        }])).toEqual([
          expect.objectContaining({
            pkgManager: bundle.packageManager.name,
            packageName: "sample-package",
            currentVersion: "1.0.0",
          }),
        ]);
      }
    }
  });

  test("selected-package validation allows scoped npm names without allowing shell metacharacters", () => {
    expect(validatePackageName("@ludash/npm-project-fixture")).toBe("@ludash/npm-project-fixture");
    expect(validatePackageName("ludash-pip-user-fixture")).toBe("ludash-pip-user-fixture");

    expect(() => validatePackageName("@ludash/npm-project-fixture;rm")).toThrow(/Invalid package name/);
    expect(() => validatePackageName("../package")).toThrow(/Invalid package name/);
    expect(() => validatePackageName("@bad/scope/extra")).toThrow(/Invalid package name/);
  });
});
