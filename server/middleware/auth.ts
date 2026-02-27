import { createMiddleware } from "hono/factory";
import { eq, count } from "drizzle-orm";
import { getSession, refreshSessionIfNeeded, type SessionData } from "../auth/session";
import { validateToken } from "../auth/api-token";
import { getDb } from "../db";
import { users } from "../db/schema";
import { isLoopbackRequest, getClientIp } from "../request-security";

// Rate-limit failed bearer token attempts: max 20 failures per IP per minute
const BEARER_FAIL_WINDOW_MS = 60_000;
const BEARER_FAIL_MAX = 20;
const bearerFailures = new Map<string, number[]>();

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of bearerFailures) {
    const valid = timestamps.filter((t) => now - t < BEARER_FAIL_WINDOW_MS);
    if (valid.length === 0) bearerFailures.delete(ip);
    else bearerFailures.set(ip, valid);
  }
}, 120_000);

type AuthEnv = {
  Variables: {
    user: SessionData;
    apiToken: boolean;
  };
};

async function hasUsers(): Promise<boolean> {
  const db = getDb();
  const result = db.select({ count: count() }).from(users).get();
  return (result?.count ?? 0) > 0;
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const path = c.req.path;
  const isWebSocketUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";

  // Allow health check without auth when called from localhost (Docker HEALTHCHECK)
  if (path === "/api/health") {
    if (isLoopbackRequest(c)) {
      return next();
    }
  }

  // Allow auth routes and static files without auth
  if (
    path.startsWith("/api/auth") ||
    path.startsWith("/assets") ||
    path === "/favicon.ico"
  ) {
    return next();
  }

  // Check if setup is needed
  const usersExist = await hasUsers();

  // For API routes, return JSON errors
  if (path.startsWith("/api/")) {
    if (!usersExist) {
      return c.json({ error: "Setup required", setupRequired: true }, 401);
    }

    // --- Bearer token auth (for external API consumers) ---
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      // Rate-limit failed attempts per IP
      const ip = getClientIp(c) || "unknown";
      const now = Date.now();
      const failures = (bearerFailures.get(ip) || []).filter(
        (t) => now - t < BEARER_FAIL_WINDOW_MS
      );
      if (failures.length >= BEARER_FAIL_MAX) {
        return c.json({ error: "Too many failed attempts" }, 429);
      }

      const token = authHeader.slice(7);
      const tokenData = await validateToken(token);
      if (!tokenData) {
        failures.push(now);
        bearerFailures.set(ip, failures);
        return c.json({ error: "Invalid or expired API token" }, 401);
      }

      // Block management endpoints — tokens are for data API only
      const managementPrefixes = [
        "/api/auth", "/api/settings", "/api/tokens",
        "/api/passkeys", "/api/notifications",
      ];
      if (managementPrefixes.some((p) => path.startsWith(p))) {
        return c.json({ error: "API tokens cannot access management endpoints" }, 403);
      }

      // Enforce read-only permission
      const method = c.req.method;
      if (tokenData.readOnly && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        return c.json({ error: "This token is read-only" }, 403);
      }

      c.set("user", { userId: tokenData.userId, username: tokenData.username });
      c.set("apiToken", true);
      return next();
    }

    // --- Cookie/session auth (browser UI) ---
    const session = await getSession(c);
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("user", session);

    // Avoid mutating cookies during WebSocket upgrade handshakes.
    if (!isWebSocketUpgrade) {
      // Rolling session: refresh token if it's past the halfway point
      await refreshSessionIfNeeded(c);
    }

    return next();
  }

  // For non-API routes (SPA), always serve the index.html
  // The SPA client handles auth state and redirects
  return next();
});
