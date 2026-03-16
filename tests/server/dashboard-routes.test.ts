import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { hiddenUpdates, systems, updateCache, updateHistory } from "../../server/db/schema";
import dashboardRoutes from "../../server/routes/dashboard";
import { initEncryptor } from "../../server/security";

describe("dashboard routes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-dashboard-routes-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("hides hidden systems from dashboard stats and systems list", async () => {
    const db = getDb();
    db.insert(systems).values([
      {
        name: "Visible",
        hostname: "visible.local",
        port: 22,
        authType: "password",
        username: "root",
        isReachable: 1,
        hidden: 0,
      },
      {
        name: "Hidden",
        hostname: "hidden.local",
        port: 22,
        authType: "password",
        username: "root",
        isReachable: 1,
        hidden: 1,
      },
    ]).run();

    const app = new Hono();
    app.route("/api/dashboard", dashboardRoutes);

    const statsRes = await app.request("/api/dashboard/stats");
    expect(statsRes.status).toBe(200);
    const statsBody = await statsRes.json();
    expect(statsBody.stats.total).toBe(1);

    const systemsRes = await app.request("/api/dashboard/systems");
    expect(systemsRes.status).toBe(200);
    const systemsBody = await systemsRes.json();
    expect(systemsBody.systems).toHaveLength(1);
    expect(systemsBody.systems[0].name).toBe("Visible");
  });

  test("includes securityCount and keptBackCount in dashboard systems list", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Visible",
      hostname: "visible.local",
      port: 22,
      authType: "password",
      username: "root",
      isReachable: 1,
      hidden: 0,
    }).returning({ id: systems.id }).get();

    db.insert(updateCache).values([
      {
        systemId: inserted.id,
        pkgManager: "apt",
        packageName: "openssl",
        newVersion: "1.2.3",
        isSecurity: 1,
      },
      {
        systemId: inserted.id,
        pkgManager: "apt",
        packageName: "bash",
        newVersion: "5.2",
        isSecurity: 0,
        isKeptBack: 1,
      },
    ]).run();

    const app = new Hono();
    app.route("/api/dashboard", dashboardRoutes);

    const systemsRes = await app.request("/api/dashboard/systems");
    expect(systemsRes.status).toBe(200);
    const systemsBody = await systemsRes.json();

    expect(systemsBody.systems).toHaveLength(1);
    expect(systemsBody.systems[0].updateCount).toBe(2);
    expect(systemsBody.systems[0].securityCount).toBe(1);
    expect(systemsBody.systems[0].keptBackCount).toBe(1);
  });

  test("excludes active hidden updates from dashboard counts", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Visible",
      hostname: "visible.local",
      port: 22,
      authType: "password",
      username: "root",
      isReachable: 1,
      hidden: 0,
    }).returning({ id: systems.id }).get();

    db.insert(updateCache).values([
      {
        systemId: inserted.id,
        pkgManager: "apt",
        packageName: "openssl",
        newVersion: "1.2.3",
        isSecurity: 1,
      },
      {
        systemId: inserted.id,
        pkgManager: "apt",
        packageName: "bash",
        newVersion: "5.2",
        isSecurity: 0,
      },
    ]).run();

    db.insert(hiddenUpdates).values({
      systemId: inserted.id,
      pkgManager: "apt",
      packageName: "openssl",
      newVersion: "1.2.3",
      isSecurity: 1,
      active: 1,
      lastMatchedAt: "2026-01-01 00:00:00",
    }).run();

    const app = new Hono();
    app.route("/api/dashboard", dashboardRoutes);

    const statsRes = await app.request("/api/dashboard/stats");
    const statsBody = await statsRes.json();
    expect(statsBody.stats.totalUpdates).toBe(1);
    expect(statsBody.stats.needsUpdates).toBe(1);

    const systemsRes = await app.request("/api/dashboard/systems");
    const systemsBody = await systemsRes.json();
    expect(systemsBody.systems[0].updateCount).toBe(1);
    expect(systemsBody.systems[0].securityCount).toBe(0);
    expect(systemsBody.systems[0].keptBackCount).toBe(0);
  });

  test("exposes lastCheck and counts failed checks separately from up to date", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Failed Check",
      hostname: "failed-check.local",
      port: 22,
      authType: "password",
      username: "root",
      isReachable: 1,
      hidden: 0,
    }).returning({ id: systems.id }).get();

    db.insert(updateHistory).values({
      systemId: inserted.id,
      action: "check",
      pkgManager: "apt",
      status: "failed",
      error: "[apt] sudo: a password is required",
      startedAt: "2026-01-01 10:00:00",
      completedAt: "2026-01-01 10:01:00",
    }).run();

    const app = new Hono();
    app.route("/api/dashboard", dashboardRoutes);

    const statsRes = await app.request("/api/dashboard/stats");
    expect(statsRes.status).toBe(200);
    const statsBody = await statsRes.json();
    expect(statsBody.stats.upToDate).toBe(0);
    expect(statsBody.stats.needsUpdates).toBe(0);
    expect(statsBody.stats.checkIssues).toBe(1);

    const systemsRes = await app.request("/api/dashboard/systems");
    expect(systemsRes.status).toBe(200);
    const systemsBody = await systemsRes.json();
    expect(systemsBody.systems[0].lastCheck).toMatchObject({
      status: "failed",
      error: "[apt] sudo: a password is required",
    });
  });

  test("keeps warning checks out of needs updates while preserving total update counts", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Warning Check",
      hostname: "warning-check.local",
      port: 22,
      authType: "password",
      username: "root",
      isReachable: 1,
      hidden: 0,
    }).returning({ id: systems.id }).get();

    db.insert(updateCache).values({
      systemId: inserted.id,
      pkgManager: "apt",
      packageName: "bash",
      newVersion: "5.3",
    }).run();

    db.insert(updateHistory).values({
      systemId: inserted.id,
      action: "check",
      pkgManager: "apt,flatpak",
      status: "warning",
      error: "[flatpak] Command exited with code 1",
      startedAt: "2026-01-01 11:00:00",
      completedAt: "2026-01-01 11:01:00",
    }).run();

    const app = new Hono();
    app.route("/api/dashboard", dashboardRoutes);

    const statsRes = await app.request("/api/dashboard/stats");
    expect(statsRes.status).toBe(200);
    const statsBody = await statsRes.json();
    expect(statsBody.stats.needsUpdates).toBe(0);
    expect(statsBody.stats.checkIssues).toBe(1);
    expect(statsBody.stats.totalUpdates).toBe(1);

    const systemsRes = await app.request("/api/dashboard/systems");
    expect(systemsRes.status).toBe(200);
    const systemsBody = await systemsRes.json();
    expect(systemsBody.systems[0].lastCheck).toMatchObject({
      status: "warning",
      error: "[flatpak] Command exited with code 1",
    });
    expect(systemsBody.systems[0].updateCount).toBe(1);
  });
});
