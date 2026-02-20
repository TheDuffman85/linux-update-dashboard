import * as client from "openid-client";

let _config: client.Configuration | null = null;
let _configured = false;
let _clientId = "";
let _redirectUri = "";

export async function configureOidc(
  issuer: string,
  clientId: string,
  clientSecret: string,
  baseUrl: string
): Promise<void> {
  if (!issuer || !clientId) {
    _configured = false;
    return;
  }

  try {
    _config = await client.discovery(
      new URL(issuer),
      clientId,
      clientSecret || undefined
    );
    _clientId = clientId;
    _redirectUri = `${baseUrl.replace(/\/$/, "")}/api/auth/oidc/callback`;
    _configured = true;
  } catch (e) {
    console.error("Failed to configure OIDC:", e);
    _configured = false;
  }
}

export function isConfigured(): boolean {
  return _configured;
}

export function getAuthorizationUrl(state: string, nonce: string): string {
  if (!_config) throw new Error("OIDC not configured");

  const params = new URLSearchParams({
    client_id: _clientId,
    redirect_uri: _redirectUri,
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
  expectedNonce?: string
): Promise<{ username: string; email?: string } | null> {
  if (!_config) throw new Error("OIDC not configured");

  try {
    const tokens = await client.authorizationCodeGrant(_config, currentUrl, {
      expectedNonce,
      expectedState: client.skipStateCheck,
    } as Parameters<typeof client.authorizationCodeGrant>[2]);

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
  } catch (e) {
    console.error("OIDC callback error:", e);
    return null;
  }
}
