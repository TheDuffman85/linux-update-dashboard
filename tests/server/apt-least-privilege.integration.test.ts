import { describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { APT_DPKG_AUDIT_SCRIPT, APT_UPDATE_COMMAND, aptParser } from "../../server/ssh/parsers/apt";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const aptHost = process.env.LUDASH_APT_LEAST_PRIVILEGE_TEST_HOST ?? "127.0.0.1";
const aptPort = Number(process.env.LUDASH_APT_LEAST_PRIVILEGE_TEST_PORT ?? "2016");

describe("APT least-privilege sudoers integration", () => {
  integrationTest("allows required APT operations without granting broad passwordless sudo", async () => {
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
      const audit = await sshManager.runCommand(conn, APT_DPKG_AUDIT_SCRIPT, 60);
      expect(audit.exitCode).toBe(0);

      const refresh = await sshManager.runCommand(conn, APT_UPDATE_COMMAND, 60);
      expect(refresh.exitCode).toBe(0);

      const denied = await sshManager.runCommand(conn, "sudo -n true", 10);
      expect(denied.exitCode).not.toBe(0);

      const upgrade = await sshManager.runPersistentCommand(
        conn,
        aptParser.getUpgradePackageCommand("least-privilege-app"),
        60,
      );
      expect(upgrade.exitCode).toBe(0);
    } finally {
      sshManager.disconnect(conn);
    }
  });
});
