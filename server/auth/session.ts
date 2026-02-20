import { SignJWT, jwtVerify } from "jose";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

const SESSION_COOKIE = "ludash_session";
const SESSION_MAX_AGE = 86400 * 7; // 7 days

let _secret: Uint8Array | null = null;

export function initSession(secretKey: string): void {
  _secret = new TextEncoder().encode(secretKey);
}

export interface SessionData {
  userId: number;
  username: string;
}

export async function createSession(
  c: Context,
  userId: number,
  username: string
): Promise<void> {
  if (!_secret) throw new Error("Session not initialized");

  const token = await new SignJWT({ userId, username })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .setIssuedAt()
    .sign(_secret);

  setCookie(c, SESSION_COOKIE, token, {
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    sameSite: "Lax",
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

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
