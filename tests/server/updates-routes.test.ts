import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import updatesRoutes from "../../server/routes/updates";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateCache } from "../../server/db/schema";

function seedSystemWithVisibleUpdate(packageNames: string[] = ["bash"]): number {
  const systemId = getDb()
    .insert(systems)
    .values({
      name: "Debian",
      hostname: "debian.local",
      port: 22,
      authType: "password",
      username: "root",
      hostKeyVerificationEnabled: 0,
      pkgManager: "apt",
      detectedPkgManagers: JSON.stringify(["apt"]),
    })
    .returning({ id: systems.id })
    .get().id;

  for (const packageName of packageNames) {
    getDb().insert(updateCache).values({
      systemId,
      pkgManager: "apt",
      packageName,
      currentVersion: "1.0",
      newVersion: "1.1",
      architecture: "amd64",
      repository: "stable",
      isSecurity: 0,
      isKeptBack: 0,
    }).run();
  }

  return systemId;
}

describe("updates routes validation", () => {
  test("rejects invalid system id on check endpoint", async () => {
    const app = new Hono();
    app.route("/api", updatesRoutes);

    const res = await app.request("/api/systems/not-a-number/check", {
      method: "POST",
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain("Invalid system ID");
  });

  test("rejects full-upgrade for unsupported systems", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ludash-updates-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));

    const app = new Hono();
    app.route("/api", updatesRoutes);

    try {
      const res = await app.request("/api/systems/1/full-upgrade", {
        method: "POST",
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("not supported");
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("starts selected-package upgrade jobs for valid visible packages", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ludash-updates-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));

    const app = new Hono();
    app.route("/api", updatesRoutes);

    try {
      const systemId = seedSystemWithVisibleUpdate(["bash", "curl"]);

      const res = await app.request(`/api/systems/${systemId}/upgrade-packages`, {
        method: "POST",
        body: JSON.stringify({ packageNames: ["bash", "curl"] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("started");
      expect(body.jobId).toEqual(expect.any(String));
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects empty selected-package requests", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ludash-updates-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));

    const app = new Hono();
    app.route("/api", updatesRoutes);

    try {
      const systemId = seedSystemWithVisibleUpdate();

      const res = await app.request(`/api/systems/${systemId}/upgrade-packages`, {
        method: "POST",
        body: JSON.stringify({ packageNames: [] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("At least one package name is required");
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects invalid selected-package names", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ludash-updates-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));

    const app = new Hono();
    app.route("/api", updatesRoutes);

    try {
      const systemId = seedSystemWithVisibleUpdate();

      const res = await app.request(`/api/systems/${systemId}/upgrade-packages`, {
        method: "POST",
        body: JSON.stringify({ packageNames: ["bash; rm -rf /"] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid package name");
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects selected packages that are not visible anymore", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ludash-updates-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));

    const app = new Hono();
    app.route("/api", updatesRoutes);

    try {
      const systemId = seedSystemWithVisibleUpdate(["bash"]);

      const res = await app.request(`/api/systems/${systemId}/upgrade-packages`, {
        method: "POST",
        body: JSON.stringify({ packageNames: ["openssl"] }),
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("no longer available");
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps the single-package compatibility route working", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ludash-updates-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));

    const app = new Hono();
    app.route("/api", updatesRoutes);

    try {
      const systemId = seedSystemWithVisibleUpdate(["bash"]);

      const res = await app.request(`/api/systems/${systemId}/upgrade/bash`, {
        method: "POST",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("started");
      expect(body.jobId).toEqual(expect.any(String));
    } finally {
      closeDatabase();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
