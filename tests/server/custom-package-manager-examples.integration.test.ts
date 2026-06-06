import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { getSSHManager, initSSHManager } from "../../server/ssh/connection";
import { createCredential } from "../../server/services/credential-service";
import { getInstalledPackages } from "../../server/services/installed-package-service";
import { importCustomPackageManagerBundle, type CustomPackageManagerBundle } from "../../server/services/script-service";
import { createSystem, getSystem } from "../../server/services/system-service";
import { applyUpgradePackages, checkUpdates } from "../../server/services/update-service";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const customHost = process.env.LUDASH_CUSTOM_PM_TEST_HOST ?? "127.0.0.1";
const customPort = Number(process.env.LUDASH_CUSTOM_PM_TEST_PORT ?? "2017");
const examplesDir = fileURLToPath(new URL("../../examples", import.meta.url));

const expectedManagers = ["npm-global", "npm-project", "pip-user", "pip-venv", "pipx"];
const expectedPackages = [
  "ludash-npm-global-fixture",
  "@ludash/npm-project-fixture",
  "ludash-pip-user-fixture",
  "ludash-pip-venv-fixture",
  "ludash-pipx-fixture-app",
];

function loadExampleBundles(): CustomPackageManagerBundle[] {
  return readdirSync(examplesDir)
    .filter((file) => expectedManagers.some((manager) => file === `${manager}-package-manager.json`))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(examplesDir, file), "utf8")) as CustomPackageManagerBundle);
}

describe("custom package manager example integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-custom-pm-integration-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    initSSHManager(2, 10, 300, getEncryptor());
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  integrationTest("checks and upgrades npm, pip, and pipx custom package manager examples", async () => {
    for (const bundle of loadExampleBundles()) {
      importCustomPackageManagerBundle(bundle);
    }

    const credentialId = createCredential({
      name: "Custom package manager fixture",
      kind: "usernamePassword",
      payload: {
        username: "testuser",
        password: "testpass",
      },
    });
    const systemId = createSystem({
      name: "Custom package managers",
      hostname: customHost,
      port: customPort,
      credentialId,
      hostKeyVerificationEnabled: false,
    });
    getDb().update(systems)
      .set({ disabledPkgManagers: JSON.stringify(["apt"]) })
      .where(eq(systems.id, systemId))
      .run();

    const sshManager = getSSHManager();
    const system = getSystem(systemId);
    expect(system).toBeTruthy();
    const conn = await sshManager.connect(system as Record<string, unknown>, { systemId });
    try {
      const reset = await sshManager.runCommand(
        conn,
        "/opt/ludash-custom-package-managers/reset-fixtures.sh",
        300,
      );
      expect(reset.exitCode, `${reset.stdout}\n${reset.stderr}`).toBe(0);
    } finally {
      sshManager.disconnect(conn);
    }

    const updates = await checkUpdates(systemId);
    const updateSummary = updates.map((update) => [update.pkgManager, update.packageName, update.currentVersion, update.newVersion]);
    const detectedAfterCheck = getDb()
      .select({ detectedPkgManagers: systems.detectedPkgManagers })
      .from(systems)
      .where(eq(systems.id, systemId))
      .get()?.detectedPkgManagers;
    const historyAfterCheck = getDb()
      .select({ status: updateHistory.status, error: updateHistory.error, output: updateHistory.output })
      .from(updateHistory)
      .all();
    for (const manager of expectedManagers) {
      expect(
        updates.filter((update) => update.pkgManager === manager),
        `updates: ${JSON.stringify(updateSummary)} detected: ${detectedAfterCheck} history: ${JSON.stringify(historyAfterCheck)}`,
      ).toHaveLength(1);
    }
    for (const packageName of expectedPackages) {
      expect(updates.some((update) => update.packageName === packageName)).toBe(true);
    }

    const detected = JSON.parse(getDb()
      .select({ detectedPkgManagers: systems.detectedPkgManagers })
      .from(systems)
      .where(eq(systems.id, systemId))
      .get()?.detectedPkgManagers ?? "[]") as string[];
    expect(detected).toEqual(expect.arrayContaining(expectedManagers));

    const installedBefore = getInstalledPackages(systemId);
    for (const manager of expectedManagers) {
      expect(installedBefore.some((pkg) => pkg.pkgManager === manager)).toBe(true);
    }

    const upgrade = await applyUpgradePackages(systemId, expectedPackages);
    expect(upgrade.success).toBe(true);

    const remaining = await checkUpdates(systemId);
    expect(remaining.filter((update) => expectedManagers.includes(update.pkgManager))).toEqual([]);

    const installedAfter = getInstalledPackages(systemId);
    for (const packageName of expectedPackages) {
      expect(installedAfter.some((pkg) => pkg.packageName === packageName && pkg.currentVersion === "1.1.0")).toBe(true);
    }
  }, 120_000);
});
