import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import updatesRoutes from "../../server/routes/updates";

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
});
