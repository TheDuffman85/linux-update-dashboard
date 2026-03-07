import { describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { Hono } from "hono";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import systemsRoutes from "../../server/routes/systems";

describe("systems test-connection route", () => {
  test("returns a debug reference on connection failure", async () => {
    initEncryptor(randomBytes(32).toString("base64"));

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).testConnection = async () => ({
      success: false,
      message: "Permission denied (check credentials)",
      debugRef: "attempt-123",
    });

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "host.example",
        port: 22,
        username: "ops",
        authType: "password",
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: false,
      message: "Permission denied (check credentials)",
      debugRef: "attempt-123",
    });
  });
});
