import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import * as client from "openid-client";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { settings, users } from "../../server/db/schema";
import { initSession } from "../../server/auth/session";
import { initEncryptor } from "../../server/security";

const { getEndSessionUrl } = vi.hoisted(() => ({
  getEndSessionUrl: vi.fn(),
}));

vi.mock("../../server/auth/oidc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/auth/oidc")>()),
  getEndSessionUrl,
}));

const { buildEndSessionUrl, isEndSessionEnabled } = await import(
  "../../server/auth/oidc"
);
const { default: authRoutes } = await import("../../server/routes/auth");

const SESSION_SECRET = "oidc-logout-test-secret";
const incoming = {
  socket: {
    remoteAddress: "127.0.0.1",
    remotePort: 12345,
    remoteFamily: "IPv4",
  },
};

async function sessionCookie(userId: number, username: string, authMethod: string) {
  const token = await new SignJWT({ userId, username, authMethod, sessionVersion: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SESSION_SECRET));
  return `ludash_session=${token}`;
}

describe("buildEndSessionUrl", () => {
  test("adds client_id, id_token_hint and post_logout_redirect_uri", () => {
    const configuration = new client.Configuration(
      {
        issuer: "https://idp.example.com",
        end_session_endpoint: "https://idp.example.com/logout",
      },
      "ludash",
    );
    const url = new URL(
      buildEndSessionUrl(configuration, "https://ludash.example.com/login", "id.token")!,
    );
    expect(url.origin + url.pathname).toBe("https://idp.example.com/logout");
    expect(url.searchParams.get("client_id")).toBe("ludash");
    expect(url.searchParams.get("id_token_hint")).toBe("id.token");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://ludash.example.com/login",
    );
  });

  test("omits id_token_hint when no ID token is available", () => {
    const configuration = new client.Configuration(
      {
        issuer: "https://idp.example.com",
        end_session_endpoint: "https://idp.example.com/logout",
      },
      "ludash",
    );
    const url = new URL(
      buildEndSessionUrl(configuration, "https://ludash.example.com/login")!,
    );
    expect(url.searchParams.has("id_token_hint")).toBe(false);
  });

  test("returns null when the provider has no end_session_endpoint", () => {
    const configuration = new client.Configuration(
      { issuer: "https://idp.example.com" },
      "ludash",
    );
    expect(buildEndSessionUrl(configuration, "https://ludash.example.com/login")).toBeNull();
  });
});

describe("POST /api/auth/logout", () => {
  let tempDir: string;
  let app: Hono;
  let localId: number;
  let oidcId: number;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-oidc-logout-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initSession(SESSION_SECRET);
    initDatabase(join(tempDir, "dashboard.db"));
    const db = getDb();
    localId = db.insert(users).values({ username: "admin", passwordHash: "x" }).returning().get().id;
    oidcId = db
      .insert(users)
      .values({ username: "sso", authProvider: "oidc", oidcIssuer: "https://idp", oidcSubject: "s" })
      .returning()
      .get().id;
    getEndSessionUrl.mockReset();
    getEndSessionUrl.mockImplementation(
      (redirect: string, hint?: string) =>
        `https://idp.example.com/logout?post_logout_redirect_uri=${encodeURIComponent(redirect)}&id_token_hint=${hint ?? ""}`,
    );
    app = new Hono();
    app.route("/api/auth", authRoutes);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const logout = (cookie: string) =>
    app.request("/api/auth/logout", { method: "POST", headers: { cookie } }, { incoming });

  test("SSO sessions get the provider logout URL with the stored ID token", async () => {
    const cookie = `${await sessionCookie(oidcId, "sso", "oidc")}; ludash_oidc_id_token=id.token`;
    const res = await logout(cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectUrl?: string };
    expect(body.redirectUrl).toContain("https://idp.example.com/logout");
    expect(getEndSessionUrl).toHaveBeenCalledWith(expect.stringMatching(/\/login$/), "id.token");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/ludash_session=;/);
    expect(setCookie).toMatch(/ludash_oidc_id_token=;/);
  });

  test("local sessions only clear the session", async () => {
    const res = await logout(await sessionCookie(localId, "admin", "password"));
    expect(await res.json()).toEqual({ status: "ok" });
    expect(getEndSessionUrl).not.toHaveBeenCalled();
  });

  test("the setting turns provider logout off", async () => {
    getDb()
      .update(settings)
      .set({ value: "false" })
      .where(eq(settings.key, "oidc_end_session"))
      .run();
    expect(isEndSessionEnabled()).toBe(false);

    const res = await logout(await sessionCookie(oidcId, "sso", "oidc"));
    expect(await res.json()).toEqual({ status: "ok" });
    expect(getEndSessionUrl).not.toHaveBeenCalled();
  });

  test("falls back to local logout when the provider has no end-session endpoint", async () => {
    getEndSessionUrl.mockReturnValue(null);
    const res = await logout(await sessionCookie(oidcId, "sso", "oidc"));
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
