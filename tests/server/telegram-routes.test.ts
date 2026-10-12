import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Hono as BaseHono } from "hono";
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
import {
  __testing as telegramBotTesting,
  syncBrandingProfilePhotos,
} from "../../server/services/telegram-bot";
import { saveAppLogo } from "../../server/services/branding-service";

const Hono = BaseHono<{ Variables: { user: { userId: number; username: string; isAdmin?: boolean } } }>;
type Hono = InstanceType<typeof Hono>;

describe("telegram notification routes", () => {
  let tempDir: string;
  let app: Hono;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-telegram-routes-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
    initEncryptor(randomBytes(32).toString("base64"));
    telegramBotTesting.resetTestingState();

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("user", { userId: 1, username: "admin" });
      await next();
    });
    app.route("/api/notifications", notificationsRoutes);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    telegramBotTesting.resetTestingState();
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

    let profilePhotoUploaded = false;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/setMyProfilePhoto")) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get("photo")).toBe('{"type":"static","photo":"attach://avatar"}');
        const avatar = form.get("avatar");
        expect(avatar).toBeInstanceOf(File);
        expect((avatar as File).name).toBe("telegram-bot-avatar.jpg");
        expect((avatar as File).type).toBe("image/jpeg");
        profilePhotoUploaded = true;
        return new Response(JSON.stringify({
          ok: true,
          result: true,
        }), { status: 200 });
      }

      expect(url).toContain("/getMe");
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
    expect(profilePhotoUploaded).toBe(true);

    const stored = getDb().select().from(notifications).where(eq(notifications.id, created.id)).get();
    expect(stored?.config).toContain('"chatBindingStatus":"pending"');
    expect(stored?.config).toContain('"botUsername":"ludash_test_bot"');
  });

  test("creates a telegram link even if bot profile photo sync fails", async () => {
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

    let setPhotoCalls = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/setMyProfilePhoto")) {
        setPhotoCalls += 1;
        return new Response(JSON.stringify({
          ok: false,
          description: "profile photo rejected",
        }), { status: 400 });
      }

      expect(url).toContain("/getMe");
      return new Response(JSON.stringify({
        ok: true,
        result: { username: "ludash_test_bot" },
      }), { status: 200 });
    }) as typeof fetch;

    const linkRes = await app.request(`/api/notifications/${created.id}/telegram/link`, {
      method: "POST",
    });
    expect(linkRes.status).toBe(200);
    expect(setPhotoCalls).toBe(1);

    const body = await linkRes.json();
    expect(body.url).toContain("https://t.me/ludash_test_bot?start=");
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

  describe("branded bot profile photo", () => {
    const PNG_LOGO = {
      contentType: "image/png" as const,
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    };
    const jpeg = (marker: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, marker]);

    async function createTelegramNotification() {
      const res = await app.request("/api/notifications", {
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
      expect(res.status).toBe(201);
      return (await res.json()) as { id: number };
    }

    function stubTelegram(uploads: Buffer[]) {
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url.includes("/setMyProfilePhoto")) {
          const avatar = (init?.body as FormData).get("avatar") as File;
          uploads.push(Buffer.from(await avatar.arrayBuffer()));
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return new Response(JSON.stringify({
          ok: true,
          result: { username: "ludash_test_bot" },
        }), { status: 200 });
      }) as typeof fetch;
    }

    test("uploads the branding logo rendition once per version when linking", async () => {
      saveAppLogo(PNG_LOGO, jpeg(1));
      const created = await createTelegramNotification();
      const uploads: Buffer[] = [];
      stubTelegram(uploads);

      await app.request(`/api/notifications/${created.id}/telegram/link`, { method: "POST" });
      await app.request(`/api/notifications/${created.id}/telegram/link`, { method: "POST" });

      expect(uploads).toEqual([jpeg(1)]);
    });

    test("re-uploads the photo of linked bots when the logo changes", async () => {
      getDb().insert(notifications).values({
        name: "Linked Telegram",
        type: "telegram",
        enabled: 1,
        notifyOn: '["updates"]',
        config: JSON.stringify(prepareTelegramConfigForStorage({
          telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
          chatId: "42",
          chatBindingStatus: "bound",
          commandsEnabled: false,
        })),
      }).run();
      const uploads: Buffer[] = [];
      stubTelegram(uploads);
      telegramBotTesting.setStarted(true);

      saveAppLogo(PNG_LOGO, jpeg(1));
      await syncBrandingProfilePhotos();
      await syncBrandingProfilePhotos();
      saveAppLogo(PNG_LOGO, jpeg(2));
      await syncBrandingProfilePhotos();

      expect(uploads).toEqual([jpeg(1), jpeg(2)]);
    });

    test("does not touch bots without a linked chat", async () => {
      await createTelegramNotification();
      const uploads: Buffer[] = [];
      stubTelegram(uploads);
      telegramBotTesting.setStarted(true);

      saveAppLogo(PNG_LOGO, jpeg(1));
      await syncBrandingProfilePhotos();

      expect(uploads).toEqual([]);
    });
  });
});
