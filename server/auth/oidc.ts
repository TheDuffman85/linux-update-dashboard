import * as client from "openid-client";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";

export type UserRole = "admin" | "read-only";
export type OidcUnmatchedRole = "deny" | UserRole;

export const DEFAULT_OIDC_SCOPE = "openid profile email";
export const DEFAULT_OIDC_GROUPS_CLAIM = "groups";
export const OIDC_END_SESSION_SETTING_KEY = "oidc_end_session";

export interface OidcRolePolicy {
  groupsClaim: string;
  adminGroups: string[];
  readOnlyGroups: string[];
  unmatchedRole: OidcUnmatchedRole;
}

export interface OidcPolicy extends OidcRolePolicy {
  scope: string;
}

let _config: client.Configuration | null = null;
let _configured = false;
let _clientId = "";

/** Readable error messages for openid-client error codes */
const OIDC_ERROR_HINTS: Record<string, string> = {
  OAUTH_RESPONSE_IS_NOT_CONFORM:
    "The issuer returned an unexpected HTTP response. Check that the issuer URL points to a valid OIDC provider.",
  OAUTH_INVALID_RESPONSE: "The issuer returned an invalid discovery document.",
  ERR_JWT_CLAIM_VALIDATION_FAILED:
    "JWT claim validation failed — check client ID and issuer configuration.",
};

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

/** Reads the role mapping and scope settings from the database. */
export function getOidcPolicy(): OidcPolicy {
  const rows = getDb()
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      inArray(settings.key, [
        "oidc_scope",
        "oidc_groups_claim",
        "oidc_admin_groups",
        "oidc_read_only_groups",
        "oidc_unmatched_role",
      ]),
    )
    .all();
  const values = new Map(rows.map((row) => [row.key, row.value]));

  let scope = DEFAULT_OIDC_SCOPE;
  try {
    scope = parseOidcScope(values.get("oidc_scope"));
  } catch {
    scope = DEFAULT_OIDC_SCOPE;
  }
  let unmatchedRole: OidcUnmatchedRole = "deny";
  try {
    unmatchedRole = parseOidcUnmatchedRole(values.get("oidc_unmatched_role"));
  } catch {
    unmatchedRole = "deny";
  }

  return {
    scope,
    groupsClaim:
      values.get("oidc_groups_claim")?.trim() || DEFAULT_OIDC_GROUPS_CLAIM,
    adminGroups: parseCsvList(values.get("oidc_admin_groups")),
    readOnlyGroups: parseCsvList(values.get("oidc_read_only_groups")),
    unmatchedRole,
  };
}

function readClaimGroups(
  claims: Record<string, unknown>,
  claimName: string,
): string[] {
  const value = claims[claimName];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

/** Admin groups win over read-only groups; unmatched users fall back to the policy. */
export function resolveOidcRole(
  policy: Pick<OidcRolePolicy, "adminGroups" | "readOnlyGroups" | "unmatchedRole">,
  groups: string[],
): UserRole | null {
  const groupSet = new Set(groups);
  if (policy.adminGroups.some((group) => groupSet.has(group))) return "admin";
  if (policy.readOnlyGroups.some((group) => groupSet.has(group)))
    return "read-only";
  if (policy.unmatchedRole === "deny") return null;
  return policy.unmatchedRole;
}

export function resolveOidcClaims(
  idClaims: Record<string, unknown>,
  userinfo: Record<string, unknown> | undefined,
  policy: OidcRolePolicy,
): { username: string; email?: string; role: UserRole | null } | null {
  const merged = { ...idClaims, ...(userinfo ?? {}) };
  const username = (
    (typeof merged.preferred_username === "string" &&
      merged.preferred_username) ||
    (typeof merged.email === "string" && merged.email) ||
    (typeof merged.sub === "string" && merged.sub) ||
    ""
  )
    .trim()
    .slice(0, 254);
  if (!username) return null;

  const groups = Array.from(
    new Set([
      ...readClaimGroups(idClaims, policy.groupsClaim),
      ...readClaimGroups(userinfo ?? {}, policy.groupsClaim),
    ]),
  );

  return {
    username,
    email: typeof merged.email === "string" ? merged.email : undefined,
    role: resolveOidcRole(policy, groups),
  };
}

export async function configureOidc(
  issuer: string,
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  if (!issuer || !clientId) {
    _configured = false;
    return null;
  }

  const discoveryUrl = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

  try {
    _config = await client.discovery(
      new URL(issuer),
      clientId,
      clientSecret || undefined,
    );
    _clientId = clientId;
    _configured = true;
    console.log(`OIDC configured successfully (issuer: ${issuer})`);
    return null;
  } catch (e: any) {
    _configured = false;
    const code: string = e?.code || "UNKNOWN";
    const msg: string = e?.message || String(e);
    const hint =
      OIDC_ERROR_HINTS[code] ||
      "Verify the issuer URL is correct and the provider is reachable.";
    const detail = `Failed to configure OIDC: ${msg}\n  Code: ${code}\n  Issuer URL: ${issuer}\n  Discovery endpoint: ${discoveryUrl}\n  ${hint}`;
    console.error(detail);
    return `${msg} — ${hint}`;
  }
}

export function isConfigured(): boolean {
  return _configured;
}

export function getAuthorizationUrl(
  state: string,
  nonce: string,
  redirectUri: string,
  scope = DEFAULT_OIDC_SCOPE,
): string {
  if (!_config) throw new Error("OIDC not configured");

  const params = new URLSearchParams({
    client_id: _clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope,
    state,
    nonce,
  });

  const authEndpoint = _config.serverMetadata().authorization_endpoint;
  if (!authEndpoint) throw new Error("No authorization endpoint");

  return `${authEndpoint}?${params.toString()}`;
}

/** Whether logging out should also end the session at the identity provider. */
export function isEndSessionEnabled(): boolean {
  const row = getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, OIDC_END_SESSION_SETTING_KEY))
    .get();
  return row?.value !== "false";
}

/**
 * Builds the RP-Initiated Logout URL, or returns null when the provider does
 * not advertise an end_session_endpoint.
 */
export function buildEndSessionUrl(
  configuration: client.Configuration,
  postLogoutRedirectUri: string,
  idTokenHint?: string,
): string | null {
  if (!configuration.serverMetadata().end_session_endpoint) return null;
  const params: Record<string, string> = {
    post_logout_redirect_uri: postLogoutRedirectUri,
  };
  if (idTokenHint) params.id_token_hint = idTokenHint;
  return client.buildEndSessionUrl(configuration, params).toString();
}

export function getEndSessionUrl(
  postLogoutRedirectUri: string,
  idTokenHint?: string,
): string | null {
  if (!_configured || !_config) return null;
  return buildEndSessionUrl(_config, postLogoutRedirectUri, idTokenHint);
}

async function fetchUserInfoClaims(
  configuration: client.Configuration,
  accessToken: string | undefined,
  subject: string,
): Promise<Record<string, unknown> | undefined> {
  if (!configuration.serverMetadata().userinfo_endpoint) return undefined;
  if (typeof accessToken !== "string" || !accessToken) return undefined;
  try {
    const userinfo = await client.fetchUserInfo(
      configuration,
      accessToken,
      subject,
    );
    return userinfo as Record<string, unknown>;
  } catch (e: any) {
    console.warn(
      `OIDC UserInfo fetch failed; falling back to ID token claims: ${e?.message || String(e)}`,
    );
    return undefined;
  }
}

export async function handleCallback(
  currentUrl: URL,
  policy: OidcRolePolicy,
  expectedNonce?: string,
  expectedState?: string,
): Promise<{
  username: string;
  email?: string;
  role: UserRole | null;
  issuer: string;
  subject: string;
  idToken?: string;
} | null> {
  if (!_config) throw new Error("OIDC not configured");

  try {
    const tokens = await client.authorizationCodeGrant(_config, currentUrl, {
      expectedNonce,
      expectedState,
    });

    const claims = tokens.claims() as Record<string, unknown> | undefined;
    if (!claims) return null;

    const issuer = typeof claims.iss === "string" ? claims.iss : "";
    const subject = typeof claims.sub === "string" ? claims.sub : "";
    if (!issuer || !subject) return null;

    const userinfo = await fetchUserInfoClaims(
      _config,
      tokens.access_token,
      subject,
    );
    const resolved = resolveOidcClaims(claims, userinfo, policy);
    if (!resolved) return null;

    return {
      ...resolved,
      issuer,
      subject,
      idToken: tokens.id_token,
    };
  } catch (e: any) {
    const code = e?.code || "UNKNOWN";
    const msg = e?.message || String(e);
    console.error(`OIDC callback error (${code}): ${msg}`);
    return null;
  }
}
