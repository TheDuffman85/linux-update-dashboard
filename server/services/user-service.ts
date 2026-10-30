import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { userPreferences, users, webauthnCredentials } from "../db/schema";
import { isOidcOnlyAccount } from "../auth/password";
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
  createdAt: string;
  current: boolean;
}

export function getUserById(id: number): ManagedUser | undefined {
  return getDb().select().from(users).where(eq(users.id, id)).get();
}

export function getUserByUsername(username: string): ManagedUser | undefined {
  return getDb().select().from(users).where(eq(users.username, username)).get();
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

/** Administrators who can still sign in, leaving one account out. */
export function countActiveAdmins(excludingId: number): number {
  return (
    getDb()
      .select({ count: count() })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.disabled, 0), ne(users.id, excludingId)))
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
