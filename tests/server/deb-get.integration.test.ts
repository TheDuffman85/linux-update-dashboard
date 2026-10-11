import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { getSSHManager, initSSHManager } from "../../server/ssh/connection";
import { createCredential } from "../../server/services/credential-service";
import { buildCommandReference } from "../../server/services/command-reference";
import { getInstalledPackages } from "../../server/services/installed-package-service";
import { resolveSudoersPreview } from "../../server/services/sudoers-preview";
import { createSystem, getSystem } from "../../server/services/system-service";
import { applyUpgradeAll, applyUpgradePackages, checkUpdates } from "../../server/services/update-service";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const debGetHost = process.env.LUDASH_DEB_GET_TEST_HOST ?? "127.0.0.1";
const debGetPort = Number(process.env.LUDASH_DEB_GET_TEST_PORT ?? "2018");
const TOKEN = `github_pat_${randomBytes(16).toString("hex")}`;

function versions(systemId: number, pkgManager: string): Record<string, string> {
  return Object.fromEntries(getInstalledPackages(systemId)
    .filter((pkg) => pkg.pkgManager === pkgManager)
    .map((pkg) => [pkg.packageName, pkg.currentVersion]));
}

function updateSummary(updates: Awaited<ReturnType<typeof checkUpdates>>): string[] {
  return updates
    .map((update) => `${update.pkgManager}:${update.packageName}:${update.currentVersion}->${update.newVersion}`)
    .sort();
}

describe("deb-get integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-deb-get-integration-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    initSSHManager(2, 10, 300, getEncryptor());
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function resetFixtures(systemId: number): Promise<void> {
    const sshManager = getSSHManager();
    const conn = await sshManager.connect(getSystem(systemId) as Record<string, unknown>, { systemId });
    try {
      const reset = await sshManager.runCommand(conn, "sudo -n /opt/deb-get-fixture/reset-fixtures.sh", 60);
      expect(reset.exitCode, `${reset.stdout}\n${reset.stderr}`).toBe(0);
    } finally {
      sshManager.disconnect(conn);
    }
  }

  integrationTest("checks and upgrades deb-get apps through least-privilege sudo with a secret token", async () => {
    const credentialId = createCredential({
      name: "deb-get fixture",
      kind: "usernamePassword",
      payload: { username: "testuser", password: "testpass" },
    });
    const tokenId = createCredential({ name: "GitHub token", kind: "secret", payload: { value: TOKEN } });
    const systemId = createSystem({
      name: "deb-get desktop",
      hostname: debGetHost,
      port: debGetPort,
      credentialId,
      hostKeyVerificationEnabled: false,
      pkgManagerSecretRefs: { "deb-get": { githubToken: tokenId } },
    });
    await resetFixtures(systemId);

    // First check also detects package managers.
    const updates = await checkUpdates(systemId);
    const system = getSystem(systemId)!;
    expect(JSON.parse(system.detectedPkgManagers ?? "[]")).toEqual(["apt", "deb-get"]);
    expect(updateSummary(updates)).toEqual([
      "deb-get:drawio:1.0.0->1.5.0",
      "deb-get:obsidian:1.0.0->2.0.0",
    ]);
    // vscode was installed by deb-get from an APT repository, so it stays with APT.
    expect(versions(systemId, "deb-get")).toEqual({ drawio: "1.0.0", obsidian: "1.0.0" });
    expect(versions(systemId, "apt")).toMatchObject({ vscode: "1.0.0" });
    expect(versions(systemId, "apt")).not.toHaveProperty("drawio");
    expect(versions(systemId, "apt")).not.toHaveProperty("obsidian");

    // The generated sudoers file matches the rules installed in the fixture.
    const preview = await resolveSudoersPreview(
      "testuser",
      buildCommandReference(system),
      getSSHManager(),
      system as Record<string, unknown>,
      { systemId },
    );
    // The slim fixture has no reboot binary; every package-manager executable resolves.
    expect(preview.resolutionError ?? "").toBe(preview.resolution === "resolved" ? "" : "Could not resolve: reboot");
    expect(preview.content).toContain('Defaults:testuser env_keep += "DEBGET_TOKEN"');
    expect(preview.content).toContain("testuser ALL=(root) NOPASSWD: /usr/local/bin/deb-get show *");
    expect(preview.content).toContain("testuser ALL=(root) NOPASSWD: /usr/local/bin/deb-get upgrade --dg-only");
    expect(preview.content).toContain("# testuser ALL=(root) NOPASSWD: /usr/local/bin/deb-get install *");

    const upgrade = await applyUpgradeAll(systemId);
    expect(upgrade.success, upgrade.output).toBe(true);
    expect(upgrade.output).toContain("authenticated with token ***");
    expect(upgrade.output).not.toContain(TOKEN);
    expect(await checkUpdates(systemId)).toEqual([]);
    expect(versions(systemId, "deb-get")).toEqual({ drawio: "1.5.0", obsidian: "2.0.0" });

    await resetFixtures(systemId);
    await checkUpdates(systemId);
    const selected = await applyUpgradePackages(systemId, ["obsidian"]);
    expect(selected.success, selected.output).toBe(true);
    expect(updateSummary(await checkUpdates(systemId))).toEqual(["deb-get:drawio:1.0.0->1.5.0"]);

    const history = JSON.stringify(getDb().select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all());
    expect(history).toContain("Secret environment (via stdin): DEBGET_TOKEN");
    expect(history).not.toContain(TOKEN);
  }, 180_000);

  integrationTest("reports GitHub-hosted apps as undeterminable without a token", async () => {
    const credentialId = createCredential({
      name: "deb-get fixture",
      kind: "usernamePassword",
      payload: { username: "testuser", password: "testpass" },
    });
    const systemId = createSystem({
      name: "deb-get without token",
      hostname: debGetHost,
      port: debGetPort,
      credentialId,
      hostKeyVerificationEnabled: false,
    });
    getDb().update(systems)
      .set({ detectedPkgManagers: JSON.stringify(["deb-get"]), pkgManager: "deb-get" })
      .where(eq(systems.id, systemId))
      .run();
    await resetFixtures(systemId);

    expect(updateSummary(await checkUpdates(systemId))).toEqual(["deb-get:drawio:1.0.0->1.5.0"]);
    const history = getDb().select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
    expect(history?.output).toContain("could not determine the installed and published versions of obsidian");
  }, 120_000);
});
