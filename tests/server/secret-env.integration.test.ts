import { describe, expect, test } from "vitest";
import { createHash, randomBytes } from "crypto";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { sudo } from "../../server/ssh/parsers/types";
import { SecretInput } from "../../server/ssh/secret-input";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const debianSudoHost = process.env.LUDASH_DEBIAN_SUDO_TEST_HOST ?? "127.0.0.1";
const debianSudoPort = Number(process.env.LUDASH_DEBIAN_SUDO_TEST_PORT ?? "2009");

// Shell metacharacters prove the value is delivered as data, not code.
const TOKEN = `ghp_${randomBytes(12).toString("hex")}'"$(id)`;
const TOKEN_SHA256 = createHash("sha256").update(TOKEN).digest("hex");

function expectSecretSeenByRoot(output: string): void {
  expect(output).toContain("uid=0");
  expect(output).toContain(`len=${TOKEN.length}`);
  expect(output).toContain(`sha256=${TOKEN_SHA256}`);
  expect(output).toContain("token=***");
  expect(output).not.toContain(TOKEN);
}

describe("secret environment integration", () => {
  integrationTest("passes secrets through password sudo via env_keep, in and out of persistent mode", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const encryptor = getEncryptor();
    const sshManager = initSSHManager(1, 10, 30, encryptor);
    const conn = await sshManager.connect({
      hostname: debianSudoHost,
      port: debianSudoPort,
      username: "testuser",
      authType: "password",
      encryptedPassword: encryptor.encrypt("testpass"),
      hostKeyVerificationEnabled: false,
    });
    const secretInput = new SecretInput([{ envVar: "SECRET_ENV_TEST_TOKEN", value: TOKEN }]);
    const command = sudo("/usr/local/bin/ludash-secret-env-test") + " 2>&1";

    try {
      const direct = await sshManager.runCommand(
        conn,
        command,
        30,
        "testpass",
        undefined,
        undefined,
        { secretInput },
      );
      expect(direct.exitCode).toBe(0);
      expectSecretSeenByRoot(direct.stdout);

      const streamed: string[] = [];
      const persistent = await sshManager.runPersistentCommand(
        conn,
        command,
        30,
        "testpass",
        (chunk) => streamed.push(chunk),
        { secretInput },
      );
      expect(persistent.exitCode).toBe(0);
      expectSecretSeenByRoot(persistent.stdout);
      expect(streamed.join("")).not.toContain(TOKEN);

      // Without the secret, the sudo password must still reach sudo -S intact.
      const withoutSecret = await sshManager.runCommand(conn, command, 30, "testpass");
      expect(withoutSecret.exitCode).toBe(0);
      expect(withoutSecret.stdout).toContain("len=0");
    } finally {
      sshManager.disconnect(conn);
    }
  });
});
