import { Hono } from "hono";
import type { Context } from "hono";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { and, eq, count as countFn, sql } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { generateSecret, generateURI, verify } from "otplib";
import { getDb } from "../db";
import { users, webauthnCredentials, settings } from "../db/schema";
import { hashPassword, verifyPassword } from "../auth/password";
import { config } from "../config";
import { getEncryptor } from "../security";
import {
  createSession,
  getSession,
  clearSession,
  initSession,
} from "../auth/session";
import * as wa from "../auth/webauthn";
import * as oidc from "../auth/oidc";
import { rateLimit } from "../middleware/rate-limit";
import {
  getKnownPublicOrigin,
  getTrustedPublicOrigin,
  isSecureRequest,
  isTrustedReturnOrigin,
  rememberTrustedPublicOrigin,
} from "../request-security";

// Pre-computed dummy hash for timing-safe login (L1)
const DUMMY_HASH = await hashPassword("timing-safe-dummy-password-pad");
const TOTP_SETUP_COOKIE = "ludash_totp_setup";
const TOTP_EPOCH_TOLERANCE_SECONDS = 30;
const TOTP_SETUP_MAX_AGE_SECONDS = 300;
const TOTP_CODE_PATTERN = /^\d{6}$/;
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_BLOCK_MS = 15 * 60 * 1000;
const PASSWORD_MAX_FAILURES = 10;
const TOTP_MAX_FAILURES = 5;
const MAX_AUTH_FAILURE_BUCKETS = 10_000;
const MAX_CONCURRENT_PASSWORD_VERIFICATIONS = 8;

interface AuthFailureBucket {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
}

const passwordFailureBuckets = new Map<string, AuthFailureBucket>();
const totpFailureBuckets = new Map<string, AuthFailureBucket>();
let activePasswordVerifications = 0;

function getAccountAttemptKey(username: string): string {
  return username.trim().toLowerCase().slice(0, 254);
}

function pruneAuthFailureBuckets(
  buckets: Map<string, AuthFailureBucket>,
  now = Date.now(),
): void {
  for (const [key, bucket] of buckets) {
    if (
      bucket.blockedUntil <= now &&
      now - bucket.firstFailureAt > AUTH_RATE_LIMIT_WINDOW_MS
    ) {
      buckets.delete(key);
    }
  }
  while (buckets.size >= MAX_AUTH_FAILURE_BUCKETS) {
    const oldestUnblocked = Array.from(buckets).find(
      ([, bucket]) => bucket.blockedUntil <= now,
    )?.[0];
    if (!oldestUnblocked) break;
    buckets.delete(oldestUnblocked);
  }
}

function getAuthThrottleRetryAfter(
  buckets: Map<string, AuthFailureBucket>,
  key: string,
  now = Date.now(),
): number | null {
  const bucket = buckets.get(key);
  if (!bucket || bucket.blockedUntil <= now) return null;
  return Math.max(1, Math.ceil((bucket.blockedUntil - now) / 1000));
}

function recordAuthFailure(
  buckets: Map<string, AuthFailureBucket>,
  key: string,
  maxFailures: number,
  now = Date.now(),
): void {
  pruneAuthFailureBuckets(buckets, now);
  const current = buckets.get(key);
  if (!current && buckets.size >= MAX_AUTH_FAILURE_BUCKETS) return;
  const bucket =
    current && now - current.firstFailureAt <= AUTH_RATE_LIMIT_WINDOW_MS
      ? current
      : { failures: 0, firstFailureAt: now, blockedUntil: 0 };
  bucket.failures += 1;
  if (bucket.failures >= maxFailures)
    bucket.blockedUntil = now + AUTH_RATE_LIMIT_BLOCK_MS;
  buckets.set(key, bucket);
}

function clearAuthFailures(
  buckets: Map<string, AuthFailureBucket>,
  key: string,
): void {
  buckets.delete(key);
}

function authThrottleResponse(c: Context, retryAfter: number) {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: "Too many authentication attempts" }, 429);
}

function validatePassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters";
  if (!/[a-z]/.test(password))
    return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password))
    return "Password must contain an uppercase letter";
  if (!/\d/.test(password)) return "Password must contain a digit";
  return null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isBearerTokenRequest(c: Context): boolean {
  return c.req.header("authorization")?.startsWith("Bearer ") === true;
}

function isOidcOnlyAccount(
  user: { authProvider: string; passwordHash: string | null } | null,
): boolean {
  return Boolean(user && user.authProvider === "oidc" && !user.passwordHash);
}

function upsertOidcUser(params: {
  username: string;
  issuer: string;
  subject: string;
}) {
  const db = getDb();
  let user = db
    .select()
    .from(users)
    .where(
      and(
        eq(users.oidcIssuer, params.issuer),
        eq(users.oidcSubject, params.subject),
      ),
    )
    .get();

  // Older versions keyed OIDC users by username only. Claim only passwordless
  // rows so an IdP username can never take over a local account.
  if (!user) {
    const legacy = db
      .select()
      .from(users)
      .where(eq(users.username, params.username))
      .get();
    if (legacy && !legacy.passwordHash && !legacy.oidcSubject) user = legacy;
  }

  const usernameOwner = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, params.username))
    .get();
  const identitySuffix = createHash("sha256")
    .update(`${params.issuer}\n${params.subject}`, "utf8")
    .digest("hex")
    .slice(0, 12);
  const storedUsername =
    !usernameOwner || usernameOwner.id === user?.id
      ? params.username
      : `${params.username.slice(0, 236)}#oidc-${identitySuffix}`;

  if (!user) {
    return db
      .insert(users)
      .values({
        username: storedUsername,
        isAdmin: 0,
        authProvider: "oidc",
        oidcIssuer: params.issuer,
        oidcSubject: params.subject,
      })
      .returning()
      .get();
  }

  db.update(users)
    .set({
      username: storedUsername,
      authProvider: "oidc",
      oidcIssuer: params.issuer,
      oidcSubject: params.subject,
      sessionVersion: user.sessionVersion + 1,
    })
    .where(eq(users.id, user.id))
    .run();
  return db.select().from(users).where(eq(users.id, user.id)).get()!;
}

function normalizeTotpCode(value: string): string {
  return value.replace(/\s+/g, "");
}

function isValidTotpCode(code: string): boolean {
  return TOTP_CODE_PATTERN.test(code);
}

function signShortValue(value: string): string {
  const signature = createHmac("sha256", config.secretKey)
    .update(value)
    .digest("base64url");
  return `${value}.${signature}`;
}

function verifyShortValue(token: string | undefined): string | null {
  if (!token) return null;
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex <= 0) return null;

  const value = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = createHmac("sha256", config.secretKey)
    .update(value)
    .digest("base64url");
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }
  return value;
}

interface TotpSetupState {
  secret: string;
  userId: number;
  sessionVersion: number;
  exp: number;
}

function signTotpSetupState(state: TotpSetupState): string {
  return signShortValue(
    Buffer.from(JSON.stringify(state), "utf8").toString("base64url"),
  );
}

function verifyTotpSetupState(
  token: string | undefined,
): TotpSetupState | null {
  const encoded = verifyShortValue(token);
  if (!encoded) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (
      !parsed ||
      typeof parsed.secret !== "string" ||
      typeof parsed.userId !== "number" ||
      typeof parsed.sessionVersion !== "number" ||
      typeof parsed.exp !== "number" ||
      parsed.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return parsed as TotpSetupState;
  } catch {
    return null;
  }
}

async function verifyTotpCode(
  code: string,
  encryptedSecret: string,
  afterTimeStep?: number | null,
): Promise<number | null> {
  if (!isValidTotpCode(code)) return null;
  const secret = getEncryptor().decrypt(encryptedSecret);
  try {
    const result = await verify({
      token: code,
      secret,
      epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
      afterTimeStep: afterTimeStep ?? undefined,
    });
    return result.valid && "timeStep" in result ? result.timeStep : null;
  } catch {
    return null;
  }
}

function markTotpStepUsed(userId: number, timeStep: number): boolean {
  const result = getDb().run(sql`
    UPDATE users
    SET last_totp_step = ${timeStep}
    WHERE id = ${userId}
      AND (last_totp_step IS NULL OR last_totp_step < ${timeStep})
  `);
  return result.changes > 0;
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
  const result = db.select({ count: countFn() }).from(users).get();
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
    .innerJoin(users, eq(users.id, webauthnCredentials.userId))
    .where(
      sql`(${users.authProvider} != 'oidc' OR ${users.passwordHash} IS NOT NULL)`,
    )
    .get();
  const passkeysEnabled = (passkeyCount?.count ?? 0) > 0;

  let hasPassword = false;
  let totpEnabled = false;
  let passkeysAvailable = false;
  if (session) {
    const user = db
      .select({
        passwordHash: users.passwordHash,
        totpEnabled: users.totpEnabled,
        authProvider: users.authProvider,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .get();
    hasPassword = !!user?.passwordHash;
    totpEnabled = user?.totpEnabled === 1;
    passkeysAvailable = !isOidcOnlyAccount(user ?? null);
  }

  return c.json({
    setupRequired: !hasUsers,
    authenticated: !!session,
    user: session || null,
    oidcEnabled,
    passwordLoginDisabled,
    passkeysEnabled,
    hasPassword,
    totpEnabled,
    passkeysAvailable,
  });
});

// --- Setup ---
auth.post("/setup", rateLimit(3, 60_000), async (c) => {
  const db = getDb();
  const result = db.select({ count: countFn() }).from(users).get();
  if ((result?.count ?? 0) > 0) {
    return c.json({ error: "Setup already completed" }, 400);
  }

  const body = asObject(await c.req.json().catch(() => null));
  if (!body) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (username.length > 128 || password.length > 1024) {
    return c.json({ error: "Username or password is too long" }, 400);
  }
  if (!username.trim() || !password) {
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

  await createSession(c, user.id, username, "password");
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

  const body = asObject(await c.req.json().catch(() => null));
  if (!body) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const totpCode =
    typeof body.totpCode === "string" ? normalizeTotpCode(body.totpCode) : "";
  if (username.length > 254 || password.length > 1024) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
  if (!username.trim() || !password) {
    return c.json({ error: "Username and password required" }, 400);
  }

  const accountAttemptKey = getAccountAttemptKey(username);
  const accountRetryAfter = getAuthThrottleRetryAfter(
    passwordFailureBuckets,
    accountAttemptKey,
  );
  if (accountRetryAfter !== null)
    return authThrottleResponse(c, accountRetryAfter);
  if (activePasswordVerifications >= MAX_CONCURRENT_PASSWORD_VERIFICATIONS) {
    return authThrottleResponse(c, 1);
  }

  const user = db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .get();

  // Always run password verification to prevent timing-based user enumeration
  let valid = false;
  activePasswordVerifications += 1;
  try {
    valid = user?.passwordHash
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, DUMMY_HASH).then(() => false);
  } finally {
    activePasswordVerifications -= 1;
  }

  if (!valid) {
    recordAuthFailure(
      passwordFailureBuckets,
      accountAttemptKey,
      PASSWORD_MAX_FAILURES,
    );
    return c.json({ error: "Invalid credentials" }, 401);
  }
  clearAuthFailures(passwordFailureBuckets, accountAttemptKey);

  if (user!.totpEnabled === 1 && user!.totpSecret) {
    const totpAttemptKey = String(user!.id);
    const totpRetryAfter = getAuthThrottleRetryAfter(
      totpFailureBuckets,
      totpAttemptKey,
    );
    if (totpRetryAfter !== null) return authThrottleResponse(c, totpRetryAfter);
    if (!totpCode) {
      return c.json(
        { error: "Authenticator code required", requiresTotp: true },
        401,
      );
    }
    const timeStep = await verifyTotpCode(
      totpCode,
      user!.totpSecret,
      user!.lastTotpStep,
    );
    if (!timeStep || !markTotpStepUsed(user!.id, timeStep)) {
      recordAuthFailure(totpFailureBuckets, totpAttemptKey, TOTP_MAX_FAILURES);
      return c.json(
        { error: "Invalid authenticator code", requiresTotp: true },
        401,
      );
    }
    clearAuthFailures(totpFailureBuckets, totpAttemptKey);
  }

  await createSession(c, user!.id, user!.username, "password");
  return c.json({
    status: "ok",
    user: { id: user!.id, username: user!.username },
  });
});

// --- Logout ---
auth.post("/logout", async (c) => {
  clearSession(c);
  return c.json({ status: "ok" });
});

// --- TOTP ---
auth.post("/totp/setup", rateLimit(5, 60_000), async (c) => {
  if (isBearerTokenRequest(c)) {
    return c.json(
      { error: "API tokens cannot access management endpoints" },
      403,
    );
  }
  const session = await getSession(c);
  if (!session) return c.json({ error: "Not authenticated" }, 401);
  if (session.authMethod !== "password") {
    return c.json(
      { error: "Log in with your password before setting up TOTP" },
      403,
    );
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
  if (user.totpEnabled === 1) {
    return c.json({ error: "TOTP is already enabled for this account" }, 400);
  }

  const secret = generateSecret();
  const otpauthUrl = generateURI({
    issuer: "Linux Update Dashboard",
    label: user.username,
    secret,
  });

  setCookie(
    c,
    TOTP_SETUP_COOKIE,
    signTotpSetupState({
      secret,
      userId: session.userId,
      sessionVersion: session.sessionVersion ?? 0,
      exp: Math.floor(Date.now() / 1000) + TOTP_SETUP_MAX_AGE_SECONDS,
    }),
    {
      maxAge: TOTP_SETUP_MAX_AGE_SECONDS,
      httpOnly: true,
      sameSite: "Strict",
      secure: isSecureRequest(c),
      path: "/",
    },
  );

  return c.json({ secret, otpauthUrl });
});

auth.post("/totp/enable", rateLimit(5, 60_000), async (c) => {
  if (isBearerTokenRequest(c)) {
    return c.json(
      { error: "API tokens cannot access management endpoints" },
      403,
    );
  }
  const session = await getSession(c);
  if (!session) return c.json({ error: "Not authenticated" }, 401);
  if (session.authMethod !== "password") {
    return c.json(
      { error: "Log in with your password before setting up TOTP" },
      403,
    );
  }

  const body = asObject(await c.req.json().catch(() => null));
  const code =
    typeof body?.code === "string" ? normalizeTotpCode(body.code) : "";
  if (!code) return c.json({ error: "Authenticator code required" }, 400);
  if (!isValidTotpCode(code))
    return c.json({ error: "Invalid authenticator code" }, 400);

  const setupState = verifyTotpSetupState(getCookie(c, TOTP_SETUP_COOKIE));
  if (
    !setupState ||
    setupState.userId !== session.userId ||
    setupState.sessionVersion !== (session.sessionVersion ?? 0)
  ) {
    return c.json({ error: "TOTP setup expired. Start setup again." }, 400);
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
  if (user.totpEnabled === 1) {
    return c.json({ error: "TOTP is already enabled for this account" }, 400);
  }

  const result = await verify({
    token: code,
    secret: setupState.secret,
    epochTolerance: TOTP_EPOCH_TOLERANCE_SECONDS,
  }).catch(() => ({ valid: false }));
  if (!result.valid) {
    return c.json({ error: "Invalid authenticator code" }, 400);
  }

  db.update(users)
    .set({
      totpSecret: getEncryptor().encrypt(setupState.secret),
      totpEnabled: 1,
      lastTotpStep: null,
      sessionVersion: user.sessionVersion + 1,
    })
    .where(eq(users.id, session.userId))
    .run();
  deleteCookie(c, TOTP_SETUP_COOKIE, { path: "/" });
  await createSession(c, user.id, user.username, "password");

  return c.json({ status: "ok", totpEnabled: true });
});

auth.delete("/totp", rateLimit(5, 60_000), async (c) => {
  if (isBearerTokenRequest(c)) {
    return c.json(
      { error: "API tokens cannot access management endpoints" },
      403,
    );
  }
  const session = await getSession(c);
  if (!session) return c.json({ error: "Not authenticated" }, 401);
  if (session.authMethod !== "password") {
    return c.json(
      { error: "Log in with your password before disabling TOTP" },
      403,
    );
  }

  const body = asObject(await c.req.json().catch(() => null));
  const currentPassword =
    typeof body?.currentPassword === "string" ? body.currentPassword : "";
  if (!currentPassword) {
    return c.json({ error: "Current password required" }, 400);
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
  if (user.totpEnabled !== 1 || !user.totpSecret) {
    return c.json({ error: "TOTP is not enabled for this account" }, 400);
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return c.json({ error: "Current password is incorrect" }, 401);
  }

  db.update(users)
    .set({
      totpSecret: null,
      totpEnabled: 0,
      lastTotpStep: null,
      sessionVersion: user.sessionVersion + 1,
    })
    .where(eq(users.id, session.userId))
    .run();
  await createSession(c, user.id, user.username, "password");

  return c.json({ status: "ok", totpEnabled: false });
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

  const body = asObject(await c.req.json().catch(() => null));
  if (!body) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const currentPassword =
    typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword =
    typeof body.newPassword === "string" ? body.newPassword : "";
  if (currentPassword.length > 1024 || newPassword.length > 1024) {
    return c.json({ error: "Password is too long" }, 400);
  }
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
    .set({ passwordHash: newHash, sessionVersion: user.sessionVersion + 1 })
    .where(eq(users.id, session.userId))
    .run();

  await createSession(c, user.id, user.username, "password");

  return c.json({ status: "ok" });
});

// --- WebAuthn Registration ---
auth.post("/webauthn/register/options", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Not authenticated" }, 401);

  const db = getDb();
  const account = db
    .select({
      authProvider: users.authProvider,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .get();
  if (isOidcOnlyAccount(account ?? null)) {
    return c.json(
      { error: "Passkeys cannot be registered for OIDC-only accounts" },
      403,
    );
  }
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
    rpId,
  );

  setCookie(c, "webauthn_challenge", options.challenge, {
    httpOnly: true,
    sameSite: "Strict",
    secure: isSecureRequest(c),
    maxAge: 300,
    path: "/",
  });

  return c.json(options);
});

auth.post("/webauthn/register/verify", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "Not authenticated" }, 401);

  const account = getDb()
    .select({
      authProvider: users.authProvider,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .get();
  if (isOidcOnlyAccount(account ?? null)) {
    return c.json(
      { error: "Passkeys cannot be registered for OIDC-only accounts" },
      403,
    );
  }

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
      rpId,
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
  const body = asObject(await c.req.json().catch(() => null)) ?? {};
  const username = typeof body.username === "string" ? body.username : "";

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
    secure: isSecureRequest(c),
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
  if (isOidcOnlyAccount(user)) {
    return c.json(
      {
        error:
          "This passkey belongs to an OIDC-only account. Sign in with SSO instead.",
      },
      403,
    );
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
      },
    );

    if (!verification.verified) {
      return c.json({ error: "Verification failed" }, 400);
    }

    db.update(webauthnCredentials)
      .set({ signCount: verification.authenticationInfo.newCounter })
      .where(eq(webauthnCredentials.id, credRow.id))
      .run();

    await createSession(c, user.id, user.username, "passkey");
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
  rememberTrustedPublicOrigin(publicOrigin);
  const redirectUri = `${publicOrigin}/api/auth/oidc/callback`;

  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const url = oidc.getAuthorizationUrl(state, nonce, redirectUri);

  // Capture the frontend origin so we can redirect back after callback.
  // In dev, the login request comes through Vite's proxy (port 5173),
  // but the callback hits the backend (port 3001) directly from the IdP.
  const referer = c.req.header("referer");
  let returnOrigin = publicOrigin;
  if (referer) {
    try {
      const parsed = new URL(referer).origin;
      if (isTrustedReturnOrigin(parsed)) {
        returnOrigin = parsed;
      }
    } catch {
      returnOrigin = publicOrigin;
    }
  }

  setCookie(c, "oidc_state", state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    maxAge: 300,
    path: "/",
  });
  setCookie(c, "oidc_nonce", nonce, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    maxAge: 300,
    path: "/",
  });
  setCookie(c, "oidc_redirect_uri", redirectUri, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c),
    maxAge: 300,
    path: "/",
  });
  if (returnOrigin) {
    setCookie(c, "oidc_return_origin", returnOrigin, {
      httpOnly: true,
      sameSite: "Lax",
      secure: isSecureRequest(c),
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
  const storedRedirectUri = getCookie(c, "oidc_redirect_uri");

  try {
    const internalUrl = new URL(c.req.url);
    let callbackUrl: URL | null = null;

    // Prefer the exact redirect_uri we used during login so callback handling
    // is resilient across proxies that rewrite or omit referer/origin headers.
    if (storedRedirectUri) {
      try {
        const stored = new URL(storedRedirectUri);
        if (stored.pathname === internalUrl.pathname) {
          callbackUrl = new URL(stored.toString());
          callbackUrl.search = internalUrl.search;
        }
      } catch {
        callbackUrl = null;
      }
    }

    if (!callbackUrl) {
      // Fallback: prefer the last trusted public origin we observed so proxy
      // offload still resolves to the external URL when callback headers are thin.
      const publicOrigin = getKnownPublicOrigin();
      callbackUrl = new URL(
        `${publicOrigin}${internalUrl.pathname}${internalUrl.search}`,
      );
    }

    const result = await oidc.handleCallback(callbackUrl, nonce, state);
    if (!result) {
      return c.json({ error: "OIDC authentication failed" }, 400);
    }

    const user = upsertOidcUser(result);

    await createSession(c, user.id, user.username, "oidc");
    deleteCookie(c, "oidc_state", { path: "/" });
    deleteCookie(c, "oidc_nonce", { path: "/" });
    deleteCookie(c, "oidc_redirect_uri", { path: "/" });

    const returnOrigin = getCookie(c, "oidc_return_origin");
    deleteCookie(c, "oidc_return_origin", { path: "/" });

    // Redirect to SPA dashboard (use stored origin for dev where SPA is on a different port)
    const targetOrigin =
      returnOrigin && isTrustedReturnOrigin(returnOrigin)
        ? returnOrigin
        : getKnownPublicOrigin();
    return c.redirect(`${targetOrigin}/dashboard`);
  } catch (e) {
    console.error("OIDC callback error:", e);
    return c.json({ error: "OIDC authentication failed" }, 400);
  }
});

export default auth;
