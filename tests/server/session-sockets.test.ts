import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import type { WSContext } from "hono/ws";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { users } from "../../server/db/schema";
import { initSession } from "../../server/auth/session";
import { hashPassword } from "../../server/auth/password";
import { initEncryptor } from "../../server/security";
import { authMiddleware } from "../../server/middleware/auth";
import {
  SESSION_ENDED_CLOSE_CODE,
  closeEndedSessionSockets,
  trackSessionSocket,
  untrackSessionSocket,
} from "../../server/services/session-sockets";

const { handleCallback } = vi.hoisted(() => ({ handleCallback: vi.fn() }));

vi.mock("../../server/auth/oidc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/auth/oidc")>()),
  isConfigured: () => true,
  handleCallback,
}));

const { default: authRoutes } = await import("../../server/routes/auth");

const SESSION_SECRET = "session-sockets-test-secret";
const PASSWORD = "Password1";
const ISSUER = "https://idp.example.com";
const incoming = {
  socket: { remoteAddress: "127.0.0.1", remotePort: 12345, remoteFamily: "IPv4" },
};

type FakeSocket = WSContext & { close: ReturnType<typeof vi.fn> };

async function sessionToken(
  userId: number,
  authMethod = "password",
  options: { sessionId?: string; issuedAt?: number } = {},
): Promise<string> {
  const user = getDb().select().from(users).where(eq(users.id, userId)).get()!;
  return new SignJWT({
    userId,
    username: user.username,
    authMethod,
    sessionVersion: user.sessionVersion,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    // Distinguishes tokens issued within the same second.
    jti: randomBytes(8).toString("hex"),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(options.issuedAt ?? Math.floor(Date.now() / 1000))
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(SESSION_SECRET));
}

const TWO_DAYS_AGO = () => Math.floor(Date.now() / 1000) - 2 * 86400;

describe("live output streams end with their session", () => {
  let tempDir: string;
  let app: Hono;
  let tracked: FakeSocket[];
  let adminId: number;
  let otherId: number;
  let ssoId: number;

  function openSocket(token: string): FakeSocket {
    const ws = { close: vi.fn() } as unknown as FakeSocket;
    trackSessionSocket(ws, token);
    tracked.push(ws);
    return ws;
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-session-sockets-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initSession(SESSION_SECRET);
    initDatabase(join(tempDir, "dashboard.db"));
    const db = getDb();
    const passwordHash = await hashPassword(PASSWORD);
    adminId = db.insert(users).values({ username: "admin", passwordHash }).returning().get().id;
    otherId = db.insert(users).values({ username: "other", passwordHash }).returning().get().id;
    ssoId = db
      .insert(users)
      .values({ username: "sso", authProvider: "oidc", oidcIssuer: ISSUER, oidcSubject: "sso-sub" })
      .returning()
      .get().id;
    tracked = [];
    handleCallback.mockReset();
    app = new Hono();
    app.use("/api/*", authMiddleware);
    app.get("/api/ping", (c) => c.json({ ok: true }));
    app.route("/api/auth", authRoutes);
  });

  afterEach(() => {
    for (const ws of tracked) untrackSessionSocket(ws);
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("logout closes the streams of the logged-out session only", async () => {
    const token = await sessionToken(adminId);
    const mine = openSocket(token);
    const otherDevice = openSocket(await sessionToken(adminId));

    const res = await app.request(
      "/api/auth/logout",
      { method: "POST", headers: { cookie: `ludash_session=${token}` } },
      { incoming },
    );
    expect(res.status).toBe(200);

    expect(mine.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
    expect(otherDevice.close).not.toHaveBeenCalled();
  });

  describe("after a rolling session refresh", () => {
    async function refresh(token: string): Promise<string> {
      const res = await app.request(
        "/api/ping",
        { headers: { cookie: `ludash_session=${token}` } },
        { incoming },
      );
      expect(res.status).toBe(200);
      const refreshed = /ludash_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      expect(refreshed).toBeTruthy();
      expect(refreshed).not.toBe(token);
      return refreshed!;
    }

    const logout = (token: string) =>
      app.request(
        "/api/auth/logout",
        { method: "POST", headers: { cookie: `ludash_session=${token}` } },
        { incoming },
      );

    test("logout with the refreshed token closes streams opened before the refresh", async () => {
      const original = await sessionToken(adminId, "password", {
        sessionId: "session-1",
        issuedAt: TWO_DAYS_AGO(),
      });
      const openedBefore = openSocket(original);
      const otherDevice = openSocket(await sessionToken(adminId, "password", { sessionId: "session-2" }));

      const refreshed = await refresh(original);
      const openedAfter = openSocket(refreshed);
      expect((await logout(refreshed)).status).toBe(200);

      expect(openedBefore.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
      expect(openedAfter.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
      expect(otherDevice.close).not.toHaveBeenCalled();
    });

    test("sessions from before session IDs existed keep their identity across the refresh", async () => {
      const legacy = await sessionToken(adminId, "password", { issuedAt: TWO_DAYS_AGO() });
      const openedBefore = openSocket(legacy);

      const refreshed = await refresh(legacy);
      expect((await logout(refreshed)).status).toBe(200);

      expect(openedBefore.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
    });

    test("streams stay open while the session is valid", async () => {
      const original = await sessionToken(adminId, "password", {
        sessionId: "session-1",
        issuedAt: TWO_DAYS_AGO(),
      });
      const stream = openSocket(original);

      await refresh(original);
      await closeEndedSessionSockets();

      expect(stream.close).not.toHaveBeenCalled();
    });
  });

  test("a password change closes the other sessions' streams and keeps this browser's", async () => {
    const token = await sessionToken(adminId);
    const mine = openSocket(token);
    const otherDevice = openSocket(await sessionToken(adminId));
    const otherUser = openSocket(await sessionToken(otherId));

    const res = await app.request(
      "/api/auth/change-password",
      {
        method: "POST",
        headers: { cookie: `ludash_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ currentPassword: PASSWORD, newPassword: "NewPassword2" }),
      },
      { incoming },
    );
    expect(res.status).toBe(200);

    expect(otherDevice.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
    expect(mine.close).not.toHaveBeenCalled();
    expect(otherUser.close).not.toHaveBeenCalled();

    // This browser's stream now follows the reissued session.
    await closeEndedSessionSockets();
    expect(mine.close).not.toHaveBeenCalled();
  });

  test("an SSO user who lost access has their streams closed", async () => {
    const stream = openSocket(await sessionToken(ssoId, "oidc"));
    handleCallback.mockResolvedValue({
      username: "sso",
      role: null,
      issuer: ISSUER,
      subject: "sso-sub",
    });

    const res = await app.request("/api/auth/oidc/callback?code=x&state=y", {}, { incoming });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=oidc_unauthorized");

    expect(stream.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
  });

  test("a new SSO sign-in closes streams of the identity's earlier sessions", async () => {
    const earlier = openSocket(await sessionToken(ssoId, "oidc"));
    const token = await sessionToken(ssoId, "oidc");
    const thisBrowser = openSocket(token);
    handleCallback.mockResolvedValue({
      username: "sso",
      role: "admin",
      issuer: ISSUER,
      subject: "sso-sub",
    });

    const res = await app.request(
      "/api/auth/oidc/callback?code=x&state=y",
      { headers: { cookie: `ludash_session=${token}` } },
      { incoming },
    );
    expect(res.status).toBe(302);

    expect(earlier.close).toHaveBeenCalledWith(SESSION_ENDED_CLOSE_CODE, "Session ended");
    expect(thisBrowser.close).not.toHaveBeenCalled();
  });
});
