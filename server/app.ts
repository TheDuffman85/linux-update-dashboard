import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic, upgradeWebSocket, websocket } from "hono/bun";
import { authMiddleware } from "./middleware/auth";
import { csrfMiddleware } from "./middleware/csrf";
import { getTrustedPublicOrigin, rememberTrustedPublicOrigin } from "./request-security";
import * as outputStream from "./services/output-stream";
import * as notificationRuntime from "./services/notification-runtime";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import systemsRoutes from "./routes/systems";
import updatesRoutes from "./routes/updates";
import settingsRoutes from "./routes/settings";
import notificationsRoutes from "./routes/notifications";
import passkeysRoutes from "./routes/passkeys";
import apiTokensRoutes from "./routes/api-tokens";
import credentialsRoutes from "./routes/credentials";

export { websocket };

export function createApp() {
  const app = new Hono();

  // Security headers
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("X-Permitted-Cross-Domain-Policies", "none");
  });

  // CORS for development (Vite dev server on different port)
  if (process.env.NODE_ENV !== "production") {
    app.use(
      "*",
      cors({
        origin: "http://localhost:5173",
        credentials: true,
        allowHeaders: ["Content-Type", "X-CSRF-Token"],
      })
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
  app.route("/api/credentials", credentialsRoutes);
  app.route("/api/passkeys", passkeysRoutes);
  app.route("/api/tokens", apiTokensRoutes);

  // Expose the canonical logo URL in every environment for external consumers
  // such as Home Assistant entity pictures.
  app.get("/assets/logo.svg", serveStatic({ root: "./", path: "assets/logo.svg" }));
  app.get("/assets/logo.png", serveStatic({ root: "./", path: "assets/logo.png" }));

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
            ws.send(JSON.stringify({ type: "error", message: "Invalid system ID" }));
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
    })
  );

  // In production, serve built SPA files
  if (process.env.NODE_ENV === "production") {
    app.use("/assets/*", serveStatic({ root: "./dist/client" }));
    app.get("*", serveStatic({ root: "./dist/client", path: "index.html" }));
  }

  return app;
}
