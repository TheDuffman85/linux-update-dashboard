import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { generate, generateSecret } from "otplib";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, settings, users } from "../../server/db/schema";
import { authMiddleware } from "../../server/middleware/auth";
import { createSession, initSession } from "../../server/auth/session";
import { hashPassword } from "../../server/auth/password";
import { hashToken, validateToken } from "../../server/auth/api-token";
import { applyOidcLogout } from "../../server/auth/oidc-logout";
import { resetAuthConfig } from "../../server/auth/auth-config";
import { getEncryptor, initEncryptor } from "../../server/security";
import { countActiveAdmins } from "../../server/services/user-service";

const { handleCallback, configuredIssuer } = vi.hoisted(() => ({
  handleCallback: vi.fn(),
  configuredIssuer: { current: null as string | null },
}));

vi.mock("../../server/auth/oidc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/auth/oidc")>()),
  isConfigured: () => true,
  getConfiguredIssuer: () => configuredIssuer.current,
  getAuthorizationUrl: (state: string, _nonce: string, _uri: string, _scope: string, prompt?: string) =>
    `https://idp.example.com/authorize?state=${state}&prompt=${prompt ?? ""}`,
  handleCallback,
}));

const { default: authRoutes } = await import("../../server/routes/auth");
const { default: usersRoutes } = await import("../../server/routes/users");
const { default: tokensRoutes } = await import("../../server/routes/api-tokens");
const { default: passkeysRoutes } = await import("../../server/routes/passkeys");

const ISSUER = "https://idp.example.com";
const PASSWORD = "Password1";
let ipCounter = 0;

function incoming() {
  ipCounter += 1;
  return {
    socket: {
      remoteAddress: `198.51.100.${ipCounter % 250}`,
      remoteFamily: "IPv4",
      remotePort: 12345,
    },
  };
}

/** A browser: keeps the cookies the server sets, as a real one would. */
class Browser {
  cookies = new Map<string, string>();

  constructor(private app: () => Hono) {}

  async request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await this.app().request(
      path,
      {
        method: init.method ?? "GET",
        headers: {
          cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      { incoming: incoming() },
    );
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (!value || attributes.some((a) => a.trim().toLowerCase() === "max-age=0")) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    return res;
  }
}

function setSetting(key: string, value: string) {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

function getUser(id: number) {
  return getDb().select().from(users).where(eq(users.id, id)).get()!;
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    username: "alice",
    preferredUsername: "alice",
    role: "admin",
    issuer: ISSUER,
    subject: "alice-sub",
    ...overrides,
  };
}

describe("linking local and SSO sign-in", () => {
  let tempDir: string;
  let app: Hono;
  let passwordHash: string;
  let adminId: number;

  function browser() {
    return new Browser(() => app);
  }

  async function signedIn(userId: number, authMethod: "password" | "passkey" | "oidc" = "password") {
    const user = getUser(userId);
    const b = browser();
    const probe = new Hono();
    probe.get("/", async (c) => {
      await createSession(c, user.id, user.username, authMethod);
      return c.text("ok");
    });
    const res = await probe.request("/", {}, { incoming: incoming() });
    const token = /ludash_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1];
    b.cookies.set("ludash_session", token);
    return b;
  }

  async function ssoSignIn(b: Browser, result: Record<string, unknown>) {
    handleCallback.mockResolvedValue(result);
    return b.request("/api/auth/oidc/callback?code=x&state=y");
  }

  /** Takes a local session through the provider, up to the confirmation step. */
  async function reachConfirmation(b: Browser, result: Record<string, unknown> = identity()) {
    const start = await b.request("/api/auth/oidc/link/start", { method: "POST" });
    expect(start.status).toBe(200);
    const res = await ssoSignIn(b, result);
    expect(res.status).toBe(302);
    return res.headers.get("location")!;
  }

  async function link(b: Browser, result: Record<string, unknown> = identity()) {
    expect(await reachConfirmation(b, result)).toContain("oidcLink=confirm");
    const res = await b.request("/api/auth/oidc/link/confirm", {
      method: "POST",
      body: { password: PASSWORD },
    });
    expect(res.status).toBe(200);
  }

  async function linkedAdmin(result: Record<string, unknown> = identity()) {
    const b = await signedIn(adminId);
    await link(b, result);
    return b;
  }

  async function addToken(userId: number, token: string, values: Partial<typeof apiTokens.$inferInsert> = {}) {
    getDb()
      .insert(apiTokens)
      .values({ userId, tokenHash: await hashToken(token), readOnly: 0, ...values })
      .run();
  }

  async function me(b: Browser) {
    const res = await b.request("/api/auth/me");
    return res.status === 200 ? ((await res.json()) as { user: Record<string, unknown> }).user : null;
  }

  beforeEach(async () => {
    resetAuthConfig();
    tempDir = mkdtempSync(join(tmpdir(), "ludash-oidc-linking-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    initSession("oidc-linking-test-secret");
    passwordHash = await hashPassword(PASSWORD);
    adminId = getDb()
      .insert(users)
      .values({ username: "admin", passwordHash, role: "admin" })
      .returning()
      .get().id;
    handleCallback.mockReset();
    configuredIssuer.current = ISSUER;

    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/auth", authRoutes);
    app.route("/api/users", usersRoutes);
    app.route("/api/tokens", tokensRoutes);
    app.route("/api/passkeys", passkeysRoutes);
  });

  afterEach(() => {
    closeDatabase();
    resetAuthConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("linking", () => {
    test("nothing changes until the account holder confirms the identity they saw", async () => {
      const b = await signedIn(adminId);
      const before = getUser(adminId);

      const start = await b.request("/api/auth/oidc/link/start", { method: "POST" });
      const { redirectUrl } = (await start.json()) as { redirectUrl: string };
      expect(redirectUrl).toContain("prompt=login");

      const res = await ssoSignIn(b, identity());
      expect(res.headers.get("location")).toContain("/settings?tab=account&oidcLink=confirm");
      expect(getDb().select().from(users).all()).toHaveLength(1);
      expect(getUser(adminId)).toEqual(before);

      const status = (await (await b.request("/api/auth/oidc/link")).json()) as {
        link: unknown;
        pending: { username: string; issuer: string; role: string; merge: unknown };
      };
      expect(status.link).toBeNull();
      expect(status.pending).toEqual({ username: "alice", issuer: ISSUER, role: "admin", merge: null });
    });

    test("confirming needs the password, then links and ends the account's other sessions", async () => {
      const b = await signedIn(adminId);
      const otherDevice = await signedIn(adminId);
      await reachConfirmation(b);

      const wrong = await b.request("/api/auth/oidc/link/confirm", {
        method: "POST",
        body: { password: "Wrong-password1" },
      });
      expect(wrong.status).toBe(401);
      expect(getUser(adminId).oidcSubject).toBeNull();

      const res = await b.request("/api/auth/oidc/link/confirm", {
        method: "POST",
        body: { password: PASSWORD },
      });
      expect(res.status).toBe(200);

      const user = getUser(adminId);
      expect(user).toMatchObject({
        username: "admin",
        role: "admin",
        oidcIssuer: ISSUER,
        oidcSubject: "alice-sub",
        oidcUsername: "alice",
        oidcRole: "admin",
        oidcLinkMethod: "verified",
      });
      expect(user.oidcLinkedAt).toBeTruthy();
      expect(await me(b)).toMatchObject({ authMethod: "password" });
      expect(await me(otherDevice)).toBeNull();
    });

    test("a used or outdated confirmation cannot be replayed", async () => {
      const b = await signedIn(adminId);
      await reachConfirmation(b);
      const pending = b.cookies.get("ludash_oidc_link_pending")!;
      expect(
        (await b.request("/api/auth/oidc/link/confirm", { method: "POST", body: { password: PASSWORD } })).status,
      ).toBe(200);

      b.cookies.set("ludash_oidc_link_pending", pending);
      const replay = await b.request("/api/auth/oidc/link/confirm", {
        method: "POST",
        body: { password: PASSWORD },
      });
      expect(replay.status).toBe(400);
    });

    test("the authenticator code is required when TOTP is on", async () => {
      const secret = generateSecret();
      getDb()
        .update(users)
        .set({ totpEnabled: 1, totpSecret: getEncryptor().encrypt(secret) })
        .where(eq(users.id, adminId))
        .run();
      const b = await signedIn(adminId);
      await reachConfirmation(b);

      const missing = await b.request("/api/auth/oidc/link/confirm", {
        method: "POST",
        body: { password: PASSWORD },
      });
      expect(missing.status).toBe(401);

      const res = await b.request("/api/auth/oidc/link/confirm", {
        method: "POST",
        body: { password: PASSWORD, totpCode: await generate({ secret }) },
      });
      expect(res.status).toBe(200);
      expect(getUser(adminId).lastTotpStep).not.toBeNull();
    });

    test("only local sessions and browsers can start or confirm a link", async () => {
      const ssoId = getDb()
        .insert(users)
        .values({ username: "sso", authProvider: "oidc", oidcIssuer: ISSUER, oidcSubject: "s" })
        .returning()
        .get().id;
      const sso = await signedIn(ssoId, "oidc");
      expect((await sso.request("/api/auth/oidc/link/start", { method: "POST" })).status).toBe(403);
      expect((await sso.request("/api/auth/oidc/link/confirm", { method: "POST", body: {} })).status).toBe(403);

      expect((await browser().request("/api/auth/oidc/link/start", { method: "POST" })).status).toBe(401);
      const bearer = await (await signedIn(adminId)).request("/api/auth/oidc/link/start", {
        method: "POST",
        headers: { authorization: "Bearer ludash_x" },
      });
      expect(bearer.status).toBe(403);
    });

    test("an intent from another session or sign-in cannot link", async () => {
      const b = await signedIn(adminId);
      await b.request("/api/auth/oidc/link/start", { method: "POST" });
      // The account's credentials changed while the browser was at the provider.
      getDb().update(users).set({ sessionVersion: 7 }).where(eq(users.id, adminId)).run();
      const res = await ssoSignIn(b, identity());
      expect(res.headers.get("location")).toContain("oidcLink=session");
      expect(b.cookies.has("ludash_oidc_link_pending")).toBe(false);
    });

    test("a sign-in started after the link attempt stays a sign-in", async () => {
      const b = await signedIn(adminId);
      await b.request("/api/auth/oidc/link/start", { method: "POST" });
      b.cookies.set("oidc_state", "newer-state");

      const res = await ssoSignIn(b, identity());
      expect(res.headers.get("location")).toContain("/dashboard");
      expect(getUser(adminId).oidcSubject).toBeNull();
      expect(getDb().select().from(users).all()).toHaveLength(2);
    });

    test("a denied identity cannot be linked, and the attempt ends no sessions", async () => {
      const b = await signedIn(adminId);
      const location = await reachConfirmation(b, identity({ role: null }));
      expect(location).toContain("oidcLink=denied");
      expect(b.cookies.has("ludash_oidc_link_pending")).toBe(false);
      expect(await me(b)).not.toBeNull();
    });

    test("an identity on another account with a password cannot be taken", async () => {
      getDb()
        .insert(users)
        .values({ username: "bob", passwordHash, authProvider: "oidc", oidcIssuer: ISSUER, oidcSubject: "alice-sub" })
        .run();
      const b = await signedIn(adminId);
      expect(await reachConfirmation(b)).toContain("oidcLink=taken");
    });

    test("a failed provider sign-in returns to the account page", async () => {
      const b = await signedIn(adminId);
      await b.request("/api/auth/oidc/link/start", { method: "POST" });
      handleCallback.mockResolvedValue(null);
      const res = await b.request("/api/auth/oidc/callback?error=access_denied&state=y");
      expect(res.headers.get("location")).toContain("oidcLink=failed");
    });

    test("an account that is already linked has to unlink first", async () => {
      const b = await linkedAdmin();
      expect((await b.request("/api/auth/oidc/link/start", { method: "POST" })).status).toBe(409);
    });
  });

  describe("a linked account", () => {
    test("SSO sign-in keeps the local username and role, and has its own role", async () => {
      const local = await linkedAdmin();
      const sso = browser();
      const res = await ssoSignIn(sso, identity({ username: "renamed", role: "read-only" }));
      expect(res.headers.get("location")).toContain("/dashboard");

      expect(getDb().select().from(users).all()).toHaveLength(1);
      expect(getUser(adminId)).toMatchObject({
        username: "admin",
        role: "admin",
        oidcRole: "read-only",
        oidcUsername: "renamed",
      });
      expect(await me(sso)).toMatchObject({ userId: adminId, role: "read-only", authMethod: "oidc", linkedSso: true });
      // The IdP can neither demote the local sign-in nor end its session.
      expect(await me(local)).toMatchObject({ userId: adminId, role: "admin", authMethod: "password" });
    });

    test("a local read-only account gets the SSO role only through SSO", async () => {
      getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
      const local = await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso, identity({ role: "admin" }));
      expect(await me(sso)).toMatchObject({ role: "admin" });
      expect(await me(local)).toMatchObject({ role: "read-only" });
    });

    test("a new SSO sign-in ends earlier SSO sessions only", async () => {
      const local = await linkedAdmin();
      const first = browser();
      await ssoSignIn(first, identity());
      expect(await me(first)).not.toBeNull();

      await ssoSignIn(browser(), identity());
      expect(await me(first)).toBeNull();
      expect(await me(local)).not.toBeNull();
    });

    test("denial ends SSO sessions and keeps local sign-in", async () => {
      const local = await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso, identity());

      const res = await ssoSignIn(browser(), identity({ role: null }));
      expect(res.headers.get("location")).toContain("error=oidc_unauthorized");
      expect(await me(sso)).toBeNull();
      expect(await me(local)).not.toBeNull();

      const login = await browser().request("/api/auth/login", {
        method: "POST",
        body: { username: "admin", password: PASSWORD },
      });
      expect(login.status).toBe(200);
    });

    test("back-channel logout without a session ID ends SSO sessions only", async () => {
      const local = await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso, identity());

      applyOidcLogout({
        issuer: ISSUER,
        subject: "alice-sub",
        tokenId: "logout-1",
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 300,
        sessionExpiresAt: Math.floor(Date.now() / 1000) + 300,
      });
      expect(await me(sso)).toBeNull();
      expect(await me(local)).not.toBeNull();
    });

    test("disabling the account blocks both sign-in methods", async () => {
      await linkedAdmin();
      getDb().update(users).set({ disabled: 1 }).where(eq(users.id, adminId)).run();
      const res = await ssoSignIn(browser(), identity());
      expect(res.headers.get("location")).toContain("error=oidc_unauthorized");
    });

    test("an SSO session cannot touch local credentials or the link", async () => {
      await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso, identity());

      const status = (await (await sso.request("/api/auth/status")).json()) as Record<string, unknown>;
      expect(status).toMatchObject({ hasPassword: false, totpEnabled: false, passkeysAvailable: false });

      const refused = [
        await sso.request("/api/auth/change-password", {
          method: "POST",
          body: { currentPassword: PASSWORD, newPassword: "NewPassword2" },
        }),
        await sso.request("/api/auth/webauthn/register/options", { method: "POST" }),
        await sso.request("/api/auth/webauthn/register/verify", { method: "POST", body: {} }),
        await sso.request("/api/auth/totp/setup", { method: "POST" }),
        await sso.request("/api/passkeys"),
        await sso.request("/api/passkeys/1", { method: "DELETE" }),
        await sso.request("/api/auth/oidc/link", { method: "DELETE", body: { password: PASSWORD } }),
      ];
      expect(refused.map((res) => res.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    });

    test("a linked admin with only SSO admin access counts as an administrator", async () => {
      getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
      expect(countActiveAdmins(-1)).toBe(0);
      await linkedAdmin();
      expect(countActiveAdmins(-1)).toBe(1);
    });

    describe("last-administrator checks", () => {
      async function otherAdmin() {
        return getDb()
          .insert(users)
          .values({ username: "boss", passwordHash, role: "admin" })
          .returning()
          .get().id;
      }

      test("SSO admin access from a previous provider does not count", async () => {
        getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
        await linkedAdmin(identity({ issuer: "https://old-idp.example.com" }));
        expect(countActiveAdmins(-1)).toBe(0);
      });

      test("an old provider's SSO session cannot delete or disable the last local administrator", async () => {
        const bossId = await otherAdmin();
        getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
        await linkedAdmin(identity({ issuer: "https://old-idp.example.com" }));
        const stale = await signedIn(adminId, "oidc");
        expect(await me(stale)).toMatchObject({ role: "admin" });

        expect((await stale.request(`/api/users/${bossId}`, { method: "DELETE" })).status).toBe(400);
        expect(
          (await stale.request(`/api/users/${bossId}`, { method: "PATCH", body: { disabled: true } })).status,
        ).toBe(400);
        expect(getUser(bossId)).toMatchObject({ disabled: 0, role: "admin" });
      });

      test("the configured provider's SSO admin can still remove a local administrator", async () => {
        const bossId = await otherAdmin();
        getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
        await linkedAdmin();
        const sso = browser();
        await ssoSignIn(sso, identity());

        expect((await sso.request(`/api/users/${bossId}`, { method: "DELETE" })).status).toBe(200);
      });

      test("unlinking cannot remove the instance's only administrator access", async () => {
        getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
        const local = await linkedAdmin();

        const res = await local.request("/api/auth/oidc/link", {
          method: "DELETE",
          body: { password: PASSWORD },
        });
        expect(res.status).toBe(400);
        expect(getUser(adminId).oidcSubject).toBe("alice-sub");
      });

      test("an administrator cannot remove the link holding the only other administrator access", async () => {
        const staleId = getDb()
          .insert(users)
          .values({
            username: "stale",
            passwordHash,
            role: "read-only",
            authProvider: "oidc",
            oidcIssuer: "https://old-idp.example.com",
            oidcSubject: "stale-sub",
            oidcRole: "admin",
            oidcLinkedAt: "2026-11-02 10:00:00",
          })
          .returning()
          .get().id;
        getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
        await linkedAdmin();
        const stale = await signedIn(staleId, "oidc");

        const res = await stale.request(`/api/users/${adminId}/unlink-oidc`, { method: "POST" });
        expect(res.status).toBe(400);
        expect(getUser(adminId).oidcSubject).toBe("alice-sub");
      });

      test("concurrent unlinks cannot remove the last administrator access", async () => {
        const ssoAdmin = (username: string) =>
          getDb()
            .insert(users)
            .values({
              username,
              passwordHash,
              role: "read-only",
              authProvider: "oidc",
              oidcIssuer: ISSUER,
              oidcSubject: `${username}-sub`,
              oidcRole: "admin",
              oidcLinkedAt: "2026-11-02 10:00:00",
            })
            .returning()
            .get().id;
        getDb().update(users).set({ role: "read-only" }).where(eq(users.id, adminId)).run();
        const firstId = ssoAdmin("first");
        const secondId = ssoAdmin("second");
        const [first, second] = [await signedIn(firstId), await signedIn(secondId)];

        const statuses = (
          await Promise.all(
            [first, second].map((b) =>
              b.request("/api/auth/oidc/link", { method: "DELETE", body: { password: PASSWORD } }),
            ),
          )
        ).map((res) => res.status);

        expect(statuses.sort()).toEqual([200, 400]);
        expect(countActiveAdmins(-1)).toBe(1);
      });

      test("a local administrator can unlink, because the local role stays", async () => {
        const local = await linkedAdmin();
        const res = await local.request("/api/auth/oidc/link", {
          method: "DELETE",
          body: { password: PASSWORD },
        });
        expect(res.status).toBe(200);
      });
    });
  });

  describe("merging a separate SSO account", () => {
    async function ssoAccount(role: "admin" | "read-only") {
      return getDb()
        .insert(users)
        .values({
          username: "admin#oidc-1a2b3c4d5e6f",
          authProvider: "oidc",
          oidcIssuer: ISSUER,
          oidcSubject: "alice-sub",
          role,
        })
        .returning()
        .get().id;
    }

    test("the confirmation names it, and it is removed on confirm", async () => {
      const ssoId = await ssoAccount("admin");
      await addToken(ssoId, "ludash_merged");
      const b = await signedIn(adminId);
      await reachConfirmation(b);

      const status = (await (await b.request("/api/auth/oidc/link")).json()) as {
        pending: { merge: unknown };
      };
      expect(status.pending.merge).toEqual({ username: "admin#oidc-1a2b3c4d5e6f", apiTokenCount: 1 });
      expect(getDb().select().from(users).all()).toHaveLength(2);

      const res = await b.request("/api/auth/oidc/link/confirm", { method: "POST", body: { password: PASSWORD } });
      expect(res.status).toBe(200);
      expect(getDb().select().from(users).all().map((u) => u.username)).toEqual(["admin"]);
    });

    test("its sessions end", async () => {
      const ssoId = await ssoAccount("admin");
      const sso = await signedIn(ssoId, "oidc");
      await linkedAdmin();
      expect(await me(sso)).toBeNull();
    });

    test.each([
      { ssoRole: "admin", localRole: "admin", readOnly: false },
      { ssoRole: "admin", localRole: "read-only", readOnly: false },
      { ssoRole: "read-only", localRole: "admin", readOnly: true },
    ] as const)(
      "API tokens keep their access: SSO $ssoRole, local $localRole",
      async ({ ssoRole, localRole, readOnly }) => {
        const ssoId = await ssoAccount(ssoRole);
        await addToken(ssoId, "ludash_merged", { readOnly: 0 });
        expect(await validateToken("ludash_merged")).toMatchObject({ readOnly });

        getDb().update(users).set({ role: localRole }).where(eq(users.id, adminId)).run();
        await linkedAdmin(identity({ role: ssoRole }));

        expect(await validateToken("ludash_merged")).toMatchObject({
          userId: adminId,
          username: "admin",
          role: ssoRole,
          readOnly,
        });
      },
    );

    test("a disabled SSO account cannot be merged, so it stays disabled", async () => {
      const ssoId = await ssoAccount("admin");
      getDb().update(users).set({ disabled: 1 }).where(eq(users.id, ssoId)).run();
      await addToken(ssoId, "ludash_disabled");
      const b = await signedIn(adminId);

      expect(await reachConfirmation(b)).toContain("oidcLink=disabled");
      expect(b.cookies.has("ludash_oidc_link_pending")).toBe(false);
      expect(getUser(ssoId).disabled).toBe(1);
      expect(getUser(adminId).oidcSubject).toBeNull();
      expect(await validateToken("ludash_disabled")).toBeNull();
    });

    test("an SSO account disabled after the provider step is not merged on confirm", async () => {
      const ssoId = await ssoAccount("admin");
      await addToken(ssoId, "ludash_disabled");
      const b = await signedIn(adminId);
      expect(await reachConfirmation(b)).toContain("oidcLink=confirm");
      getDb().update(users).set({ disabled: 1 }).where(eq(users.id, ssoId)).run();

      const res = await b.request("/api/auth/oidc/link/confirm", {
        method: "POST",
        body: { password: PASSWORD },
      });
      expect(res.status).toBe(409);
      expect(getUser(ssoId).disabled).toBe(1);
      expect(getUser(adminId).oidcSubject).toBeNull();
      expect(await validateToken("ludash_disabled")).toBeNull();
    });

    test("the account's own tokens stay limited by the local role", async () => {
      await addToken(adminId, "ludash_local");
      await linkedAdmin(identity({ role: "read-only" }));
      expect(await validateToken("ludash_local")).toMatchObject({ role: "admin", readOnly: false });
    });
  });

  describe("API tokens on a linked account", () => {
    test("an SSO session creates tokens limited by the SSO role and only reaches those", async () => {
      await addToken(adminId, "ludash_local", { name: "local" });
      await linkedAdmin();
      const sso = browser();
      await ssoSignIn(sso, identity());

      const created = await sso.request("/api/tokens", {
        method: "POST",
        body: { name: "sso", readOnly: false },
      });
      expect(created.status).toBe(200);
      const { token, id } = (await created.json()) as { token: string; id: number };
      expect(await validateToken(token)).toMatchObject({ role: "admin", readOnly: false });

      const list = (await (await sso.request("/api/tokens")).json()) as { tokens: Array<{ name: string }> };
      expect(list.tokens.map((t) => t.name)).toEqual(["sso"]);
      const localId = getDb().select().from(apiTokens).where(eq(apiTokens.name, "local")).get()!.id;
      expect((await sso.request(`/api/tokens/${localId}`, { method: "DELETE" })).status).toBe(404);

      // The identity provider's demotion reaches the token, not the local role.
      await ssoSignIn(browser(), identity({ role: "read-only" }));
      expect(await validateToken(token)).toMatchObject({ role: "read-only", readOnly: true });
      expect(await validateToken("ludash_local")).toMatchObject({ role: "admin", readOnly: false });
      expect((await sso.request(`/api/tokens/${id}`)).status).toBe(401);
    });

    test("a local session sees all of the account's tokens", async () => {
      await addToken(adminId, "ludash_local", { name: "local" });
      await addToken(adminId, "ludash_sso", { name: "sso", roleSource: "oidc" });
      const b = await signedIn(adminId);
      const list = (await (await b.request("/api/tokens")).json()) as {
        tokens: Array<{ name: string; roleSource: string }>;
      };
      expect(list.tokens.map((t) => [t.name, t.roleSource])).toEqual([
        ["local", "local"],
        ["sso", "oidc"],
      ]);
    });
  });

  describe("unlinking", () => {
    test("needs the password, ends other sessions, and SSO creates a separate account again", async () => {
      const b = await linkedAdmin();
      const otherDevice = await signedIn(adminId);
      const sso = browser();
      await ssoSignIn(sso, identity());

      const wrong = await b.request("/api/auth/oidc/link", {
        method: "DELETE",
        body: { password: "Wrong-password1" },
      });
      expect(wrong.status).toBe(401);

      const res = await b.request("/api/auth/oidc/link", {
        method: "DELETE",
        body: { password: PASSWORD },
      });
      expect(res.status).toBe(200);
      expect(getUser(adminId)).toMatchObject({
        authProvider: "password",
        oidcIssuer: null,
        oidcSubject: null,
        oidcRole: null,
        oidcLinkedAt: null,
        oidcAutoLinkBlocked: 1,
      });
      expect(await me(b)).toMatchObject({ authMethod: "password" });
      expect(await me(otherDevice)).toBeNull();
      expect(await me(sso)).toBeNull();

      const again = browser();
      await ssoSignIn(again, identity());
      expect((await me(again))?.userId).not.toBe(adminId);
    });

    test.each([
      { ssoRole: "admin", localRole: "admin", role: "admin", readOnly: false },
      { ssoRole: "admin", localRole: "read-only", role: "read-only", readOnly: true },
      { ssoRole: "read-only", localRole: "admin", role: "admin", readOnly: true },
    ] as const)(
      "SSO tokens never gain access: SSO $ssoRole, local $localRole",
      async ({ ssoRole, localRole, role, readOnly }) => {
        const b = await linkedAdmin(identity({ role: ssoRole }));
        await addToken(adminId, "ludash_sso", { roleSource: "oidc" });
        getDb().update(users).set({ role: localRole }).where(eq(users.id, adminId)).run();
        // Keeps this account from holding the last administrator access.
        getDb().insert(users).values({ username: "boss", passwordHash, role: "admin" }).run();

        const res = await b.request("/api/auth/oidc/link", {
          method: "DELETE",
          body: { password: PASSWORD },
        });
        expect(res.status).toBe(200);
        expect(await validateToken("ludash_sso")).toMatchObject({ role, readOnly });
      },
    );

    test("another administrator can remove the link; the owner uses their profile", async () => {
      const b = await linkedAdmin();
      const otherId = getDb()
        .insert(users)
        .values({ username: "other", passwordHash, role: "admin" })
        .returning()
        .get().id;
      const other = await signedIn(otherId);

      const list = (await (await other.request("/api/users")).json()) as {
        users: Array<{ username: string; source: string; oidcLink: Record<string, unknown> | null }>;
      };
      const admin = list.users.find((u) => u.username === "admin")!;
      expect(admin.source).toBe("local");
      expect(admin.oidcLink).toMatchObject({ username: "alice", role: "admin", method: "verified", issuer: ISSUER });

      expect((await b.request(`/api/users/${adminId}/unlink-oidc`, { method: "POST" })).status).toBe(400);
      expect((await other.request(`/api/users/${otherId}/unlink-oidc`, { method: "POST" })).status).toBe(400);

      const res = await other.request(`/api/users/${adminId}/unlink-oidc`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(getUser(adminId).oidcSubject).toBeNull();
      expect(await me(b)).toBeNull();
    });

    async function linkProvider(b: Browser) {
      const status = (await (await b.request("/api/auth/oidc/link")).json()) as {
        link: { provider: string };
      };
      return status.link.provider;
    }

    test("a link to the configured provider is current", async () => {
      expect(await linkProvider(await linkedAdmin())).toBe("current");
    });

    test("an unreachable provider does not make a link stale", async () => {
      const b = await linkedAdmin();
      setSetting("oidc_issuer", ISSUER);
      setSetting("oidc_client_id", "ludash");
      configuredIssuer.current = null;
      expect(await linkProvider(b)).toBe("unavailable");
    });

    test("removing the provider makes a link stale", async () => {
      const b = await linkedAdmin();
      configuredIssuer.current = null;
      expect(await linkProvider(b)).toBe("changed");
    });

    test("a stale link from a previous issuer is reported and can be unlinked", async () => {
      const b = await linkedAdmin(identity({ issuer: "https://old-idp.example.com" }));
      expect(await linkProvider(b)).toBe("changed");
      expect((await b.request("/api/auth/oidc/link", { method: "DELETE", body: { password: PASSWORD } })).status).toBe(200);
    });
  });

  describe("automatic linking by username", () => {
    const enable = () => setSetting("oidc_auto_link_username", "true");

    test("is off by default", async () => {
      const sso = browser();
      await ssoSignIn(sso, identity({ username: "admin", preferredUsername: "admin" }));
      expect(getUser(adminId).oidcSubject).toBeNull();
      const created = getDb().select().from(users).where(eq(users.oidcSubject, "alice-sub")).get()!;
      expect(created.username).toMatch(/^admin#oidc-/);
    });

    test("links an existing account without touching its sessions or local access", async () => {
      enable();
      const local = await signedIn(adminId);
      const sso = browser();
      await ssoSignIn(sso, identity({ username: "admin", preferredUsername: "admin", role: "read-only" }));

      expect(getDb().select().from(users).all()).toHaveLength(1);
      expect(getUser(adminId)).toMatchObject({
        role: "admin",
        oidcRole: "read-only",
        oidcLinkMethod: "username",
      });
      expect(await me(local)).toMatchObject({ role: "admin", authMethod: "password" });
      expect(await me(sso)).toMatchObject({ userId: adminId, role: "read-only", linkedSso: true });
    });

    test("merges the identity's separate SSO account and keeps its tokens working", async () => {
      enable();
      const ssoId = getDb()
        .insert(users)
        .values({
          username: "admin#oidc-1a2b3c4d5e6f",
          authProvider: "oidc",
          oidcIssuer: ISSUER,
          oidcSubject: "alice-sub",
          role: "admin",
        })
        .returning()
        .get().id;
      await addToken(ssoId, "ludash_merged");

      await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: "admin" }));

      expect(getDb().select().from(users).all().map((u) => u.username)).toEqual(["admin"]);
      expect(await validateToken("ludash_merged")).toMatchObject({ userId: adminId, readOnly: false });
    });

    test("ignores usernames that came from a fallback claim", async () => {
      enable();
      await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: undefined }));
      expect(getUser(adminId).oidcSubject).toBeNull();
    });

    test("needs an exact match", async () => {
      enable();
      await ssoSignIn(browser(), identity({ username: "ADMIN", preferredUsername: "ADMIN" }));
      expect(getUser(adminId).oidcSubject).toBeNull();
    });

    test("never links a denied identity", async () => {
      enable();
      await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: "admin", role: null }));
      expect(getUser(adminId).oidcSubject).toBeNull();
    });

    test("leaves out disabled accounts", async () => {
      enable();
      getDb().update(users).set({ disabled: 1 }).where(eq(users.id, adminId)).run();
      await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: "admin" }));
      expect(getUser(adminId).oidcSubject).toBeNull();
    });

    test("leaves out accounts created while it is on", async () => {
      enable();
      const admin = await signedIn(adminId);
      const created = await admin.request("/api/users", {
        method: "POST",
        body: { username: "bob", password: PASSWORD, role: "read-only" },
      });
      expect(created.status).toBe(201);

      await ssoSignIn(browser(), identity({ username: "bob", preferredUsername: "bob", subject: "bob-sub" }));
      const bob = getDb().select().from(users).where(eq(users.username, "bob")).get()!;
      expect(bob.oidcSubject).toBeNull();
      expect(getDb().select().from(users).where(eq(users.oidcSubject, "bob-sub")).get()!.username).toMatch(
        /^bob#oidc-/,
      );
    });

    test("does not relink an account that was unlinked", async () => {
      enable();
      await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: "admin" }));
      const local = await signedIn(adminId);
      expect((await local.request("/api/auth/oidc/link", { method: "DELETE", body: { password: PASSWORD } })).status).toBe(200);

      await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: "admin" }));
      expect(getUser(adminId).oidcSubject).toBeNull();
    });

    test("cannot replace an existing link", async () => {
      await linkedAdmin();
      enable();
      await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: "admin", subject: "mallory-sub" }));
      expect(getUser(adminId).oidcSubject).toBe("alice-sub");
    });

    test("does not bring back a disabled SSO account", async () => {
      enable();
      const ssoId = getDb()
        .insert(users)
        .values({
          username: "admin#oidc-1a2b3c4d5e6f",
          authProvider: "oidc",
          oidcIssuer: ISSUER,
          oidcSubject: "alice-sub",
          role: "admin",
          disabled: 1,
        })
        .returning()
        .get().id;
      await addToken(ssoId, "ludash_disabled");

      const res = await ssoSignIn(browser(), identity({ username: "admin", preferredUsername: "admin" }));

      expect(res.headers.get("location")).toContain("error=oidc_unauthorized");
      expect(getUser(ssoId).disabled).toBe(1);
      expect(getUser(adminId).oidcSubject).toBeNull();
      expect(await validateToken("ludash_disabled")).toBeNull();
    });

    test("an automatically linked SSO session gets no local credentials or tokens", async () => {
      enable();
      await addToken(adminId, "ludash_local", { name: "local" });
      const sso = browser();
      await ssoSignIn(sso, identity({ username: "admin", preferredUsername: "admin" }));

      const list = (await (await sso.request("/api/tokens")).json()) as { tokens: unknown[] };
      expect(list.tokens).toEqual([]);
      const change = await sso.request("/api/auth/change-password", {
        method: "POST",
        body: { currentPassword: PASSWORD, newPassword: "NewPassword2" },
      });
      expect(change.status).toBe(403);
    });
  });
});
