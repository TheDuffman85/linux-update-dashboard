import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, hiddenUpdates, settings, systems, updateCache, updateHistory } from "../../server/db/schema";
import systemsRoutes from "../../server/routes/systems";
import { getEncryptor, initEncryptor } from "../../server/security";
import { listSystems } from "../../server/services/system-service";
import { issueValidatedConfigToken } from "../../server/services/system-connection-validation";
import { initSSHManager } from "../../server/ssh/connection";

function createSystemCredential(username: string): number {
  const db = getDb();
  const inserted = db.insert(credentials).values({
    name: `Credential for ${username}`,
    kind: "usernamePassword",
    payload: JSON.stringify({
      username,
      password: "encrypted-password",
    }),
  }).returning({ id: credentials.id }).get();
  return inserted.id;
}

function createValidatedConfigToken(data: {
  systemId?: number;
  hostname: string;
  port: number;
  credentialId: number;
  proxyJumpSystemId?: number | null;
  hostKeyVerificationEnabled?: boolean;
}): string {
  return issueValidatedConfigToken({
    systemId: data.systemId,
    hostname: data.hostname,
    port: data.port,
    credentialId: data.credentialId,
    proxyJumpSystemId: data.proxyJumpSystemId ?? null,
    hostKeyVerificationEnabled: data.hostKeyVerificationEnabled ?? false,
  });
}

describe("systems reorder route", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-systems-routes-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reorders systems when given a complete ordered ID list", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values([
      {
        sortOrder: 0,
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        sortOrder: 1,
        name: "Bravo",
        hostname: "bravo.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        sortOrder: 2,
        name: "Charlie",
        hostname: "charlie.local",
        port: 22,
        authType: "password",
        username: "root",
      },
    ]).returning({ id: systems.id }).all();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemIds: [inserted[2].id, inserted[0].id, inserted[1].id],
      }),
    });

    expect(res.status).toBe(200);
    expect(listSystems().map((system) => system.name)).toEqual([
      "Charlie",
      "Alpha",
      "Bravo",
    ]);
  });

  test("rejects reorder payloads that omit systems", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values([
      {
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      },
      {
        name: "Bravo",
        hostname: "bravo.local",
        port: 22,
        authType: "password",
        username: "root",
      },
    ]).returning({ id: systems.id }).all();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemIds: [inserted[0].id],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("include every system exactly once");
  });

  test("returns 409 when creating a system with a duplicate connection tuple", async () => {
    const db = getDb();
    db.insert(systems).values({
      name: "Primary",
      hostname: "alpha.local",
      port: 22,
      authType: "password",
      username: "root",
    }).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Primary Copy",
        hostname: "alpha.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        validatedConfigToken: createValidatedConfigToken({
          hostname: "alpha.local",
          port: 22,
          credentialId,
        }),
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already exists");
  });

  test("allows creating a system without a validated host-key token", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Untrusted Save",
        hostname: "untrusted.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: true,
      }),
    });

    expect(res.status).toBe(201);
    const created = listSystems().find((system) => system.name === "Untrusted Save");
    expect(created?.hostKeyVerificationEnabled).toBe(1);
    expect(created?.trustedHostKey).toBeNull();
  });

  test("rejects non-boolean excludeFromUpgradeAll values", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Flags",
        hostname: "bad-flags.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        excludeFromUpgradeAll: "true",
        validatedConfigToken: createValidatedConfigToken({
          hostname: "bad-flags.local",
          port: 22,
          credentialId,
        }),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("excludeFromUpgradeAll must be a boolean");
  });

  test("rejects invalid disabled package manager lists", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Managers",
        hostname: "bad-managers.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        disabledPkgManagers: ["apt", 123],
        validatedConfigToken: createValidatedConfigToken({
          hostname: "bad-managers.local",
          port: 22,
          credentialId,
        }),
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("disabledPkgManagers must be an array of strings");
  });

  test("rejects unsupported package manager config managers", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Manager Config",
        hostname: "bad-manager-config.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        pkgManagerConfigs: {
          snap: {
            refreshAppstreamOnCheck: true,
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pkgManagerConfigs.snap is not supported");
  });

  test("rejects invalid package manager config values", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Config Value",
        hostname: "bad-config-value.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        pkgManagerConfigs: {
          apt: {
            defaultUpgradeMode: "dist-upgrade",
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pkgManagerConfigs.apt.defaultUpgradeMode must be 'upgrade' or 'full-upgrade'");
  });

  test("rejects invalid signing-key automation config values", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad Signing Key Config",
        hostname: "bad-signing-key-config.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        pkgManagerConfigs: {
          yum: {
            autoAcceptNewSigningKeysOnCheck: "yes",
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("pkgManagerConfigs.yum.autoAcceptNewSigningKeysOnCheck must be a boolean");
  });

  test("allows creating the same connection tuple behind a different ProxyJump host", async () => {
    const db = getDb();
    const jumpCredentialId = createSystemCredential("jump");
    const targetCredentialId = createSystemCredential("root");
    const inserted = db.insert(systems).values([
      {
        name: "Jump One",
        hostname: "jump-one.local",
        port: 22,
        credentialId: jumpCredentialId,
        authType: "password",
        username: "jump",
      },
      {
        name: "Jump Two",
        hostname: "jump-two.local",
        port: 22,
        credentialId: jumpCredentialId,
        authType: "password",
        username: "jump",
      },
      {
        name: "Target One",
        hostname: "shared.internal",
        port: 22,
        credentialId: targetCredentialId,
        proxyJumpSystemId: null,
        authType: "password",
        username: "root",
      },
    ]).returning({ id: systems.id }).all();

    db.update(systems)
      .set({ proxyJumpSystemId: inserted[0].id })
      .where(eq(systems.id, inserted[2].id))
      .run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Target Two",
        hostname: "shared.internal",
        port: 22,
        credentialId: targetCredentialId,
        proxyJumpSystemId: inserted[1].id,
        hostKeyVerificationEnabled: false,
      }),
    });

    expect(res.status).toBe(201);
    const created = listSystems().find((system) => system.name === "Target Two");
    expect(created?.proxyJumpSystemId).toBe(inserted[1].id);
  });

  test("persists per-system visibility flags on create and update", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const createRes = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Hidden System",
        hostname: "hidden.local",
        port: 22,
        credentialId,
        autoHideKeptBackUpdates: true,
        hidden: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = listSystems().find((system) => system.name === "Hidden System");
    expect(created?.autoHideKeptBackUpdates).toBe(1);
    expect(created?.hidden).toBe(1);

    const updateRes = await app.request(`/api/systems/${created!.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Hidden System",
        hostname: "hidden.local",
        port: 22,
        credentialId,
        autoHideKeptBackUpdates: false,
        hidden: false,
      }),
    });

    expect(updateRes.status).toBe(200);
    const updated = listSystems().find((system) => system.id === created!.id);
    expect(updated?.autoHideKeptBackUpdates).toBe(0);
    expect(updated?.hidden).toBe(0);
  });

  test("persists and serializes package manager configs on create and update", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const createRes = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Configurable System",
        hostname: "configurable.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        pkgManagerConfigs: {
          apt: {
            defaultUpgradeMode: "full-upgrade",
          },
          pacman: {
            refreshDatabasesOnCheck: false,
          },
        },
      }),
    });

    expect(createRes.status).toBe(201);
    const created = listSystems().find((system) => system.name === "Configurable System");
    expect(created?.pkgManagerConfigs).toBe(JSON.stringify({
      apt: {
        defaultUpgradeMode: "full-upgrade",
      },
      pacman: {
        refreshDatabasesOnCheck: false,
      },
    }));

    const listRes = await app.request("/api/systems");
    const listBody = await listRes.json();
    const listed = listBody.systems.find((system: { id: number }) => system.id === created!.id);
    expect(listed.pkgManagerConfigs).toEqual({
      apt: {
        defaultUpgradeMode: "full-upgrade",
      },
      pacman: {
        refreshDatabasesOnCheck: false,
      },
    });

    const updateRes = await app.request(`/api/systems/${created!.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Configurable System",
        hostname: "configurable.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        pkgManagerConfigs: {
          dnf: {
            defaultUpgradeMode: "distro-sync",
            refreshMetadataOnCheck: true,
          },
          yum: {
            autoAcceptNewSigningKeysOnCheck: true,
          },
        },
      }),
    });

    expect(updateRes.status).toBe(200);

    const detailRes = await app.request(`/api/systems/${created!.id}`);
    const detailBody = await detailRes.json();
    expect(detailBody.system.pkgManagerConfigs).toEqual({
      dnf: {
        defaultUpgradeMode: "distro-sync",
        refreshMetadataOnCheck: true,
      },
      yum: {
        autoAcceptNewSigningKeysOnCheck: true,
      },
    });
  });

  test("uses the activity history limit setting for system detail responses", async () => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "History Limit System",
      hostname: "history-limit.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;

    db.update(settings)
      .set({ value: "2" })
      .where(eq(settings.key, "activity_history_limit"))
      .run();

    db.insert(updateHistory).values([
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "success",
        startedAt: "2026-03-19 10:00:00",
        completedAt: "2026-03-19 10:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "warning",
        startedAt: "2026-03-19 11:00:00",
        completedAt: "2026-03-19 11:00:05",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "failed",
        startedAt: "2026-03-19 12:00:00",
        completedAt: "2026-03-19 12:00:05",
      },
    ]).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.history).toHaveLength(2);
    expect(body.history.map((entry: { status: string }) => entry.status)).toEqual([
      "failed",
      "warning",
    ]);
  });

  test("updating package manager configs does not clear cached updates when enabled managers are unchanged", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("root");
    const systemId = db.insert(systems).values({
      name: "APT Cache Preserve",
      hostname: "apt-cache-preserve.local",
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;

    db.insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "openssl",
      currentVersion: "1.0",
      newVersion: "1.1",
    }).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "APT Cache Preserve",
        hostname: "apt-cache-preserve.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
        disabledPkgManagers: [],
        pkgManagerConfigs: {
          apt: {
            defaultUpgradeMode: "full-upgrade",
          },
        },
      }),
    });

    expect(res.status).toBe(200);

    const detailRes = await app.request(`/api/systems/${systemId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();

    expect(detailBody.system.updateCount).toBe(1);
    expect(detailBody.updates.map((row: { packageName: string }) => row.packageName)).toEqual(["openssl"]);
  });

  test("filters hidden systems when requesting visible scope", async () => {
    const db = getDb();
    db.insert(systems).values([
      {
        name: "Visible",
        hostname: "visible.local",
        port: 22,
        authType: "password",
        username: "root",
        hidden: 0,
      },
      {
        name: "Hidden",
        hostname: "hidden.local",
        port: 22,
        authType: "password",
        username: "root",
        hidden: 1,
      },
    ]).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems?scope=visible");
    expect(res.status).toBe(200);

    const body = await res.json() as { systems: Array<{ name: string }> };
    expect(body.systems).toHaveLength(1);
    expect(body.systems[0].name).toBe("Visible");
  });

  test("serializes the per-system kept-back flag without the removed legacy field", async () => {
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const credentialId = createSystemCredential("root");

    const createRes = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "APT System",
        hostname: "apt-system.local",
        port: 22,
        credentialId,
        autoHideKeptBackUpdates: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const created = listSystems().find((system) => system.name === "APT System");

    const listRes = await app.request("/api/systems");
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const listed = listBody.systems.find((system: { id: number }) => system.id === created!.id);
    expect(listed.autoHideKeptBackUpdates).toBe(1);
    expect("ignoreKeptBackPackages" in listed).toBe(false);

    const detailRes = await app.request(`/api/systems/${created!.id}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.system.autoHideKeptBackUpdates).toBe(1);
    expect(detailBody.system.pkgManagerConfigs).toEqual({
      apt: {
        autoHideKeptBackUpdates: true,
      },
    });
    expect("ignoreKeptBackPackages" in detailBody.system).toBe(false);
  });

  test("includes the latest completed check summary on list and detail payloads", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("root");
    const systemId = db.insert(systems).values({
      name: "Check Summary",
      hostname: "check-summary.local",
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
      isReachable: 1,
    }).returning({ id: systems.id }).get().id;

    db.insert(updateHistory).values([
      {
        systemId,
        action: "upgrade_all",
        pkgManager: "apt",
        status: "failed",
        error: "ignore this upgrade failure",
        startedAt: "2026-01-01 08:00:00",
        completedAt: "2026-01-01 08:01:00",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "started",
        startedAt: "2026-01-01 09:00:00",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "warning",
        error: "[apt] partial failure",
        startedAt: "2026-01-01 09:30:00",
        completedAt: "2026-01-01 09:31:00",
      },
      {
        systemId,
        action: "check",
        pkgManager: "apt",
        status: "failed",
        error: "[apt] older failure",
        startedAt: "2026-01-01 07:30:00",
        completedAt: "2026-01-01 07:31:00",
      },
    ]).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const listRes = await app.request("/api/systems");
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const listed = listBody.systems.find((system: { id: number }) => system.id === systemId);
    expect(listed.lastCheck).toMatchObject({
      status: "warning",
      error: "[apt] partial failure",
      startedAt: "2026-01-01 09:30:00",
      completedAt: "2026-01-01 09:31:00",
    });

    const detailRes = await app.request(`/api/systems/${systemId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.system.lastCheck).toMatchObject({
      status: "warning",
      error: "[apt] partial failure",
      startedAt: "2026-01-01 09:30:00",
      completedAt: "2026-01-01 09:31:00",
    });
  });

  test("reports host-key approval as needed when a ProxyJump hop is untrusted", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("root");
    const inserted = db.insert(systems).values([
      {
        name: "Jump",
        hostname: "jump.local",
        port: 22,
        credentialId,
        authType: "password",
        username: "root",
        hostKeyVerificationEnabled: 1,
        trustedHostKey: null,
      },
      {
        name: "Target",
        hostname: "target.local",
        port: 22,
        credentialId,
        proxyJumpSystemId: null,
        authType: "password",
        username: "root",
        hostKeyVerificationEnabled: 1,
        trustedHostKey: "dGFyZ2V0LWtleQ==",
        trustedHostKeyAlgorithm: "ssh-ed25519",
        trustedHostKeyFingerprintSha256: "SHA256:target",
      },
    ]).returning({ id: systems.id }).all();

    db.update(systems)
      .set({ proxyJumpSystemId: inserted[0].id })
      .where(eq(systems.id, inserted[1].id))
      .run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const listRes = await app.request("/api/systems");
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const listed = listBody.systems.find((system: { id: number }) => system.id === inserted[1].id);
    expect(listed.hostKeyStatus).toBe("needs_approval");

    const detailRes = await app.request(`/api/systems/${inserted[1].id}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.system.hostKeyStatus).toBe("needs_approval");
  });

  test("reports host-key approval as needed when the latest check failed host-key verification", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("testuser");
    const systemId = db.insert(systems).values({
      name: "Test APT",
      hostname: "localhost",
      port: 2001,
      credentialId,
      authType: "password",
      username: "testuser",
      hostKeyVerificationEnabled: 1,
      trustedHostKey: "ZmFrZS1ob3N0LWtleQ==",
      trustedHostKeyAlgorithm: "ssh-ed25519",
      trustedHostKeyFingerprintSha256: "SHA256:stored",
      hostKeyTrustedAt: "2026-03-16 08:00:00",
    }).returning({ id: systems.id }).get().id;

    db.insert(updateHistory).values({
      systemId,
      action: "check",
      pkgManager: "apt",
      status: "failed",
      error: "HostKeyVerificationError: SSH host key approval required",
      startedAt: "2026-03-17 09:00:00",
      completedAt: "2026-03-17 09:01:00",
    }).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const listRes = await app.request("/api/systems");
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    const listed = listBody.systems.find((system: { id: number }) => system.id === systemId);
    expect(listed.hostKeyStatus).toBe("needs_approval");

    const detailRes = await app.request(`/api/systems/${systemId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.system.hostKeyStatus).toBe("needs_approval");
  });

  test("keeps host-key status verified when the key was re-approved after a failed check", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("testuser");
    const systemId = db.insert(systems).values({
      name: "Recovered Host Key",
      hostname: "localhost",
      port: 2002,
      credentialId,
      authType: "password",
      username: "testuser",
      hostKeyVerificationEnabled: 1,
      trustedHostKey: "bmV3LWhvc3Qta2V5",
      trustedHostKeyAlgorithm: "ssh-ed25519",
      trustedHostKeyFingerprintSha256: "SHA256:new",
      hostKeyTrustedAt: "2026-03-17 10:30:00",
    }).returning({ id: systems.id }).get().id;

    db.insert(updateHistory).values({
      systemId,
      action: "check",
      pkgManager: "apt",
      status: "failed",
      error: "HostKeyVerificationError: SSH host key approval required",
      startedAt: "2026-03-17 09:00:00",
      completedAt: "2026-03-17 09:01:00",
    }).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const detailRes = await app.request(`/api/systems/${systemId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.system.hostKeyStatus).toBe("verified");
  });

  test("returns 409 when updating a system to match another connection tuple", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values([
      {
        name: "Alpha",
        hostname: "alpha.local",
        port: 22,
        credentialId: createSystemCredential("root"),
        authType: "password",
        username: "root",
      },
      {
        name: "Bravo",
        hostname: "bravo.local",
        port: 2222,
        credentialId: createSystemCredential("admin"),
        authType: "password",
        username: "admin",
      },
    ]).returning({ id: systems.id }).all();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);
    const replacementCredentialId = createSystemCredential("root");

    const res = await app.request(`/api/systems/${inserted[1].id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bravo",
        hostname: "alpha.local",
        port: 22,
        credentialId: replacementCredentialId,
        hostKeyVerificationEnabled: false,
        validatedConfigToken: createValidatedConfigToken({
          systemId: inserted[1].id,
          hostname: "alpha.local",
          port: 22,
          credentialId: replacementCredentialId,
        }),
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already exists");
  });

  test("accepts a duplicate-flow validation token when saving with a new ProxyJump host", async () => {
    const db = getDb();
    const jumpCredentialId = createSystemCredential("jump");
    const targetCredentialId = createSystemCredential("root");
    const inserted = db.insert(systems).values([
      {
        name: "Jump One",
        hostname: "jump-one.local",
        port: 22,
        credentialId: jumpCredentialId,
        authType: "password",
        username: "jump",
      },
      {
        name: "Jump Two",
        hostname: "jump-two.local",
        port: 22,
        credentialId: jumpCredentialId,
        authType: "password",
        username: "jump",
      },
      {
        name: "Source",
        hostname: "shared.internal",
        port: 22,
        credentialId: targetCredentialId,
        proxyJumpSystemId: null,
        authType: "password",
        username: "root",
        hostKeyVerificationEnabled: 1,
        trustedHostKey: "ZmFrZS1ob3N0LWtleQ==",
        trustedHostKeyAlgorithm: "ssh-ed25519",
        trustedHostKeyFingerprintSha256: "SHA256:source",
        hostKeyTrustedAt: "2026-03-09 10:00:00",
      },
    ]).returning({ id: systems.id }).all();

    db.update(systems)
      .set({ proxyJumpSystemId: inserted[0].id })
      .where(eq(systems.id, inserted[2].id))
      .run();

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).testConnection = async () => ({
      success: true,
      message: "Connection successful",
    });
    (sshManager as any).connect = async () => {
      throw new Error("skip detection");
    };

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const testRes = await app.request("/api/systems/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "shared.internal",
        port: 22,
        credentialId: targetCredentialId,
        proxyJumpSystemId: inserted[1].id,
        hostKeyVerificationEnabled: true,
        sourceSystemId: inserted[2].id,
      }),
    });

    expect(testRes.status).toBe(200);
    const testBody = await testRes.json();
    expect(testBody.validatedConfigToken).toEqual(expect.any(String));

    const createRes = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Duplicated Through Jump Two",
        hostname: "shared.internal",
        port: 22,
        credentialId: targetCredentialId,
        proxyJumpSystemId: inserted[1].id,
        hostKeyVerificationEnabled: true,
        sourceSystemId: inserted[2].id,
        validatedConfigToken: testBody.validatedConfigToken,
      }),
    });

    expect(createRes.status).toBe(201);
  });

  test("rejects deleting a system that is referenced as a ProxyJump host", async () => {
    const db = getDb();
    const jumpCredentialId = createSystemCredential("jump");
    const targetCredentialId = createSystemCredential("target");
    const inserted = db.insert(systems).values([
      {
        name: "Jump",
        hostname: "jump.local",
        port: 22,
        credentialId: jumpCredentialId,
        authType: "password",
        username: "jump",
      },
      {
        name: "Target",
        hostname: "target.local",
        port: 22,
        credentialId: targetCredentialId,
        authType: "password",
        username: "target",
      },
    ]).returning({ id: systems.id }).all();

    db.update(systems)
      .set({ proxyJumpSystemId: inserted[0].id })
      .where(eq(systems.id, inserted[1].id))
      .run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${inserted[0].id}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("ProxyJump");
  });

  test("revokes the stored approved host key", async () => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "Trusted",
      hostname: "trusted.local",
      port: 22,
      credentialId: createSystemCredential("root"),
      authType: "password",
      username: "root",
      hostKeyVerificationEnabled: 1,
      trustedHostKey: "ZmFrZS1ob3N0LWtleQ==",
      trustedHostKeyAlgorithm: "ssh-ed25519",
      trustedHostKeyFingerprintSha256: "SHA256:abc",
      hostKeyTrustedAt: "2026-03-09 10:00:00",
    }).returning({ id: systems.id }).get().id;

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}/revoke-host-key`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    const updated = getDb().select().from(systems).where(eq(systems.id, systemId)).get();
    expect(updated?.trustedHostKey).toBeNull();
    expect(updated?.trustedHostKeyAlgorithm).toBeNull();
    expect(updated?.trustedHostKeyFingerprintSha256).toBeNull();
    expect(updated?.hostKeyTrustedAt).toBeNull();
  });

  test("clears stored host key when saving a system with verification disabled", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("root");
    const systemId = db.insert(systems).values({
      name: "Disable Verification",
      hostname: "disable.local",
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
      hostKeyVerificationEnabled: 1,
      trustedHostKey: "ZmFrZS1ob3N0LWtleQ==",
      trustedHostKeyAlgorithm: "ssh-ed25519",
      trustedHostKeyFingerprintSha256: "SHA256:abc",
      hostKeyTrustedAt: "2026-03-09 10:00:00",
    }).returning({ id: systems.id }).get().id;

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Disable Verification",
        hostname: "disable.local",
        port: 22,
        credentialId,
        hostKeyVerificationEnabled: false,
      }),
    });

    expect(res.status).toBe(200);
    const updated = db.select().from(systems).where(eq(systems.id, systemId)).get();
    expect(updated?.hostKeyVerificationEnabled).toBe(0);
    expect(updated?.trustedHostKey).toBeNull();
    expect(updated?.trustedHostKeyAlgorithm).toBeNull();
    expect(updated?.trustedHostKeyFingerprintSha256).toBeNull();
  });

  test("allows clearing all disabled package managers on update", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("root");
    const systemId = db.insert(systems).values({
      name: "Pkg Toggle",
      hostname: "pkg-toggle.local",
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
      detectedPkgManagers: JSON.stringify(["apt"]),
      disabledPkgManagers: JSON.stringify(["apt"]),
    }).returning({ id: systems.id }).get().id;

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Pkg Toggle",
        hostname: "pkg-toggle.local",
        port: 22,
        credentialId,
        disabledPkgManagers: [],
      }),
    });

    expect(res.status).toBe(200);
    const updated = db.select().from(systems).where(eq(systems.id, systemId)).get();
    expect(updated?.disabledPkgManagers).toBe("[]");
  });

  test("clears cached updates when disabled package managers change", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("root");
    const systemId = db.insert(systems).values({
      name: "Cache Clear",
      hostname: "cache-clear.local",
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
      detectedPkgManagers: JSON.stringify(["apt"]),
      disabledPkgManagers: JSON.stringify([]),
    }).returning({ id: systems.id }).get().id;

    db.insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "openssl",
      currentVersion: "1.0",
      newVersion: "1.1",
    }).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Cache Clear",
        hostname: "cache-clear.local",
        port: 22,
        credentialId,
        disabledPkgManagers: ["apt"],
      }),
    });

    expect(res.status).toBe(200);
    const cached = db
      .select()
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all();
    expect(cached).toHaveLength(0);
  });

  test("returns only visible updates and active hidden updates in system detail", async () => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "Hidden Detail",
      hostname: "hidden-detail.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;

    db.insert(updateCache).values([
      {
        systemId,
        pkgManager: "apt",
        packageName: "openssl",
        currentVersion: "1.0",
        newVersion: "1.1",
        isSecurity: 1,
      },
      {
        systemId,
        pkgManager: "apt",
        packageName: "bash",
        currentVersion: "5.1",
        newVersion: "5.2",
      },
    ]).run();

    db.insert(hiddenUpdates).values([
      {
        systemId,
        pkgManager: "apt",
        packageName: "openssl",
        currentVersion: "1.0",
        newVersion: "1.1",
        isSecurity: 1,
        active: 1,
        lastMatchedAt: "2026-01-01 00:00:00",
      },
      {
        systemId,
        pkgManager: "apt",
        packageName: "oldpkg",
        currentVersion: "1.0",
        newVersion: "1.1",
        active: 0,
        lastMatchedAt: "2026-01-01 00:00:00",
        inactiveSince: "2026-01-10 00:00:00",
      },
    ]).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.system.updateCount).toBe(1);
    expect(body.system.securityCount).toBe(0);
    expect(body.system.keptBackCount).toBe(0);
    expect(body.updates.map((row: { packageName: string }) => row.packageName)).toEqual(["bash"]);
    expect(body.hiddenUpdates).toHaveLength(1);
    expect(body.hiddenUpdates[0].packageName).toBe("openssl");
  });

  test("enabling per-system kept-back auto-hide immediately hides cached kept-back updates", async () => {
    const db = getDb();
    const credentialId = createSystemCredential("root");
    const systemId = db.insert(systems).values({
      name: "Kept Back Toggle",
      hostname: "kept-back-toggle.local",
      port: 22,
      credentialId,
      authType: "password",
      username: "root",
      autoHideKeptBackUpdates: 0,
    }).returning({ id: systems.id }).get().id;

    db.insert(updateCache).values([
      {
        systemId,
        pkgManager: "apt",
        packageName: "keptback-app",
        currentVersion: "1.0",
        newVersion: "1.1",
        isKeptBack: 1,
      },
      {
        systemId,
        pkgManager: "apt",
        packageName: "normal-app",
        currentVersion: "2.0",
        newVersion: "2.1",
        isKeptBack: 0,
      },
    ]).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${systemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Kept Back Toggle",
        hostname: "kept-back-toggle.local",
        port: 22,
        credentialId,
        autoHideKeptBackUpdates: true,
      }),
    });

    expect(res.status).toBe(200);

    const detailRes = await app.request(`/api/systems/${systemId}`);
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();

    expect(detailBody.system.autoHideKeptBackUpdates).toBe(1);
    expect(detailBody.updates.map((row: { packageName: string }) => row.packageName)).toEqual(["normal-app"]);
    expect(detailBody.hiddenUpdates.map((row: { packageName: string }) => row.packageName)).toEqual(["keptback-app"]);
  });

  test("creates and deletes hidden updates through the route", async () => {
    const db = getDb();
    const systemId = db.insert(systems).values({
      name: "Hide Route",
      hostname: "hide-route.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;

    db.insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName: "openssl",
      currentVersion: "1.0",
      newVersion: "1.1",
      isSecurity: 1,
    }).run();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const createRes = await app.request(`/api/systems/${systemId}/hidden-updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pkgManager: "apt",
        packageName: "openssl",
        newVersion: "1.1",
      }),
    });

    expect(createRes.status).toBe(201);
    const createBody = await createRes.json();
    expect(createBody.hiddenUpdate.packageName).toBe("openssl");

    const stored = db
      .select()
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.systemId, systemId))
      .get();
    expect(stored?.active).toBe(1);

    const deleteRes = await app.request(
      `/api/systems/${systemId}/hidden-updates/${stored?.id}`,
      { method: "DELETE" },
    );
    expect(deleteRes.status).toBe(200);

    const remaining = db
      .select()
      .from(hiddenUpdates)
      .where(eq(hiddenUpdates.systemId, systemId))
      .all();
    expect(remaining).toHaveLength(0);
  });
});
