import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { generate } from "otplib";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { users } from "../../server/db/schema";
import authRoutes from "../../server/routes/auth";
import { initSession } from "../../server/auth/session";
import { initEncryptor, getEncryptor } from "../../server/security";
import { config } from "../../server/config";

function cookiePair(header: string | null, name = "ludash_session"): string {
  return (
    header
      ?.split(/,(?=\s*ludash_)/)
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${name}=`))
      ?.split(";")[0] ?? ""
  );
}

const incoming = {
  socket: {
    remoteAddress: "127.0.0.1",
    remotePort: 12345,
    remoteFamily: "IPv4",
  },
};

describe("auth TOTP routes", () => {
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-auth-totp-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initSession(config.secretKey);
    initDatabase(join(tempDir, "dashboard.db"));
    app = new Hono();
    app.route("/api/auth", authRoutes);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("requires a valid authenticator code after TOTP is enabled", async () => {
    const setupRes = await app.request(
      "/api/auth/setup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "Password1" }),
      },
      { incoming },
    );
    expect(setupRes.status).toBe(200);
    const sessionCookie = cookiePair(setupRes.headers.get("set-cookie"));

    const totpSetupRes = await app.request(
      "/api/auth/totp/setup",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
        },
      },
      { incoming },
    );
    expect(totpSetupRes.status).toBe(200);
    const totpSetupBody = (await totpSetupRes.json()) as {
      secret: string;
      otpauthUrl: string;
    };
    expect(totpSetupBody.otpauthUrl).toContain("otpauth://totp/");
    const totpCookie = cookiePair(
      totpSetupRes.headers.get("set-cookie"),
      "ludash_totp_setup",
    );

    const malformedEnableRes = await app.request(
      "/api/auth/totp/enable",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookie}; ${totpCookie}`,
        },
        body: JSON.stringify({ code: "abcdef" }),
      },
      { incoming },
    );
    expect(malformedEnableRes.status).toBe(400);

    const code = await generate({ secret: totpSetupBody.secret });
    const enableRes = await app.request(
      "/api/auth/totp/enable",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${sessionCookie}; ${totpCookie}`,
        },
        body: JSON.stringify({ code }),
      },
      { incoming },
    );
    expect(enableRes.status).toBe(200);
    const enabledSessionCookie = cookiePair(
      enableRes.headers.get("set-cookie"),
    );

    const oldSessionRes = await app.request(
      "/api/auth/me",
      {
        headers: { cookie: sessionCookie },
      },
      { incoming },
    );
    expect(oldSessionRes.status).toBe(401);

    const storedUser = getDb()
      .select()
      .from(users)
      .where(eq(users.username, "admin"))
      .get();
    expect(storedUser?.totpEnabled).toBe(1);
    expect(storedUser?.totpSecret).toBeTruthy();
    expect(getEncryptor().decrypt(storedUser!.totpSecret!)).toBe(
      totpSetupBody.secret,
    );

    const setupAgainRes = await app.request(
      "/api/auth/totp/setup",
      {
        method: "POST",
        headers: { cookie: enabledSessionCookie },
      },
      { incoming },
    );
    expect(setupAgainRes.status).toBe(400);

    const missingTotpRes = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "Password1" }),
      },
      { incoming },
    );
    expect(missingTotpRes.status).toBe(401);
    expect(await missingTotpRes.json()).toMatchObject({ requiresTotp: true });

    const badTotpRes = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "Password1",
          totpCode: "000000",
        }),
      },
      { incoming },
    );
    expect(badTotpRes.status).toBe(401);
    expect(await badTotpRes.json()).toMatchObject({ requiresTotp: true });

    const loginRes = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "Password1",
          totpCode: code,
        }),
      },
      { incoming },
    );
    expect(loginRes.status).toBe(200);

    const replayLoginRes = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "Password1",
          totpCode: code,
        }),
      },
      { incoming },
    );
    expect(replayLoginRes.status).toBe(401);

    const disableRes = await app.request(
      "/api/auth/totp",
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          cookie: enabledSessionCookie,
        },
        body: JSON.stringify({ currentPassword: "Password1" }),
      },
      { incoming },
    );
    expect(disableRes.status).toBe(200);

    const disabledUser = getDb()
      .select()
      .from(users)
      .where(eq(users.username, "admin"))
      .get();
    expect(disabledUser?.totpEnabled).toBe(0);
    expect(disabledUser?.totpSecret).toBeNull();
  });

  test("rejects bearer token access to TOTP management routes", async () => {
    const setupRes = await app.request(
      "/api/auth/setup",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "Password1" }),
      },
      { incoming },
    );
    expect(setupRes.status).toBe(200);
    const sessionCookie = cookiePair(setupRes.headers.get("set-cookie"));

    for (const [method, path] of [
      ["POST", "/api/auth/totp/setup"],
      ["POST", "/api/auth/totp/enable"],
      ["DELETE", "/api/auth/totp"],
    ] as const) {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer ludash_test_token",
            cookie: sessionCookie,
          },
          body:
            method === "POST"
              ? JSON.stringify({ code: "123456" })
              : JSON.stringify({ currentPassword: "Password1" }),
        },
        { incoming },
      );
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toMatchObject({
        error: "API tokens cannot access management endpoints",
      });
    }
  });
});
