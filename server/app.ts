import { Hono } from "hono";
import crypto from "crypto";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { upgradeWebSocket } from "@hono/node-server";
import { authMiddleware } from "./middleware/auth";
import { csrfMiddleware } from "./middleware/csrf";
import {
  getPublicRequestOrigin,
  getTrustedPublicOrigin,
  rememberTrustedPublicOrigin,
} from "./request-security";
import * as outputStream from "./services/output-stream";
import * as notificationRuntime from "./services/notification-runtime";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import systemsRoutes from "./routes/systems";
import updatesRoutes from "./routes/updates";
import settingsRoutes from "./routes/settings";
import notificationsRoutes from "./routes/notifications";
import schedulesRoutes from "./routes/schedules";
import passkeysRoutes from "./routes/passkeys";
import apiTokensRoutes from "./routes/api-tokens";
import credentialsRoutes from "./routes/credentials";
import scriptsRoutes from "./routes/scripts";

export function createApp() {
  const app = new Hono();

  // Security headers and cache controls for sensitive API responses.
  app.use("*", async (c, next) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Permitted-Cross-Domain-Policies", "none");
    c.header(
      "Content-Security-Policy",
      `default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`,
    );
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
      c.header("Cache-Control", "private, no-store");
      c.header("Pragma", "no-cache");
      c.header("Expires", "0");
    }
  });

  // CORS for development (Vite dev server on different port)
  if (process.env.NODE_ENV !== "production") {
    app.use(
      "*",
      cors({
        origin: "http://localhost:5173",
        credentials: true,
        allowHeaders: ["Content-Type", "X-CSRF-Token"],
      }),
    );
  }

  app.use("*", async (c, next) => {
    const changed = rememberTrustedPublicOrigin(getTrustedPublicOrigin(c));
    if (changed) {
      void notificationRuntime.syncSystemState();
      void notificationRuntime.syncAppUpdateState();
    }
    await next();
  });

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "Request body is too large" }, 413),
    }),
  );

  // Cookies use SameSite and CSRF tokens, but also reject cross-site browser
  // mutations before they reach an authenticated handler. Non-browser clients
  // without Origin/Sec-Fetch-Site remain supported.
  app.use("/api/*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: "Cross-origin request rejected" }, 403);
    }

    const origin = c.req.header("origin");
    if (origin) {
      try {
        if (new URL(origin).origin !== getPublicRequestOrigin(c)) {
          return c.json({ error: "Cross-origin request rejected" }, 403);
        }
      } catch {
        return c.json({ error: "Cross-origin request rejected" }, 403);
      }
    }
    return next();
  });

  // CSRF protection for all API routes (safe methods are exempt)
  app.use("/api/*", csrfMiddleware);

  // Auth middleware for API routes
  app.use("/api/*", authMiddleware);

  // Health check endpoint for Docker/orchestrator liveness probes.
  // Auth is bypassed only for loopback requests (see auth middleware).
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // API routes
  app.route("/api/auth", authRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/systems", systemsRoutes);
  app.route("/api", updatesRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/notifications", notificationsRoutes);
  app.route("/api/schedules", schedulesRoutes);
  app.route("/api/credentials", credentialsRoutes);
  app.route("/api/passkeys", passkeysRoutes);
  app.route("/api/tokens", apiTokensRoutes);
  app.route("/api/scripts", scriptsRoutes);

  // Expose the canonical logo URL in every environment for external consumers
  // such as Home Assistant entity pictures.
  app.get(
    "/assets/logo.svg",
    serveStatic({ root: "./", path: "assets/logo.svg" }),
  );
  app.get(
    "/assets/logo.png",
    serveStatic({ root: "./", path: "assets/logo.png" }),
  );

  // WebSocket route for live command output streaming
  // Auth is enforced by authMiddleware on the HTTP GET before upgrade.
  app.get(
    "/api/ws/systems/:id/output",
    upgradeWebSocket((c) => {
      const rawSystemId = c.req.param("id");
      const systemId = rawSystemId ? parseInt(rawSystemId, 10) : NaN;

      return {
        onOpen(_evt, ws) {
          if (isNaN(systemId)) {
            ws.send(
              JSON.stringify({ type: "error", message: "Invalid system ID" }),
            );
            ws.close(4002, "Invalid system ID");
            return;
          }

          outputStream.subscribe(systemId, ws);
        },

        onClose(_evt, ws) {
          if (systemId) {
            outputStream.unsubscribe(systemId, ws);
          }
        },
      };
    }),
  );

  // In production, serve built SPA files
  if (process.env.NODE_ENV === "production") {
    app.use("/assets/*", serveStatic({ root: "./dist/client" }));
    app.get("*", serveStatic({ root: "./dist/client", path: "index.html" }));
  }

  return app;
}
