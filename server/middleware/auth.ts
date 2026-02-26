import { createMiddleware } from "hono/factory";
import { eq, count } from "drizzle-orm";
import { getSession, refreshSessionIfNeeded, type SessionData } from "../auth/session";
import { getDb } from "../db";
import { users } from "../db/schema";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

async function hasUsers(): Promise<boolean> {
  const db = getDb();
  const result = db.select({ count: count() }).from(users).get();
  return (result?.count ?? 0) > 0;
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  const path = c.req.path;

  // Allow health check without auth when called from localhost (Docker HEALTHCHECK)
  if (path === "/api/health") {
    const host = new URL(c.req.url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
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

    const session = await getSession(c);
    if (!session) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    c.set("user", session);

    // Rolling session: refresh token if it's past the halfway point
    await refreshSessionIfNeeded(c);

    return next();
  }

  // For non-API routes (SPA), always serve the index.html
  // The SPA client handles auth state and redirects
  return next();
});
