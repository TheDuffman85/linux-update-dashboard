import { sanitizeOutput } from "../utils/sanitize";
import type { Logger } from "../logger";
import type { ApprovedHostKeyInput } from "../services/system-connection-validation";

export interface SSHConnectContext {
  systemId?: number;
  approvedHostKeys?: ApprovedHostKeyInput[];
}

export interface SSHAttemptLogMeta {
  systemId?: number;
  host?: string;
  port: number;
  username?: string;
  authType: string;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasKeyPassphrase: boolean;
}

export interface SafeSshDebugEvent {
  event: string;
  method?: string;
  methods?: string[];
  algorithm?: string;
  value?: string;
  error?: string;
}

const SAFE_HANDSHAKE_FIELDS = new Set([
  "KEX algorithm",
  "Host key format",
  "C->S cipher",
  "S->C cipher",
  "C->S MAC",
  "S->C MAC",
  "C->S compression",
  "S->C compression",
]);

function normalizePort(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 22;
}

function normalizeAuthType(value: unknown): string {
  return value === "key" ? "key" : "password";
}

export function buildSSHAttemptLogMeta(
  system: Record<string, unknown>,
  context: SSHConnectContext = {}
): SSHAttemptLogMeta {
  return {
    systemId: context.systemId,
    host: typeof system.hostname === "string" ? system.hostname : undefined,
    port: normalizePort(system.port),
    username: typeof system.username === "string" ? system.username : undefined,
    authType: normalizeAuthType(system.authType),
    hasPassword: !!system.encryptedPassword,
    hasPrivateKey: !!system.encryptedPrivateKey,
    hasKeyPassphrase: !!system.encryptedKeyPassphrase,
  };
}

export function filterSafeSshDebugMessage(
  message: string
): SafeSshDebugEvent | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  if (trimmed === "Socket connected") return { event: "socket_connected" };
  if (trimmed === "Socket ended") return { event: "socket_ended" };
  if (trimmed === "Socket closed") return { event: "socket_closed" };

  if (trimmed.startsWith("Socket error:")) {
    return {
      event: "socket_error",
      error: sanitizeOutput(trimmed.slice("Socket error:".length).trim()),
    };
  }

  if (/^Client: Trying .* on port \d+ \.\.\.$/.test(trimmed)) {
    return { event: "connect_attempt" };
  }

  if (trimmed === "Handshake completed") {
    return { event: "handshake_completed" };
  }

  const handshakeMatch = /^Handshake: ([^:]+): (.+)$/.exec(trimmed);
  if (handshakeMatch && SAFE_HANDSHAKE_FIELDS.has(handshakeMatch[1])) {
    return {
      event: "handshake_negotiated",
      algorithm: handshakeMatch[1],
      value: handshakeMatch[2],
    };
  }

  const authRequestMatch =
    /^Outbound: Sending USERAUTH_REQUEST \(([^)]+)\)$/.exec(trimmed);
  if (authRequestMatch) {
    return {
      event: "auth_method_attempt",
      method: authRequestMatch[1],
    };
  }

  const authFailureMatch =
    /^Inbound: Received USERAUTH_FAILURE \(([^)]+)\)$/.exec(trimmed);
  if (authFailureMatch) {
    return {
      event: "auth_methods_remaining",
      methods: authFailureMatch[1]
        .split(",")
        .map((method) => method.trim())
        .filter(Boolean),
    };
  }

  const authMethodFailedMatch =
    /^Client: ([a-z-]+)(?: \([^)]+\))? auth failed$/.exec(trimmed);
  if (authMethodFailedMatch) {
    return {
      event: "auth_method_failed",
      method: authMethodFailedMatch[1],
    };
  }

  if (trimmed === "Client: agent auth failed") {
    return { event: "auth_method_failed", method: "agent" };
  }

  return null;
}

export function createSafeSshDebugHook(
  appLogger: Logger,
  attemptId: string
): ((message: string) => void) | undefined {
  if (!appLogger.isLevelEnabled("debug")) return undefined;

  return (message: string) => {
    const event = filterSafeSshDebugMessage(message);
    if (!event) return;

    appLogger.debug("SSH debug", {
      attemptId,
      ...event,
    });
  };
}
