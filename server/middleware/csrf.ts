import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "../config";

const CSRF_COOKIE = "ludash_csrf";
const CSRF_HEADER = "x-csrf-token";

function isSecureContext(): boolean {
  try {
    return new URL(config.baseUrl).protocol === "https:";
  } catch {
    return false;
  }
}

function ensureToken(c: Context): string | null {
  return getCookie(c, CSRF_COOKIE) ?? null;
}

function setToken(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "Lax",
    secure: isSecureContext(),
    maxAge: 86400 * 30,
    path: "/",
  });
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export const csrfMiddleware = createMiddleware(async (c, next) => {
  // WebSocket upgrade requests must pass through untouched.
  if (c.req.header("upgrade")?.toLowerCase() === "websocket") {
    return next();
  }

  // Bearer token requests are stateless — no CSRF risk.
  if (c.req.header("authorization")?.startsWith("Bearer ")) {
    return next();
  }

  let token = ensureToken(c);
  if (!token) {
    token = crypto.randomUUID();
    setToken(c, token);
  }

  if (!isUnsafeMethod(c.req.method)) {
    return next();
  }

  const headerToken = c.req.header(CSRF_HEADER);
  if (!headerToken || headerToken !== token) {
    return c.json({ error: "CSRF token missing or invalid" }, 403);
  }

  return next();
});

export { CSRF_COOKIE, CSRF_HEADER };
