import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, initDatabase } from "../../server/db";
import { createApp } from "../../server/app";
import { initSession } from "../../server/auth/session";
import { initEncryptor } from "../../server/security";

const incoming = {
  socket: {
    remoteAddress: "127.0.0.1",
    remotePort: 12345,
    remoteFamily: "IPv4",
  },
};

describe("API security middleware", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-app-security-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initSession("app-security-test-secret");
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("adds CSP and no-store headers to API responses", async () => {
    const response = await createApp().request("/api/health", {}, { incoming });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("rejects cross-origin API mutations before CSRF handling", async () => {
    const response = await createApp().request(
      "http://localhost:3001/api/auth/login",
      {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "admin", password: "Password1" }),
      },
      { incoming },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Cross-origin request rejected",
    });
  });

  test("rejects API request bodies larger than one MiB", async () => {
    const response = await createApp().request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(1024 * 1024 + 1),
      },
      { incoming },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "Request body is too large",
    });
  });
});
