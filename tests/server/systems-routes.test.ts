import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems } from "../../server/db/schema";
import systemsRoutes from "../../server/routes/systems";
import { initEncryptor } from "../../server/security";
import { listSystems } from "../../server/services/system-service";

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

    const res = await app.request("/api/systems", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Primary Copy",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already exists");
  });

  test("returns 409 when updating a system to match another connection tuple", async () => {
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
        port: 2222,
        authType: "password",
        username: "admin",
      },
    ]).returning({ id: systems.id }).all();

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request(`/api/systems/${inserted[1].id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bravo",
        hostname: "alpha.local",
        port: 22,
        authType: "password",
        username: "root",
      }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already exists");
  });
});
