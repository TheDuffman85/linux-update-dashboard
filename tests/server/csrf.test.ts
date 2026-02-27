import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { csrfMiddleware, CSRF_COOKIE, CSRF_HEADER } from "../../server/middleware/csrf";

function createApp() {
  const app = new Hono();
  app.use("/api/*", csrfMiddleware);
  app.get("/api/ping", (c) => c.json({ ok: true }));
  app.post("/api/mutate", (c) => c.json({ ok: true }));
  return app;
}

describe("csrfMiddleware", () => {
  test("safe GET request sets CSRF cookie", async () => {
    const app = createApp();
    const res = await app.request("/api/ping");
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain(`${CSRF_COOKIE}=`);
  });

  test("unsafe request without token is rejected", async () => {
    const app = createApp();
    const res = await app.request("/api/mutate", { method: "POST" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("CSRF token");
  });

  test("unsafe request with matching cookie and header succeeds", async () => {
    const app = createApp();
    const token = "test-csrf-token";
    const res = await app.request("/api/mutate", {
      method: "POST",
      headers: {
        "Cookie": `${CSRF_COOKIE}=${token}`,
        [CSRF_HEADER]: token,
      },
    });
    expect(res.status).toBe(200);
  });

  test("websocket upgrade request is bypassed by csrf middleware", async () => {
    const app = createApp();
    const res = await app.request("/api/mutate", {
      method: "GET",
      headers: { Upgrade: "websocket" },
    });
    // Route exists as POST-only, so bypassing CSRF should leave method handling to router
    expect(res.status).toBe(404);
  });
});
