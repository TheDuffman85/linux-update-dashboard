import { describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { sudo } from "../../server/ssh/parsers/types";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const debianSudoHost = process.env.LUDASH_DEBIAN_SUDO_TEST_HOST ?? "127.0.0.1";
const debianSudoPort = Number(process.env.LUDASH_DEBIAN_SUDO_TEST_PORT ?? "2009");

describe("persistent sudo monitor integration", () => {
  integrationTest("keeps streaming a root-owned background command until it finishes", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const encryptor = getEncryptor();
    const sshManager = initSSHManager(1, 10, 30, encryptor);
    const conn = await sshManager.connect({
      hostname: debianSudoHost,
      port: debianSudoPort,
      username: "testuser",
      authType: "password",
      encryptedPassword: encryptor.encrypt("testpass"),
    });

    try {
      const result = await sshManager.runPersistentCommand(
        conn,
        sudo(`printf "begin\\n"; sleep 2; printf "end\\n"`) + " 2>&1",
        30,
        "testpass"
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("begin");
      expect(result.stdout).toContain("end");
    } finally {
      sshManager.disconnect(conn);
    }
  });
});
