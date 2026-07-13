import { SignJWT, jwtVerify } from "jose";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../db/schema";
import { isSecureRequest } from "../request-security";

const SESSION_COOKIE = "ludash_session";
const SESSION_LIFETIME = 86400 * 30; // 30 days — JWT expiration
const OIDC_SESSION_LIFETIME = 86400; // OIDC role and access changes take effect within a day
const REFRESH_AFTER = 86400; // refresh daily to keep session rolling

let _secret: Uint8Array | null = null;

export function initSession(secretKey: string): void {
  _secret = new TextEncoder().encode(secretKey);
}

export interface SessionData {
  userId: number;
  username: string;
  authMethod?: "password" | "passkey" | "oidc";
  sessionVersion?: number;
  issuedAt?: number;
}

export async function createSession(
  c: Context,
  userId: number,
  username: string,
  authMethod: SessionData["authMethod"] = "password",
): Promise<void> {
  if (!_secret) throw new Error("Session not initialized");
  const user = getDb()
    .select({
      sessionVersion: users.sessionVersion,
      authProvider: users.authProvider,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  const sessionVersion = user?.sessionVersion ?? 0;
  const lifetime =
    authMethod === "oidc" ? OIDC_SESSION_LIFETIME : SESSION_LIFETIME;

  const token = await new SignJWT({
    userId,
    username,
    authMethod,
    sessionVersion,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(`${lifetime}s`)
    .setIssuedAt()
    .sign(_secret);

  setCookie(c, SESSION_COOKIE, token, {
    maxAge: lifetime,
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    path: "/",
  });
}

export async function getSession(c: Context): Promise<SessionData | null> {
  if (!_secret) return null;

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, _secret);
    const userId = payload.userId as number;
    const user = getDb()
      .select({
        sessionVersion: users.sessionVersion,
        authProvider: users.authProvider,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!user) return null;
    const tokenSessionVersion =
      typeof payload.sessionVersion === "number" ? payload.sessionVersion : 0;
    if (tokenSessionVersion !== user.sessionVersion) return null;
    const authMethod = payload.authMethod as SessionData["authMethod"];
    if (authMethod === "oidc" && user.authProvider !== "oidc") return null;
    if (
      authMethod === "passkey" &&
      user.authProvider === "oidc" &&
      !user.passwordHash
    )
      return null;

    return {
      userId,
      username: payload.username as string,
      authMethod,
      sessionVersion: tokenSessionVersion,
      issuedAt: payload.iat,
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
    if (payload.authMethod === "oidc") return false;
    const iat = payload.iat;
    if (!iat) return false;
    const userId = payload.userId as number;
    const user = getDb()
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    const tokenSessionVersion =
      typeof payload.sessionVersion === "number" ? payload.sessionVersion : 0;
    if (!user || tokenSessionVersion !== user.sessionVersion) return false;

    const age = Math.floor(Date.now() / 1000) - iat;
    if (age > REFRESH_AFTER) {
      await createSession(
        c,
        userId,
        payload.username as string,
        payload.authMethod as SessionData["authMethod"],
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
