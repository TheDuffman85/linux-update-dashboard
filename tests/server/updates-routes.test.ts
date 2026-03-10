import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import updatesRoutes from "../../server/routes/updates";
import { closeDatabase, initDatabase } from "../../server/db";

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
});
