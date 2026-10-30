import { createHash, randomUUID } from "crypto";
import { SignJWT, decodeJwt, jwtVerify } from "jose";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { users } from "../db/schema";
import { isSecureRequest } from "../request-security";
import type { UserRole } from "./oidc";
import {
  getOidcLogoutVersion,
  INITIAL_OIDC_LOGOUT_VERSION,
  isOidcSessionRevoked,
} from "./oidc-logout";

const SESSION_COOKIE = "ludash_session";
const SESSION_LIFETIME = 86400 * 30; // 30 days — JWT expiration
export const OIDC_SESSION_LIFETIME = 86400; // OIDC role and access changes take effect within a day
const REFRESH_AFTER = 86400; // refresh daily to keep session rolling

let _secret: Uint8Array | null = null;

export function initSession(secretKey: string): void {
  _secret = new TextEncoder().encode(secretKey);
}

export interface SessionData {
  userId: number;
  username: string;
  role: UserRole;
  authMethod?: "password" | "passkey" | "oidc";
  sessionVersion?: number;
  issuedAt?: number;
  /** Set while a password session waits for the password an administrator chose to be replaced. */
  passwordChangeRequired?: boolean;
}

export function normalizeUserRole(value: string | null | undefined): UserRole {
  return value === "read-only" ? "read-only" : "admin";
}

export interface CreateSessionOptions {
  /** Provider session ID (sid) of an OIDC sign-in, for back-channel logout. */
  oidcSessionId?: string;
  /** Keeps the session ID of a refreshed session; new sign-ins get a new one. */
  sessionId?: string;
}

/**
 * Whether the account's sessions are unchanged since `sessionVersion` was read.
 * Sign-ins recheck this after verifying credentials, because an administrator
 * may have revoked them (password or MFA reset, disabling) in the meantime.
 */
export function isSessionVersionCurrent(userId: number, sessionVersion: number): boolean {
  const user = getDb()
    .select({ sessionVersion: users.sessionVersion })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return user?.sessionVersion === sessionVersion;
}

export async function createSession(
  c: Context,
  userId: number,
  username: string,
  authMethod: SessionData["authMethod"] = "password",
  { oidcSessionId, sessionId = randomUUID() }: CreateSessionOptions = {},
): Promise<string> {
  if (!_secret) throw new Error("Session not initialized");
  const user = getDb()
    .select({
      sessionVersion: users.sessionVersion,
      authProvider: users.authProvider,
      oidcIssuer: users.oidcIssuer,
      oidcSubject: users.oidcSubject,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  const sessionVersion = user?.sessionVersion ?? 0;
  const lifetime =
    authMethod === "oidc" ? OIDC_SESSION_LIFETIME : SESSION_LIFETIME;
  // Without a provider session ID, back-channel logout can only match this
  // session by its identity's logout version.
  const oidcLogoutVersion =
    authMethod === "oidc" &&
    !oidcSessionId &&
    user?.oidcIssuer &&
    user.oidcSubject
      ? getOidcLogoutVersion(user.oidcIssuer, user.oidcSubject)
      : undefined;

  const token = await new SignJWT({
    userId,
    username,
    authMethod,
    sessionVersion,
    sessionId,
    ...(authMethod === "oidc" && oidcSessionId ? { sid: oidcSessionId } : {}),
    ...(oidcLogoutVersion ? { oidcLogoutVersion } : {}),
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
  return token;
}

export async function getSession(c: Context): Promise<SessionData | null> {
  const token = getSessionToken(c);
  return token ? verifySessionToken(token) : null;
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE) || undefined;
}

/**
 * Stable identifier of the sign-in a token belongs to; rolling refreshes keep
 * it. Tokens from before session IDs existed are identified by their hash,
 * which their first refresh carries forward.
 */
export function getSessionKey(token: string): string {
  try {
    const { sessionId } = decodeJwt(token);
    if (typeof sessionId === "string" && sessionId) return sessionId;
  } catch {
    // Not a JWT; fall back to the token hash.
  }
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Verifies a session token against the current user state, so it also detects
 * sessions ended after the token was issued (logout, revocation, role loss).
 */
export async function verifySessionToken(
  token: string,
): Promise<SessionData | null> {
  if (!_secret) return null;

  try {
    const { payload } = await jwtVerify(token, _secret);
    const userId = payload.userId as number;
    const user = getDb()
      .select({
        sessionVersion: users.sessionVersion,
        authProvider: users.authProvider,
        passwordHash: users.passwordHash,
        role: users.role,
        oidcIssuer: users.oidcIssuer,
        oidcSubject: users.oidcSubject,
        disabled: users.disabled,
        passwordChangeRequired: users.passwordChangeRequired,
      })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (!user || user.disabled === 1) return null;
    const tokenSessionVersion =
      typeof payload.sessionVersion === "number" ? payload.sessionVersion : 0;
    if (tokenSessionVersion !== user.sessionVersion) return null;
    const authMethod = payload.authMethod as SessionData["authMethod"];
    if (authMethod === "oidc" && user.authProvider !== "oidc") return null;
    if (
      authMethod === "oidc" &&
      user.oidcIssuer &&
      isOidcSessionLoggedOut(payload, user.oidcIssuer, user.oidcSubject)
    )
      return null;
    if (
      authMethod === "passkey" &&
      user.authProvider === "oidc" &&
      !user.passwordHash
    )
      return null;

    return {
      userId,
      username: payload.username as string,
      role: normalizeUserRole(user.role),
      authMethod,
      sessionVersion: tokenSessionVersion,
      issuedAt: payload.iat,
      ...(authMethod === "password" && user.passwordChangeRequired === 1
        ? { passwordChangeRequired: true }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Whether the identity provider ended this OIDC session through back-channel logout. */
function isOidcSessionLoggedOut(
  payload: Record<string, unknown>,
  issuer: string,
  subject: string | null,
): boolean {
  if (typeof payload.sid === "string" && payload.sid) {
    return isOidcSessionRevoked(issuer, payload.sid);
  }
  if (!subject) return false;
  // Tokens from before back-channel logout carry no version and belong to the initial one.
  const tokenVersion =
    typeof payload.oidcLogoutVersion === "number" &&
    Number.isInteger(payload.oidcLogoutVersion) &&
    payload.oidcLogoutVersion > 0
      ? payload.oidcLogoutVersion
      : INITIAL_OIDC_LOGOUT_VERSION;
  return tokenVersion !== getOidcLogoutVersion(issuer, subject);
}

/**
 * Check if the current session token needs refreshing (rolling session).
 * Returns the new token if one was issued.
 */
export async function refreshSessionIfNeeded(c: Context): Promise<string | null> {
  if (!_secret) return null;

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, _secret);
    if (payload.authMethod === "oidc") return null;
    const iat = payload.iat;
    if (!iat) return null;
    const userId = payload.userId as number;
    const user = getDb()
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    const tokenSessionVersion =
      typeof payload.sessionVersion === "number" ? payload.sessionVersion : 0;
    if (!user || tokenSessionVersion !== user.sessionVersion) return null;

    const age = Math.floor(Date.now() / 1000) - iat;
    if (age > REFRESH_AFTER) {
      return await createSession(
        c,
        userId,
        payload.username as string,
        payload.authMethod as SessionData["authMethod"],
        { sessionId: getSessionKey(token) },
      );
    }
    return null;
  } catch {
    return null;
  }
}

export function clearSession(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
