import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateCache } from "../../server/db/schema";
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

  test("includes securityCount in dashboard systems list", async () => {
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

    const app = new Hono();
    app.route("/api/dashboard", dashboardRoutes);

    const systemsRes = await app.request("/api/dashboard/systems");
    expect(systemsRes.status).toBe(200);
    const systemsBody = await systemsRes.json();

    expect(systemsBody.systems).toHaveLength(1);
    expect(systemsBody.systems[0].updateCount).toBe(2);
    expect(systemsBody.systems[0].securityCount).toBe(1);
  });
});
