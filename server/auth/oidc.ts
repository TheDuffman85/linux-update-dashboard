import * as client from "openid-client";

let _config: client.Configuration | null = null;
let _configured = false;
let _clientId = "";

export async function configureOidc(
  issuer: string,
  clientId: string,
  clientSecret: string,
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
    _configured = true;
  } catch (e) {
    console.error("Failed to configure OIDC:", e);
    _configured = false;
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
  } catch (e) {
    console.error("OIDC callback error:", e);
    return null;
  }
}
