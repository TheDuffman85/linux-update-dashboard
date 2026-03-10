import { afterEach, describe, expect, test } from "bun:test";
import { initEncryptor } from "../../server/security";
import { telegramProvider, resolveTelegramBotToken } from "../../server/services/notifications/telegram";

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
    let requestBody = "";
    globalThis.fetch = (async (_input, init) => {
      requestBody = String(init?.body || "");
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }) as typeof fetch;

    const result = await telegramProvider.send(
      {
        title: "Updates",
        body: "2 packages",
        event: {
          title: "Updates",
          body: "2 packages",
          priority: "default",
          tags: [],
          sentAt: new Date().toISOString(),
          eventTypes: [],
          totals: {
            systemsWithUpdates: 0,
            totalUpdates: 0,
            totalSecurity: 0,
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
    expect(requestBody).toContain('"chat_id":"55"');
    expect(requestBody).toContain("Updates");
  });
});

