export type UserRole = "admin" | "read-only";
export type OidcUnmatchedRole = "deny" | UserRole;

export const DEFAULT_OIDC_SCOPE = "openid profile email";
export const DEFAULT_OIDC_GROUPS_CLAIM = "groups";
export const OIDC_END_SESSION_SETTING_KEY = "oidc_end_session";
export const OIDC_AUTO_LOGIN_SETTING_KEY = "oidc_auto_login";
export const OIDC_BACKCHANNEL_LOGOUT_SETTING_KEY = "oidc_backchannel_logout";
export const OIDC_ISSUER_ENV_VAR = "LUDASH_OIDC_ISSUER";

export function parseCsvList(value: string | undefined | null): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

/** Normalizes a space-separated scope list. Throws when openid is missing. */
export function parseOidcScope(value: string | undefined | null): string {
  const scope = value?.trim();
  if (!scope) return DEFAULT_OIDC_SCOPE;
  const scopes = Array.from(new Set(scope.split(/\s+/)));
  if (!scopes.includes("openid")) {
    throw new Error("OIDC scopes must include openid");
  }
  return scopes.join(" ");
}

export function parseOidcUnmatchedRole(
  value: string | undefined | null,
): OidcUnmatchedRole {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "deny";
  if (
    normalized === "deny" ||
    normalized === "admin" ||
    normalized === "read-only"
  ) {
    return normalized;
  }
  throw new Error("Invalid OIDC unmatched role");
}
