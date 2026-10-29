import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes, randomUUID } from "crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings, users } from "../../server/db/schema";
import { initSession } from "../../server/auth/session";
import { resetAuthConfig } from "../../server/auth/auth-config";
import { initEncryptor } from "../../server/security";
import { csrfMiddleware } from "../../server/middleware/csrf";
import {
  SESSION_ENDED_CLOSE_CODE,
  trackSessionSocket,
  untrackSessionSocket,
} from "../../server/services/session-sockets";
import type { WSContext } from "hono/ws";

const ISSUER = "https://idp.example.com";
const JWKS_URI = `${ISSUER}/jwks`;
const CLIENT_ID = "ludash";
const CLIENT_SECRET = "backchannel-client-secret-with-enough-length";
const SESSION_SECRET = "oidc-backchannel-test-secret";
const BACKCHANNEL_EVENT = "http://schemas.openid.net/event/backchannel-logout";

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(
      async (_issuer: URL, clientId: string, clientSecret?: string) =>
        new actual.Configuration(
          { issuer: ISSUER, jwks_uri: JWKS_URI },
          clientId,
          clientSecret,
        ),
    ),
  };
});

const { configureOidc } = await import("../../server/auth/oidc");
const { default: authRoutes } = await import("../../server/routes/auth");

const incoming = {
  socket: { remoteAddress: "127.0.0.1", remotePort: 12345, remoteFamily: "IPv4" },
};

function writeSetting(key: string, value: string) {
  getDb().update(settings).set({ value }).where(eq(settings.key, key)).run();
}

async function sessionCookie(
  userId: number,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const user = getDb().select().from(users).where(eq(users.id, userId)).get()!;
  const token = await new SignJWT({
    userId,
    username: user.username,
    authMethod: "oidc",
    sessionVersion: user.sessionVersion,
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SESSION_SECRET));
  return `ludash_session=${token}`;
}

function logoutToken(
  claims: Record<string, unknown>,
  options: { secret?: string } = {},
): Promise<string> {
  return new SignJWT({
    events: { [BACKCHANNEL_EVENT]: {} },
    jti: randomUUID(),
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .sign(new TextEncoder().encode(options.secret ?? CLIENT_SECRET));
}

describe("OIDC back-channel logout", () => {
  let tempDir: string;
  let app: Hono;
  let aliceId: number;
  let bobId: number;

  beforeEach(async () => {
    resetAuthConfig();
    tempDir = mkdtempSync(join(tmpdir(), "ludash-oidc-backchannel-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initSession(SESSION_SECRET);
    initDatabase(join(tempDir, "dashboard.db"));
    const db = getDb();
    aliceId = db
      .insert(users)
      .values({ username: "alice", authProvider: "oidc", oidcIssuer: ISSUER, oidcSubject: "alice-sub" })
      .returning()
      .get().id;
    bobId = db
      .insert(users)
      .values({ username: "bob", authProvider: "oidc", oidcIssuer: ISSUER, oidcSubject: "bob-sub" })
      .returning()
      .get().id;
    writeSetting("oidc_backchannel_logout", "true");
    await configureOidc(ISSUER, CLIENT_ID, CLIENT_SECRET);

    app = new Hono();
    app.use("/api/*", csrfMiddleware);
    app.route("/api/auth", authRoutes);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await configureOidc("", "", "");
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const postLogout = (token: string) =>
    app.request(
      "/api/auth/oidc/backchannel-logout",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ logout_token: token }).toString(),
      },
      { incoming },
    );

  const isAuthenticated = async (cookie: string) => {
    const res = await app.request("/api/auth/status", { headers: { cookie } }, { incoming });
    return ((await res.json()) as { authenticated: boolean }).authenticated;
  };

  test("is rejected while the setting is off", async () => {
    writeSetting("oidc_backchannel_logout", "false");
    const res = await postLogout(await logoutToken({ sub: "alice-sub" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  test("needs no CSRF token and acknowledges a valid token with 200", async () => {
    const res = await postLogout(await logoutToken({ sub: "alice-sub" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("sid ends only the sessions from that provider sign-in", async () => {
    const ended = await sessionCookie(aliceId, { sid: "sid-1" });
    const other = await sessionCookie(aliceId, { sid: "sid-2" });
    expect(await isAuthenticated(ended)).toBe(true);

    expect((await postLogout(await logoutToken({ sid: "sid-1" }))).status).toBe(200);

    expect(await isAuthenticated(ended)).toBe(false);
    expect(await isAuthenticated(other)).toBe(true);
  });

  test("sid with sub also ends the user's sessions without a stored sid", async () => {
    const legacy = await sessionCookie(aliceId);
    const otherSid = await sessionCookie(aliceId, { sid: "sid-2" });
    const bob = await sessionCookie(bobId);

    const res = await postLogout(await logoutToken({ sid: "sid-1", sub: "alice-sub" }));
    expect(res.status).toBe(200);

    expect(await isAuthenticated(legacy)).toBe(false);
    expect(await isAuthenticated(otherSid)).toBe(true);
    expect(await isAuthenticated(bob)).toBe(true);
    // Sessions created afterwards are bound to the new logout version.
    expect(await isAuthenticated(await sessionCookie(aliceId, { oidcLogoutVersion: 2 }))).toBe(true);
  });

  test("sub alone ends all sessions of the user", async () => {
    const withSid = await sessionCookie(aliceId, { sid: "sid-1" });
    const withoutSid = await sessionCookie(aliceId);
    const bob = await sessionCookie(bobId, { sid: "bob-sid" });

    expect((await postLogout(await logoutToken({ sub: "alice-sub" }))).status).toBe(200);

    expect(await isAuthenticated(withSid)).toBe(false);
    expect(await isAuthenticated(withoutSid)).toBe(false);
    expect(await isAuthenticated(bob)).toBe(true);
  });

  test("closes open output streams of the ended sessions", async () => {
    const socket = (cookie: string) => {
      const ws = { close: vi.fn() } as unknown as WSContext & { close: ReturnType<typeof vi.fn> };
      trackSessionSocket(ws, cookie.slice("ludash_session=".length));
      return ws;
    };
    const ended = socket(await sessionCookie(aliceId, { sid: "sid-1" }));
    const otherSid = socket(await sessionCookie(aliceId, { sid: "sid-2" }));
    const bob = socket(await sessionCookie(bobId));

    try {
      expect((await postLogout(await logoutToken({ sid: "sid-1" }))).status).toBe(200);

      expect(ended.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
      expect(otherSid.close).not.toHaveBeenCalled();
      expect(bob.close).not.toHaveBeenCalled();

      // Later logouts do not touch a socket that was already closed.
      expect((await postLogout(await logoutToken({ sub: "alice-sub" }))).status).toBe(200);
      expect(ended.close).toHaveBeenCalledTimes(1);
      expect(otherSid.close).toHaveBeenCalledTimes(1);
      expect(bob.close).not.toHaveBeenCalled();
    } finally {
      for (const ws of [ended, otherSid, bob]) untrackSessionSocket(ws);
    }
  });

  test("a repeated notification does not end later sign-ins", async () => {
    const token = await logoutToken({ sub: "alice-sub" });
    expect((await postLogout(token)).status).toBe(200);

    const later = await sessionCookie(aliceId);
    expect((await postLogout(token)).status).toBe(200);
    expect(await isAuthenticated(later)).toBe(true);
  });

  test.each([
    ["a wrong signature", () => logoutToken({ sub: "alice-sub" }, { secret: "x".repeat(48) })],
    ["no sub or sid", () => logoutToken({})],
    ["a nonce", () => logoutToken({ sub: "alice-sub", nonce: "n" })],
    ["no logout event", () => logoutToken({ sub: "alice-sub", events: {} })],
    [
      "another audience",
      () =>
        new SignJWT({ events: { [BACKCHANNEL_EVENT]: {} }, jti: randomUUID(), sub: "alice-sub" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer(ISSUER)
          .setAudience("someone-else")
          .setIssuedAt()
          .sign(new TextEncoder().encode(CLIENT_SECRET)),
    ],
    [
      "an old issue time",
      () =>
        new SignJWT({ events: { [BACKCHANNEL_EVENT]: {} }, jti: randomUUID(), sub: "alice-sub" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer(ISSUER)
          .setAudience(CLIENT_ID)
          .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
          .sign(new TextEncoder().encode(CLIENT_SECRET)),
    ],
  ])("rejects a token with %s", async (_label, makeToken) => {
    const session = await sessionCookie(aliceId);
    const res = await postLogout(await makeToken());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(await isAuthenticated(session)).toBe(true);
  });

  test("rejects a request without logout_token", async () => {
    const res = await app.request(
      "/api/auth/oidc/backchannel-logout",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      },
      { incoming },
    );
    expect(res.status).toBe(400);
  });

  test("verifies asymmetric tokens with the provider's JWKS", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = await sessionCookie(aliceId, { sid: "sid-rs" });
    const token = await new SignJWT({
      events: { [BACKCHANNEL_EVENT]: {} },
      jti: randomUUID(),
      sid: "sid-rs",
    })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .sign(privateKey);

    expect((await postLogout(token)).status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(await isAuthenticated(session)).toBe(false);
  });
});

describe("OIDC auto-login status", () => {
  let tempDir: string;

  beforeEach(async () => {
    resetAuthConfig();
    tempDir = mkdtempSync(join(tmpdir(), "ludash-oidc-auto-login-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initSession(SESSION_SECRET);
    initDatabase(join(tempDir, "dashboard.db"));
    writeSetting("oidc_issuer", ISSUER);
    writeSetting("oidc_client_id", CLIENT_ID);
    await configureOidc(ISSUER, CLIENT_ID, CLIENT_SECRET);
  });

  afterEach(async () => {
    await configureOidc("", "", "");
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const status = async () => {
    const app = new Hono();
    app.route("/api/auth", authRoutes);
    const res = await app.request("/api/auth/status", {}, { incoming });
    return (await res.json()) as { oidcAutoLogin: boolean };
  };

  test("is only reported while SSO is the only sign-in method", async () => {
    expect((await status()).oidcAutoLogin).toBe(false);

    writeSetting("oidc_auto_login", "true");
    expect((await status()).oidcAutoLogin).toBe(false);

    writeSetting("disable_password_login", "true");
    expect((await status()).oidcAutoLogin).toBe(true);

    await configureOidc("", "", "");
    expect((await status()).oidcAutoLogin).toBe(false);
  });
});
