import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  processAppUpdateNotifications,
  processScheduledDigests,
} from "../../server/services/notification-service";
import { resetAppUpdateStatusCache } from "../../server/services/app-update-service";

describe("app update notifications", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;
  let envSnapshot: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-app-update-notification-test-"));
    envSnapshot = { ...process.env };
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    resetAppUpdateStatusCache();
    process.env.LUDASH_APP_REPOSITORY = "TheDuffman85/linux-update-dashboard";
    process.env.LUDASH_APP_BRANCH = "main";
    process.env.LUDASH_APP_VERSION = "2026.3.1";
  });

  afterEach(() => {
    resetAppUpdateStatusCache();
    globalThis.fetch = originalFetch;
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });

    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("sends immediate app update notifications once per remote version", async () => {
    const db = getDb();
    const inserted = db.insert(notifications).values({
      name: "Ops ntfy",
      type: "ntfy",
      enabled: 1,
      notifyOn: '["appUpdates"]',
      config: JSON.stringify({
        ntfyUrl: "https://ntfy.sh",
        ntfyTopic: "ops",
      }),
    }).returning({ id: notifications.id }).get();

    const sentBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "2026.3.2",
            html_url:
              "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
          }),
          { status: 200 }
        );
      }
      if (url === "https://ntfy.sh/ops") {
        sentBodies.push(String(init?.body ?? ""));
        expect(new Headers(init?.headers).get("Title")).toBe(
          "Application update available"
        );
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await processAppUpdateNotifications();
    await processAppUpdateNotifications();

    const row = db
      .select()
      .from(notifications)
      .where(eq(notifications.id, inserted.id))
      .get();

    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toContain("Linux Update Dashboard: v2026.3.1 -> v2026.3.2");
    expect(row?.lastAppVersionNotified).toBe("2026.3.2");
  });

  test("buffers scheduled app update notifications until the digest runs", async () => {
    const db = getDb();
    const inserted = db.insert(notifications).values({
      name: "Scheduled ntfy",
      type: "ntfy",
      enabled: 1,
      notifyOn: '["appUpdates"]',
      config: JSON.stringify({
        ntfyUrl: "https://ntfy.sh",
        ntfyTopic: "scheduled",
      }),
      schedule: "* * * * *",
      lastSentAt: "2000-01-01 00:00:00",
    }).returning({ id: notifications.id }).get();

    let ntfyPosts = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "2026.3.2",
            html_url:
              "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
          }),
          { status: 200 }
        );
      }
      if (url === "https://ntfy.sh/scheduled") {
        ntfyPosts += 1;
        expect(String(init?.body ?? "")).toContain(
          "Linux Update Dashboard: v2026.3.1 -> v2026.3.2"
        );
        return new Response("", { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    await processAppUpdateNotifications();

    let row = db
      .select()
      .from(notifications)
      .where(eq(notifications.id, inserted.id))
      .get();
    expect(row?.pendingEvents).toContain('"remoteVersion":"2026.3.2"');
    expect(row?.lastAppVersionNotified).toBeNull();

    await processScheduledDigests();

    row = db
      .select()
      .from(notifications)
      .where(eq(notifications.id, inserted.id))
      .get();
    expect(ntfyPosts).toBe(1);
    expect(row?.pendingEvents).toBeNull();
    expect(row?.lastAppVersionNotified).toBe("2026.3.2");
  });
});
