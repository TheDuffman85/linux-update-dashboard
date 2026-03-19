import { describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import { getEncryptor, initEncryptor } from "../../server/security";
import {
  buildPersistentSetupCommand,
  buildTestConnectionFailureMessage,
  buildTailMonitorCommand,
  HostKeyVerificationError,
  initSSHManager,
  preparePersistentSudoCommand,
  wrapRemoteCommand,
} from "../../server/ssh/connection";

describe("wrapRemoteCommand", () => {
  test("wraps commands in a POSIX shell with PATH and locale setup", () => {
    const wrapped = wrapRemoteCommand("echo ok");
    expect(wrapped).toBe(
      "sh -c 'export LC_ALL=C LANG=C PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH; echo ok'"
    );
  });

  test("does not invoke a login shell that would source profile files", () => {
    expect(wrapRemoteCommand("echo ok")).not.toContain("sh -lc");
  });

  test("escapes single quotes in the wrapped payload", () => {
    const wrapped = wrapRemoteCommand("printf '%s\\n' \"it's fine\"");
    expect(wrapped).toContain(`printf '"'"'%s\\n'"'"' "it'"'"'s fine"`);
  });
});

describe("preparePersistentSudoCommand", () => {
  test("returns command unchanged when sudo -S is absent", () => {
    const cmd = "apt-get update -qq 2>&1";
    expect(preparePersistentSudoCommand(cmd)).toBe(cmd);
  });

  test("replaces sudo -S with sudo -n and drops the prompt override", () => {
    const cmd =
      `if [ "$(id -u)" = "0" ]; then apt-get upgrade -y; elif command -v sudo >/dev/null 2>&1; then sudo -S -p '' apt-get upgrade -y; else apt-get upgrade -y; fi 2>&1`;
    const out = preparePersistentSudoCommand(cmd);
    expect(out).toContain("then sudo -n apt-get upgrade -y");
    expect(out).not.toContain("then sudo -S apt-get");
    expect(out).not.toContain("sudo -n -p ''");
  });

  test("replaces every sudo -S occurrence", () => {
    const out = preparePersistentSudoCommand(
      "sudo -S -p '' apt-get update && sudo -S -p '' apt-get upgrade"
    );
    expect((out.match(/sudo -n/g) || []).length).toBe(2);
    expect((out.match(/sudo -S/g) || []).length).toBe(0);
  });

  test("still produces a wrapped command without sudo stdin usage", () => {
    const prepared = preparePersistentSudoCommand(
      "sudo -S -p '' apt-get update && sudo -S -p '' apt-get upgrade"
    );
    const wrapped = wrapRemoteCommand(prepared);
    expect(wrapped).toContain("sh -c");
    expect(wrapped).toContain("sudo -n apt-get update && sudo -n apt-get upgrade");
    expect(wrapped).not.toContain("sudo -S");
  });
});

describe("buildPersistentSetupCommand", () => {
  test("uses a portable mktemp basename instead of a suffixed template", () => {
    const { setupCmd, useSudoLaunch } = buildPersistentSetupCommand(
      "apk upgrade 2>&1",
      false
    );

    expect(useSudoLaunch).toBe(false);
    expect(setupCmd).toContain('BASE=$(mktemp /tmp/ludash_XXXXXX)');
    expect(setupCmd).toContain('SCRIPT="${BASE}.sh"');
    expect(setupCmd).toContain('LOGFILE="${BASE}.log"');
    expect(setupCmd).toContain('EXITFILE="${BASE}.exit"');
    expect(setupCmd).toContain('rm -f "$BASE"');
    expect(setupCmd).toContain('chmod 700 "$SCRIPT"');
    expect(setupCmd).toContain('nohup sh "$1" "$2" > "$3" 2>&1 < /dev/null &');
    expect(setupCmd).not.toContain('mktemp /tmp/ludash_XXXXXX.sh');
  });

  test("keeps sudo-stdin launch path when a password is provided", () => {
    const command =
      `if [ "$(id -u)" = "0" ]; then apk upgrade; elif command -v sudo >/dev/null 2>&1; then sudo -S -p '' apk upgrade; else apk upgrade; fi 2>&1`;
    const { setupCmd, useSudoLaunch } = buildPersistentSetupCommand(
      command,
      true
    );

    expect(useSudoLaunch).toBe(true);
    expect(setupCmd).toContain("sudo -S -p ''");
  });
});

describe("buildTailMonitorCommand", () => {
  test("uses a BusyBox-compatible tail monitor", () => {
    const cmd = buildTailMonitorCommand("/tmp/ludash_abc.log", 1234);

    expect(cmd).toContain('tail -F "$LOGFILE" 2>/dev/null &');
    expect(cmd).toContain('while [ -d "/proc/$PID" ]; do sleep 1; done');
    expect(cmd).toContain('kill "$TAILPID" 2>/dev/null || true');
    expect(cmd).not.toContain("tail --pid=");
    expect(cmd).not.toContain("&;");
  });
});

describe("buildTestConnectionFailureMessage", () => {
  test("explains loopback targets when Proxy Jump channel opening fails", () => {
    const message = buildTestConnectionFailureMessage(
      {
        hostname: "localhost",
        proxyJumpSystemId: 17,
      },
      new Error("(SSH) Channel open failure: Connection refused")
    );

    expect(message).toContain("Connection failed: (SSH) Channel open failure: Connection refused");
    expect(message).toContain("localhost is resolved from the jump host");
    expect(message).toContain("Use a host or IP that the jump host can reach instead of loopback");
  });

  test("leaves direct-connection failures unchanged", () => {
    const message = buildTestConnectionFailureMessage(
      {
        hostname: "localhost",
      },
      new Error("(SSH) Channel open failure: Connection refused")
    );

    expect(message).toBe("Connection failed: (SSH) Channel open failure: Connection refused");
  });
});

describe("SSHConnectionManager.runCommand", () => {
  test("closes stdin for non-interactive commands without sudo", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const manager = initSSHManager(1, 1, 1, getEncryptor());
    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      end: (input?: string) => void;
    };
    let endedWith: string | undefined;
    stream.stderr = new EventEmitter();
    stream.end = (input?: string) => {
      endedWith = input;
      queueMicrotask(() => stream.emit("close", 0));
    };

    const conn = {
      exec: (_command: string, callback: (err: Error | null, stream: typeof stream) => void) => {
        callback(null, stream);
      },
    };

    const result = await manager.runCommand(conn as any, "echo ok", 1);

    expect(result.exitCode).toBe(0);
    expect(endedWith).toBeUndefined();
  });

  test("writes the sudo password and then closes stdin", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const manager = initSSHManager(1, 1, 1, getEncryptor());
    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      end: (input?: string) => void;
    };
    let endedWith: string | undefined;
    stream.stderr = new EventEmitter();
    stream.end = (input?: string) => {
      endedWith = input;
      queueMicrotask(() => stream.emit("close", 0));
    };

    const conn = {
      exec: (_command: string, callback: (err: Error | null, stream: typeof stream) => void) => {
        callback(null, stream);
      },
    };

    const result = await manager.runCommand(conn as any, "sudo -S -p '' true", 1, "secret");

    expect(result.exitCode).toBe(0);
    expect(endedWith).toBe("secret\n");
  });
});

describe("SSHConnectionManager host-key aggregation", () => {
  test("collects jump and target host-key challenges in one review flow", async () => {
    initEncryptor(randomBytes(32).toString("base64"));
    const manager = initSSHManager(1, 1, 1, getEncryptor());

    const jumpChallenge = {
      systemId: 1,
      role: "jump" as const,
      host: "jump.local",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:jump",
      rawKey: "anVtcC1rZXk=",
    };
    const targetChallenge = {
      systemId: 2,
      role: "target" as const,
      host: "target.local",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:target",
      rawKey: "dGFyZ2V0LWtleQ==",
    };

    (manager as any).resolveChain = () => [
      {
        systemId: 1,
        role: "jump",
        hostname: "jump.local",
        port: 22,
        username: "root",
        authType: "password",
        hostKeyVerificationEnabled: true,
        trustedHostKey: null,
      },
      {
        systemId: 2,
        role: "target",
        hostname: "target.local",
        port: 22,
        username: "root",
        authType: "password",
        hostKeyVerificationEnabled: true,
        trustedHostKey: null,
      },
    ];

    (manager as any).openForwardStream = async () => ({});

    (manager as any).connectSingleHop = async (
      hop: { role: "jump" | "target" },
      _hopIndex: number,
      _hopCount: number,
      context: { approvedHostKeys?: typeof jumpChallenge[] },
    ) => {
      const approved = context.approvedHostKeys ?? [];
      const hasApproval = (challenge: typeof jumpChallenge) =>
        approved.some((entry) => (
          entry.role === challenge.role &&
          entry.host === challenge.host &&
          entry.port === challenge.port &&
          (entry.systemId ?? null) === (challenge.systemId ?? null) &&
          entry.rawKey === challenge.rawKey
        ));

      if (hop.role === "jump") {
        if (!hasApproval(jumpChallenge)) {
          throw new HostKeyVerificationError([jumpChallenge]);
        }
        return { end() {} };
      }

      if (!hasApproval(targetChallenge)) {
        throw new HostKeyVerificationError([targetChallenge]);
      }
      return { end() {} };
    };

    (manager as any).runCommand = async () => ({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await manager.testConnection(
      {
        hostname: "target.local",
        port: 22,
        proxyJumpSystemId: 1,
      },
      { systemId: 2 }
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe("SSH host key approval required");
    expect(result.hostKeyChallenges).toEqual([jumpChallenge, targetChallenge]);
  });
});
