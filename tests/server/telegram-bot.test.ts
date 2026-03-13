import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications } from "../../server/db/schema";
import { eq } from "drizzle-orm";
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

  test("runs refresh commands through the existing API", async () => {
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
        expect(url).toContain("/api/systems?scope=visible");
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
        text: "/refresh 1",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessages.some((body) => body.includes("Refreshing updates for alpha"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("Refresh completed for alpha"))).toBe(true);
  });

  test("runs /refresh all across every allowed system", async () => {
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

    const sentMessages: string[] = [];
    const checkedSystems: number[] = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/check")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "alpha", updateCount: 2, isReachable: 1 },
            { id: 2, name: "beta", updateCount: 0, isReachable: 1 },
          ],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/check")) {
        checkedSystems.push(1);
        return new Response(JSON.stringify({ status: "started", jobId: "job-1" }), { status: 200 });
      }
      if (url.includes("/api/systems/2/check")) {
        checkedSystems.push(2);
        return new Response(JSON.stringify({ status: "started", jobId: "job-2" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-1")) {
        return new Response(JSON.stringify({ status: "done", result: { updateCount: 2 } }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-2")) {
        return new Response(JSON.stringify({ status: "done", result: { updateCount: 0 } }), { status: 200 });
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
        text: "/refresh all",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkedSystems).toEqual([1, 2]);
    expect(sentMessages.some((body) => body.includes("Refresh all started for 2 systems."))).toBe(true);
    expect(sentMessages.some((body) => body.includes("- alpha (#1): 2 updates"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("- beta (#2): 0 updates"))).toBe(true);
  });

  test("lists cached package updates for a system", async () => {
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
          updates: [
            { packageName: "bash", currentVersion: "5.2.15", newVersion: "5.2.21" },
            { packageName: "openssl", currentVersion: "3.0.2", newVersion: "3.0.3" },
          ],
          history: [],
        }), { status: 200 });
      }
      if (url.includes("/api/systems") && !url.includes("/api/systems/1")) {
        return new Response(JSON.stringify({
          systems: [{ id: 1, name: "alpha", updateCount: 2, isReachable: 1 }],
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 1,
      message: {
        message_id: 10,
        text: "/packages 1",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    const packageMessage = sentBodies.find((body) => body.includes("Package updates for alpha (#1): 2 packages"));
    expect(packageMessage).toBeTruthy();
    const parsedBody = JSON.parse(packageMessage || "{}") as { text?: string };
    expect(parsedBody.text).toContain("- bash: 5.2.15 -> 5.2.21");
    expect(parsedBody.text).toContain("- openssl: 3.0.2 -> 3.0.3");
  });

  test("formats /status as HTML with emojis and preserves system order", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[2,1]",
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
            { id: 1, name: "alpha & beta", updateCount: 3, securityCount: 2, isReachable: 1 },
            { id: 2, name: "gamma <prod>", updateCount: 0, securityCount: 0, isReachable: 0 },
          ],
        }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        sentBodies.push(String(init?.body || ""));
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

    expect(sentBodies).toHaveLength(1);
    const parsedBody = JSON.parse(sentBodies[0]) as { text: string; parse_mode?: string };

    expect(parsedBody.parse_mode).toBe("HTML");
    expect(parsedBody.text).toContain("⚠️ Pending updates on 1 system (2 security)");
    expect(parsedBody.text).toContain("<code>#1</code> 🟢 <b>alpha &amp; beta</b>: 3 updates (⚠️ 2 security)");
    expect(parsedBody.text).toContain("<code>#2</code> 🟠 <b>gamma &lt;prod&gt;</b>: 0 updates");
    expect(parsedBody.text.indexOf("alpha &amp; beta")).toBeLessThan(parsedBody.text.indexOf("gamma &lt;prod&gt;"));
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

  test("requires one confirmation before /upgrade all and skips systems excluded from Upgrade All", async () => {
    getDb().insert(notifications).values({
      name: "Ops Telegram",
      type: "telegram",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1,2,3,4]",
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatId: "55",
        chatBindingStatus: "bound",
        commandsEnabled: true,
        commandApiTokenEncrypted: "ludash_command_token",
      })),
    }).run();

    const sentBodies: string[] = [];
    const upgradedSystems: number[] = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/upgrade")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "alpha", updateCount: 2, isReachable: 1, supportsFullUpgrade: true, excludeFromUpgradeAll: 0 },
            { id: 2, name: "beta", updateCount: 0, isReachable: 1, supportsFullUpgrade: true, excludeFromUpgradeAll: 0 },
            { id: 3, name: "gamma", updateCount: 1, isReachable: 1, supportsFullUpgrade: false, excludeFromUpgradeAll: 1 },
            { id: 4, name: "delta", updateCount: 3, isReachable: 1, supportsFullUpgrade: true, excludeFromUpgradeAll: 0 },
          ],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/upgrade")) {
        upgradedSystems.push(1);
        return new Response(JSON.stringify({ status: "started", jobId: "job-up-1" }), { status: 200 });
      }
      if (url.includes("/api/systems/4/upgrade")) {
        upgradedSystems.push(4);
        return new Response(JSON.stringify({ status: "started", jobId: "job-up-4" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-up-1")) {
        return new Response(JSON.stringify({ status: "done", result: { status: "success", output: "done" } }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-up-4")) {
        return new Response(JSON.stringify({ status: "done", result: { status: "warning", output: "done" } }), { status: 200 });
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
        text: "/upgrade all",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    expect(upgradedSystems).toEqual([]);

    const confirmBody = sentBodies.find((body) => body.includes("Confirm upgrade all for 2 systems?"));
    expect(confirmBody).toBeTruthy();
    expect(confirmBody).toContain("alpha");
    expect(confirmBody).toContain("delta");
    expect(confirmBody).not.toContain("beta");
    expect(confirmBody).not.toContain("gamma");
    const parsed = JSON.parse(confirmBody || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const confirmData = parsed.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(confirmData).toMatch(/^confirm:/);

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-upgrade-all",
        data: confirmData,
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 11,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(upgradedSystems).toEqual([1, 4]);
    expect(sentBodies.some((body) => body.includes("Upgrade all started for 2 systems."))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- alpha (#1): success"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- delta (#4): warning"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- gamma (#3):"))).toBe(false);
  });

  test("requires one confirmation before /fullupgrade all and skips systems excluded from Upgrade All", async () => {
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
    const fullUpgradedSystems: number[] = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/full-upgrade")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "alpha", updateCount: 2, isReachable: 1, supportsFullUpgrade: true, excludeFromUpgradeAll: 0 },
            { id: 2, name: "beta", updateCount: 1, isReachable: 1, supportsFullUpgrade: true, excludeFromUpgradeAll: 1 },
            { id: 3, name: "gamma", updateCount: 4, isReachable: 1, supportsFullUpgrade: false, excludeFromUpgradeAll: 0 },
          ],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/full-upgrade")) {
        fullUpgradedSystems.push(1);
        return new Response(JSON.stringify({ status: "started", jobId: "job-full-up-1" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-full-up-1")) {
        return new Response(JSON.stringify({ status: "done", result: { status: "success", output: "done" } }), { status: 200 });
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
        text: "/fullupgrade all",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    expect(fullUpgradedSystems).toEqual([]);

    const confirmBody = sentBodies.find((body) => body.includes("Confirm full upgrade all for 1 system?"));
    expect(confirmBody).toBeTruthy();
    expect(confirmBody).toContain("alpha");
    expect(confirmBody).not.toContain("beta");
    expect(confirmBody).not.toContain("gamma");
    const parsed = JSON.parse(confirmBody || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const confirmData = parsed.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(confirmData).toMatch(/^confirm:/);

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-full-upgrade-all",
        data: confirmData,
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 11,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fullUpgradedSystems).toEqual([1]);
    expect(sentBodies.some((body) => body.includes("Full upgrade all started for 1 system."))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- alpha (#1): success"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- beta (#2):"))).toBe(false);
    expect(sentBodies.some((body) => body.includes("- gamma (#3):"))).toBe(false);
  });

  test("confirmation re-checks current channel scope for single-system upgrades", async () => {
    const inserted = getDb().insert(notifications).values({
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
    }).returning({ id: notifications.id }).get();

    const sentBodies: string[] = [];
    let upgradeCalled = false;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/upgrade")) {
        return new Response(JSON.stringify({
          systems: [{ id: 1, name: "alpha", updateCount: 2, isReachable: 1 }],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/upgrade")) {
        upgradeCalled = true;
        return new Response(JSON.stringify({ status: "started", jobId: "job-upgrade-1" }), { status: 200 });
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
        text: "/upgrade 1",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    const confirmBody = sentBodies.find((body) => body.includes("Confirm upgrade for alpha"));
    expect(confirmBody).toBeTruthy();
    const parsed = JSON.parse(confirmBody || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const confirmData = parsed.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(confirmData).toMatch(/^confirm:/);

    getDb().update(notifications)
      .set({ systemIds: "[2]" })
      .where(eq(notifications.id, inserted.id))
      .run();

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-scope-single",
        data: confirmData,
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 11,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    expect(upgradeCalled).toBe(false);
    expect(sentBodies.some((body) => body.includes("no longer allowed"))).toBe(true);
  });

  test("bulk confirmation re-checks current channel scope before execution", async () => {
    const inserted = getDb().insert(notifications).values({
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
    }).returning({ id: notifications.id }).get();

    const sentBodies: string[] = [];
    const upgradedSystems: number[] = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/upgrade")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "alpha", updateCount: 2, isReachable: 1, supportsFullUpgrade: true },
            { id: 2, name: "beta", updateCount: 1, isReachable: 1, supportsFullUpgrade: true },
          ],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/2/upgrade")) {
        upgradedSystems.push(2);
        return new Response(JSON.stringify({ status: "started", jobId: "job-upgrade-2" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-upgrade-2")) {
        return new Response(JSON.stringify({ status: "done", result: { status: "success", output: "done" } }), { status: 200 });
      }
      if (url.includes("/api/systems/1/upgrade")) {
        upgradedSystems.push(1);
        return new Response(JSON.stringify({ status: "started", jobId: "job-upgrade-1" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-upgrade-1")) {
        return new Response(JSON.stringify({ status: "done", result: { status: "success", output: "done" } }), { status: 200 });
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
        text: "/upgrade all",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    const confirmBody = sentBodies.find((body) => body.includes("Confirm upgrade all for 2 systems?"));
    expect(confirmBody).toBeTruthy();
    const parsed = JSON.parse(confirmBody || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const confirmData = parsed.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(confirmData).toMatch(/^confirm:/);

    getDb().update(notifications)
      .set({ systemIds: "[2]" })
      .where(eq(notifications.id, inserted.id))
      .run();

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-scope-bulk",
        data: confirmData,
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 11,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(upgradedSystems).toEqual([2]);
    expect(sentBodies.some((body) => body.includes("Upgrade all started for 1 system."))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- beta (#2): success"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- alpha (#1): success"))).toBe(false);
  });

  test("bulk confirmation re-checks current Upgrade All exclusions before execution", async () => {
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
    const upgradedSystems: number[] = [];
    let excludeBetaAfterPrompt = false;

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/upgrade")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "alpha", updateCount: 2, isReachable: 1, supportsFullUpgrade: true, excludeFromUpgradeAll: 0 },
            { id: 2, name: "beta", updateCount: 1, isReachable: 1, supportsFullUpgrade: true, excludeFromUpgradeAll: excludeBetaAfterPrompt ? 1 : 0 },
          ],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/upgrade")) {
        upgradedSystems.push(1);
        return new Response(JSON.stringify({ status: "started", jobId: "job-upgrade-1" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-upgrade-1")) {
        return new Response(JSON.stringify({ status: "done", result: { status: "success", output: "done" } }), { status: 200 });
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
        text: "/upgrade all",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    const confirmBody = sentBodies.find((body) => body.includes("Confirm upgrade all for 2 systems?"));
    expect(confirmBody).toBeTruthy();
    const parsed = JSON.parse(confirmBody || "{}") as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    const confirmData = parsed.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(confirmData).toMatch(/^confirm:/);

    excludeBetaAfterPrompt = true;

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-exclusion-bulk",
        data: confirmData,
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 11,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(upgradedSystems).toEqual([1]);
    expect(sentBodies.some((body) => body.includes("Upgrade all started for 1 system."))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- alpha (#1): success"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- beta (#2): success"))).toBe(false);
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
          updates: [
            { packageName: "bash", currentVersion: "5.2.15", newVersion: "5.2.21" },
            { packageName: "openssl", currentVersion: "3.0.2", newVersion: "3.0.3" },
          ],
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

  test("menu shows package updates for a selected system", async () => {
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
          updates: [
            { packageName: "bash", currentVersion: "5.2.15", newVersion: "5.2.21" },
            { packageName: "openssl", currentVersion: "3.0.2", newVersion: "3.0.3" },
          ],
          history: [],
        }), { status: 200 });
      }
      if (url.includes("/api/systems") && !url.includes("/api/systems/1")) {
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
      callback_query: {
        id: "cb-pkglist-1",
        data: "menu:list:pkglist:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 20,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const systemMenu = sentBodies.find((body) => body.includes("Select a system to view package updates"));
    expect(systemMenu).toBeTruthy();
    expect(systemMenu).not.toContain('"callback_data":"menu:runall:pkglist"');

    await telegramTesting.processUpdate("123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345", {
      update_id: 2,
      callback_query: {
        id: "cb-pkglist-2",
        data: "menu:run:pkglist:1:0",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 21,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    const packageMessage = sentBodies.find((body) => body.includes("Package updates for alpha (#1): 2 packages"));
    expect(packageMessage).toBeTruthy();
    const parsedBody = JSON.parse(packageMessage || "{}") as { text?: string; reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } };
    expect(parsedBody.text).toContain("- bash: 5.2.15 -> 5.2.21");
    expect(parsedBody.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("menu:list:pkglist:0");
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

  test("hides backend error details for refresh failures", async () => {
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
        text: "/refresh 1",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    expect(sentMessages.some((body) => body.includes("Refresh failed for alpha (#1)."))).toBe(true);
    expect(sentMessages.some((body) => body.includes("backend exploded"))).toBe(false);
    expect(sentMessages.some((body) => body.includes("password=***"))).toBe(false);
    expect(sentMessages.some((body) => body.includes("secret"))).toBe(false);
  });

  test("hides backend error details in bulk refresh summaries", async () => {
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

    const sentMessages: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/check")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "alpha", updateCount: 2, isReachable: 1 },
            { id: 2, name: "beta", updateCount: 1, isReachable: 1 },
          ],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/check")) {
        return new Response(JSON.stringify({ status: "started", jobId: "job-1" }), { status: 200 });
      }
      if (url.includes("/api/systems/2/check")) {
        return new Response(JSON.stringify({ status: "started", jobId: "job-2" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-1")) {
        return new Response(JSON.stringify({ status: "done", result: { updateCount: 2 } }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-2")) {
        return new Response(JSON.stringify({
          status: "failed",
          result: { error: "apt exploded\npassword=secret" },
        }), { status: 200 });
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
        text: "/refresh all",
        chat: { id: 55, type: "private", first_name: "Alice" },
        from: { id: 55, first_name: "Alice" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sentMessages.some((body) => body.includes("Refresh all finished for 2 systems."))).toBe(true);
    expect(sentMessages.some((body) => body.includes("- alpha (#1): 2 updates"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("- beta (#2): failed"))).toBe(true);
    expect(sentMessages.some((body) => body.includes("apt exploded"))).toBe(false);
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

    expect(sentBodies.some((body) => body.includes("Refreshing updates for alpha"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("Refresh completed for alpha"))).toBe(true);

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
    expect(upgradeMenu).toContain('"callback_data":"menu:runall:upgrade"');

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
    expect(fullUpgradeMenu).toContain('"callback_data":"menu:runall:fullupgrade"');

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

    const checkMenu = sentBodies.find((body) => body.includes("Select a system to refresh"));
    expect(checkMenu).toBeTruthy();
    expect(checkMenu).toContain("updatable-apt");
    expect(checkMenu).toContain("no-updates-apt");
    expect(checkMenu).toContain("updatable-snap");
    expect(checkMenu).toContain('"callback_data":"menu:runall:check"');
  });

  test("menu refresh all checks systems regardless of current update count", async () => {
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
    const checkedSystems: number[] = [];

    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/api/systems") && !url.includes("/check")) {
        return new Response(JSON.stringify({
          systems: [
            { id: 1, name: "has-updates", updateCount: 5, isReachable: 1, supportsFullUpgrade: true },
            { id: 2, name: "no-updates", updateCount: 0, isReachable: 1, supportsFullUpgrade: true },
          ],
        }), { status: 200 });
      }
      if (url.includes("/api/systems/1/check")) {
        checkedSystems.push(1);
        return new Response(JSON.stringify({ status: "started", jobId: "job-check-1" }), { status: 200 });
      }
      if (url.includes("/api/systems/2/check")) {
        checkedSystems.push(2);
        return new Response(JSON.stringify({ status: "started", jobId: "job-check-2" }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-check-1")) {
        return new Response(JSON.stringify({ status: "done", result: { updateCount: 3 } }), { status: 200 });
      }
      if (url.includes("/api/jobs/job-check-2")) {
        return new Response(JSON.stringify({ status: "done", result: { updateCount: 0 } }), { status: 200 });
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
        id: "cb-runall-check",
        data: "menu:runall:check",
        from: { id: 55, first_name: "Alice" },
        message: {
          message_id: 60,
          chat: { id: 55, type: "private", first_name: "Alice" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkedSystems).toEqual([1, 2]);
    expect(sentBodies.some((body) => body.includes("Refresh all started for 2 systems."))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- has-updates (#1): 3 updates"))).toBe(true);
    expect(sentBodies.some((body) => body.includes("- no-updates (#2): 0 updates"))).toBe(true);
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

    expect(setMyCommandsBody).toContain('"command":"help"');
    expect(setMyCommandsBody).toContain('"command":"menu"');
    expect(setMyCommandsBody).not.toContain('"command":"check"');
    expect(setMyCommandsBody).not.toContain('"command":"refresh"');
    expect(setMyCommandsBody).not.toContain('"command":"packages"');
    expect(setMyCommandsBody).not.toContain('"command":"status"');
    expect(setMyCommandsBody).not.toContain('"command":"upgradepkg"');
    expect(getUpdatesCalls).toBeGreaterThan(0);
  });

  test("start ignores disabled Telegram channels even when a bot token is stored", async () => {
    getDb().insert(notifications).values({
      name: "Disabled Telegram",
      type: "telegram",
      enabled: 0,
      notifyOn: '["updates"]',
      systemIds: null,
      config: JSON.stringify(prepareTelegramConfigForStorage({
        telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXyz_12345",
        chatBindingStatus: "unbound",
        commandsEnabled: false,
      })),
    }).run();

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("Telegram token should not be used for disabled channels");
    }) as typeof fetch;

    await startTelegramBot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    stopTelegramBot();

    expect(fetchCalls).toBe(0);
  });
});
