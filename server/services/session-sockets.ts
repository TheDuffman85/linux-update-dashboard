import type { WSContext } from "hono/ws";
import { getSessionKey, verifySessionToken } from "../auth/session";

/** Close code the client treats as an auth failure and does not reconnect after. */
export const SESSION_ENDED_CLOSE_CODE = 4001;

interface SocketSession {
  /** Stable across rolling refreshes, so logout matches sockets of older tokens. */
  key: string;
  /** Latest known token of the session, used to check it is still valid. */
  token: string;
}

// Open WebSockets authorized by a browser session. Auth is only checked on the
// upgrade request, so sockets must be closed explicitly when their session ends.
const sockets = new Map<WSContext, SocketSession>();

export function trackSessionSocket(ws: WSContext, sessionToken: string): void {
  sockets.set(ws, { key: getSessionKey(sessionToken), token: sessionToken });
}

export function untrackSessionSocket(ws: WSContext): void {
  sockets.delete(ws);
}

function closeSocket(ws: WSContext): void {
  sockets.delete(ws);
  try {
    ws.close(SESSION_ENDED_CLOSE_CODE, "Session ended");
  } catch {
    // Already closing; onClose cleans up the stream subscription.
  }
}

/** Closes the sockets of this token's session, including ones opened before a refresh. */
export function closeSessionSockets(sessionToken: string): number {
  const key = getSessionKey(sessionToken);
  let closed = 0;
  for (const [ws, session] of [...sockets]) {
    if (session.key !== key) continue;
    closeSocket(ws);
    closed += 1;
  }
  return closed;
}

/** Records the token a rolling refresh issued for the sockets' session. */
export function refreshSessionSockets(sessionToken: string): void {
  const key = getSessionKey(sessionToken);
  for (const session of sockets.values()) {
    if (session.key === key) session.token = sessionToken;
  }
}

/**
 * Moves sockets to a new session of the same browser, e.g. after a password
 * change, so ending the other sessions keeps them open.
 */
export function rebindSessionSockets(fromToken: string, toToken: string): void {
  const fromKey = getSessionKey(fromToken);
  const to = { key: getSessionKey(toToken), token: toToken };
  for (const [ws, session] of sockets) {
    if (session.key === fromKey) sockets.set(ws, { ...to });
  }
}

/**
 * Closes sockets whose session no longer verifies, e.g. after a back-channel
 * logout, a password change, or an SSO user losing access.
 */
export async function closeEndedSessionSockets(): Promise<number> {
  const verified = new Map<string, boolean>();
  let closed = 0;
  for (const [ws, { token }] of [...sockets]) {
    let valid = verified.get(token);
    if (valid === undefined) {
      valid = !!(await verifySessionToken(token));
      verified.set(token, valid);
    }
    if (valid) continue;

    closeSocket(ws);
    closed += 1;
  }
  return closed;
}
