import { SignJWT, jwtVerify } from "jose";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { config } from "../config";

const SESSION_COOKIE = "ludash_session";
const SESSION_LIFETIME = 86400 * 30; // 30 days — JWT expiration
const COOKIE_MAX_AGE = SESSION_LIFETIME; // match JWT lifetime
const REFRESH_AFTER = 86400; // refresh daily to keep session rolling

let _secret: Uint8Array | null = null;

export function initSession(secretKey: string): void {
  _secret = new TextEncoder().encode(secretKey);
}

export interface SessionData {
  userId: number;
  username: string;
}

function isSecureContext(): boolean {
  try {
    return new URL(config.baseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export async function createSession(
  c: Context,
  userId: number,
  username: string
): Promise<void> {
  if (!_secret) throw new Error("Session not initialized");

  const token = await new SignJWT({ userId, username })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${SESSION_LIFETIME}s`)
    .setIssuedAt()
    .sign(_secret);

  setCookie(c, SESSION_COOKIE, token, {
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureContext(),
    path: "/",
  });
}

export async function getSession(c: Context): Promise<SessionData | null> {
  if (!_secret) return null;

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, _secret);
    return {
      userId: payload.userId as number,
      username: payload.username as string,
    };
  } catch {
    return null;
  }
}

/**
 * Check if the current session token needs refreshing (rolling session).
 * Returns true if a new token was issued.
 */
export async function refreshSessionIfNeeded(c: Context): Promise<boolean> {
  if (!_secret) return false;

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return false;

  try {
    const { payload } = await jwtVerify(token, _secret);
    const iat = payload.iat;
    if (!iat) return false;

    const age = Math.floor(Date.now() / 1000) - iat;
    if (age > REFRESH_AFTER) {
      await createSession(
        c,
        payload.userId as number,
        payload.username as string,
      );
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
