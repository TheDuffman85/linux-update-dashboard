import { describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { APT_DPKG_AUDIT_SCRIPT, APT_UPDATE_COMMAND } from "../../server/ssh/parsers/apt";
import { getBuiltinScripts } from "../../server/services/script-service";

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
});
