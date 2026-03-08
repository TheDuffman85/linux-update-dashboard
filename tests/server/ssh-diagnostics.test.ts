import { describe, expect, test } from "bun:test";
import { createLogger } from "../../server/logger";
import {
  buildSSHAttemptLogMeta,
  createSafeSshDebugHook,
  filterSafeSshDebugMessage,
} from "../../server/ssh/diagnostics";

describe("buildSSHAttemptLogMeta", () => {
  test("keeps only allowlisted metadata", () => {
    const meta = buildSSHAttemptLogMeta(
      {
        hostname: "host.example",
        port: 2222,
        username: "ops",
        authType: "key",
        encryptedPassword: "ciphertext-password",
        encryptedPrivateKey: "ciphertext-key",
        encryptedKeyPassphrase: "ciphertext-passphrase",
        password: "plaintext-password",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        sudoPassword: "super-secret",
      },
      { systemId: 42 }
    );

    expect(meta).toEqual({
      systemId: 42,
      host: "host.example",
      port: 2222,
      username: "ops",
      authType: "key",
      hasPassword: true,
      hasPrivateKey: true,
      hasKeyPassphrase: true,
    });
    expect("password" in meta).toBe(false);
    expect("privateKey" in meta).toBe(false);
    expect("sudoPassword" in meta).toBe(false);
  });
});

describe("filterSafeSshDebugMessage", () => {
  test("keeps only allowlisted auth and handshake events", () => {
    expect(filterSafeSshDebugMessage("Socket connected")).toEqual({
      event: "socket_connected",
    });
    expect(
      filterSafeSshDebugMessage("Outbound: Sending USERAUTH_REQUEST (publickey)")
    ).toEqual({
      event: "auth_method_attempt",
      method: "publickey",
    });
    expect(
      filterSafeSshDebugMessage(
        "Inbound: Received USERAUTH_FAILURE (publickey,password)"
      )
    ).toEqual({
      event: "auth_methods_remaining",
      methods: ["publickey", "password"],
    });
    expect(
      filterSafeSshDebugMessage("Handshake: KEX algorithm: curve25519-sha256")
    ).toEqual({
      event: "handshake_negotiated",
      algorithm: "KEX algorithm",
      value: "curve25519-sha256",
    });
  });

  test("drops raw server debug lines outside the allowlist", () => {
    expect(
      filterSafeSshDebugMessage(
        'Debug output from server: {"message":"auth banner with token=abc"}'
      )
    ).toBeNull();
    expect(
      filterSafeSshDebugMessage("Remote ident: 'SSH-2.0-OpenSSH_9.9'")
    ).toBeNull();
  });
});

describe("createSafeSshDebugHook", () => {
  test("does not enable ssh2 debug forwarding outside debug level", () => {
    const entries: string[] = [];
    const logger = createLogger({
      level: "info",
      writeStdout: (line) => entries.push(line),
      writeStderr: (line) => entries.push(line),
    });

    expect(createSafeSshDebugHook(logger, "attempt-1")).toBeUndefined();
  });

  test("logs only filtered ssh2 debug events in debug mode", () => {
    const entries: string[] = [];
    const logger = createLogger({
      level: "debug",
      writeStdout: (line) => entries.push(line),
      writeStderr: (line) => entries.push(line),
    });

    const hook = createSafeSshDebugHook(logger, "attempt-2");
    hook?.("Socket connected");
    hook?.("Outbound: Sending USERAUTH_REQUEST (password)");
    hook?.("Debug output from server: password=hunter2");

    expect(entries).toHaveLength(2);
    expect(entries.map((line) => JSON.parse(line))).toEqual([
      {
        ts: expect.any(String),
        level: "debug",
        msg: "SSH debug",
        attemptId: "attempt-2",
        event: "socket_connected",
      },
      {
        ts: expect.any(String),
        level: "debug",
        msg: "SSH debug",
        attemptId: "attempt-2",
        event: "auth_method_attempt",
        method: "password",
      },
    ]);
  });
});
