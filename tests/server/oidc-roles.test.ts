import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, settings, users } from "../../server/db/schema";
import { authMiddleware } from "../../server/middleware/auth";
import settingsRoutes from "../../server/routes/settings";
import { initSession } from "../../server/auth/session";
import { hashToken } from "../../server/auth/api-token";
import { initEncryptor } from "../../server/security";
import {
  getOidcPolicy,
  parseOidcScope,
  resolveOidcClaims,
  resolveOidcRole,
} from "../../server/auth/oidc";

const SESSION_SECRET = "oidc-roles-test-secret";
const incoming = {
  socket: {
    remoteAddress: "203.0.113.10",
    remoteFamily: "IPv4",
    remotePort: 12345,
  },
};

function readSetting(key: string): string | undefined {
  return getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .get()?.value;
}

async function sessionCookie(userId: number, username: string, authMethod = "oidc") {
  const token = await new SignJWT({ userId, username, authMethod, sessionVersion: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SESSION_SECRET));
  return `ludash_session=${token}`;
}

describe("OIDC role mapping", () => {
  const policy = {
    groupsClaim: "groups",
    adminGroups: ["ops"],
    readOnlyGroups: ["viewers"],
    unmatchedRole: "deny" as const,
  };

  test("admin groups win over read-only groups", () => {
    expect(resolveOidcRole(policy, ["viewers", "ops"])).toBe("admin");
    expect(resolveOidcRole(policy, ["viewers"])).toBe("read-only");
  });

  test("unmatched users follow the configured policy", () => {
    expect(resolveOidcRole(policy, ["other"])).toBeNull();
    expect(resolveOidcRole({ ...policy, unmatchedRole: "read-only" }, [])).toBe("read-only");
    expect(resolveOidcRole({ ...policy, unmatchedRole: "admin" }, [])).toBe("admin");
  });

  test("merges groups from ID token and UserInfo using the configured claim", () => {
    const result = resolveOidcClaims(
      { sub: "abc", preferred_username: "alice", roles: "viewers" },
      { roles: ["ops"] },
      { ...policy, groupsClaim: "roles" },
    );
    expect(result).toEqual({ username: "alice", email: undefined, role: "admin" });
  });

  test("scopes must include openid", () => {
    expect(parseOidcScope("")).toBe("openid profile email");
    expect(parseOidcScope(" openid  email groups ")).toBe("openid email groups");
    expect(() => parseOidcScope("profile email")).toThrow();
  });
});

describe("OIDC settings defaults and upgrades", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-oidc-roles-"));
    initEncryptor(randomBytes(32).toString("base64"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("fresh installs deny OIDC users that match no group", () => {
    initDatabase(join(tempDir, "fresh.db"));
    expect(getOidcPolicy()).toEqual({
      scope: "openid profile email",
      groupsClaim: "groups",
      adminGroups: [],
      readOnlyGroups: [],
      unmatchedRole: "deny",
    });
  });

  test("existing installs keep full access for OIDC users and local accounts", () => {
    const dbPath = join(tempDir, "legacy.db");
    // Users table as created by releases before roles existed.
    const legacy = new BetterSqlite3(dbPath);
    legacy.exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      last_totp_step INTEGER,
      session_version INTEGER NOT NULL DEFAULT 0,
      auth_provider TEXT NOT NULL DEFAULT 'password',
      oidc_issuer TEXT,
      oidc_subject TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    legacy.exec(`INSERT INTO users (username, password_hash, is_admin) VALUES ('admin', 'hash', 1)`);
    legacy.exec(`INSERT INTO users (username, auth_provider, oidc_issuer, oidc_subject) VALUES ('sso', 'oidc', 'https://idp', 'sub-1')`);
    legacy.close();

    initDatabase(dbPath);

    const roles = getDb().select({ username: users.username, role: users.role }).from(users).all();
    expect(roles).toEqual([
      { username: "admin", role: "admin" },
      { username: "sso", role: "admin" },
    ]);
    expect(readSetting("oidc_unmatched_role")).toBe("admin");
    expect(readSetting("oidc_scope")).toBe("openid profile email");
  });

  test("an install with only an OIDC issuer configured keeps admin fallback", () => {
    const dbPath = join(tempDir, "configured.db");
    initDatabase(dbPath);
    getDb().delete(settings).where(eq(settings.key, "oidc_unmatched_role")).run();
    getDb().update(settings).set({ value: "https://idp" }).where(eq(settings.key, "oidc_issuer")).run();
    closeDatabase();

    initDatabase(dbPath);
    expect(readSetting("oidc_unmatched_role")).toBe("admin");
  });
});

describe("read-only enforcement", () => {
  let tempDir: string;
  let adminId: number;
  let viewerId: number;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-oidc-enforce-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "enforce.db"));
    initSession(SESSION_SECRET);
    const db = getDb();
    adminId = db.insert(users).values({ username: "admin", passwordHash: "x", role: "admin" }).returning().get().id;
    viewerId = db
      .insert(users)
      .values({ username: "viewer", authProvider: "oidc", oidcIssuer: "https://idp", oidcSubject: "v", role: "read-only" })
      .returning()
      .get().id;

    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.get("/api/systems", (c) => c.json({ ok: true }));
    app.post("/api/systems/1/check", (c) => c.json({ ok: true }));
    app.get("/api/credentials", (c) => c.json({ ok: true }));
    app.route("/api/settings", settingsRoutes);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("read-only sessions can view data and general settings", async () => {
    const cookie = await sessionCookie(viewerId, "viewer");
    expect((await app.request("/api/systems", { headers: { cookie } })).status).toBe(200);
    expect((await app.request("/api/settings", { headers: { cookie } })).status).toBe(200);
  });

  test("read-only sessions cannot change anything or open management areas", async () => {
    const cookie = await sessionCookie(viewerId, "viewer");
    const post = await app.request("/api/systems/1/check", { method: "POST", headers: { cookie } });
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({ code: "READ_ONLY" });
    expect((await app.request("/api/credentials", { headers: { cookie } })).status).toBe(403);
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ oidc_unmatched_role: "admin" }),
    });
    expect(put.status).toBe(403);
    expect(readSetting("oidc_unmatched_role")).toBe("deny");
  });

  test("admin sessions keep full access", async () => {
    const cookie = await sessionCookie(adminId, "admin", "password");
    expect((await app.request("/api/systems/1/check", { method: "POST", headers: { cookie } })).status).toBe(200);
    expect((await app.request("/api/credentials", { headers: { cookie } })).status).toBe(200);
  });

  test("API tokens never exceed the owner's role", async () => {
    const token = "ludash_readonly_owner_token";
    getDb()
      .insert(apiTokens)
      .values({ userId: viewerId, name: "t", tokenHash: await hashToken(token), readOnly: 0 })
      .run();
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.request("/api/systems", { headers }, { incoming })).status).toBe(200);
    expect(
      (await app.request("/api/systems/1/check", { method: "POST", headers }, { incoming })).status,
    ).toBe(403);
  });

  test("validates and normalizes OIDC settings", async () => {
    const cookie = await sessionCookie(adminId, "admin", "password");
    const put = (body: Record<string, string>) =>
      app.request("/api/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await put({ oidc_scope: "profile email" })).status).toBe(400);
    expect((await put({ oidc_unmatched_role: "owner" })).status).toBe(400);

    const ok = await put({
      oidc_scope: "openid  groups",
      oidc_groups_claim: "  ",
      oidc_admin_groups: " ops, ops ,admins,",
      oidc_read_only_groups: "viewers",
      oidc_unmatched_role: "read-only",
      oidc_end_session: "no",
    });
    expect(ok.status).toBe(200);
    expect(readSetting("oidc_end_session")).toBe("true");
    expect((await put({ oidc_end_session: "false" })).status).toBe(200);
    expect(readSetting("oidc_end_session")).toBe("false");
    expect(getOidcPolicy()).toEqual({
      scope: "openid groups",
      groupsClaim: "groups",
      adminGroups: ["ops", "admins"],
      readOnlyGroups: ["viewers"],
      unmatchedRole: "read-only",
    });
  });
});
