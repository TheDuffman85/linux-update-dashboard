import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications } from "../../server/db/schema";
import notificationsRoutes from "../../server/routes/notifications";
import { getEncryptor, initEncryptor } from "../../server/security";

describe("notifications routes validation", () => {
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-notifications-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
    initEncryptor(randomBytes(32).toString("base64"));

    app = new Hono();
    app.route("/api/notifications", notificationsRoutes);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates ntfy notifications with valid overrides", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops ntfy",
        type: "ntfy",
        enabled: true,
        notifyOn: ["updates", "appUpdates"],
        systemIds: null,
        config: {
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "updates",
          ntfyPriorityOverride: "urgent",
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);

    const stored = getDb().select().from(notifications).get();
    expect(stored?.config).toContain('"ntfyPriorityOverride":"urgent"');
    expect(stored?.notifyOn).toBe('["updates","appUpdates"]');
  });

  test("rejects ntfy notifications with unsupported config keys", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops ntfy",
        type: "ntfy",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "updates",
          unsupportedKey: "value",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unsupported ntfy config key");
  });

  test("rejects email updates with invalid importance overrides", async () => {
    const db = getDb();
    const inserted = db.insert(notifications).values({
      name: "Ops Email",
      type: "email",
      enabled: 1,
      notifyOn: '["updates"]',
      config: JSON.stringify({
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpFrom: "dashboard@example.com",
        emailTo: "admin@example.com",
      }),
    }).returning({ id: notifications.id }).get();

    const res = await app.request(`/api/notifications/${inserted.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          emailImportanceOverride: "critical",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("email importance override");
  });

  test("rejects inline test requests with invalid ntfy priority overrides", async () => {
    const res = await app.request("/api/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops ntfy",
        type: "ntfy",
        config: {
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "updates",
          ntfyPriorityOverride: "critical",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("ntfy priority override");
  });

  test("inline test reuses stored ntfy token for existing notifications", async () => {
    const originalFetch = globalThis.fetch;
    let authorizationHeader: string | null = null;

    globalThis.fetch = (async (_input, init) => {
      authorizationHeader = new Headers(init?.headers).get("Authorization");
      return new Response("", { status: 200 });
    }) as typeof fetch;

    try {
      const encryptedToken = getEncryptor().encrypt("secret-token");
      const inserted = getDb().insert(notifications).values({
        name: "Existing ntfy",
        type: "ntfy",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "updates",
          ntfyToken: encryptedToken,
          ntfyPriorityOverride: "high",
        }),
      }).returning({ id: notifications.id }).get();

      const res = await app.request("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          existingId: inserted.id,
          name: "Existing ntfy",
          type: "ntfy",
          config: {
            ntfyUrl: "https://ntfy.sh",
            ntfyTopic: "updates",
            ntfyToken: "(stored)",
            ntfyPriorityOverride: "urgent",
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(authorizationHeader).toBe("Bearer secret-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("removes unsupported ntfy config from existing database rows", async () => {
    const db = getDb();
    const inserted = db.insert(notifications).values({
      name: "Legacy ntfy",
      type: "ntfy",
      enabled: 1,
      notifyOn: '["updates"]',
      config: JSON.stringify({
        ntfyUrl: "https://ntfy.sh",
        ntfyTopic: "updates",
        ntfyPriorityOverride: "high",
        staleField: "legacy-value",
      }),
    }).returning({ id: notifications.id }).get();

    const res = await app.request("/api/notifications");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0].config.staleField).toBeUndefined();
    expect(body.notifications[0].config.ntfyPriorityOverride).toBe("high");

    const stored = db
      .select()
      .from(notifications)
      .where(eq(notifications.id, inserted.id))
      .get();
    expect(stored?.config).not.toContain("staleField");
  });
});
