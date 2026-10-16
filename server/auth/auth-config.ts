import { count, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { settings, users, webauthnCredentials } from "../db/schema";
import { resolveSecretEnv } from "../env-secrets";
import { logger } from "../logger";
import { getEncryptor } from "../security";
import {
  OIDC_END_SESSION_SETTING_KEY,
  parseCsvList,
  parseOidcScope,
  parseOidcUnmatchedRole,
} from "./oidc-settings";

/**
 * Deployment-managed authentication settings.
 *
 * Each auth setting can be pinned by an environment variable. A pinned value
 * wins over the value saved in Settings, is never written to the database and
 * locks the field in the UI. Removing the variable restores the saved value.
 */
export const AUTH_SETTING_ENV_VARS = {
  oidc_issuer: "LUDASH_OIDC_ISSUER",
  oidc_client_id: "LUDASH_OIDC_CLIENT_ID",
  oidc_client_secret: "LUDASH_OIDC_CLIENT_SECRET",
  oidc_scope: "LUDASH_OIDC_SCOPE",
  oidc_groups_claim: "LUDASH_OIDC_GROUPS_CLAIM",
  oidc_admin_groups: "LUDASH_OIDC_ADMIN_GROUPS",
  oidc_read_only_groups: "LUDASH_OIDC_READ_ONLY_GROUPS",
  oidc_unmatched_role: "LUDASH_OIDC_UNMATCHED_ROLE",
  [OIDC_END_SESSION_SETTING_KEY]: "LUDASH_OIDC_END_SESSION",
  disable_password_login: "LUDASH_PASSWORD_LOGIN_ENABLED",
} as const;

export type AuthSettingKey = keyof typeof AUTH_SETTING_ENV_VARS;

export const MANAGED_BY_CONFIG_CODE = "MANAGED_BY_CONFIG";

const ENCRYPTED_AUTH_SETTING_KEYS: ReadonlySet<AuthSettingKey> = new Set([
  "oidc_client_secret",
]);

type AuthEnvOverrides = Partial<Record<AuthSettingKey, string>>;

let _overrides: AuthEnvOverrides | null = null;
let _passwordLoginFallbackWarned = false;

function configError(name: string, message: string): Error {
  return new Error(`Configuration error: ${name} ${message}`);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseBooleanEnv(name: string, value: string): boolean {
  const normalized = value.toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw configError(name, `must be true or false (got "${value}").`);
}

/** Reads and validates the auth environment variables. Throws on invalid values. */
export function loadAuthEnvOverrides(): AuthEnvOverrides {
  const overrides: AuthEnvOverrides = {};
  const env = AUTH_SETTING_ENV_VARS;

  const issuer = readEnv(env.oidc_issuer);
  if (issuer) {
    let url: URL;
    try {
      url = new URL(issuer);
    } catch {
      throw configError(env.oidc_issuer, `must be a valid URL (got "${issuer}").`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw configError(env.oidc_issuer, "must be an http:// or https:// URL.");
    }
    overrides.oidc_issuer = issuer;
  }

  const clientId = readEnv(env.oidc_client_id);
  if (clientId) overrides.oidc_client_id = clientId;

  if (!!issuer !== !!clientId) {
    throw new Error(
      `Configuration error: ${env.oidc_issuer} and ${env.oidc_client_id} must be set together.`,
    );
  }

  const clientSecret = resolveSecretEnv(env.oidc_client_secret)?.trim();
  if (clientSecret) overrides.oidc_client_secret = clientSecret;

  const scope = readEnv(env.oidc_scope);
  if (scope) {
    try {
      overrides.oidc_scope = parseOidcScope(scope);
    } catch {
      throw configError(env.oidc_scope, "must include openid.");
    }
  }

  const groupsClaim = readEnv(env.oidc_groups_claim);
  if (groupsClaim) overrides.oidc_groups_claim = groupsClaim;

  for (const key of ["oidc_admin_groups", "oidc_read_only_groups"] as const) {
    const value = readEnv(env[key]);
    if (value) overrides[key] = parseCsvList(value).join(",");
  }

  const unmatchedRole = readEnv(env.oidc_unmatched_role);
  if (unmatchedRole) {
    try {
      overrides.oidc_unmatched_role = parseOidcUnmatchedRole(unmatchedRole);
    } catch {
      throw configError(
        env.oidc_unmatched_role,
        `must be deny, admin, or read-only (got "${unmatchedRole}").`,
      );
    }
  }

  const endSession = readEnv(env[OIDC_END_SESSION_SETTING_KEY]);
  if (endSession) {
    overrides[OIDC_END_SESSION_SETTING_KEY] = String(
      parseBooleanEnv(env[OIDC_END_SESSION_SETTING_KEY], endSession),
    );
  }

  const passwordLoginEnabled = readEnv(env.disable_password_login);
  if (passwordLoginEnabled) {
    overrides.disable_password_login = String(
      !parseBooleanEnv(env.disable_password_login, passwordLoginEnabled),
    );
  }

  return overrides;
}

/** Validates the auth environment once at startup so misconfiguration fails fast. */
export function initAuthConfig(): void {
  _overrides = loadAuthEnvOverrides();
  _passwordLoginFallbackWarned = false;
}

/** Drops the cached environment so the next read picks up process.env again. */
export function resetAuthConfig(): void {
  _overrides = null;
  _passwordLoginFallbackWarned = false;
}

function getOverrides(): AuthEnvOverrides {
  _overrides ??= loadAuthEnvOverrides();
  return _overrides;
}

export function isAuthSettingKey(key: string): key is AuthSettingKey {
  return Object.prototype.hasOwnProperty.call(AUTH_SETTING_ENV_VARS, key);
}

/** Settings pinned by the environment, mapped to the variable that sets them. */
export function getManagedAuthSettings(): Partial<Record<AuthSettingKey, string>> {
  const managed: Partial<Record<AuthSettingKey, string>> = {};
  for (const key of Object.keys(getOverrides()) as AuthSettingKey[]) {
    managed[key] = AUTH_SETTING_ENV_VARS[key];
  }
  return managed;
}

export function isAuthSettingManaged(key: string): boolean {
  return isAuthSettingKey(key) && getOverrides()[key] !== undefined;
}

/** Effective (environment or saved) values; encrypted settings are returned decrypted. */
export function getAuthSettings<K extends AuthSettingKey>(
  keys: readonly K[],
): Map<K, string> {
  const overrides = getOverrides();
  const values = new Map<K, string>();
  const stored = keys.filter((key) => overrides[key] === undefined);

  if (stored.length > 0) {
    const rows = getDb()
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, stored))
      .all();
    for (const row of rows) {
      const key = row.key as K;
      values.set(
        key,
        ENCRYPTED_AUTH_SETTING_KEYS.has(key) && row.value
          ? getEncryptor().decrypt(row.value)
          : row.value,
      );
    }
  }

  for (const key of keys) {
    const override = overrides[key];
    if (override !== undefined) values.set(key, override);
  }
  return values;
}

export function getAuthSetting(key: AuthSettingKey): string | undefined {
  return getAuthSettings([key]).get(key);
}

/** Whether OIDC issuer and client ID are present, regardless of provider reachability. */
export function hasOidcSettings(): boolean {
  const values = getAuthSettings(["oidc_issuer", "oidc_client_id"]);
  return !!(values.get("oidc_issuer") && values.get("oidc_client_id"));
}

/** Whether any account that can sign in with a passkey has one registered. */
export function hasUsablePasskeys(): boolean {
  const row = getDb()
    .select({ count: count() })
    .from(webauthnCredentials)
    .innerJoin(users, eq(users.id, webauthnCredentials.userId))
    .where(
      sql`(${users.authProvider} != 'oidc' OR ${users.passwordHash} IS NOT NULL)`,
    )
    .get();
  return (row?.count ?? 0) > 0;
}

export interface PasswordLoginState {
  /** Effective state used for login. */
  disabled: boolean;
  /** Password login was requested off but stays on because no other sign-in method exists. */
  fallback: boolean;
}

export function getPasswordLoginState(): PasswordLoginState {
  const requestedDisabled = getAuthSetting("disable_password_login") === "true";
  const fallback = requestedDisabled && !hasOidcSettings() && !hasUsablePasskeys();

  if (fallback && !_passwordLoginFallbackWarned) {
    const source = isAuthSettingManaged("disable_password_login")
      ? `${AUTH_SETTING_ENV_VARS.disable_password_login}=false`
      : "the saved setting";
    logger.warn(
      `Password login is disabled by ${source}, but neither OIDC nor a passkey is configured; keeping password login enabled to avoid a lockout.`,
    );
  }
  _passwordLoginFallbackWarned = fallback;

  return { disabled: requestedDisabled && !fallback, fallback };
}

export function isPasswordLoginDisabled(): boolean {
  return getPasswordLoginState().disabled;
}
