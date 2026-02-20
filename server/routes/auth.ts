import { Hono } from "hono";
import { eq, count as countFn } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { getDb } from "../db";
import { users, webauthnCredentials } from "../db/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  createSession,
  getSession,
  clearSession,
  initSession,
} from "../auth/session";
import * as wa from "../auth/webauthn";
import * as oidc from "../auth/oidc";
import { config } from "../config";

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

  return c.json({
    setupRequired: !hasUsers,
    authenticated: !!session,
    user: session || null,
    oidcEnabled,
  });
});

// --- Setup ---
auth.post("/setup", async (c) => {
  const db = getDb();
  const result = db.select({ count: countFn() }).from(users).get();
  if ((result?.count ?? 0) > 0) {
    return c.json({ error: "Setup already completed" }, 400);
  }

  const { username, password } = await c.req.json();
  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
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
auth.post("/login", async (c) => {
  const { username, password } = await c.req.json();
  if (!username || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const db = getDb();
  const user = db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();

  if (!user?.passwordHash) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return c.json({ error: "Invalid credentials" }, 401);
  }

  await createSession(c, user.id, user.username);
  return c.json({ status: "ok", user: { id: user.id, username: user.username } });
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

  const options = await wa.getRegistrationOptions(
    session.userId,
    session.username,
    existing
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
    const verification = await wa.verifyRegistration(
      body,
      challenge,
      config.baseUrl
    );

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "Verification failed" }, 400);
    }

    const { credential } = verification.registrationInfo;
    const db = getDb();
    db.insert(webauthnCredentials)
      .values({
        userId: session.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        signCount: credential.counter,
        transports: JSON.stringify(body.response?.transports || []),
      })
      .run();

    deleteCookie(c, "webauthn_challenge", { path: "/" });
    return c.json({ status: "ok" });
  } catch (e) {
    return c.json({ error: String(e) }, 400);
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

  const options = await wa.getAuthenticationOptions(credentials);

  setCookie(c, "webauthn_challenge", options.challenge, {
    httpOnly: true,
    sameSite: "Strict",
    maxAge: 300,
    path: "/",
  });

  return c.json(options);
});

auth.post("/webauthn/login/verify", async (c) => {
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
    const verification = await wa.verifyAuthentication(
      body,
      challenge,
      config.baseUrl,
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
    return c.json({ error: String(e) }, 400);
  }
});

// --- OIDC ---
auth.get("/oidc/login", async (c) => {
  if (!oidc.isConfigured()) {
    return c.json({ error: "OIDC not configured" }, 400);
  }

  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const url = oidc.getAuthorizationUrl(state, nonce);

  setCookie(c, "oidc_state", state, {
    httpOnly: true,
    sameSite: "Lax",
    maxAge: 300,
    path: "/",
  });

  return c.redirect(url);
});

auth.get("/oidc/callback", async (c) => {
  if (!oidc.isConfigured()) {
    return c.json({ error: "OIDC not configured" }, 400);
  }

  try {
    const result = await oidc.handleCallback(new URL(c.req.url));
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

    // Redirect to SPA dashboard
    return c.redirect("/dashboard");
  } catch (e) {
    console.error("OIDC callback error:", e);
    return c.json({ error: "OIDC authentication failed" }, 400);
  }
});

export default auth;
