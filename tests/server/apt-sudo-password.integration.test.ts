import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { initEncryptor, getEncryptor } from "../../server/security";
import { getSSHManager, initSSHManager } from "../../server/ssh/connection";
import { APT_DPKG_AUDIT_SCRIPT, APT_UPDATE_COMMAND } from "../../server/ssh/parsers/apt";
import { createScript, getBuiltinScripts, setSystemOverrides } from "../../server/services/script-service";
import { createSystem } from "../../server/services/system-service";
import { runPendingPostUpgradeScript } from "../../server/services/update-service";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, updateHistory } from "../../server/db/schema";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const aptHost = process.env.LUDASH_APT_SUDO_PASSWORD_TEST_HOST ?? "127.0.0.1";
const aptPort = Number(process.env.LUDASH_APT_SUDO_PASSWORD_TEST_PORT ?? "2009");

describe("APT sudo-password integration", () => {
  integrationTest("feeds the sudo password to each atomic APT check step", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const encryptor = getEncryptor();
    const sshManager = initSSHManager(1, 10, 60, encryptor);
    const conn = await sshManager.connect({
      hostname: aptHost,
      port: aptPort,
      username: "testuser",
      authType: "password",
      encryptedPassword: encryptor.encrypt("testpass"),
      hostKeyVerificationEnabled: false,
    });

    try {
      const audit = await sshManager.runCommand(conn, APT_DPKG_AUDIT_SCRIPT, 60, "testpass");
      expect(audit.exitCode).toBe(0);

      const refresh = await sshManager.runCommand(conn, APT_UPDATE_COMMAND, 60, "testpass");
      expect(refresh.exitCode).toBe(0);

      const autoremoveCommand = getBuiltinScripts()
        .find((script) => script.id === "builtin:apt:autoremove")
        ?.steps[0]?.command;
      expect(autoremoveCommand).toBeTruthy();
      const autoremove = await sshManager.runPersistentCommand(conn, autoremoveCommand!, 60, "testpass");
      expect(autoremove.exitCode).toBe(0);
    } finally {
      sshManager.disconnect(conn);
    }
  });

  integrationTest("gives every step of an upgrade script the sudo password", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ludash-hook-sudo-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    try {
      const encryptor = getEncryptor();
      initSSHManager(1, 10, 60, encryptor);
      const credentialId = getDb().insert(credentials).values({
        name: "Test password",
        kind: "usernamePassword",
        payload: JSON.stringify({ username: "testuser", password: encryptor.encrypt("testpass") }),
      }).returning({ id: credentials.id }).get().id;
      const systemId = createSystem({
        name: "Debian",
        hostname: aptHost,
        port: aptPort,
        credentialId,
        sudoPassword: "testpass",
        hostKeyVerificationEnabled: false,
      });
      const privileged = "{{sudo:/usr/local/bin/ludash-persistent-sudo-test}}";
      const assign = (steps: Array<{ label: string; command: string }>, name: string) => {
        const script = createScript({ name, type: "system", operation: "post_upgrade", pkgManager: null, steps });
        setSystemOverrides(systemId, { "system/post_upgrade": script.id });
      };

      assign([
        { label: "First", command: privileged },
        { label: "Second", command: privileged },
        { label: "Third", command: `echo "op=$LUDASH_OPERATION result=$LUDASH_UPGRADE_RESULT"\n${privileged}` },
      ], "One sudo per step");
      const perStep = await runPendingPostUpgradeScript(systemId);
      expect(perStep.success).toBe(true);
      const row = getDb().select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all().at(-1);
      expect(row?.output).toContain("op=manual result=unknown");
      expect(row?.output?.match(/begin/g)).toHaveLength(3);

      // Script output must not stay behind in the host's temp directory.
      const sshManager = getSSHManager();
      const conn = await sshManager.connect({
        hostname: aptHost,
        port: aptPort,
        username: "testuser",
        authType: "password",
        encryptedPassword: encryptor.encrypt("testpass"),
        hostKeyVerificationEnabled: false,
      });
      const leftovers = await sshManager.runCommand(conn, "grep -l '^op=manual result=unknown' /tmp/ludash_*.log 2>/dev/null || true", 20);
      sshManager.disconnect(conn);
      expect(leftovers.stdout.trim()).toBe("");

      // This is the documented limit: the password only reaches one sudo per step.
      assign([{ label: "Both", command: `${privileged}\n${privileged}` }], "Two sudo in one step");
      const sameStep = await runPendingPostUpgradeScript(systemId);
      expect(sameStep.success).toBe(false);
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
