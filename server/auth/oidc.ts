import * as client from "openid-client";

let _config: client.Configuration | null = null;
let _configured = false;
let _clientId = "";

/** Readable error messages for openid-client error codes */
const OIDC_ERROR_HINTS: Record<string, string> = {
  OAUTH_RESPONSE_IS_NOT_CONFORM: "The issuer returned an unexpected HTTP response. Check that the issuer URL points to a valid OIDC provider.",
  OAUTH_INVALID_RESPONSE: "The issuer returned an invalid discovery document.",
  ERR_JWT_CLAIM_VALIDATION_FAILED: "JWT claim validation failed — check client ID and issuer configuration.",
};

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
      clientSecret || undefined
    );
    _clientId = clientId;
    _configured = true;
    console.log(`OIDC configured successfully (issuer: ${issuer})`);
    return null;
  } catch (e: any) {
    _configured = false;
    const code: string = e?.code || "UNKNOWN";
    const msg: string = e?.message || String(e);
    const hint = OIDC_ERROR_HINTS[code] || "Verify the issuer URL is correct and the provider is reachable.";
    const detail = `Failed to configure OIDC: ${msg}\n  Code: ${code}\n  Issuer URL: ${issuer}\n  Discovery endpoint: ${discoveryUrl}\n  ${hint}`;
    console.error(detail);
    return `${msg} — ${hint}`;
  }
}

export function isConfigured(): boolean {
  return _configured;
}

export function getAuthorizationUrl(state: string, nonce: string, redirectUri: string): string {
  if (!_config) throw new Error("OIDC not configured");

  const params = new URLSearchParams({
    client_id: _clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
    nonce,
  });

  const authEndpoint =
    _config.serverMetadata().authorization_endpoint;
  if (!authEndpoint) throw new Error("No authorization endpoint");

  return `${authEndpoint}?${params.toString()}`;
}

export async function handleCallback(
  currentUrl: URL,
  expectedNonce?: string,
  expectedState?: string,
): Promise<{ username: string; email?: string } | null> {
  if (!_config) throw new Error("OIDC not configured");

  try {
    const tokens = await client.authorizationCodeGrant(_config, currentUrl, {
      expectedNonce,
      expectedState,
    });

    const claims = tokens.claims();
    if (!claims) return null;

    const username =
      (claims.preferred_username as string) ||
      (claims.email as string) ||
      (claims.sub as string);

    return {
      username,
      email: claims.email as string | undefined,
    };
  } catch (e: any) {
    const code = e?.code || "UNKNOWN";
    const msg = e?.message || String(e);
    console.error(`OIDC callback error (${code}): ${msg}`);
    return null;
  }
}
