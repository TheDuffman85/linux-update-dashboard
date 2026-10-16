import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono as BaseHono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings, users, webauthnCredentials } from "../../server/db/schema";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSession } from "../../server/auth/session";
import {
  getAuthSetting,
  getManagedAuthSettings,
  getPasswordLoginState,
  initAuthConfig,
  loadAuthEnvOverrides,
  resetAuthConfig,
} from "../../server/auth/auth-config";
import { getOidcPolicy, isEndSessionEnabled } from "../../server/auth/oidc";
import settingsRoutes from "../../server/routes/settings";

const { default: authRoutes } = await import("../../server/routes/auth");

const Hono = BaseHono<{ Variables: { user: { userId: number; username: string; isAdmin: boolean } } }>;

const AUTH_ENV_VARS = [
  "LUDASH_OIDC_ISSUER",
  "LUDASH_OIDC_CLIENT_ID",
  "LUDASH_OIDC_CLIENT_SECRET",
  "LUDASH_OIDC_CLIENT_SECRET_FILE",
  "LUDASH_OIDC_SCOPE",
  "LUDASH_OIDC_GROUPS_CLAIM",
  "LUDASH_OIDC_ADMIN_GROUPS",
  "LUDASH_OIDC_READ_ONLY_GROUPS",
  "LUDASH_OIDC_UNMATCHED_ROLE",
  "LUDASH_OIDC_END_SESSION",
  "LUDASH_PASSWORD_LOGIN_ENABLED",
];

const incoming = {
  socket: { remoteAddress: "127.0.0.1", remotePort: 12345, remoteFamily: "IPv4" },
};

function setEnv(values: Record<string, string>) {
  Object.assign(process.env, values);
  resetAuthConfig();
}

function writeSetting(key: string, value: string) {
  getDb().update(settings).set({ value }).where(eq(settings.key, key)).run();
}

function readSetting(key: string): string | undefined {
  return getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get()?.value;
}

function settingsApp() {
  const app = new Hono();
  app.use("/api/settings/*", async (c, next) => {
    c.set("user", { userId: 1, username: "admin", isAdmin: true });
    await next();
  });
  app.route("/api/settings", settingsRoutes);
  return app;
}

function addPasskey() {
  const db = getDb();
  const user = db
    .insert(users)
    .values({ username: "admin", passwordHash: "hash", isAdmin: 1 })
    .returning({ id: users.id })
    .get();
  db.insert(webauthnCredentials)
    .values({
      userId: user.id,
      credentialId: "credential-1",
      publicKey: "public-key",
      signCount: 0,
    })
    .run();
}

describe("deployment-managed auth settings", () => {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(AUTH_ENV_VARS.map((name) => [name, process.env[name]]));
    for (const name of AUTH_ENV_VARS) delete process.env[name];
    resetAuthConfig();
    tempDir = mkdtempSync(join(tmpdir(), "ludash-auth-config-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "auth-config.db"));
    initSession("auth-config-test-secret");
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetAuthConfig();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("environment parsing", () => {
    test("normalizes values into the stored setting format", () => {
      setEnv({
        LUDASH_OIDC_ISSUER: " https://idp.example.com ",
        LUDASH_OIDC_CLIENT_ID: "ludash",
        LUDASH_OIDC_CLIENT_SECRET: "s3cret\n",
        LUDASH_OIDC_SCOPE: "openid  groups openid",
        LUDASH_OIDC_GROUPS_CLAIM: "roles",
        LUDASH_OIDC_ADMIN_GROUPS: " ops, ops ,admins,",
        LUDASH_OIDC_READ_ONLY_GROUPS: "viewers",
        LUDASH_OIDC_UNMATCHED_ROLE: "Read-Only",
        LUDASH_OIDC_END_SESSION: "off",
        LUDASH_PASSWORD_LOGIN_ENABLED: "no",
      });

      expect(loadAuthEnvOverrides()).toEqual({
        oidc_issuer: "https://idp.example.com",
        oidc_client_id: "ludash",
        oidc_client_secret: "s3cret",
        oidc_scope: "openid groups",
        oidc_groups_claim: "roles",
        oidc_admin_groups: "ops,admins",
        oidc_read_only_groups: "viewers",
        oidc_unmatched_role: "read-only",
        oidc_end_session: "false",
        disable_password_login: "true",
      });
    });

    test("treats empty variables as unset", () => {
      setEnv({ LUDASH_OIDC_ISSUER: "", LUDASH_PASSWORD_LOGIN_ENABLED: "  " });
      expect(loadAuthEnvOverrides()).toEqual({});
    });

    test("reads the client secret from a _FILE variable", () => {
      const secretFile = join(tempDir, "oidc_secret");
      writeFileSync(secretFile, "file-secret\n");
      setEnv({ LUDASH_OIDC_CLIENT_SECRET_FILE: secretFile });
      expect(loadAuthEnvOverrides().oidc_client_secret).toBe("file-secret");
    });

    test.each([
      [{ LUDASH_OIDC_ISSUER: "https://idp.example.com" }, "must be set together"],
      [{ LUDASH_OIDC_CLIENT_ID: "ludash" }, "must be set together"],
      [{ LUDASH_OIDC_ISSUER: "not a url", LUDASH_OIDC_CLIENT_ID: "x" }, "LUDASH_OIDC_ISSUER must be a valid URL"],
      [{ LUDASH_OIDC_ISSUER: "ftp://idp", LUDASH_OIDC_CLIENT_ID: "x" }, "http:// or https://"],
      [{ LUDASH_OIDC_SCOPE: "profile email" }, "LUDASH_OIDC_SCOPE must include openid"],
      [{ LUDASH_OIDC_UNMATCHED_ROLE: "owner" }, "LUDASH_OIDC_UNMATCHED_ROLE must be deny, admin, or read-only"],
      [{ LUDASH_OIDC_END_SESSION: "maybe" }, "LUDASH_OIDC_END_SESSION must be true or false"],
      [{ LUDASH_PASSWORD_LOGIN_ENABLED: "sometimes" }, "LUDASH_PASSWORD_LOGIN_ENABLED must be true or false"],
      [{ LUDASH_OIDC_CLIENT_SECRET: "a", LUDASH_OIDC_CLIENT_SECRET_FILE: "/x" }, "both LUDASH_OIDC_CLIENT_SECRET"],
    ])("rejects invalid configuration %o", (env, message) => {
      setEnv(env);
      expect(() => initAuthConfig()).toThrow(message);
    });
  });

  describe("effective values", () => {
    test("environment values win over saved settings and saved values return when unset", () => {
      writeSetting("oidc_groups_claim", "saved-claim");
      writeSetting("oidc_client_secret", getEncryptor().encrypt("saved-secret"));
      expect(getAuthSetting("oidc_groups_claim")).toBe("saved-claim");
      expect(getAuthSetting("oidc_client_secret")).toBe("saved-secret");

      setEnv({ LUDASH_OIDC_GROUPS_CLAIM: "env-claim", LUDASH_OIDC_CLIENT_SECRET: "env-secret" });
      expect(getAuthSetting("oidc_groups_claim")).toBe("env-claim");
      expect(getAuthSetting("oidc_client_secret")).toBe("env-secret");
      expect(readSetting("oidc_groups_claim")).toBe("saved-claim");

      delete process.env.LUDASH_OIDC_GROUPS_CLAIM;
      delete process.env.LUDASH_OIDC_CLIENT_SECRET;
      resetAuthConfig();
      expect(getAuthSetting("oidc_groups_claim")).toBe("saved-claim");
    });

    test("OIDC policy and logout behavior follow the environment", () => {
      writeSetting("oidc_admin_groups", "saved-admins");
      setEnv({
        LUDASH_OIDC_SCOPE: "openid groups",
        LUDASH_OIDC_READ_ONLY_GROUPS: "viewers",
        LUDASH_OIDC_UNMATCHED_ROLE: "admin",
        LUDASH_OIDC_END_SESSION: "false",
      });

      expect(getOidcPolicy()).toEqual({
        scope: "openid groups",
        groupsClaim: "groups",
        adminGroups: ["saved-admins"],
        readOnlyGroups: ["viewers"],
        unmatchedRole: "admin",
      });
      expect(isEndSessionEnabled()).toBe(false);
    });

    test("reports which settings are managed by which variable", () => {
      setEnv({ LUDASH_OIDC_SCOPE: "openid", LUDASH_PASSWORD_LOGIN_ENABLED: "true" });
      expect(getManagedAuthSettings()).toEqual({
        oidc_scope: "LUDASH_OIDC_SCOPE",
        disable_password_login: "LUDASH_PASSWORD_LOGIN_ENABLED",
      });
    });
  });

  describe("password login lockout protection", () => {
    test("LUDASH_PASSWORD_LOGIN_ENABLED=true re-enables password login saved as disabled", () => {
      writeSetting("disable_password_login", "true");
      addPasskey();
      expect(getPasswordLoginState()).toEqual({ disabled: true, fallback: false });

      setEnv({ LUDASH_PASSWORD_LOGIN_ENABLED: "true" });
      expect(getPasswordLoginState()).toEqual({ disabled: false, fallback: false });
    });

    test("disabling from the environment needs OIDC or a passkey", () => {
      setEnv({ LUDASH_PASSWORD_LOGIN_ENABLED: "false" });
      expect(getPasswordLoginState()).toEqual({ disabled: false, fallback: true });

      setEnv({
        LUDASH_OIDC_ISSUER: "https://idp.example.com",
        LUDASH_OIDC_CLIENT_ID: "ludash",
      });
      expect(getPasswordLoginState()).toEqual({ disabled: true, fallback: false });
    });

    test("a saved disabled setting falls back when no other sign-in method remains", () => {
      writeSetting("disable_password_login", "true");
      expect(getPasswordLoginState()).toEqual({ disabled: false, fallback: true });

      addPasskey();
      expect(getPasswordLoginState()).toEqual({ disabled: true, fallback: false });
    });
  });

  describe("settings routes", () => {
    test("GET reports effective managed values and masks the secret", async () => {
      writeSetting("oidc_groups_claim", "saved-claim");
      setEnv({
        LUDASH_OIDC_ISSUER: "https://idp.example.com",
        LUDASH_OIDC_CLIENT_ID: "ludash",
        LUDASH_OIDC_CLIENT_SECRET: "env-secret",
        LUDASH_PASSWORD_LOGIN_ENABLED: "true",
      });

      const res = await settingsApp().request("/api/settings");
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.settings).toMatchObject({
        oidc_issuer: "https://idp.example.com",
        oidc_client_id: "ludash",
        oidc_client_secret: "(stored)",
        oidc_groups_claim: "saved-claim",
        disable_password_login: "false",
      });
      expect(body.managedSettings).toEqual({
        oidc_issuer: "LUDASH_OIDC_ISSUER",
        oidc_client_id: "LUDASH_OIDC_CLIENT_ID",
        oidc_client_secret: "LUDASH_OIDC_CLIENT_SECRET",
        disable_password_login: "LUDASH_PASSWORD_LOGIN_ENABLED",
      });
      expect(body.passwordLoginFallback).toBe(false);
      expect(JSON.stringify(body)).not.toContain("env-secret");
    });

    test("GET flags the lockout fallback", async () => {
      writeSetting("disable_password_login", "true");
      const body = await (await settingsApp().request("/api/settings")).json();
      expect(body.managedSettings).toEqual({});
      expect(body.passwordLoginFallback).toBe(true);
    });

    test("PUT rejects managed keys without saving anything", async () => {
      setEnv({ LUDASH_OIDC_GROUPS_CLAIM: "env-claim" });

      const res = await settingsApp().request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidc_groups_claim: "other", language: "de" }),
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "MANAGED_BY_CONFIG",
        keys: ["oidc_groups_claim"],
      });
      expect(readSetting("language")).toBe("browser");
    });

    test("PUT still saves unmanaged auth settings", async () => {
      setEnv({ LUDASH_OIDC_GROUPS_CLAIM: "env-claim" });

      const res = await settingsApp().request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oidc_read_only_groups: "viewers" }),
      });

      expect(res.status).toBe(200);
      expect(readSetting("oidc_read_only_groups")).toBe("viewers");
    });

    test("disabling password login in Settings accepts OIDC configured from the environment", async () => {
      setEnv({
        LUDASH_OIDC_ISSUER: "https://idp.example.com",
        LUDASH_OIDC_CLIENT_ID: "ludash",
      });

      const res = await settingsApp().request("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disable_password_login: "true" }),
      });

      expect(res.status).toBe(200);
      expect(readSetting("disable_password_login")).toBe("true");
    });
  });

  describe("auth routes", () => {
    function authApp() {
      const app = new BaseHono();
      app.route("/api/auth", authRoutes);
      return app;
    }

    test("status and login use the effective password login state", async () => {
      addPasskey();
      setEnv({ LUDASH_PASSWORD_LOGIN_ENABLED: "false" });

      const status = await (await authApp().request("/api/auth/status", {}, { incoming })).json();
      expect(status.passwordLoginDisabled).toBe(true);

      const login = await authApp().request(
        "/api/auth/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "admin", password: "irrelevant" }),
        },
        { incoming },
      );
      expect(login.status).toBe(403);
    });

    test("status only reports passkey sign-in while a passkey exists", async () => {
      const status = async () =>
        (await authApp().request("/api/auth/status", {}, { incoming })).json();

      expect((await status()).passkeysEnabled).toBe(false);
      addPasskey();
      expect((await status()).passkeysEnabled).toBe(true);
      getDb().delete(webauthnCredentials).run();
      expect((await status()).passkeysEnabled).toBe(false);
    });

    test("status reports password login as available while the fallback is active", async () => {
      setEnv({ LUDASH_PASSWORD_LOGIN_ENABLED: "false" });
      const status = await (await authApp().request("/api/auth/status", {}, { incoming })).json();
      expect(status.passwordLoginDisabled).toBe(false);
    });
  });
});
