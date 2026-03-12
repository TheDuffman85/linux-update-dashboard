import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
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

  test("creates email notifications with inline SMTP auth", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops email",
        type: "email",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          smtpHost: "smtp.example.com",
          smtpPort: "587",
          smtpSecure: "true",
          smtpUser: "mailer",
          smtpPassword: "smtp-secret",
          smtpFrom: "dashboard@example.com",
          emailTo: "admin@example.com",
        },
      }),
    });

    expect(res.status).toBe(201);
    const stored = getDb().select().from(notifications).get();
    expect(stored?.config).toContain('"smtpUser":"mailer"');
    expect(stored?.config).toContain('"smtpPassword":"');
    expect(stored?.config).not.toContain("smtp-secret");
  });

  test("defaults new notifications to updates and app updates", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Default events email",
        type: "email",
        enabled: true,
        systemIds: null,
        config: {
          smtpHost: "smtp.example.com",
          smtpPort: "587",
          smtpSecure: "true",
          smtpUser: "mailer",
          smtpPassword: "smtp-secret",
          smtpFrom: "dashboard@example.com",
          emailTo: "admin@example.com",
        },
      }),
    });

    expect(res.status).toBe(201);

    const stored = getDb().select().from(notifications).get();
    expect(stored?.notifyOn).toBe('["updates","appUpdates"]');
  });

  test("creates gotify notifications", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops gotify",
        type: "gotify",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          gotifyUrl: "https://gotify.example.com",
          gotifyToken: "app-token",
          gotifyPriorityOverride: "8",
        },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeGreaterThan(0);

    const stored = getDb().select().from(notifications).get();
    expect(stored?.config).toContain('"gotifyPriorityOverride":"8"');
    expect(stored?.config).toContain('"gotifyToken":"');
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

  test("rejects inline mqtt test requests with publish events enabled and a blank topic", async () => {
    const res = await app.request("/api/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops mqtt",
        type: "mqtt",
        config: {
          brokerUrl: "mqtt://broker.example.com:1883",
          publishEvents: true,
          topic: "   ",
          homeAssistantEnabled: true,
          discoveryPrefix: "homeassistant",
          baseTopic: "ludash",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("MQTT topic is required");
  });

  test("rejects gotify notifications with invalid priority overrides", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops gotify",
        type: "gotify",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          gotifyUrl: "https://gotify.example.com",
          gotifyToken: "app-token",
          gotifyPriorityOverride: "11",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("gotify priority override");
  });

  test("creates webhook notifications with nested config and encrypted secrets", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops webhook",
        type: "webhook",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          preset: "custom",
          method: "POST",
          url: "https://example.com/webhook",
          query: [{ name: "source", value: "{{event.eventTypes.0}}" }],
          headers: [{ name: "X-Api-Key", value: "header-secret", sensitive: true }],
          auth: { mode: "bearer", token: "bearer-secret" },
          body: { mode: "text", template: "hello" },
          timeoutMs: 10000,
          retryAttempts: 2,
          retryDelayMs: 30000,
          allowInsecureTls: false,
        },
      }),
    });

    expect(res.status).toBe(201);

    const stored = getDb().select().from(notifications).get();
    expect(stored?.config).not.toContain("header-secret");
    expect(stored?.config).not.toContain("bearer-secret");
    expect(stored?.config).toContain('"template":"hello"');
  });

  test("rejects webhook notifications with invalid methods", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bad webhook",
        type: "webhook",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          preset: "custom",
          method: "DELETE",
          url: "https://example.com/webhook",
          query: [],
          headers: [],
          auth: { mode: "none" },
          body: { mode: "text", template: "hello" },
          timeoutMs: 10000,
          retryAttempts: 2,
          retryDelayMs: 30000,
          allowInsecureTls: false,
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("POST, PUT, or PATCH");
  });

  test("masks and reuses stored webhook secrets", async () => {
    const inserted = getDb().insert(notifications).values({
      name: "Ops webhook",
      type: "webhook",
      enabled: 1,
      notifyOn: '["updates"]',
      config: JSON.stringify({
        preset: "custom",
        method: "POST",
        url: "https://example.com/webhook",
        query: [],
        headers: [{ name: "X-Api-Key", value: getEncryptor().encrypt("header-secret"), sensitive: true }],
        auth: { mode: "bearer", token: getEncryptor().encrypt("bearer-secret") },
        body: { mode: "text", template: "body-secret" },
        timeoutMs: 10000,
        retryAttempts: 2,
        retryDelayMs: 30000,
        allowInsecureTls: false,
      }),
    }).returning({ id: notifications.id }).get();

    const updateRes = await app.request(`/api/notifications/${inserted.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          preset: "custom",
          method: "POST",
          url: "https://example.com/webhook",
          query: [],
          headers: [{ name: "X-Api-Key", value: "(stored)", sensitive: true }],
          auth: { mode: "bearer", token: "(stored)" },
          body: { mode: "text", template: "body-secret-updated" },
          timeoutMs: 10000,
          retryAttempts: 2,
          retryDelayMs: 30000,
          allowInsecureTls: false,
        },
      }),
    });

    expect(updateRes.status).toBe(200);

    const getRes = await app.request(`/api/notifications/${inserted.id}`);
    expect(getRes.status).toBe(200);

    const body = await getRes.json();
    expect(body.config.headers[0].value).toBe("(stored)");
    expect(body.config.auth.token).toBe("(stored)");
    expect(body.config.body.template).toBe("body-secret-updated");
  });

  test("masks and reuses stored email passwords", async () => {
    const originalCreateTransport = nodemailer.createTransport;
    let sentAuth: Record<string, unknown> | undefined;

    (nodemailer as any).createTransport = (options: Record<string, unknown>) => {
      sentAuth = options.auth as Record<string, unknown> | undefined;
      return {
        sendMail: async () => {},
      };
    };

    try {
      const encryptedPassword = getEncryptor().encrypt("smtp-secret");
      const inserted = getDb().insert(notifications).values({
        name: "Existing email",
        type: "email",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          smtpHost: "smtp.example.com",
          smtpPort: "587",
          smtpSecure: "true",
          smtpUser: "mailer",
          smtpPassword: encryptedPassword,
          smtpFrom: "dashboard@example.com",
          emailTo: "admin@example.com",
        }),
      }).returning({ id: notifications.id }).get();

      const listRes = await app.request("/api/notifications");
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.notifications[0].config.smtpPassword).toBe("(stored)");

      const updateRes = await app.request(`/api/notifications/${inserted.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            smtpPassword: "(stored)",
            emailImportanceOverride: "important",
          },
        }),
      });
      expect(updateRes.status).toBe(200);

      const stored = getDb()
        .select()
        .from(notifications)
        .where(eq(notifications.id, inserted.id))
        .get();
      expect(stored?.config).toContain(encryptedPassword);
      expect(stored?.config).not.toContain('"(stored)"');

      const testRes = await app.request("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          existingId: inserted.id,
          name: "Existing email",
          type: "email",
          config: {
            smtpHost: "smtp.example.com",
            smtpPort: "587",
            smtpSecure: "true",
            smtpUser: "mailer",
            smtpPassword: "(stored)",
            smtpFrom: "dashboard@example.com",
            emailTo: "admin@example.com",
            emailImportanceOverride: "important",
          },
        }),
      });

      expect(testRes.status).toBe(200);
      const testBody = await testRes.json();
      expect(testBody.success).toBe(true);
      expect(sentAuth).toEqual({
        user: "mailer",
        pass: "smtp-secret",
      });
    } finally {
      (nodemailer as any).createTransport = originalCreateTransport;
    }
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

  test("inline test reuses stored gotify token for existing notifications", async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl: string | null = null;

    globalThis.fetch = (async (input) => {
      requestUrl = String(input);
      return new Response("", { status: 200 });
    }) as typeof fetch;

    try {
      const encryptedToken = getEncryptor().encrypt("secret-gotify-token");
      const inserted = getDb().insert(notifications).values({
        name: "Existing gotify",
        type: "gotify",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          gotifyUrl: "https://gotify.example.com",
          gotifyToken: encryptedToken,
          gotifyPriorityOverride: "8",
        }),
      }).returning({ id: notifications.id }).get();

      const res = await app.request("/api/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          existingId: inserted.id,
          name: "Existing gotify",
          type: "gotify",
          config: {
            gotifyUrl: "https://gotify.example.com",
            gotifyToken: "(stored)",
            gotifyPriorityOverride: "10",
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(requestUrl).toBe("https://gotify.example.com/message?token=secret-gotify-token");
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

  test("reorders notifications when given a complete ordered ID list", async () => {
    const inserted = getDb().insert(notifications).values([
      {
        sortOrder: 0,
        name: "Alpha",
        type: "ntfy",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "alpha",
        }),
      },
      {
        sortOrder: 1,
        name: "Bravo",
        type: "ntfy",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "bravo",
        }),
      },
      {
        sortOrder: 2,
        name: "Charlie",
        type: "ntfy",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "charlie",
        }),
      },
    ]).returning({ id: notifications.id }).all();

    const res = await app.request("/api/notifications/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notificationIds: [inserted[2].id, inserted[0].id, inserted[1].id],
      }),
    });

    expect(res.status).toBe(200);

    const listRes = await app.request("/api/notifications");
    expect(listRes.status).toBe(200);
    const body = await listRes.json();
    expect(body.notifications.map((notification: { name: string }) => notification.name)).toEqual([
      "Charlie",
      "Alpha",
      "Bravo",
    ]);
  });

  test("rejects notification reorder payloads that omit notifications", async () => {
    const inserted = getDb().insert(notifications).values([
      {
        name: "Alpha",
        type: "ntfy",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "alpha",
        }),
      },
      {
        name: "Bravo",
        type: "ntfy",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify({
          ntfyUrl: "https://ntfy.sh",
          ntfyTopic: "bravo",
        }),
      },
    ]).returning({ id: notifications.id }).all();

    const res = await app.request("/api/notifications/reorder", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        notificationIds: [inserted[0].id],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("include every notification exactly once");
  });
});
