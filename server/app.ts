import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { authMiddleware } from "./middleware/auth";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
import systemsRoutes from "./routes/systems";
import updatesRoutes from "./routes/updates";
import settingsRoutes from "./routes/settings";
import notificationsRoutes from "./routes/notifications";

export function createApp() {
  const app = new Hono();

  // CORS for development (Vite dev server on different port)
  if (process.env.NODE_ENV !== "production") {
    app.use(
      "*",
      cors({
        origin: "http://localhost:5173",
        credentials: true,
      })
    );
  }

  // Auth middleware for API routes
  app.use("/api/*", authMiddleware);

  // API routes
  app.route("/api/auth", authRoutes);
  app.route("/api/dashboard", dashboardRoutes);
  app.route("/api/systems", systemsRoutes);
  app.route("/api", updatesRoutes);
  app.route("/api/settings", settingsRoutes);
  app.route("/api/notifications", notificationsRoutes);

  // In production, serve built SPA files
  if (process.env.NODE_ENV === "production") {
    app.use("/assets/*", serveStatic({ root: "./dist/client" }));
    app.get("*", serveStatic({ root: "./dist/client", path: "index.html" }));
  }

  return app;
}
