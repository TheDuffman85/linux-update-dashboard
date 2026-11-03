import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, credentials, systems, users } from "../../server/db/schema";
import systemsRoutes from "../../server/routes/systems";
import tokensRoutes from "../../server/routes/api-tokens";
import updatesRoutes from "../../server/routes/updates";
import { createApp } from "../../server/app";
import { authMiddleware, MANAGEMENT_PREFIXES } from "../../server/middleware/auth";
import { hashToken } from "../../server/auth/api-token";
import { TOKEN_WRITE_RULES, findTokenWriteRule } from "../../server/auth/api-token-access";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { logger } from "../../server/logger";
import { API_TOKEN_PERMISSIONS, parseApiTokenPermissions } from "../../shared/api-token-permissions";

vi.mock("../../server/generated/distro-lifecycle-data.json", async () => ({
  default: { catalog: (await import("../fixtures/distro-lifecycle-catalog.json")).default },
}));

const incoming = {
  socket: { remoteAddress: "127.0.0.1", remotePort: 12345, remoteFamily: "IPv4" },
};

const MIGRATED_READ_WRITE = ["updates:check", "updates:apply", "systems:organize", "systems:remove"];

const HOST_KEY_CHALLENGE = {
  role: "target",
  host: "new.local",
  port: 22,
  algorithm: "ssh-ed25519",
  fingerprintSha256: "SHA256:abc",
  rawKey: "cmF3LWtleQ==",
};

describe("API token permissions", () => {
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-token-permissions-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.route("/api/systems", systemsRoutes);
    app.route("/api", updatesRoutes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createOwner(role: "admin" | "read-only" = "admin"): number {
    return getDb().insert(users).values({
      username: `owner-${randomBytes(4).toString("hex")}`,
      passwordHash: "unused",
      isAdmin: role === "admin" ? 1 : 0,
      role,
    }).returning({ id: users.id }).get().id;
  }

  async function createToken(values: {
    permissions?: string;
    userId?: number;
  }): Promise<string> {
    const token = `ludash_${randomBytes(32).toString("hex")}`;
    getDb().insert(apiTokens).values({
      userId: values.userId ?? createOwner(),
      name: "test",
      tokenHash: await hashToken(token),
      permissions: values.permissions ?? "[]",
    }).run();
    return token;
  }

  function withPermissions(...permissions: string[]): Promise<string> {
    return createToken({ permissions: JSON.stringify(permissions) });
  }

  function createCredential(username = "root"): number {
    return getDb().insert(credentials).values({
      name: `Credential ${randomBytes(4).toString("hex")}`,
      kind: "usernamePassword",
      payload: JSON.stringify({
        username,
        password: getEncryptor().encrypt("secret"),
      }),
    }).returning({ id: credentials.id }).get().id;
  }

  function createSystem(credentialId: number, hostname = "existing.local"): number {
    return getDb().insert(systems).values({
      name: hostname,
      hostname,
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;
  }

  function send(token: string, method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { incoming });
  }

  function mockSsh() {
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    vi.spyOn(sshManager, "connect").mockRejectedValue(new Error("no connection in tests"));
    return sshManager;
  }

  describe("route table", () => {
    function listAppWriteRoutes() {
      return createApp().routes
        .filter((route) => !["ALL", "GET", "HEAD", "OPTIONS"].includes(route.method))
        .filter((route) => route.path.startsWith("/api/"))
        .filter((route) => !MANAGEMENT_PREFIXES.some((prefix) => route.path.startsWith(prefix)));
    }

    test("covers every state-changing route a token can reach", () => {
      const routes = listAppWriteRoutes();
      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(findTokenWriteRule(route.method, route.path)?.path, `${route.method} ${route.path}`)
          .toBe(route.path);
      }
    });

    test("has no rules for routes that do not exist", () => {
      const routes = listAppWriteRoutes().map((route) => `${route.method} ${route.path}`);
      for (const rule of TOKEN_WRITE_RULES) {
        expect(routes, `${rule.method} ${rule.path}`).toContain(`${rule.method} ${rule.path}`);
      }
    });

    test("resolves literal paths before parameterized ones", () => {
      expect(findTokenWriteRule("PUT", "/api/systems/reorder")?.path).toBe("/api/systems/reorder");
      expect(findTokenWriteRule("PUT", "/api/systems/12")?.path).toBe("/api/systems/:id");
      expect(findTokenWriteRule("PUT", "/api/systems/")).toBeUndefined();
    });
  });

  describe("parsing permissions", () => {
    test("returns known permissions in canonical order", () => {
      expect(parseApiTokenPermissions('["systems:edit","updates:check","systems:edit"]'))
        .toEqual(["updates:check", "systems:edit"]);
    });

    test("malformed or unknown stored values grant nothing", () => {
      expect(parseApiTokenPermissions("{not json")).toEqual([]);
      expect(parseApiTokenPermissions('"systems:add"')).toEqual([]);
      expect(parseApiTokenPermissions('["systems:everything"]')).toEqual([]);
    });
  });

  describe("migrating read-only and read/write tokens", () => {
    function createLegacyDatabase(path: string, withPermissionsColumn = false) {
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT);
        INSERT INTO users (username) VALUES ('admin');
        CREATE TABLE api_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT,
          token_hash TEXT NOT NULL UNIQUE,
          read_only INTEGER NOT NULL DEFAULT 1,
          ${withPermissionsColumn ? "permissions TEXT," : ""}
          expires_at TEXT,
          last_used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO api_tokens (user_id, name, token_hash, read_only) VALUES (1, 'reader', 'hash-reader', 1);
        INSERT INTO api_tokens (user_id, name, token_hash, read_only) VALUES (1, 'writer', 'hash-writer', 0);
      `);
      return legacy;
    }

    function storedTokens() {
      return Object.fromEntries(
        getDb().select().from(apiTokens).all().map((row) => [row.name, parseApiTokenPermissions(row.permissions)]),
      );
    }

    test("read-only tokens get no permissions and read/write tokens the ones they had", () => {
      closeDatabase();
      const path = join(tempDir, "legacy.db");
      createLegacyDatabase(path).close();

      initDatabase(path);

      expect(storedTokens()).toEqual({ reader: [], writer: MIGRATED_READ_WRITE });
      const columns = getDb().all<{ name: string }>(sql`PRAGMA table_info(api_tokens)`).map((c) => c.name);
      expect(columns).toContain("permissions");
      expect(columns).not.toContain("read_only");
    });

    test("keeps chosen permissions from a database that already had the column", () => {
      closeDatabase();
      const path = join(tempDir, "legacy-permissions.db");
      const legacy = createLegacyDatabase(path, true);
      legacy.exec(`INSERT INTO api_tokens (user_id, name, token_hash, read_only, permissions)
        VALUES (1, 'custom', 'hash-custom', 0, '["systems:add"]')`);
      legacy.close();

      initDatabase(path);

      expect(storedTokens()).toEqual({
        reader: [],
        writer: MIGRATED_READ_WRITE,
        custom: ["systems:add"],
      });
    });

    test("does not change tokens when it starts again", () => {
      closeDatabase();
      const path = join(tempDir, "legacy-restart.db");
      createLegacyDatabase(path).close();
      initDatabase(path);
      getDb().update(apiTokens).set({ permissions: "[]" }).where(eq(apiTokens.name, "writer")).run();
      closeDatabase();

      initDatabase(path);

      expect(storedTokens()).toEqual({ reader: [], writer: [] });
    });
  });

  describe("enforcement", () => {
    test("migrated read/write tokens keep their access but cannot configure connections", async () => {
      const credentialId = createCredential();
      const systemId = createSystem(credentialId);
      const token = await withPermissions(...MIGRATED_READ_WRITE);

      const added = await send(token, "POST", "/api/systems", {
        name: "New", hostname: "new.local", credentialId,
      });
      expect(added.status).toBe(403);
      expect((await send(token, "PUT", `/api/systems/${systemId}`, {
        name: "Moved", hostname: "moved.local", credentialId,
      })).status).toBe(403);

      expect((await send(token, "POST", `/api/systems/${systemId}/dismiss-root-user-banner`)).status).toBe(200);
      expect((await send(token, "POST", `/api/systems/${systemId}/revoke-host-key`)).status).toBe(200);
      expect((await send(token, "DELETE", `/api/systems/${systemId}`)).status).toBe(200);
    });

    test("tokens without permissions can read but not write", async () => {
      const token = await createToken({});
      expect((await send(token, "GET", "/api/systems")).status).toBe(200);
      const res = await send(token, "POST", "/api/systems/1/check");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "This token needs the updates:check permission" });
    });

    test("every token can read", async () => {
      const token = await withPermissions("updates:check");
      expect((await send(token, "GET", "/api/systems")).status).toBe(200);
    });

    test("a token only gets the permissions it holds", async () => {
      const systemId = createSystem(createCredential());
      const token = await withPermissions("systems:organize");

      expect((await send(token, "POST", `/api/systems/${systemId}/dismiss-root-user-banner`)).status).toBe(200);

      const check = await send(token, "POST", `/api/systems/${systemId}/check`);
      expect(check.status).toBe(403);
      expect(await check.json()).toEqual({ error: "This token needs the updates:check permission" });
      expect((await send(token, "POST", `/api/systems/${systemId}/upgrade`)).status).toBe(403);
      expect((await send(token, "POST", `/api/systems/${systemId}/reboot`)).status).toBe(403);
      expect((await send(token, "DELETE", `/api/systems/${systemId}`)).status).toBe(403);
    });

    test("a token that can only check cannot apply updates", async () => {
      const systemId = createSystem(createCredential());
      const token = await withPermissions("updates:check");
      const res = await send(token, "POST", `/api/systems/${systemId}/upgrade`);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "This token needs the updates:apply permission" });
    });

    test("unlisted routes are denied", async () => {
      const token = await withPermissions(...API_TOKEN_PERMISSIONS);
      const res = await send(token, "POST", "/api/systems/1/unknown");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "API tokens cannot use this endpoint" });
    });

    test("no permission opens script overrides or repository sources", async () => {
      const systemId = createSystem(createCredential());
      const token = await withPermissions(...API_TOKEN_PERMISSIONS);

      const overrides = await send(token, "PUT", `/api/systems/${systemId}/script-overrides`, { scriptOverrides: {} });
      expect(overrides.status).toBe(403);
      expect(await overrides.json()).toEqual({ error: "API tokens cannot modify script overrides" });

      const sources = await send(token, "PUT", `/api/systems/${systemId}/repository-sources`, {});
      expect(sources.status).toBe(403);
      expect(await sources.json()).toEqual({ error: "API tokens cannot modify repository sources" });
    });

    test("management areas stay closed with every permission", async () => {
      const token = await withPermissions(...API_TOKEN_PERMISSIONS);
      for (const path of ["/api/tokens", "/api/users", "/api/credentials", "/api/settings"]) {
        const res = await send(token, "GET", path);
        expect(res.status, path).toBe(403);
      }
    });

    test("the owner's role caps a token's permissions", async () => {
      const token = await createToken({
        userId: createOwner("read-only"),
        permissions: JSON.stringify(["systems:add"]),
      });
      const res = await send(token, "POST", "/api/systems", {
        name: "New", hostname: "new.local", credentialId: createCredential(),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "This token needs the systems:add permission" });
    });
  });

  describe("adding systems", () => {
    test("adds a system through the host-key approval flow", async () => {
      const sshManager = mockSsh();
      const testConnection = vi.spyOn(sshManager, "testConnection")
        .mockResolvedValueOnce({
          success: false,
          message: "Host key approval required",
          hostKeyChallenges: [HOST_KEY_CHALLENGE],
        } as never)
        .mockResolvedValueOnce({ success: true, message: "Connected" } as never);
      const info = vi.spyOn(logger, "info");
      const credentialId = createCredential();
      const token = await withPermissions("systems:add");
      const connection = { hostname: "new.local", port: 22, credentialId };

      const challenged = await send(token, "POST", "/api/systems/test-connection", connection);
      expect(challenged.status).toBe(200);
      const challenge = await challenged.json() as {
        hostKeyChallenges: typeof HOST_KEY_CHALLENGE[];
        trustChallengeToken: string;
      };
      expect(challenge.hostKeyChallenges).toEqual([HOST_KEY_CHALLENGE]);

      const approved = await send(token, "POST", "/api/systems/test-connection", {
        ...connection,
        trustChallengeToken: challenge.trustChallengeToken,
        approvedHostKeys: challenge.hostKeyChallenges,
      });
      expect(approved.status).toBe(200);
      const { validatedConfigToken } = await approved.json() as { validatedConfigToken: string };
      expect(validatedConfigToken).toBeTruthy();
      expect(testConnection).toHaveBeenCalledTimes(2);

      const created = await send(token, "POST", "/api/systems", {
        ...connection,
        name: "New",
        validatedConfigToken,
      });
      expect(created.status).toBe(201);
      const { id } = await created.json() as { id: number };

      const stored = getDb().select().from(systems).where(eq(systems.id, id)).get();
      expect(stored?.hostname).toBe("new.local");
      expect(stored?.trustedHostKey).toBe(HOST_KEY_CHALLENGE.rawKey);
      expect(stored?.hostKeyVerificationEnabled).toBe(1);
      expect(info).toHaveBeenCalledWith("API token: system created", expect.objectContaining({ systemId: id }));
    });

    test.each([
      ["scriptOverrides", {}],
      ["pkgManagerConfigs", {}],
      ["repositorySourceEditingEnabled", true],
    ])("rejects %s", async (field, value) => {
      const credentialId = createCredential();
      const token = await withPermissions("systems:add");
      const res = await send(token, "POST", "/api/systems", {
        name: "New", hostname: "new.local", credentialId, [field]: value,
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: `API tokens cannot set ${field}` });
      expect(getDb().select().from(systems).all()).toHaveLength(0);
    });

    test("an add-only token cannot test or trust keys of existing systems", async () => {
      const sshManager = mockSsh();
      const testConnection = vi.spyOn(sshManager, "testConnection");
      const credentialId = createCredential();
      const systemId = createSystem(credentialId);
      const token = await withPermissions("systems:add");
      const connection = { hostname: "new.local", port: 22, credentialId };

      const existing = await send(token, "POST", "/api/systems/test-connection", { ...connection, systemId });
      expect(existing.status).toBe(403);

      const approval = await send(token, "POST", "/api/systems/test-connection", {
        ...connection,
        trustChallengeToken: "any",
        approvedHostKeys: [{ ...HOST_KEY_CHALLENGE, systemId }],
      });
      expect(approval.status).toBe(403);
      expect(await approval.json()).toEqual({
        error: "This token needs the systems:edit permission for existing systems",
      });

      expect(testConnection).not.toHaveBeenCalled();
      expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.trustedHostKey).toBeNull();
    });

    test("adding does not allow editing or removing", async () => {
      const credentialId = createCredential();
      const systemId = createSystem(credentialId);
      const token = await withPermissions("systems:add");
      expect((await send(token, "PUT", `/api/systems/${systemId}`, {
        name: "Moved", hostname: "moved.local", credentialId,
      })).status).toBe(403);
      expect((await send(token, "DELETE", `/api/systems/${systemId}`)).status).toBe(403);
    });
  });

  describe("editing systems", () => {
    test("updates a system and logs the change", async () => {
      const info = vi.spyOn(logger, "info");
      const credentialId = createCredential();
      const systemId = createSystem(credentialId);
      const token = await withPermissions("systems:edit");

      const res = await send(token, "PUT", `/api/systems/${systemId}`, {
        name: "Moved", hostname: "moved.local", port: 2222, credentialId,
      });

      expect(res.status).toBe(200);
      const stored = getDb().select().from(systems).where(eq(systems.id, systemId)).get();
      expect(stored).toMatchObject({ name: "Moved", hostname: "moved.local", port: 2222 });
      expect(info).toHaveBeenCalledWith("API token: system updated", expect.objectContaining({ systemId }));
    });

    test("rejects script-affecting fields", async () => {
      const credentialId = createCredential();
      const systemId = createSystem(credentialId);
      const token = await withPermissions("systems:edit");
      const res = await send(token, "PUT", `/api/systems/${systemId}`, {
        name: "Moved", hostname: "moved.local", credentialId, pkgManagerConfigs: {},
      });
      expect(res.status).toBe(403);
      expect(getDb().select().from(systems).where(eq(systems.id, systemId)).get()?.hostname).toBe("existing.local");
    });

    test("may test existing systems and trust their host keys", async () => {
      const sshManager = mockSsh();
      vi.spyOn(sshManager, "testConnection").mockResolvedValue({
        success: false,
        message: "Host key approval required",
        hostKeyChallenges: [{ ...HOST_KEY_CHALLENGE, systemId: 1 }],
      } as never);
      const credentialId = createCredential();
      const systemId = createSystem(credentialId);
      const token = await withPermissions("systems:edit");
      const res = await send(token, "POST", "/api/systems/test-connection", {
        hostname: "existing.local", port: 22, credentialId, systemId,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveProperty("trustChallengeToken");
    });

    test("editing does not allow adding", async () => {
      const token = await withPermissions("systems:edit");
      const res = await send(token, "POST", "/api/systems", {
        name: "New", hostname: "new.local", credentialId: createCredential(),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("removing systems", () => {
    test("needs systems:remove and logs the change", async () => {
      const info = vi.spyOn(logger, "info");
      const systemId = createSystem(createCredential());
      const token = await withPermissions("systems:remove");
      expect((await send(token, "DELETE", `/api/systems/${systemId}`)).status).toBe(200);
      expect(getDb().select().from(systems).all()).toHaveLength(0);
      expect(info).toHaveBeenCalledWith("API token: system deleted", expect.objectContaining({ systemId }));
    });
  });

  describe("token management routes", () => {
    function managementApp(userId: number) {
      const tokenApp = new Hono();
      tokenApp.use("*", async (c, next) => {
        c.set("user" as never, { userId, username: "owner", role: "admin" } as never);
        await next();
      });
      tokenApp.route("/api/tokens", tokensRoutes);
      return tokenApp;
    }

    function post(tokenApp: Hono, body: unknown) {
      return tokenApp.request("/api/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    async function list(tokenApp: Hono) {
      const res = await tokenApp.request("/api/tokens");
      return (await res.json() as {
        tokens: Array<{ name: string; permissions: string[] }>;
      }).tokens;
    }

    test("stores chosen permissions in canonical order", async () => {
      const tokenApp = managementApp(createOwner());
      const res = await post(tokenApp, { name: "c", permissions: ["systems:edit", "systems:add", "systems:add"] });
      expect(res.status).toBe(200);
      expect(await list(tokenApp)).toMatchObject([
        { name: "c", permissions: ["systems:add", "systems:edit"] },
      ]);
    });

    test("creates a token that can only read without permissions", async () => {
      const tokenApp = managementApp(createOwner());
      await post(tokenApp, { name: "default" });
      await post(tokenApp, { name: "empty", permissions: [] });
      expect(await list(tokenApp)).toMatchObject([
        { name: "default", permissions: [] },
        { name: "empty", permissions: [] },
      ]);
    });

    test("permissions cannot be changed after creation", async () => {
      const tokenApp = managementApp(createOwner());
      const created = await post(tokenApp, { name: "fixed", permissions: ["updates:check"] });
      const { id } = await created.json() as { id: number };

      const res = await tokenApp.request(`/api/tokens/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "renamed", permissions: ["systems:add"] }),
      });

      expect(res.status).toBe(200);
      expect(await list(tokenApp)).toMatchObject([{ name: "renamed", permissions: ["updates:check"] }]);
    });

    test("rejects unknown permissions and the old readOnly field", async () => {
      const tokenApp = managementApp(createOwner());
      expect((await post(tokenApp, { permissions: ["systems:everything"] })).status).toBe(400);
      expect((await post(tokenApp, { permissions: "systems:add" })).status).toBe(400);
      const legacy = await post(tokenApp, { readOnly: false });
      expect(legacy.status).toBe(400);
      expect(await legacy.json()).toEqual({ error: "readOnly was replaced by permissions" });
      expect(await list(tokenApp)).toEqual([]);
    });
  });
});
