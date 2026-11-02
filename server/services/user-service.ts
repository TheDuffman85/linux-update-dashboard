import { and, asc, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import { apiTokens, userPreferences, users, webauthnCredentials } from "../db/schema";
import { isOidcAutoLinkEnabled } from "../auth/auth-config";
import { getConfiguredIssuer } from "../auth/oidc";
import { isLinkedAccount, isOidcOnlyAccount } from "../auth/password";
import { normalizeLinkedSsoRole } from "../auth/session";
import type { UserRole } from "../auth/oidc";

export const USER_PREFERENCE_KEYS = ["language", "time_format"] as const;
export type UserPreferenceKey = (typeof USER_PREFERENCE_KEYS)[number];
export type UserPreferences = Partial<Record<UserPreferenceKey, string>>;

const LANGUAGE_PREFERENCE_PATTERN = /^(browser|[a-z]{2}(-[a-z]{2})?)$/;
const TIME_FORMAT_PREFERENCES = new Set(["browser", "12h", "24h"]);

export function isUserPreferenceKey(key: string): key is UserPreferenceKey {
  return (USER_PREFERENCE_KEYS as readonly string[]).includes(key);
}

export function isValidUserPreference(key: UserPreferenceKey, value: string): boolean {
  return key === "language"
    ? LANGUAGE_PREFERENCE_PATTERN.test(value)
    : TIME_FORMAT_PREFERENCES.has(value);
}

export function getUserPreferences(userId: number): UserPreferences {
  const rows = getDb()
    .select({ key: userPreferences.key, value: userPreferences.value })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .all();
  const preferences: UserPreferences = {};
  for (const row of rows) {
    if (isUserPreferenceKey(row.key)) preferences[row.key] = row.value;
  }
  return preferences;
}

/** Saves the given preferences; `null` removes one so the instance default applies again. */
export function setUserPreferences(
  userId: number,
  changes: Partial<Record<UserPreferenceKey, string | null>>,
): void {
  getDb().transaction((tx) => {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === undefined) {
        tx.delete(userPreferences)
          .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
          .run();
      } else {
        tx.insert(userPreferences)
          .values({ userId, key, value })
          .onConflictDoUpdate({
            target: [userPreferences.userId, userPreferences.key],
            set: { value },
          })
          .run();
      }
    }
  });
}

export type ManagedUser = typeof users.$inferSelect;

export interface UserSummary {
  id: number;
  username: string;
  role: UserRole;
  /** OIDC-only accounts get their role from the identity provider on every sign-in. */
  source: "local" | "oidc";
  disabled: boolean;
  passwordChangeRequired: boolean;
  totpEnabled: boolean;
  passkeyCount: number;
  /** The SSO identity of a local account that can use both sign-in methods. */
  oidcLink: OidcLinkSummary | null;
  createdAt: string;
  current: boolean;
}

export type OidcLinkMethod = "verified" | "username";

export interface OidcLinkSummary {
  issuer: string;
  username: string | null;
  role: UserRole;
  method: OidcLinkMethod;
  linkedAt: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  username: string;
  role: UserRole;
}

export function getUserById(id: number): ManagedUser | undefined {
  return getDb().select().from(users).where(eq(users.id, id)).get();
}

export function getUserByUsername(username: string): ManagedUser | undefined {
  return getDb().select().from(users).where(eq(users.username, username)).get();
}

export function getUserByOidcIdentity(issuer: string, subject: string): ManagedUser | undefined {
  return getDb()
    .select()
    .from(users)
    .where(and(eq(users.oidcIssuer, issuer), eq(users.oidcSubject, subject)))
    .get();
}

export function summarizeOidcLink(user: ManagedUser): OidcLinkSummary | null {
  if (!isLinkedAccount(user)) return null;
  return {
    issuer: user.oidcIssuer ?? "",
    username: user.oidcUsername,
    role: normalizeLinkedSsoRole(user.oidcRole),
    method: user.oidcLinkMethod === "username" ? "username" : "verified",
    linkedAt: user.oidcLinkedAt!,
  };
}

export function summarizeUser(user: ManagedUser, currentUserId: number): UserSummary {
  const passkeyCount =
    getDb()
      .select({ count: count() })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, user.id))
      .get()?.count ?? 0;
  return {
    id: user.id,
    username: user.username,
    role: user.role === "read-only" ? "read-only" : "admin",
    source: isOidcOnlyAccount(user) ? "oidc" : "local",
    disabled: user.disabled === 1,
    passwordChangeRequired: user.passwordChangeRequired === 1,
    totpEnabled: user.totpEnabled === 1 && !!user.totpSecret,
    passkeyCount,
    oidcLink: summarizeOidcLink(user),
    createdAt: user.createdAt,
    current: user.id === currentUserId,
  };
}

export function listUsers(currentUserId: number): UserSummary[] {
  return getDb()
    .select()
    .from(users)
    .orderBy(sql`${users.username} COLLATE NOCASE`, asc(users.id))
    .all()
    .map((user) => summarizeUser(user, currentUserId));
}

/** SSO admin access only counts while its provider can still sign in. */
function hasCurrentSsoAdminAccess(user: ManagedUser): boolean {
  return user.oidcRole === "admin" && !!user.oidcIssuer && user.oidcIssuer === getConfiguredIssuer();
}

/** Whether the account can administer the instance through either sign-in method. */
export function isActiveAdmin(user: ManagedUser): boolean {
  return (user.role === "admin" || hasCurrentSsoAdminAccess(user)) && user.disabled === 0;
}

/** Unlinking keeps the local role and removes the SSO role, which may be the last admin access. */
export function wouldUnlinkRemoveLastAdmin(user: ManagedUser): boolean {
  return user.role !== "admin" && isActiveAdmin(user) && countActiveAdmins(user.id) === 0;
}

/** Accounts with admin access through either sign-in method, leaving one account out. */
export function countActiveAdmins(excludingId: number): number {
  const issuer = getConfiguredIssuer();
  return (
    getDb()
      .select({ count: count() })
      .from(users)
      .where(
        and(
          or(
            eq(users.role, "admin"),
            issuer ? and(eq(users.oidcRole, "admin"), eq(users.oidcIssuer, issuer)) : undefined,
          ),
          eq(users.disabled, 0),
          ne(users.id, excludingId),
        ),
      )
      .get()?.count ?? 0
  );
}

export function createLocalUser(params: {
  username: string;
  passwordHash: string;
  role: UserRole;
  passwordChangeRequired: boolean;
}): ManagedUser | null {
  return getDb().transaction((tx) => {
    if (tx.select({ id: users.id }).from(users).where(eq(users.username, params.username)).get()) {
      return null;
    }
    return tx
      .insert(users)
      .values({
        username: params.username,
        passwordHash: params.passwordHash,
        role: params.role,
        authProvider: "password",
        passwordChangeRequired: params.passwordChangeRequired ? 1 : 0,
        // Automatic linking only covers accounts that existed before it was turned on.
        oidcAutoLinkBlocked: isOidcAutoLinkEnabled() ? 1 : 0,
      })
      .returning()
      .get();
  });
}

/** Sessions read the role on every request; disabling an account also ends its sessions. */
export function updateUserAccess(
  id: number,
  changes: { role?: UserRole; disabled?: boolean },
): void {
  if (!changes.role && changes.disabled === undefined) return;
  getDb()
    .update(users)
    .set({
      ...(changes.role ? { role: changes.role } : {}),
      ...(changes.disabled !== undefined ? { disabled: changes.disabled ? 1 : 0 } : {}),
      ...(changes.disabled ? { sessionVersion: sql`${users.sessionVersion} + 1` } : {}),
    })
    .where(eq(users.id, id))
    .run();
}

/** Sets a password chosen by an administrator and ends the account's sessions. */
export function resetUserPassword(id: number, passwordHash: string, changeRequired: boolean): void {
  getDb()
    .update(users)
    .set({
      passwordHash,
      passwordChangeRequired: changeRequired ? 1 : 0,
      sessionVersion: sql`${users.sessionVersion} + 1`,
    })
    .where(eq(users.id, id))
    .run();
}

/** Removes the account's TOTP secret and passkeys and ends its sessions. */
export function resetUserSecondFactors(id: number): void {
  getDb().transaction((tx) => {
    tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id)).run();
    tx.update(users)
      .set({
        totpSecret: null,
        totpEnabled: 0,
        lastTotpStep: null,
        sessionVersion: sql`${users.sessionVersion} + 1`,
      })
      .where(eq(users.id, id))
      .run();
  });
}

/** Passkeys, API tokens and preferences go with the account (ON DELETE CASCADE). */
export function deleteUser(id: number): void {
  getDb().delete(users).where(eq(users.id, id)).run();
}

/** The local account an SSO sign-in with this username may link to automatically. */
export function findOidcAutoLinkTarget(username: string): ManagedUser | undefined {
  const user = getDb()
    .select()
    .from(users)
    .where(
      and(
        eq(users.username, username),
        eq(users.disabled, 0),
        eq(users.oidcAutoLinkBlocked, 0),
        isNull(users.oidcSubject),
      ),
    )
    .get();
  return user?.passwordHash ? user : undefined;
}

export function countUserApiTokens(userId: number, roleSource?: "oidc"): number {
  return (
    getDb()
      .select({ count: count() })
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, userId),
          roleSource ? eq(apiTokens.roleSource, roleSource) : undefined,
        ),
      )
      .get()?.count ?? 0
  );
}

/**
 * Links an SSO identity to a local account. If the identity already has a separate
 * SSO-only account, that account is merged: its API tokens move over and stay
 * limited by the SSO role, so they keep exactly the access they had. A link the
 * owner verified ends the account's other sessions; one matched by username does
 * not, because that sign-in must have no effect on local sessions.
 * Merging must not bring back a disabled account, so one is left alone.
 * Returns false when the identity belongs to a disabled account or one with local credentials.
 */
export function linkOidcIdentity(
  userId: number,
  identity: OidcIdentity,
  method: OidcLinkMethod,
): boolean {
  return getDb().transaction((tx) => {
    const target = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!target?.passwordHash || isLinkedAccount(target)) return false;

    const owner = tx
      .select()
      .from(users)
      .where(and(eq(users.oidcIssuer, identity.issuer), eq(users.oidcSubject, identity.subject)))
      .get();
    if (owner && owner.id !== target.id) {
      if (!isOidcOnlyAccount(owner) || owner.disabled === 1) return false;
      tx.update(apiTokens)
        .set({ userId: target.id, roleSource: "oidc" })
        .where(eq(apiTokens.userId, owner.id))
        .run();
      tx.delete(users).where(eq(users.id, owner.id)).run();
    }

    tx.update(users)
      .set({
        authProvider: "oidc",
        oidcIssuer: identity.issuer,
        oidcSubject: identity.subject,
        oidcUsername: identity.username,
        oidcRole: identity.role,
        oidcLinkedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
        oidcLinkMethod: method,
        oidcAutoLinkBlocked: 0,
        ...(method === "verified" ? { sessionVersion: sql`${users.sessionVersion} + 1` } : {}),
      })
      .where(eq(users.id, target.id))
      .run();
    return true;
  });
}

/** Records the role and name from a linked identity's SSO sign-in and ends its earlier SSO sessions. */
export function updateLinkedOidcIdentity(
  userId: number,
  identity: Pick<OidcIdentity, "username" | "role">,
): void {
  getDb()
    .update(users)
    .set({
      oidcUsername: identity.username,
      oidcRole: identity.role,
      oidcSessionVersion: sql`${users.oidcSessionVersion} + 1`,
    })
    .where(eq(users.id, userId))
    .run();
}

/**
 * Removes an account's SSO identity and ends its sessions. Tokens limited by the SSO
 * role now follow the local role, without gaining access. The next SSO sign-in
 * creates a separate account again instead of linking automatically.
 * Returns false when this would remove the last administrator access. The check is
 * part of the change, so concurrent unlinks cannot each count on the other's access.
 */
export function unlinkOidcIdentity(userId: number): boolean {
  return getDb().transaction((tx) => {
    const user = tx.select().from(users).where(eq(users.id, userId)).get();
    if (!user || wouldUnlinkRemoveLastAdmin(user)) return false;
    const ssoTokens = and(eq(apiTokens.userId, userId), eq(apiTokens.roleSource, "oidc"));
    if (normalizeLinkedSsoRole(user.oidcRole) !== "admin") {
      tx.update(apiTokens).set({ readOnly: 1 }).where(ssoTokens).run();
    }
    tx.update(apiTokens).set({ roleSource: "local" }).where(ssoTokens).run();
    tx.update(users)
      .set({
        authProvider: "password",
        oidcIssuer: null,
        oidcSubject: null,
        oidcUsername: null,
        oidcRole: null,
        oidcLinkedAt: null,
        oidcLinkMethod: null,
        oidcAutoLinkBlocked: 1,
        sessionVersion: sql`${users.sessionVersion} + 1`,
      })
      .where(eq(users.id, userId))
      .run();
    return true;
  });
}
