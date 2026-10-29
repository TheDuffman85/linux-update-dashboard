import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import {
  apiTokens,
  settings,
  userPreferences,
  users,
  webauthnCredentials,
} from "../../server/db/schema";
import { authMiddleware } from "../../server/middleware/auth";
import authRoutes from "../../server/routes/auth";
import usersRoutes from "../../server/routes/users";
import accountRoutes from "../../server/routes/account";
import settingsRoutes from "../../server/routes/settings";
import passkeysRoutes from "../../server/routes/passkeys";
import { createSession, initSession } from "../../server/auth/session";
import { hashToken } from "../../server/auth/api-token";
import { hashPassword } from "../../server/auth/password";
import { resetAuthConfig } from "../../server/auth/auth-config";
import { initEncryptor } from "../../server/security";

const SESSION_SECRET = "user-management-test-secret";
let ipCounter = 0;

// Each request gets its own client address so the per-IP login rate limit never interferes.
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

function sessionCookieFrom(res: Response): string {
  return (
    res.headers
      .get("set-cookie")
      ?.split(/,(?=\s*ludash_)/)
      .map((part) => part.trim())
      .find((part) => part.startsWith("ludash_session="))
      ?.split(";")[0] ?? ""
  );
}

async function sessionCookie(
  userId: number,
  authMethod: "password" | "passkey" | "oidc" = "password",
): Promise<string> {
  const user = getDb().select().from(users).where(eq(users.id, userId)).get()!;
  const probe = new Hono();
  probe.get("/", async (c) => {
    await createSession(c, user.id, user.username, authMethod);
    return c.text("ok");
  });
  return sessionCookieFrom(await probe.request("/", {}, { incoming: incoming() }));
}

function setSetting(key: string, value: string) {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run();
}

describe("user management", () => {
  let tempDir: string;
  let app: Hono;
  let adminId: number;
  let adminCookie: string;

  const request = (
    path: string,
    { method = "GET", cookie, body, headers = {} }: {
      method?: string;
      cookie?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(
      path,
      {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      { incoming: incoming() },
    );

  async function addUser(values: Partial<typeof users.$inferInsert> & { username: string }) {
    return getDb().insert(users).values(values).returning().get().id;
  }

  async function createUser(username: string, role: "admin" | "read-only", extra = {}) {
    const res = await request("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username, password: "Password1", role, ...extra },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { user: { id: number } }).user.id;
  }

  async function login(username: string, password = "Password1") {
    return request("/api/auth/login", {
      method: "POST",
      body: { username, password },
    });
  }

  beforeEach(async () => {
    resetAuthConfig();
    tempDir = mkdtempSync(join(tmpdir(), "ludash-user-management-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    initSession(SESSION_SECRET);
    adminId = await addUser({
      username: "admin",
      passwordHash: await hashPassword("Password1"),
      role: "admin",
    });
    adminCookie = await sessionCookie(adminId);

    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/auth", authRoutes);
    app.route("/api/users", usersRoutes);
    app.route("/api/account", accountRoutes);
    app.route("/api/settings", settingsRoutes);
    app.route("/api/passkeys", passkeysRoutes);
    app.get("/api/systems", (c) => c.json({ ok: true }));
  });

  afterEach(() => {
    closeDatabase();
    resetAuthConfig();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("administrators create local users; read-only users and API tokens cannot", async () => {
    const viewerId = await createUser("viewer", "read-only");
    const duplicate = await request("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "viewer", password: "Password1", role: "admin" },
    });
    expect(duplicate.status).toBe(409);
    const weak = await request("/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "weak", password: "short", role: "admin" },
    });
    expect(weak.status).toBe(400);

    const list = (await (await request("/api/users", { cookie: adminCookie })).json()) as {
      users: Array<{ username: string; role: string; current: boolean; passwordChangeRequired: boolean }>;
    };
    expect(list.users.map((u) => [u.username, u.role, u.current, u.passwordChangeRequired])).toEqual([
      ["admin", "admin", true, false],
      ["viewer", "read-only", false, true],
    ]);

    const viewerCookie = await sessionCookie(viewerId, "passkey");
    expect((await request("/api/users", { cookie: viewerCookie })).status).toBe(403);

    const token = "ludash_admin_token";
    getDb()
      .insert(apiTokens)
      .values({ userId: adminId, name: "t", tokenHash: await hashToken(token), readOnly: 0 })
      .run();
    expect(
      (await request("/api/users", { headers: { authorization: `Bearer ${token}` } })).status,
    ).toBe(403);
  });

  test("a password chosen by an administrator must be changed before anything else", async () => {
    await createUser("ops", "admin");

    const loginRes = await login("ops");
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieFrom(loginRes);

    const status = (await (await request("/api/auth/status", { cookie })).json()) as {
      user: { passwordChangeRequired?: boolean };
    };
    expect(status.user.passwordChangeRequired).toBe(true);
    const blocked = await request("/api/systems", { cookie });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "PASSWORD_CHANGE_REQUIRED" });
    expect((await request("/api/settings", { cookie })).status).toBe(200);
    expect(
      (await request("/api/auth/webauthn/register/options", { method: "POST", cookie })).status,
    ).toBe(403);
    expect((await request("/api/auth/totp/setup", { method: "POST", cookie })).status).toBe(403);

    const same = await request("/api/auth/change-password", {
      method: "POST",
      cookie,
      body: { currentPassword: "Password1", newPassword: "Password1" },
    });
    expect(same.status).toBe(400);

    const changed = await request("/api/auth/change-password", {
      method: "POST",
      cookie,
      body: { currentPassword: "Password1", newPassword: "Password2" },
    });
    expect(changed.status).toBe(200);
    const newCookie = sessionCookieFrom(changed);
    expect((await request("/api/systems", { cookie: newCookie })).status).toBe(200);
    expect((await request("/api/systems", { cookie })).status).toBe(401);
  });

  test("users created without a required change can work right away", async () => {
    await createUser("direct", "read-only", { requirePasswordChange: false });
    const cookie = sessionCookieFrom(await login("direct"));
    expect((await request("/api/systems", { cookie })).status).toBe(200);
  });

  test("disabling an account ends its sessions and API tokens until it is enabled again", async () => {
    const opsId = await createUser("ops", "admin", { requirePasswordChange: false });
    const cookie = sessionCookieFrom(await login("ops"));
    const token = "ludash_ops_token";
    getDb()
      .insert(apiTokens)
      .values({ userId: opsId, name: "t", tokenHash: await hashToken(token), readOnly: 1 })
      .run();
    const tokenHeaders = { authorization: `Bearer ${token}` };
    expect((await request("/api/systems", { headers: tokenHeaders })).status).toBe(200);

    const disable = await request(`/api/users/${opsId}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { disabled: true },
    });
    expect(disable.status).toBe(200);
    expect((await request("/api/systems", { cookie })).status).toBe(401);
    expect((await request("/api/systems", { headers: tokenHeaders })).status).toBe(401);
    const denied = await login("ops");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "This account is disabled" });

    await request(`/api/users/${opsId}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { disabled: false },
    });
    expect((await login("ops")).status).toBe(200);
  });

  test("role changes apply to existing sessions", async () => {
    const opsId = await createUser("ops", "admin", { requirePasswordChange: false });
    const cookie = sessionCookieFrom(await login("ops"));
    expect((await request("/api/users", { cookie })).status).toBe(200);

    await request(`/api/users/${opsId}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { role: "read-only" },
    });
    expect((await request("/api/users", { cookie })).status).toBe(403);
    expect((await request("/api/systems", { cookie })).status).toBe(200);
  });

  test("administrators cannot change, disable or delete their own account", async () => {
    for (const [method, body] of [
      ["PATCH", { role: "read-only" }],
      ["PATCH", { disabled: true }],
      ["DELETE", undefined],
    ] as const) {
      const res = await request(`/api/users/${adminId}`, { method, cookie: adminCookie, body });
      expect(res.status).toBe(400);
    }
    expect(
      (await request(`/api/users/${adminId}/password`, {
        method: "POST",
        cookie: adminCookie,
        body: { password: "Password2" },
      })).status,
    ).toBe(400);
  });

  test("resetting the password and second factors ends the user's sessions", async () => {
    const opsId = await createUser("ops", "read-only", { requirePasswordChange: false });
    const cookie = sessionCookieFrom(await login("ops"));
    getDb()
      .insert(webauthnCredentials)
      .values({ userId: opsId, credentialId: "ops-key", publicKey: "pk" })
      .run();
    getDb().update(users).set({ totpEnabled: 1, totpSecret: "secret" }).where(eq(users.id, opsId)).run();

    const mfa = await request(`/api/users/${opsId}/reset-mfa`, { method: "POST", cookie: adminCookie });
    expect(mfa.status).toBe(200);
    expect(await mfa.json()).toMatchObject({ user: { totpEnabled: false, passkeyCount: 0 } });
    expect((await request("/api/systems", { cookie })).status).toBe(401);

    const reset = await request(`/api/users/${opsId}/password`, {
      method: "POST",
      cookie: adminCookie,
      body: { password: "Password3" },
    });
    expect(await reset.json()).toMatchObject({ user: { passwordChangeRequired: true } });
    expect((await login("ops", "Password1")).status).toBe(401);
    expect((await login("ops", "Password3")).status).toBe(200);
  });

  test("an enabled administrator keeps a passkey while passkeys are the only sign-in method", async () => {
    const opsId = await createUser("ops", "admin", { requirePasswordChange: false });
    const credentialId = getDb()
      .insert(webauthnCredentials)
      .values({ userId: opsId, credentialId: "ops-key", publicKey: "pk" })
      .returning()
      .get().id;
    setSetting("disable_password_login", "true");

    for (const [path, method, body] of [
      [`/api/users/${opsId}`, "PATCH", { role: "read-only" }],
      [`/api/users/${opsId}`, "PATCH", { disabled: true }],
      [`/api/users/${opsId}/reset-mfa`, "POST", undefined],
      [`/api/users/${opsId}`, "DELETE", undefined],
    ] as const) {
      const res = await request(path, { method, cookie: adminCookie, body });
      expect(res.status, `${method} ${path}`).toBe(400);
    }
    const opsCookie = await sessionCookie(opsId, "passkey");
    expect(
      (await request(`/api/passkeys/${credentialId}`, { method: "DELETE", cookie: opsCookie })).status,
    ).toBe(400);

    // A read-only user's passkey does not count.
    const viewerId = await createUser("viewer", "read-only");
    getDb()
      .insert(webauthnCredentials)
      .values({ userId: viewerId, credentialId: "viewer-key", publicKey: "pk" })
      .run();
    expect(
      (await request(`/api/users/${opsId}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { role: "read-only" },
      })).status,
    ).toBe(400);

    // With OIDC configured nobody is locked out.
    setSetting("oidc_issuer", "https://idp.example.com");
    setSetting("oidc_client_id", "ludash");
    expect(
      (await request(`/api/users/${opsId}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { role: "read-only" },
      })).status,
    ).toBe(200);
  });

  test("disabling password login requires an administrator passkey", async () => {
    const viewerId = await createUser("viewer", "read-only");
    getDb()
      .insert(webauthnCredentials)
      .values({ userId: viewerId, credentialId: "viewer-key", publicKey: "pk" })
      .run();
    const put = () =>
      request("/api/settings", {
        method: "PUT",
        cookie: adminCookie,
        body: { disable_password_login: "true" },
      });
    expect((await put()).status).toBe(400);

    getDb()
      .insert(webauthnCredentials)
      .values({ userId: adminId, credentialId: "admin-key", publicKey: "pk" })
      .run();
    expect((await put()).status).toBe(200);
  });

  test("OIDC users can only be deleted", async () => {
    const ssoId = await addUser({
      username: "sso",
      authProvider: "oidc",
      oidcIssuer: "https://idp",
      oidcSubject: "sub-1",
      role: "read-only",
    });
    const list = (await (await request("/api/users", { cookie: adminCookie })).json()) as {
      users: Array<{ username: string; source: string }>;
    };
    expect(list.users.find((u) => u.username === "sso")?.source).toBe("oidc");

    expect(
      (await request(`/api/users/${ssoId}`, {
        method: "PATCH",
        cookie: adminCookie,
        body: { role: "admin" },
      })).status,
    ).toBe(400);
    expect(
      (await request(`/api/users/${ssoId}/password`, {
        method: "POST",
        cookie: adminCookie,
        body: { password: "Password1" },
      })).status,
    ).toBe(400);
    expect((await request(`/api/users/${ssoId}`, { method: "DELETE", cookie: adminCookie })).status).toBe(200);
    expect(getDb().select().from(users).where(eq(users.id, ssoId)).get()).toBeUndefined();
  });

  test("every user saves their own language and time format", async () => {
    const viewerId = await createUser("viewer", "read-only", { requirePasswordChange: false });
    const viewerCookie = await sessionCookie(viewerId);
    setSetting("language", "de");
    setSetting("oidc_issuer", "https://idp.example.com");

    const save = await request("/api/account/preferences", {
      method: "PUT",
      cookie: viewerCookie,
      body: { language: "fr", time_format: "24h" },
    });
    expect(save.status).toBe(200);
    expect(
      (await request("/api/account/preferences", {
        method: "PUT",
        cookie: viewerCookie,
        body: { time_format: "25h" },
      })).status,
    ).toBe(400);
    expect(
      (await request("/api/account/preferences", {
        method: "PUT",
        cookie: viewerCookie,
        body: { theme: "dark" },
      })).status,
    ).toBe(400);

    const viewerSettings = (await (await request("/api/settings", { cookie: viewerCookie })).json()) as {
      settings: Record<string, string>;
      preferences: Record<string, string>;
      managedSettings?: unknown;
    };
    expect(viewerSettings.preferences).toEqual({ language: "fr", time_format: "24h" });
    expect(viewerSettings.settings.language).toBe("de");
    // Only administrators see how sign-in is configured.
    expect(viewerSettings.settings.oidc_issuer).toBeUndefined();
    expect(viewerSettings.managedSettings).toBeUndefined();

    const adminSettings = (await (await request("/api/settings", { cookie: adminCookie })).json()) as {
      settings: Record<string, string>;
      preferences: Record<string, string>;
    };
    expect(adminSettings.preferences).toEqual({});
    expect(adminSettings.settings.oidc_issuer).toBe("https://idp.example.com");

    await request("/api/account/preferences", {
      method: "PUT",
      cookie: viewerCookie,
      body: { language: null },
    });
    const rows = getDb()
      .select({ key: userPreferences.key })
      .from(userPreferences)
      .where(eq(userPreferences.userId, viewerId))
      .all();
    expect(rows).toEqual([{ key: "time_format" }]);

    // Preferences go with the account.
    await request(`/api/users/${viewerId}`, { method: "DELETE", cookie: adminCookie });
    expect(getDb().select().from(userPreferences).all()).toEqual([]);
  });
});
