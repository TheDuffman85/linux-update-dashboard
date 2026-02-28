import { Hono } from "hono";
import type { Context } from "hono";
import { eq, count as countFn } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getDb } from "../db";
import { users, webauthnCredentials, settings } from "../db/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  createSession,
  getSession,
  clearSession,
  initSession,
} from "../auth/session";
import * as wa from "../auth/webauthn";
import * as oidc from "../auth/oidc";
import { rateLimit } from "../middleware/rate-limit";
import { getTrustedPublicOrigin, isTrustedReturnOrigin } from "../request-security";

// Pre-computed dummy hash for timing-safe login (L1)
const DUMMY_HASH = await hashPassword("timing-safe-dummy-password-pad");

function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/\d/.test(password)) return "Password must contain a digit";
  return null;
}

/** Derive WebAuthn origin and rpId from the incoming request headers. */
function getWebAuthnParams(c: Context): { origin: string; rpId: string } {
  const origin = getTrustedPublicOrigin(c);
  return { origin, rpId: new URL(origin).hostname };
}

const auth = new Hono();

// --- Status ---
auth.get("/status", async (c) => {
  const db = getDb();
  const result = db
    .select({ count: countFn() })
    .from(users)
    .get();
  const hasUsers = (result?.count ?? 0) > 0;

  const session = await getSession(c);
  const oidcEnabled = oidc.isConfigured();

  const pwSetting = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "disable_password_login"))
    .get();
  const passwordLoginDisabled = pwSetting?.value === "true";

  const passkeyCount = db
    .select({ count: countFn() })
    .from(webauthnCredentials)
    .get();
  const passkeysEnabled = (passkeyCount?.count ?? 0) > 0;

  let hasPassword = false;
  if (session) {
    const user = db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.userId))
      .get();
    hasPassword = !!user?.passwordHash;
  }

  return c.json({
    setupRequired: !hasUsers,
    authenticated: !!session,
    user: session || null,
    oidcEnabled,
    passwordLoginDisabled,
    passkeysEnabled,
    hasPassword,
  });
});

// --- Setup ---
auth.post("/setup", rateLimit(3, 60_000), async (c) => {
  const db = getDb();
  const result = db.select({ count: countFn() }).from(users).get();
  if ((result?.count ?? 0) > 0) {
    return c.json({ error: "Setup already completed" }, 400);
  }

  const { username, password } = await c.req.json();
  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }
  const pwError = validatePassword(password);
  if (pwError) {
    return c.json({ error: pwError }, 400);
  }

  const pwHash = await hashPassword(password);
  const user = db
    .insert(users)
    .values({ username, passwordHash: pwHash, isAdmin: 1 })
    .returning({ id: users.id })
    .get();

  await createSession(c, user.id, username);
  return c.json({ status: "ok", userId: user.id });
});

// --- Login ---
auth.post("/login", rateLimit(5, 60_000), async (c) => {
  const db = getDb();
  const pwSetting = db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "disable_password_login"))
    .get();
  if (pwSetting?.value === "true") {
    return c.json({ error: "Password login is disabled" }, 403);
  }

  const { username, password } = await c.req.json();
  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();

  // Always run password verification to prevent timing-based user enumeration
  const valid = user?.passwordHash
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, DUMMY_HASH).then(() => false);

  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  await createSession(c, user!.id, user!.username);
  return c.json({ status: "ok", user: { id: user!.id, username: user!.username } });
});

// --- Logout ---
auth.post("/logout", async (c) => {
  clearSession(c);
  return c.json({ status: "ok" });
});

// --- Current user ---
auth.get("/me", async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }
  return c.json({ user: session });
});

// --- Change Password ---
auth.post("/change-password", rateLimit(5, 60_000), async (c) => {
  const session = await getSession(c);
  if (!session) {
    return c.json({ error: "Not authenticated" }, 401);
  }

  const { currentPassword, newPassword } = await c.req.json();
  if (!currentPassword || !newPassword) {
    return c.json({ error: "Current and new password required" }, 400);
  }

  const db = getDb();
  const user = db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .get();

  if (!user?.passwordHash) {
    return c.json({ error: "No password set for this account" }, 400);
  }

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  const pwError = validatePassword(newPassword);
  if (pwError) {
    return c.json({ error: pwError }, 400);
  }

  const newHash = await hashPassword(newPassword);
  db.update(users)
    .set({ passwordHash: newHash })
    .where(eq(users.id, session.userId))
    .run();

  return c.json({ status: "ok" });
});

// --- WebAuthn Registration ---
auth.post("/webauthn/register/options", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Not authenticated" }, 401);

  const db = getDb();
  const existing = db
    .select({ credentialId: webauthnCredentials.credentialId })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, session.userId))
    .all();

  const { rpId } = getWebAuthnParams(c);
  const options = await wa.getRegistrationOptions(
    session.userId,
    session.username,
    existing,
    rpId
  );

  setCookie(c, "webauthn_challenge", options.challenge, {
    httpOnly: true,
    sameSite: "Strict",
    maxAge: 300,
    path: "/",
  });

  return c.json(options);
});

auth.post("/webauthn/register/verify", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Not authenticated" }, 401);

  const body = await c.req.json();
  const challenge = getCookie(c, "webauthn_challenge");
  if (!challenge) {
    return c.json({ error: "No registration challenge found" }, 400);
  }

  try {
    const { origin, rpId } = getWebAuthnParams(c);
    const verification = await wa.verifyRegistration(
      body,
      challenge,
      origin,
      rpId
    );

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "Verification failed" }, 400);
    }

    const { credential } = verification.registrationInfo;
    const passkeyName =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 50)
        : null;
    const db = getDb();
    db.insert(webauthnCredentials)
      .values({
        userId: session.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        signCount: credential.counter,
        transports: JSON.stringify(body.response?.transports || []),
        name: passkeyName,
      })
      .run();

    deleteCookie(c, "webauthn_challenge", { path: "/" });
    return c.json({ status: "ok" });
  } catch (e) {
    console.error("WebAuthn registration error:", e);
    return c.json({ error: "Verification failed" }, 400);
  }
});

// --- WebAuthn Authentication ---
auth.post("/webauthn/login/options", async (c) => {
  const { username } = await c.req.json();

  let credentials: Array<{ credentialId: string }> = [];
  if (username) {
    const db = getDb();
    const user = db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();
    if (user) {
      credentials = db
        .select({ credentialId: webauthnCredentials.credentialId })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, user.id))
        .all();
    }
  }

  const { rpId } = getWebAuthnParams(c);
  const options = await wa.getAuthenticationOptions(credentials, rpId);

  setCookie(c, "webauthn_challenge", options.challenge, {
    httpOnly: true,
    sameSite: "Strict",
    maxAge: 300,
    path: "/",
  });

  return c.json(options);
});

auth.post("/webauthn/login/verify", rateLimit(5, 60_000), async (c) => {
  const body = await c.req.json();
  const challenge = getCookie(c, "webauthn_challenge");
  if (!challenge) {
    return c.json({ error: "No authentication challenge found" }, 400);
  }

  const credIdFromClient = body.id;
  const db = getDb();

  const credRow = db
    .select({
      id: webauthnCredentials.id,
      userId: webauthnCredentials.userId,
      credentialId: webauthnCredentials.credentialId,
      publicKey: webauthnCredentials.publicKey,
      signCount: webauthnCredentials.signCount,
    })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.credentialId, credIdFromClient))
    .get();

  if (!credRow) {
    return c.json({ error: "Credential not found" }, 400);
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.id, credRow.userId))
    .get();
  if (!user) {
    return c.json({ error: "User not found" }, 400);
  }

  try {
    const { origin, rpId } = getWebAuthnParams(c);
    const verification = await wa.verifyAuthentication(
      body,
      challenge,
      origin,
      rpId,
      {
        credentialId: credRow.credentialId,
        publicKey: credRow.publicKey,
        signCount: credRow.signCount,
      }
    );

    if (!verification.verified) {
      return c.json({ error: "Verification failed" }, 400);
    }

    db.update(webauthnCredentials)
      .set({ signCount: verification.authenticationInfo.newCounter })
      .where(eq(webauthnCredentials.id, credRow.id))
      .run();

    await createSession(c, user.id, user.username);
    deleteCookie(c, "webauthn_challenge", { path: "/" });
    return c.json({
      status: "ok",
      user: { id: user.id, username: user.username },
    });
  } catch (e) {
    console.error("WebAuthn authentication error:", e);
    return c.json({ error: "Verification failed" }, 400);
  }
});

// --- OIDC ---
auth.get("/oidc/login", async (c) => {
  if (!oidc.isConfigured()) {
    return c.json({ error: "OIDC not configured" }, 400);
  }

  const publicOrigin = getTrustedPublicOrigin(c);
  const redirectUri = `${publicOrigin}/api/auth/oidc/callback`;

  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const url = oidc.getAuthorizationUrl(state, nonce, redirectUri);

  // Capture the frontend origin so we can redirect back after callback.
  // In dev, the login request comes through Vite's proxy (port 5173),
  // but the callback hits the backend (port 3001) directly from the IdP.
  const referer = c.req.header("referer");
  let returnOrigin = "";
  if (referer) {
    try {
      returnOrigin = new URL(referer).origin;
    } catch {
      returnOrigin = "";
    }
  }

  setCookie(c, "oidc_state", state, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 300,
    path: "/",
  });
  setCookie(c, "oidc_nonce", nonce, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 300,
    path: "/",
  });
  if (returnOrigin && isTrustedReturnOrigin(returnOrigin)) {
    setCookie(c, "oidc_return_origin", returnOrigin, {
      httpOnly: true,
      sameSite: "Lax",
      maxAge: 300,
      path: "/",
    });
  }

  return c.redirect(url);
});

auth.get("/oidc/callback", async (c) => {
  if (!oidc.isConfigured()) {
    return c.json({ error: "OIDC not configured" }, 400);
  }

  const nonce = getCookie(c, "oidc_nonce");
  const state = getCookie(c, "oidc_state");

  try {
    // Reconstruct callback URL with the public-facing origin so it matches
    // the redirect_uri that was sent to the IdP during authorization.
    const publicOrigin = getTrustedPublicOrigin(c);
    const internalUrl = new URL(c.req.url);
    const callbackUrl = new URL(`${publicOrigin}${internalUrl.pathname}${internalUrl.search}`);

    const result = await oidc.handleCallback(callbackUrl, nonce, state);
    if (!result) {
      return c.json({ error: "OIDC authentication failed" }, 400);
    }

    const db = getDb();
    let user = db
      .select()
      .from(users)
      .where(eq(users.username, result.username))
      .get();

    if (!user) {
      const inserted = db
        .insert(users)
        .values({ username: result.username, isAdmin: 0 })
        .returning()
        .get();
      user = inserted;
    }

    await createSession(c, user.id, user.username);
    deleteCookie(c, "oidc_state", { path: "/" });
    deleteCookie(c, "oidc_nonce", { path: "/" });

    const returnOrigin = getCookie(c, "oidc_return_origin");
    deleteCookie(c, "oidc_return_origin", { path: "/" });

    // Redirect to SPA dashboard (use stored origin for dev where SPA is on a different port)
    return c.redirect(returnOrigin ? `${returnOrigin}/dashboard` : "/dashboard");
  } catch (e) {
    console.error("OIDC callback error:", e);
    return c.json({ error: "OIDC authentication failed" }, 400);
  }
});

export default auth;
