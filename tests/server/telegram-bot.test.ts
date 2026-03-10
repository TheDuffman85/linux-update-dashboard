import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { prepareTelegramConfigForStorage } from "../../server/services/notifications/telegram";
import { __testing as telegramTesting, start as startTelegramBot, stop as stopTelegramBot } from "../../server/services/telegram-bot";

describe("telegram bot commands", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-telegram-bot-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
    initEncryptor(randomBytes(32).toString("base64"));
    telegramTesting.resetTestingState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    telegramTesting.resetTestingState();
    stopTelegramBot();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("runs check commands through the existing API", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentMessages: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/check")) {
        return new Response(JSON.stringify({
          systems: [{ id: 1, name: "alpha", updateCount: 2, isReachable: 1 }],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/check")) {
        expect(init?.headers && new Headers(init.headers).get("Authorization")).toBe("Bearer ludash_command_token");
        return new Response(JSON.stringify({ status: "started", jobId: "job-1" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-1")) {
        return new Response(JSON.stringify({ status: "done", result: { updateCount: 2 } }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentMessages.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      message: {
        message_id: 10,
        text: "/check 1",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessages.some((body) => body.includes("Checking updates for alpha"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("Check completed for alpha"))).toBe(true);
  });

  test("requires confirmation before package upgrades", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentBodies: string[] = [];
    let upgradeCalled = false;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/upgrade/")) {
        return new Response(JSON.stringify({
          systems: [{ id: 1, name: "alpha", updateCount: 2, isReachable: 1 }],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/upgrade/bash")) {
        upgradeCalled = true;
        return new Response(JSON.stringify({ status: "started", jobId: "job-2" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-2")) {
        return new Response(JSON.stringify({
          status: "done",
          result: { status: "success", package: "bash", output: "done" },
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      if (url.includes("/answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      message: {
        message_id: 10,
        text: "/upgradepkg 1 bash",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    expect(upgradeCalled).toBe(false);

    const confirmBody = sentBodies.find((body) => body.includes("Confirm package upgrade"));
    expect(confirmBody).toBeTruthy();
    const parsed = JSON.parse(confirmBody || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const confirmData = parsed.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(confirmData).toMatch(/^confirm:/);

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-1",
        data: confirmData,
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 11,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(upgradeCalled).toBe(true);
    expect(sentBodies.some((body) => body.includes("Package upgrade started"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("Package upgrade finished"))).toBe(true);
  });

  test("menu flow lets the user pick a package before confirmation", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems/1") && !url.includes("/upgrade/")) {
        return new Response(JSON.stringify({
          system: { id: 1, name: "alpha" },
          updates: [{ packageName: "bash" }, { packageName: "openssl" }],
          history: [],
        }), { status: 200 });
      }
      if (url.includes("/api/systems") && !url.includes("/upgrade/") && !url.includes("/api/systems/1")) {
        return new Response(JSON.stringify({
          systems: [{ id: 1, name: "alpha", updateCount: 2, isReachable: 1 }],
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      if (url.includes("/answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      message: {
        message_id: 10,
        text: "/menu",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    const rootMenu = sentBodies.find((body) => body.includes("Telegram command menu"));
    expect(rootMenu).toBeTruthy();

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-menu-1",
        data: "menu:list:pkgsys:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 11,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const systemMenu = sentBodies.find((body) => body.includes("Select a system to choose a package"));
    expect(systemMenu).toBeTruthy();
    expect(systemMenu).toContain("Page 1/1");

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 3,
      callback_query: {
        id: "cb-menu-2",
        data: "menu:run:pkgsys:1:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 12,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const packageMenu = sentBodies.find((body) => body.includes("Select a package to upgrade"));
    expect(packageMenu).toBeTruthy();
    expect(packageMenu).toContain("bash");
    expect(packageMenu).toContain("Page 1/1");

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 4,
      callback_query: {
        id: "cb-menu-3",
        data: "menu:pkg:1:0:bash",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 13,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    expect(sentBodies.some((body) => body.includes("Confirm package upgrade on alpha"))).toBe(true);
  });

  test("sends a Telegram error message when the command token is no longer valid", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentMessages: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems")) {
        expect(init?.headers && new Headers(init.headers).get("Authorization")).toBe("Bearer ludash_command_token");
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }
      if (url.includes("/sendMessage")) {
        sentMessages.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      message: {
        message_id: 10,
        text: "/status",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    expect(sentMessages.some((body) => body.includes("command authentication failed"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("Reissue"))).toBe(true);
  });

  test("sends a sanitized Telegram error message for other API failures", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentMessages: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/check")) {
        return new Response(JSON.stringify({
          systems: [{ id: 1, name: "alpha", updateCount: 2, isReachable: 1 }],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/check")) {
        expect(init?.headers && new Headers(init.headers).get("Authorization")).toBe("Bearer ludash_command_token");
        return new Response(JSON.stringify({ error: "backend exploded\npassword=secret" }), { status: 500 });
      }
      if (url.includes("/sendMessage")) {
        sentMessages.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      message: {
        message_id: 10,
        text: "/check 1",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    expect(sentMessages.some((body) => body.includes("Command failed: backend exploded"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("password=***"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("secret"))).toBe(false);
  });

  test("package menu keeps pagination context for back navigation", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1,2,3,4,5,6,7,8,9]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems/9") && !url.includes("/upgrade/")) {
        return new Response(JSON.stringify({
          system: { id: 9, name: "sys-9" },
          updates: [
            { packageName: "pkg1" }, { packageName: "pkg2" }, { packageName: "pkg3" },
            { packageName: "pkg4" }, { packageName: "pkg5" }, { packageName: "pkg6" },
            { packageName: "pkg7" }, { packageName: "pkg8" }, { packageName: "pkg9" },
          ],
          history: [],
        }), { status: 200 });
      }
      if (url.includes("/api/systems") && !url.includes("/api/systems/9")) {
        return new Response(JSON.stringify({
          systems: Array.from({ length: 9 }, (_, index) => ({
            id: index + 1,
            name: `sys-${index + 1}`,
            updateCount: index + 1,
            isReachable: 1,
          })),
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      if (url.includes("/answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      callback_query: {
        id: "cb-page-1",
        data: "menu:list:pkgsys:1",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 20,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const systemMenu = sentBodies.find((body) => body.includes("Select a system to choose a package"));
    expect(systemMenu).toBeTruthy();
    expect(systemMenu).toContain("Page 2/2");
    const parsedSystemMenu = JSON.parse(systemMenu || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    expect(parsedSystemMenu.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("menu:run:pkgsys:9:1");

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-page-2",
        data: "menu:run:pkgsys:9:1",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 21,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const packageMenu = sentBodies.find((body) => body.includes("Select a package to upgrade on sys-9"));
    expect(packageMenu).toBeTruthy();
    const parsedPackageMenu = JSON.parse(packageMenu || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const backRow = parsedPackageMenu.reply_markup?.inline_keyboard?.at(-1);
    expect(backRow?.[0]?.callback_data).toBe("menu:list:pkgsys:1");
  });

  test("menu runs single-target check and confirmation-based upgrades", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentBodies: string[] = [];
    let fullUpgradeCalled = false;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/check") && !url.includes("/full-upgrade")) {
        return new Response(JSON.stringify({
          systems: [{ id: 1, name: "alpha", updateCount: 2, isReachable: 1, supportsFullUpgrade: true }],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/check")) {
        return new Response(JSON.stringify({ status: "started", jobId: "job-check" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-check")) {
        return new Response(JSON.stringify({ status: "done", result: { updateCount: 2 } }), { status: 200 });
      }
      if (url.includes("/api/systems/1/full-upgrade")) {
        fullUpgradeCalled = true;
        return new Response(JSON.stringify({ status: "started", jobId: "job-full" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-full")) {
        return new Response(JSON.stringify({
          status: "done",
          result: { status: "success", output: "done" },
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      if (url.includes("/answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      callback_query: {
        id: "cb-run-check",
        data: "menu:run:check:1:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 30,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentBodies.some((body) => body.includes("Checking updates for alpha"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("Check completed for alpha"))).toBe(true);

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-run-fullupgrade",
        data: "menu:run:fullupgrade:1:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 31,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    expect(fullUpgradeCalled).toBe(false);

    const fullUpgradePrompt = sentBodies.find((body) => body.includes("Confirm full upgrade for alpha"));
    expect(fullUpgradePrompt).toBeTruthy();
    const parsedPrompt = JSON.parse(fullUpgradePrompt || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const confirmData = parsedPrompt.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(confirmData).toMatch(/^confirm:/);

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 3,
      callback_query: {
        id: "cb-confirm-fullupgrade",
        data: confirmData,
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 32,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fullUpgradeCalled).toBe(true);
    expect(sentBodies.some((body) => body.includes("Full upgrade started for system #1"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("Full upgrade finished for system #1"))).toBe(true);
  });

  test("menu hides unsupported systems from full-upgrade and typed command rejects them", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1,2]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "apt-box", updateCount: 2, isReachable: 1, supportsFullUpgrade: true },
            { id: 2, name: "snap-box", updateCount: 1, isReachable: 1, supportsFullUpgrade: false },
          ],
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      if (url.includes("/answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      callback_query: {
        id: "cb-full-list",
        data: "menu:list:fullupgrade:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 40,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const fullUpgradeMenu = sentBodies.find((body) => body.includes("Select a system for full upgrade"));
    expect(fullUpgradeMenu).toBeTruthy();
    expect(fullUpgradeMenu).toContain("apt-box");
    expect(fullUpgradeMenu).not.toContain("snap-box");

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      message: {
        message_id: 41,
        text: "/fullupgrade 2",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    expect(sentBodies.some((body) => body.includes("Full upgrade is not supported for snap-box"))).toBe(true);
  });

  test("menu only shows actionable systems for upgrade-related actions", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1,2,3]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "updatable-apt", updateCount: 4, isReachable: 1, supportsFullUpgrade: true },
            { id: 2, name: "no-updates-apt", updateCount: 0, isReachable: 1, supportsFullUpgrade: true },
            { id: 3, name: "updatable-snap", updateCount: 2, isReachable: 1, supportsFullUpgrade: false },
          ],
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      if (url.includes("/answerCallbackQuery")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      callback_query: {
        id: "cb-upgrade-list",
        data: "menu:list:upgrade:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 50,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const upgradeMenu = sentBodies.find((body) => body.includes("Select a system to upgrade"));
    expect(upgradeMenu).toBeTruthy();
    expect(upgradeMenu).toContain("updatable-apt");
    expect(upgradeMenu).toContain("updatable-snap");
    expect(upgradeMenu).not.toContain("no-updates-apt");

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-fullupgrade-list",
        data: "menu:list:fullupgrade:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 51,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const fullUpgradeMenu = sentBodies.find((body) => body.includes("Select a system for full upgrade"));
    expect(fullUpgradeMenu).toBeTruthy();
    expect(fullUpgradeMenu).toContain("updatable-apt");
    expect(fullUpgradeMenu).not.toContain("no-updates-apt");
    expect(fullUpgradeMenu).not.toContain("updatable-snap");

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 3,
      callback_query: {
        id: "cb-pkgsys-list",
        data: "menu:list:pkgsys:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 52,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const packageSystemMenu = sentBodies.find((body) => body.includes("Select a system to choose a package"));
    expect(packageSystemMenu).toBeTruthy();
    expect(packageSystemMenu).toContain("updatable-apt");
    expect(packageSystemMenu).toContain("updatable-snap");
    expect(packageSystemMenu).not.toContain("no-updates-apt");

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 4,
      callback_query: {
        id: "cb-check-list",
        data: "menu:list:check:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 53,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const checkMenu = sentBodies.find((body) => body.includes("Select a system to refresh/check"));
    expect(checkMenu).toBeTruthy();
    expect(checkMenu).toContain("updatable-apt");
    expect(checkMenu).toContain("no-updates-apt");
    expect(checkMenu).toContain("updatable-snap");
  });

  test("start syncs Telegram slash commands", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: null,
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatBindingStatus: "unbound",
        commandsEnabled: false,
      })),
    }).run();

    let setMyCommandsBody = "";
    let getUpdatesCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/setMyCommands")) {
        setMyCommandsBody = String(init?.body || "");
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (url.includes("/getUpdates")) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          queueMicrotask(() => stopTelegramBot());
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await startTelegramBot();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(setMyCommandsBody).toContain('"command":"menu"');
    expect(setMyCommandsBody).toContain('"command":"status"');
    expect(setMyCommandsBody).not.toContain('"command":"check"');
    expect(setMyCommandsBody).not.toContain('"command":"upgradepkg"');
    expect(getUpdatesCalls).toBeGreaterThan(0);
  });
});
