import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { EventEmitter } from "node:events";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications, systems, updateCache } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  processScheduledDigests,
  processScheduledResults,
} from "../../server/services/notification-service";
import { webhookProvider } from "../../server/services/notifications/webhook";
import type { NotificationPayload } from "../../server/services/notifications";

function buildPayload(): NotificationPayload {
  const event = {
    title: "Updates available",
    body: "web-1: 3 updates",
    priority: "default" as const,
    tags: ["package"],
    sentAt: "2026-03-09T10:00:00.000Z",
    eventTypes: ["updates"] as const,
    totals: {
      systemsWithUpdates: 1,
      totalUpdates: 3,
      totalSecurity: 0,
      unreachableSystems: 0,
    },
    updates: [
      {
        systemId: 1,
        systemName: "web-1",
        updateCount: 3,
        securityCount: 0,
        previouslyReachable: true,
        nowUnreachable: false,
      },
    ],
    unreachable: [],
    appUpdate: null,
  };

  return {
    title: event.title,
    body: event.body,
    priority: event.priority,
    tags: event.tags,
    event,
  };
}

function mockHttpRequest(responseStatus: number, responseBody = "") {
  const originalRequest = http.request;
  let requestBody = "";
  let requestOptions: Record<string, unknown> | undefined;

  (http as any).request = ((options: Record<string, unknown>, callback: (res: IncomingMessage) => void) => {
    requestOptions = options;

    const req = new EventEmitter() as EventEmitter & {
      write: (chunk: string) => void;
      end: () => void;
      setTimeout: (_ms: number, _cb: () => void) => void;
      destroy: (error: Error) => void;
    };

    req.write = (chunk: string) => {
      requestBody += chunk;
    };
    req.setTimeout = () => {};
    req.destroy = (error: Error) => {
      req.emit("error", error);
    };
    req.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter() as IncomingMessage;
        (res as any).statusCode = responseStatus;
        (res as any).setEncoding = () => res;
        callback(res);
        if (responseBody) {
          res.emit("data", responseBody);
        }
        res.emit("end");
      });
    };

    return req;
  }) as typeof http.request;

  return {
    getRequestBody: () => requestBody,
    getRequestOptions: () => requestOptions,
    restore: () => {
      (http as any).request = originalRequest;
    },
  };
}

describe("webhook provider validation", () => {
  test("rejects forbidden headers", () => {
    const result = webhookProvider.validateConfig({
      preset: "custom",
      method: "POST",
      url: "https://example.com/webhook",
      query: [],
      headers: [
        { name: "Authorization", value: "Bearer token", sensitive: true },
      ],
      auth: { mode: "none" },
      body: { mode: "text", template: "{{event.body}}" },
      timeoutMs: 10000,
      retryAttempts: 2,
      retryDelayMs: 30000,
      allowInsecureTls: false,
    });

    expect(result).toContain("reserved");
  });

  test("rejects blocked metadata destinations", () => {
    const result = webhookProvider.validateConfig({
      preset: "custom",
      method: "POST",
      url: "http://169.254.169.254/latest/meta-data",
      query: [],
      headers: [],
      auth: { mode: "none" },
      body: { mode: "text", template: "{{event.body}}" },
      timeoutMs: 10000,
      retryAttempts: 2,
      retryDelayMs: 30000,
      allowInsecureTls: false,
    });

    expect(result).toContain("blocked metadata");
  });

  test("rejects disallowed Mustache sections", () => {
    const result = webhookProvider.validateConfig({
      preset: "custom",
      method: "POST",
      url: "https://example.com/{{#event.updates}}bad{{/event.updates}}",
      query: [],
      headers: [],
      auth: { mode: "none" },
      body: { mode: "text", template: "{{event.body}}" },
      timeoutMs: 10000,
      retryAttempts: 2,
      retryDelayMs: 30000,
      allowInsecureTls: false,
    });

    expect(result).toContain("simple variable tags");
  });

  test("rejects unsupported methods", () => {
    const result = webhookProvider.validateConfig({
      preset: "custom",
      method: "DELETE",
      url: "https://example.com/webhook",
      query: [],
      headers: [],
      auth: { mode: "none" },
      body: { mode: "text", template: "{{event.body}}" },
      timeoutMs: 10000,
      retryAttempts: 2,
      retryDelayMs: 30000,
      allowInsecureTls: false,
    });

    expect(result).toContain("POST, PUT, or PATCH");
  });

  test("accepts valid query params, headers, and basic auth", () => {
    const result = webhookProvider.validateConfig({
      preset: "custom",
      method: "PATCH",
      url: "https://example.com/webhook",
      query: [{ name: "source", value: "{{event.eventTypes.0}}" }],
      headers: [{ name: "X-Environment", value: "prod", sensitive: false }],
      auth: { mode: "basic", username: "ops-user", password: "ops-password" },
      body: { mode: "json", template: "{\"body\":{{event.bodyJson}}}" },
      timeoutMs: 10000,
      retryAttempts: 2,
      retryDelayMs: 30000,
      allowInsecureTls: false,
    });

    expect(result).toBeNull();
  });
});

describe("webhook provider sending", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-webhook-notification-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("renders templated JSON bodies and bearer auth", async () => {
    const requestMock = mockHttpRequest(200, "ok");
    const bearerToken = Buffer.from("super-secret-token-data", "utf8").toString("base64");

    try {
      const result = await webhookProvider.send(
        buildPayload(),
        webhookProvider.prepareConfigForStorage({
          preset: "custom",
          method: "POST",
          url: "http://example.com/hook",
          query: [{ name: "source", value: "{{event.eventTypes.0}}" }],
          headers: [{ name: "X-Env", value: "prod", sensitive: false }],
          auth: { mode: "bearer", token: bearerToken },
          body: {
            mode: "json",
            template: "{\"title\":\"{{event.title}}\",\"json\":{{event.json}}}",
          },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })
      );

      expect(result.success).toBe(true);

      const options = requestMock.getRequestOptions();
      const headers = options?.headers as Record<string, string>;
      const body = requestMock.getRequestBody();

      expect(String(options?.path)).toBe("/hook?source=updates");
      expect(headers.Authorization).toBe(`Bearer ${bearerToken}`);
      expect(headers["X-Env"]).toBe("prod");

      const parsedBody = JSON.parse(body);
      expect(parsedBody.title).toBe("Updates available");
      expect(parsedBody.json.title).toBe("Updates available");
    } finally {
      requestMock.restore();
    }
  });

  test("skips hidden systems for immediate update notifications", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const db = getDb();
      const insertedSystem = db.insert(systems).values({
        name: "hidden-web",
        hostname: "hidden-web.local",
        port: 22,
        credentialId: null,
        authType: "password",
        username: "root",
        hidden: 1,
      }).returning({ id: systems.id }).get();

      db.insert(updateCache).values({
        systemId: insertedSystem.id,
        pkgManager: "apt",
        packageName: "openssl",
        newVersion: "1.2.3",
        isSecurity: 1,
      }).run();

      const insertedNotification = db.insert(notifications).values({
        name: "Webhook",
        type: "webhook",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify(webhookProvider.prepareConfigForStorage({
          preset: "custom",
          method: "POST",
          url: "http://example.com/hook",
          query: [],
          headers: [],
          auth: { mode: "none" },
          body: { mode: "text", template: "{{event.body}}" },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })),
      }).returning({ id: notifications.id }).get();

      await processScheduledResults([
        {
          systemId: insertedSystem.id,
          systemName: "hidden-web",
          updateCount: 1,
          securityCount: 1,
          previouslyReachable: true,
          nowUnreachable: false,
        },
      ]);

      const row = db
        .select()
        .from(notifications)
        .where(eq(notifications.id, insertedNotification.id))
        .get();

      expect(requestMock.getRequestBody()).toBe("");
      expect(row?.lastDeliveryStatus).toBeNull();
    } finally {
      requestMock.restore();
    }
  });

  test("drops hidden systems from scheduled digests before sending", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const db = getDb();
      const insertedSystem = db.insert(systems).values({
        name: "digest-web",
        hostname: "digest-web.local",
        port: 22,
        credentialId: null,
        authType: "password",
        username: "root",
        hidden: 0,
      }).returning({ id: systems.id }).get();

      db.insert(updateCache).values({
        systemId: insertedSystem.id,
        pkgManager: "apt",
        packageName: "openssl",
        newVersion: "1.2.3",
        isSecurity: 1,
      }).run();

      const insertedNotification = db.insert(notifications).values({
        name: "Webhook digest",
        type: "webhook",
        enabled: 1,
        notifyOn: '["updates"]',
        schedule: "* * * * *",
        lastSentAt: "2000-01-01 00:00:00",
        config: JSON.stringify(webhookProvider.prepareConfigForStorage({
          preset: "custom",
          method: "POST",
          url: "http://example.com/hook",
          query: [],
          headers: [],
          auth: { mode: "none" },
          body: { mode: "text", template: "{{event.body}}" },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })),
      }).returning({ id: notifications.id }).get();

      await processScheduledResults([
        {
          systemId: insertedSystem.id,
          systemName: "digest-web",
          updateCount: 1,
          securityCount: 1,
          previouslyReachable: true,
          nowUnreachable: false,
        },
      ]);

      db.update(systems)
        .set({ hidden: 1 })
        .where(eq(systems.id, insertedSystem.id))
        .run();

      await processScheduledDigests();

      const row = db
        .select()
        .from(notifications)
        .where(eq(notifications.id, insertedNotification.id))
        .get();

      expect(requestMock.getRequestBody()).toBe("");
      expect(row?.pendingEvents).toBeNull();
      expect(row?.lastDeliveryStatus).toBeNull();
    } finally {
      requestMock.restore();
    }
  });

  test("supports PUT method and basic auth", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const result = await webhookProvider.send(
        buildPayload(),
        webhookProvider.prepareConfigForStorage({
          preset: "custom",
          method: "PUT",
          url: "http://example.com/hook",
          query: [],
          headers: [],
          auth: { mode: "basic", username: "ops-user", password: "ops-password" },
          body: {
            mode: "text",
            template: "{{event.body}}",
          },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })
      );

      expect(result.success).toBe(true);

      const options = requestMock.getRequestOptions();
      const headers = options?.headers as Record<string, string>;
      expect(String(options?.method)).toBe("PUT");
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from("ops-user:ops-password").toString("base64")}`
      );
    } finally {
      requestMock.restore();
    }
  });

  test("supports PATCH method", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const result = await webhookProvider.send(
        buildPayload(),
        webhookProvider.prepareConfigForStorage({
          preset: "custom",
          method: "PATCH",
          url: "http://example.com/hook",
          query: [],
          headers: [],
          auth: { mode: "none" },
          body: {
            mode: "text",
            template: "{{event.body}}",
          },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })
      );

      expect(result.success).toBe(true);
      const options = requestMock.getRequestOptions();
      expect(String(options?.method)).toBe("PATCH");
    } finally {
      requestMock.restore();
    }
  });

  test("json-safe template fields keep multiline strings valid", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const multilinePayload = buildPayload();
      multilinePayload.body = "line one\nline two";
      multilinePayload.event.body = multilinePayload.body;

      const result = await webhookProvider.send(
        multilinePayload,
        webhookProvider.prepareConfigForStorage({
          preset: "discord",
          method: "POST",
          url: "http://example.com/hook",
          query: [],
          headers: [],
          auth: { mode: "none" },
          body: {
            mode: "json",
            template: "{\n  \"description\": {{event.bodyJson}}\n}",
          },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })
      );

      expect(result.success).toBe(true);
      expect(JSON.parse(requestMock.getRequestBody()).description).toBe("line one\nline two");
    } finally {
      requestMock.restore();
    }
  });

  test("auto-upgrades the previously broken discord preset template", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const result = await webhookProvider.send(
        buildPayload(),
        webhookProvider.prepareConfigForStorage({
          preset: "discord",
          method: "POST",
          url: "http://example.com/hook",
          query: [],
          headers: [],
          auth: { mode: "none" },
          body: {
            mode: "json",
            template: JSON.stringify(
              {
                embeds: [
                  {
                    title: "{{event.titleJson}}",
                    description: "{{event.bodyJson}}",
                    timestamp: "{{event.sentAtJson}}",
                  },
                ],
              },
              null,
              2,
            ),
          },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })
      );

      expect(result.success).toBe(true);
      const parsed = JSON.parse(requestMock.getRequestBody());
      expect(parsed.embeds[0].title).toBe("📦 Updates available");
      expect(parsed.embeds[0].description).toBe("web-1: 3 updates");
    } finally {
      requestMock.restore();
    }
  });
});

describe("webhook delivery diagnostics", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-webhook-notification-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("stores delivery diagnostics after a successful webhook send", async () => {
    const requestMock = mockHttpRequest(200, "accepted");

    try {
      const db = getDb();
      const insertedSystem = db.insert(systems).values({
        name: "web-1",
        hostname: "web-1.local",
        username: "root",
      }).returning({ id: systems.id }).get();

      db.insert(updateCache).values({
        systemId: insertedSystem.id,
        pkgManager: "apt",
        packageName: "openssl",
        newVersion: "1.2.3",
      }).run();

      const insertedNotification = db.insert(notifications).values({
        name: "Webhook",
        type: "webhook",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify(webhookProvider.prepareConfigForStorage({
          preset: "custom",
          method: "POST",
          url: "http://example.com/hook",
          query: [],
          headers: [],
          auth: { mode: "none" },
          body: { mode: "text", template: "{{event.body}}" },
          timeoutMs: 10000,
          retryAttempts: 0,
          retryDelayMs: 0,
          allowInsecureTls: false,
        })),
      }).returning({ id: notifications.id }).get();

      await processScheduledResults([
        {
          systemId: insertedSystem.id,
          systemName: "web-1",
          updateCount: 1,
          securityCount: 1,
          previouslyReachable: true,
          nowUnreachable: false,
        },
      ]);

      const row = db
        .select()
        .from(notifications)
        .where(eq(notifications.id, insertedNotification.id))
        .get();

      expect(requestMock.getRequestBody()).toBe("web-1: 1 update (⚠️ 1 security)");
      expect(row?.lastDeliveryStatus).toBe("success");
      expect(row?.lastDeliveryCode).toBe(200);
      expect(row?.lastDeliveryMessage).toContain("accepted");
    } finally {
      requestMock.restore();
    }
  });
});
