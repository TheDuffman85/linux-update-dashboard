import { describe, expect, test, vi } from "vitest";
import { randomBytes } from "crypto";
import { initEncryptor, getEncryptor } from "../../server/security";
import { EXIT_CANCELLED, EXIT_MONITORING_LOST, initSSHManager } from "../../server/ssh/connection";
import { sudo } from "../../server/ssh/parsers/types";

const runIntegration = process.env.LUDASH_RUN_DOCKER_INTEGRATION === "1";
const integrationTest = runIntegration ? test : test.skip;
const debianSudoHost = process.env.LUDASH_DEBIAN_SUDO_TEST_HOST ?? "127.0.0.1";
const debianSudoPort = Number(process.env.LUDASH_DEBIAN_SUDO_TEST_PORT ?? "2009");

describe("persistent sudo monitor integration", () => {
  integrationTest("follows a command whose connection dies as soon as it has started", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const encryptor = getEncryptor();
    const sshManager = initSSHManager(2, 10, 30, encryptor);
    const system = {
      hostname: debianSudoHost,
      port: debianSudoPort,
      username: "testuser",
      authType: "password",
      encryptedPassword: encryptor.encrypt("testpass"),
      hostKeyVerificationEnabled: false,
    };
    const conn = await sshManager.connect(system);
    const realRunCommand = sshManager.runCommand.bind(sshManager);
    const runCommand = vi.spyOn(sshManager, "runCommand").mockImplementationOnce(
      (client, command, timeout, sudoPassword, onData, signal, options) =>
        realRunCommand(client, command, timeout, sudoPassword, (chunk, stream) => {
          onData?.(chunk, stream);
          if (chunk.includes("LUDASH_BG")) (client as unknown as { destroy: () => void }).destroy();
        }, signal, options),
    );

    const lost = await sshManager.runPersistentCommand(conn, "sleep 3; echo finished; exit 7", 60);
    runCommand.mockRestore();
    expect(lost.exitCode).toBe(EXIT_MONITORING_LOST);
    expect(lost.persistentInfo?.pid).toBeGreaterThan(0);

    const reconnected = await sshManager.connect(system);
    try {
      const resumed = await sshManager.resumePersistentCommand(reconnected, lost.persistentInfo!, 60);
      expect(resumed.exitCode).toBe(7);
      expect(resumed.stdout).toContain("finished");
    } finally {
      sshManager.disconnect(reconnected);
    }
  }, 60_000);

  integrationTest("a cancel only counts once the stop command has reached the host", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const encryptor = getEncryptor();
    const sshManager = initSSHManager(3, 10, 30, encryptor);
    const system = {
      hostname: debianSudoHost,
      port: debianSudoPort,
      username: "testuser",
      authType: "password",
      encryptedPassword: encryptor.encrypt("testpass"),
      hostKeyVerificationEnabled: false,
    };
    const monitored = await sshManager.connect(system);
    const checker = await sshManager.connect(system);
    const isRunning = async (pid: number) =>
      (await sshManager.runCommand(checker, `[ -d /proc/${pid} ] && echo alive || echo dead`, 10)).stdout.trim() === "alive";

    try {
      const controller = new AbortController();
      let pid = 0;
      const running = sshManager.runPersistentCommand(monitored, "sleep 300", 60, undefined, undefined, {
        signal: controller.signal,
        onPersistentInfo: (info) => {
          pid = info.pid;
          // The connection dies with the cancel, so the stop command cannot be delivered.
          setTimeout(() => {
            (monitored as unknown as { destroy: () => void }).destroy();
            controller.abort();
          }, 500);
        },
      });

      const lost = await running;
      expect(lost.exitCode).toBe(EXIT_MONITORING_LOST);
      expect(lost.persistentInfo?.pid).toBe(pid);
      expect(await isRunning(pid)).toBe(true);

      const reconnected = await sshManager.connect(system);
      const stopped = await sshManager.resumePersistentCommand(reconnected, lost.persistentInfo!, 60, undefined, {
        signal: controller.signal,
      });
      sshManager.disconnect(reconnected);

      expect(stopped.exitCode).toBe(EXIT_CANCELLED);
      expect(await isRunning(pid)).toBe(false);
    } finally {
      sshManager.disconnect(checker);
    }
  }, 60_000);

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
      hostKeyVerificationEnabled: false,
    });

    try {
      const result = await sshManager.runPersistentCommand(
        conn,
        sudo("/usr/local/bin/ludash-persistent-sudo-test") + " 2>&1",
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
