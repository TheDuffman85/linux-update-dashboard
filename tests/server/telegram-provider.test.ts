import { afterEach, describe, expect, test } from "bun:test";
import { initEncryptor } from "../../server/security";
import { telegramProvider, resolveTelegramBotToken } from "../../server/services/notifications/telegram";
import { __testing as requestSecurityTesting, rememberTrustedPublicOrigin } from "../../server/request-security";

describe("telegram provider validation", () => {
  test("accepts config without a bound chat", () => {
    const result = telegramProvider.validateConfig({
      telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
      commandsEnabled: false,
    });
    expect(result).toBeNull();
  });

  test("rejects invalid bot token format", () => {
    const result = telegramProvider.validateConfig({
      telegramBotToken: "bad-token",
    });
    expect(result).toContain("token format");
  });

  test("masks and encrypts sensitive values", () => {
    initEncryptor("telegram-provider-test-key");

    const stored = telegramProvider.prepareConfigForStorage({
      telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
      commandApiTokenEncrypted: "ludash_plain_command_token",
      commandsEnabled: true,
    });
    const masked = telegramProvider.maskConfig(stored);

    expect(String(stored.telegramBotToken)).not.toContain("123456789:");
    expect(resolveTelegramBotToken(stored)).toBe("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345");
    expect(masked.telegramBotToken).toBe("(stored)");
    expect(masked.commandApiTokenEncrypted).toBe("(stored)");
  });
});

describe("telegram provider sending", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    requestSecurityTesting.resetKnownPublicOrigin();
  });

  test("fails when chat is not bound", async () => {
    const result = await telegramProvider.send(
      {
        title: "Updates",
        body: "Body",
        event: {
          title: "Updates",
          body: "Body",
          priority: "default",
          tags: [],
          sentAt: new Date().toISOString(),
          eventTypes: [],
          totals: {
            systemsWithUpdates: 0,
            totalUpdates: 0,
            totalSecurity: 0,
            totalKeptBack: 0,
            unreachableSystems: 0,
          },
          updates: [],
          unreachable: [],
          appUpdate: null,
        },
      },
      {
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
      }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not bound");
  });

  test("posts sendMessage when bound", async () => {
    const previousBaseUrl = process.env.LUDASH_BASE_URL;
    delete process.env.LUDASH_BASE_URL;

    let requestBody = "";
    try {
      globalThis.fetch = (async (_input, init) => {
        requestBody = String(init?.body || "");
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as typeof fetch;

      rememberTrustedPublicOrigin("https://dashboard.example.com");

      const result = await telegramProvider.send(
        {
          title: "Updates",
          body: "2 packages",
          tags: ["package"],
          event: {
            title: "Updates",
            body: "2 packages",
            priority: "default",
            tags: ["package"],
            sentAt: new Date().toISOString(),
            eventTypes: [],
            totals: {
              systemsWithUpdates: 0,
              totalUpdates: 0,
              totalSecurity: 0,
              totalKeptBack: 0,
              unreachableSystems: 0,
            },
            updates: [],
            unreachable: [],
            appUpdate: null,
          },
        },
        {
          telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
          chatId: "55",
        }
      );

      expect(result.success).toBe(true);
      const parsedBody = JSON.parse(requestBody) as {
        chat_id: string;
        text: string;
        parse_mode?: string;
        reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; url?: string }>> };
      };
      expect(parsedBody.chat_id).toBe("55");
      expect(parsedBody.parse_mode).toBe("HTML");
      expect(parsedBody.text).toBe("<b>📦 Updates</b>\n\n2 packages");
      expect(parsedBody.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
        text: "Open LUD",
        url: "https://dashboard.example.com/",
      });
    } finally {
      if (previousBaseUrl === undefined) delete process.env.LUDASH_BASE_URL;
      else process.env.LUDASH_BASE_URL = previousBaseUrl;
    }
  });

  test("adds an Open release button for app updates", async () => {
    let requestBody = "";
    globalThis.fetch = (async (_input, init) => {
      requestBody = String(init?.body || "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as typeof fetch;

    const result = await telegramProvider.send(
      {
        title: "Application update available",
        body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
        tags: ["arrow_up"],
        event: {
          title: "Application update available",
          body: "Linux Update Dashboard: v2026.3.1 -> v2026.3.2",
          priority: "default",
          tags: ["arrow_up"],
          sentAt: new Date().toISOString(),
          eventTypes: ["appUpdates"],
          totals: {
            systemsWithUpdates: 0,
            totalUpdates: 0,
            totalSecurity: 0,
            totalKeptBack: 0,
            unreachableSystems: 0,
          },
          updates: [],
          unreachable: [],
          appUpdate: {
            currentVersion: "2026.3.1",
            currentBranch: "main",
            remoteVersion: "2026.3.2",
            releaseUrl: "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
            repoUrl: "https://github.com/TheDuffman85/linux-update-dashboard",
          },
        },
      },
      {
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
      }
    );

    expect(result.success).toBe(true);
    const parsedBody = JSON.parse(requestBody) as {
      reply_markup?: { inline_keyboard?: Array<Array<{ text?: string; url?: string }>> };
    };
    expect(parsedBody.reply_markup?.inline_keyboard?.[0]?.[0]).toEqual({
      text: "Open release",
      url: "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
    });
  });
});
