import { beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "crypto";
import type { EventEmitter } from "events";

type Scenario = (conn: EventEmitter & { end(): void }, config: Record<string, unknown>) => void;

const fake = vi.hoisted(() => ({
  scenario: null as Scenario | null,
  configs: [] as Record<string, unknown>[],
}));

vi.mock("ssh2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ssh2") & { default: typeof import("ssh2") }>();
  const { EventEmitter } = await import("events");
  class FakeClient extends EventEmitter {
    connect(config: Record<string, unknown>) {
      fake.configs.push(config);
      queueMicrotask(() => fake.scenario?.(this as never, config));
    }
    end() {}
  }
  return { ...actual, default: { ...actual.default, Client: FakeClient } };
});

const { getEncryptor, initEncryptor } = await import("../../server/security");
const {
  buildAuthenticationTimeoutMessage,
  initSSHManager,
  normalizeServerBanner,
} = await import("../../server/ssh/connection");

function sshError(message: string, level: string): Error & { level: string } {
  return Object.assign(new Error(message), { level });
}

function createManager() {
  initEncryptor(randomBytes(32).toString("base64"));
  return initSSHManager(1, 30, 10, getEncryptor());
}

function directSystem() {
  return {
    hostname: "100.101.101.104",
    port: 22,
    username: "nick",
    authType: "password",
    encryptedPassword: getEncryptor().encrypt("secret"),
    hostKeyVerificationEnabled: false,
  };
}

const TAILSCALE_BANNER =
  "# Tailscale SSH requires an additional check.\r\n" +
  "# To authenticate, visit: https://login.tailscale.com/a/abc123\r\n";

describe("normalizeServerBanner", () => {
  test("keeps line breaks and strips terminal control sequences", () => {
    expect(normalizeServerBanner("\x1b[1mWelcome\x1b[0m\r\nline\x07 two\r\n")).toBe(
      "Welcome\nline two"
    );
  });

  test("ignores empty or non-string banners", () => {
    expect(normalizeServerBanner(" \r\n ")).toBeUndefined();
    expect(normalizeServerBanner(undefined)).toBeUndefined();
  });

  test("redacts secrets and caps the length", () => {
    expect(normalizeServerBanner("token=abc")).toBe("token=***");
    const long = normalizeServerBanner("x".repeat(5000));
    expect(long?.length).toBe(1001);
    expect(long?.endsWith("…")).toBe(true);
  });
});

describe("SSHConnectionManager connect attempt diagnostics", () => {
  beforeEach(() => {
    fake.scenario = null;
    fake.configs = [];
  });

  test("reports a stalled login after a completed handshake and surfaces the banner", async () => {
    const manager = createManager();
    fake.scenario = (conn) => {
      conn.emit("handshake", {});
      conn.emit("banner", TAILSCALE_BANNER);
      conn.emit("error", sshError("Timed out while waiting for handshake", "client-timeout"));
    };

    const result = await manager.testConnection(directSystem());

    expect(result.success).toBe(false);
    expect(result.message).toBe(
      `Connection failed: ${buildAuthenticationTimeoutMessage(30)}`
    );
    expect(result.serverBanner).toBe(
      "# Tailscale SSH requires an additional check.\n" +
        "# To authenticate, visit: https://login.tailscale.com/a/abc123"
    );
    expect(result.debugRef).toBeTruthy();
  });

  test("keeps the original timeout message when the handshake never completed", async () => {
    const manager = createManager();
    fake.scenario = (conn) => {
      conn.emit("error", sshError("Timed out while waiting for handshake", "client-timeout"));
    };

    const result = await manager.testConnection(directSystem());

    expect(result.message).toBe("Connection failed: Timed out while waiting for handshake");
    expect(result.serverBanner).toBeUndefined();
  });

  test("includes the banner with authentication failures", async () => {
    const manager = createManager();
    fake.scenario = (conn) => {
      conn.emit("handshake", {});
      conn.emit("banner", "Authorized users only\n");
      conn.emit(
        "error",
        sshError("All configured authentication methods failed", "client-authentication")
      );
    };

    const result = await manager.testConnection(directSystem());

    expect(result.message).toBe("Permission denied (check credentials)");
    expect(result.serverBanner).toBe("Authorized users only");
  });
});
