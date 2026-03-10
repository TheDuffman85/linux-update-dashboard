import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { apiTokens, notifications, users } from "../../server/db/schema";
import notificationsRoutes from "../../server/routes/notifications";
import { initEncryptor } from "../../server/security";
import {
  prepareTelegramConfigForStorage,
  resolveTelegramCommandToken,
} from "../../server/services/notifications/telegram";

describe("telegram notification routes", () => {
  let tempDir: string;
  let app: Hono;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-telegram-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
    initEncryptor(randomBytes(32).toString("base64"));

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin" });
      await next();
    });
    app.route("/api/notifications", notificationsRoutes);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("creates a telegram link for a saved notification", async () => {
    const createRes = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ops Telegram",
        type: "telegram",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
          commandsEnabled: false,
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    globalThis.fetch = (async (_input, _init) => {
      return new Response(JSON.stringify({
        ok: true,
        result: { username: "ludash_test_bot" },
      }), { status: 200 });
    }) as typeof fetch;

    const linkRes = await app.request(`/api/notifications/${created.id}/telegram/link`, {
      method: "POST",
    });
    expect(linkRes.status).toBe(200);
    const body = await linkRes.json();
    expect(body.url).toContain("https://t.me/ludash_test_bot?start=");

    const stored = getDb().select().from(notifications).where(eq(notifications.id, created.id)).get();
    expect(stored?.config).toContain('"chatBindingStatus":"pending"');
    expect(stored?.config).toContain('"botUsername":"ludash_test_bot"');
  });

  test("unlink clears chat binding and revokes generated command token", async () => {
    getDb().insert(users).values({
      id: 1,
      username: "admin",
      passwordHash: null,
      isAdmin: 1,
    }).run();

    const tokenRow = getDb().insert(apiTokens).values({
      userId: 1,
      name: "telegram:test",
      tokenHash: "token-hash",
      readOnly: 0,
      expiresAt: null,
    }).returning({ id: apiTokens.id }).get();

    const notificationRow = getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatDisplayName: "Alice",
        chatBoundAt: new Date().toISOString(),
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_plain_command_token",
        commandApiTokenId: tokenRow.id,
      })),
    }).returning({ id: notifications.id }).get();

    const res = await app.request(`/api/notifications/${notificationRow.id}/telegram/unlink`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const stored = getDb().select().from(notifications).where(eq(notifications.id, notificationRow.id)).get();
    const token = getDb().select().from(apiTokens).where(eq(apiTokens.id, tokenRow.id)).get();

    expect(stored?.config).toContain('"chatBindingStatus":"unbound"');
    expect(stored?.config).not.toContain('"chatId":"55"');
    expect(token).toBeUndefined();
  });

  test("notification details expose Telegram command token status when the token is missing", async () => {
    getDb().insert(users).values({
      id: 1,
      username: "admin",
      passwordHash: null,
      isAdmin: 1,
    }).run();

    const notificationRow = getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatDisplayName: "Alice",
        chatBoundAt: new Date().toISOString(),
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_missing_command_token",
        commandApiTokenId: 9999,
      })),
    }).returning({ id: notifications.id }).get();

    const res = await app.request(`/api/notifications/${notificationRow.id}`);
    expect(res.status).toBe(200);

    const body = await res.json() as { config: Record<string, unknown> };
    expect(body.config.commandTokenStatus).toBe("missing");
    expect(body.config.commandApiTokenEncrypted).toBe("(stored)");
  });

  test("reissue rotates the Telegram command token and updates notification status", async () => {
    getDb().insert(users).values({
      id: 1,
      username: "admin",
      passwordHash: null,
      isAdmin: 1,
    }).run();

    const oldToken = getDb().insert(apiTokens).values({
      userId: 1,
      name: "telegram:test",
      tokenHash: "old-token-hash",
      readOnly: 0,
      expiresAt: null,
    }).returning({ id: apiTokens.id }).get();

    const notificationRow = getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatDisplayName: "Alice",
        chatBoundAt: new Date().toISOString(),
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_old_command_token",
        commandApiTokenId: oldToken.id,
      })),
    }).returning({ id: notifications.id }).get();

    const res = await app.request(`/api/notifications/${notificationRow.id}/telegram/reissue-command-token`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const reloaded = getDb().select().from(notifications).where(eq(notifications.id, notificationRow.id)).get();
    const tokenRows = getDb().select().from(apiTokens).all();

    expect(tokenRows).toHaveLength(1);
    expect(tokenRows[0]?.id).not.toBe(oldToken.id);
    expect(getDb().select().from(apiTokens).where(eq(apiTokens.id, oldToken.id)).get()).toBeUndefined();

    const decrypted = resolveTelegramCommandToken(JSON.parse(reloaded?.config || "{}"));
    expect(decrypted).toMatch(/^ludash_/);
    expect(decrypted).not.toBe("ludash_old_command_token");

    const detailsRes = await app.request(`/api/notifications/${notificationRow.id}`);
    expect(detailsRes.status).toBe(200);

    const details = await detailsRes.json() as { config: Record<string, unknown> };
    expect(details.config.commandTokenStatus).toBe("active");
    expect(details.config.commandApiTokenId).toBe(tokenRows[0]?.id);
  });

  test("notification details mark Telegram command tokens as expired", async () => {
    getDb().insert(users).values({
      id: 1,
      username: "admin",
      passwordHash: null,
      isAdmin: 1,
    }).run();

    const expiredToken = getDb().insert(apiTokens).values({
      userId: 1,
      name: "telegram:expired",
      tokenHash: "expired-token-hash",
      readOnly: 0,
      expiresAt: "2000-01-01 00:00:00",
    }).returning({ id: apiTokens.id }).get();

    const notificationRow = getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatDisplayName: "Alice",
        chatBoundAt: new Date().toISOString(),
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_expired_command_token",
        commandApiTokenId: expiredToken.id,
      })),
    }).returning({ id: notifications.id }).get();

    const res = await app.request(`/api/notifications/${notificationRow.id}`);
    expect(res.status).toBe(200);

    const body = await res.json() as { config: Record<string, unknown> };
    expect(body.config.commandTokenStatus).toBe("expired");
    expect(body.config.commandTokenExpiresAt).toBe("2000-01-01 00:00:00");
  });
});
