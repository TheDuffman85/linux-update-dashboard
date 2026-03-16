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
import {
  notificationDeliveredUpdates,
  notifications,
  settings,
  systems,
  updateCache,
} from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  processScheduledDigests,
  processScheduledResults,
} from "../../server/services/notification-service";
import { webhookProvider } from "../../server/services/notifications/webhook";

function mockHttpRequest(responseStatus: number, responseBody = "") {
  const originalRequest = http.request;
  const requestBodies: string[] = [];

  (http as unknown as { request: typeof http.request }).request = ((options, callback) => {
    let requestBody = "";

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
        requestBodies.push(requestBody);
        const res = new EventEmitter() as IncomingMessage;
        (res as unknown as { statusCode: number }).statusCode = responseStatus;
        (res as unknown as { setEncoding: () => IncomingMessage }).setEncoding = () => res;
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
    getBodies: () => [...requestBodies],
    getRequestBody: () => requestBodies.at(-1) ?? "",
    getRequestCount: () => requestBodies.length,
    restore: () => {
      (http as unknown as { request: typeof http.request }).request = originalRequest;
    },
  };
}

function buildWebhookConfig() {
  return JSON.stringify(
    webhookProvider.prepareConfigForStorage({
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
    })
  );
}

function createSystem(name: string): number {
  return getDb()
    .insert(systems)
    .values({
      name,
      hostname: `${name.toLowerCase().replace(/\s+/g, "-")}.local`,
      port: 22,
      authType: "password",
      username: "root",
      hidden: 0,
      isReachable: 1,
    })
    .returning({ id: systems.id })
    .get().id;
}

function upsertUpdates(
  systemId: number,
  updates: Array<{
    pkgManager: string;
    packageName: string;
    currentVersion?: string | null;
    newVersion: string;
    isSecurity?: number;
    isKeptBack?: number;
  }>,
): void {
  getDb().delete(updateCache).where(eq(updateCache.systemId, systemId)).run();
  if (updates.length === 0) return;

  getDb().insert(updateCache).values(
    updates.map((update) => ({
      systemId,
      pkgManager: update.pkgManager,
      packageName: update.packageName,
      currentVersion: update.currentVersion ?? null,
      newVersion: update.newVersion,
      isSecurity: update.isSecurity ?? 0,
      isKeptBack: update.isKeptBack ?? 0,
    }))
  ).run();
}

function createNotification(options?: {
  schedule?: string;
  pendingEvents?: string | null;
}): number {
  return getDb()
    .insert(notifications)
    .values({
      name: "Webhook",
      type: "webhook",
      enabled: 1,
      notifyOn: '["updates"]',
      schedule: options?.schedule ?? null,
      pendingEvents: options?.pendingEvents ?? null,
      lastSentAt: options?.schedule ? "2000-01-01 00:00:00" : null,
      config: buildWebhookConfig(),
    })
    .returning({ id: notifications.id })
    .get().id;
}

function resultFor(
  systemId: number,
  systemName: string,
  counts: {
    updateCount: number;
    securityCount?: number;
    keptBackCount?: number;
  },
) {
  return {
    systemId,
    systemName,
    updateCount: counts.updateCount,
    securityCount: counts.securityCount ?? 0,
    keptBackCount: counts.keptBackCount ?? 0,
    previouslyReachable: true,
    nowUnreachable: false,
  };
}

describe("update notification dedupe", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-update-notification-dedupe-"));
    dbPath = join(tempDir, "dashboard.db");
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("does not resend identical package-version sets", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const systemId = createSystem("Alpha");
      upsertUpdates(systemId, [
        { pkgManager: "apt", packageName: "bash", currentVersion: "1.0", newVersion: "1.1" },
      ]);
      createNotification();

      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);
      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);

      expect(requestMock.getRequestCount()).toBe(1);
      expect(requestMock.getRequestBody()).toBe("Alpha: 1 update");
    } finally {
      requestMock.restore();
    }
  });

  test("does not resend when a previously notified version disappears and later returns", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const systemId = createSystem("Alpha");
      upsertUpdates(systemId, [
        { pkgManager: "apt", packageName: "bash", currentVersion: "1.0", newVersion: "1.1" },
      ]);
      createNotification();

      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);

      upsertUpdates(systemId, []);
      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 0 })]);

      upsertUpdates(systemId, [
        { pkgManager: "apt", packageName: "bash", currentVersion: "1.0", newVersion: "1.1" },
      ]);
      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);

      expect(requestMock.getRequestCount()).toBe(1);
    } finally {
      requestMock.restore();
    }
  });

  test("resends when a new package-version appears and includes the full current scope body", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const alphaId = createSystem("Alpha");
      const betaId = createSystem("Beta");
      upsertUpdates(alphaId, [
        { pkgManager: "apt", packageName: "bash", currentVersion: "1.0", newVersion: "1.1" },
      ]);
      upsertUpdates(betaId, []);
      createNotification();

      await processScheduledResults([resultFor(alphaId, "Alpha", { updateCount: 1 })]);

      upsertUpdates(betaId, [
        { pkgManager: "apt", packageName: "curl", currentVersion: "8.0", newVersion: "8.1" },
      ]);
      await processScheduledResults([resultFor(betaId, "Beta", { updateCount: 1 })]);

      expect(requestMock.getRequestCount()).toBe(2);
      expect(requestMock.getBodies()[1]).toBe("Alpha: 1 update\nBeta: 1 update");
    } finally {
      requestMock.restore();
    }
  });

  test("tracks package manager as part of the dedupe identity", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const systemId = createSystem("Alpha");
      createNotification();

      upsertUpdates(systemId, [
        { pkgManager: "apt", packageName: "hello", currentVersion: "1.0", newVersion: "1.1" },
      ]);
      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);

      upsertUpdates(systemId, [
        { pkgManager: "snap", packageName: "hello", currentVersion: "1.0", newVersion: "1.1" },
      ]);
      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);

      expect(requestMock.getRequestCount()).toBe(2);
    } finally {
      requestMock.restore();
    }
  });

  test("scheduled digests dedupe repeated pending package versions", async () => {
    const requestMock = mockHttpRequest(200, "ok");

    try {
      const systemId = createSystem("Alpha");
      upsertUpdates(systemId, [
        { pkgManager: "apt", packageName: "bash", currentVersion: "1.0", newVersion: "1.1" },
      ]);
      const notificationId = createNotification({ schedule: "* * * * *" });

      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);
      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);

      const pendingRow = getDb()
        .select({ pendingEvents: notifications.pendingEvents })
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .get();
      const pending = JSON.parse(pendingRow?.pendingEvents || "{}") as {
        updates?: Array<{ packageVersions?: unknown[] }>;
      };

      expect(pending.updates).toHaveLength(1);
      expect(pending.updates?.[0]?.packageVersions).toHaveLength(1);

      await processScheduledDigests();

      const delivered = getDb()
        .select()
        .from(notificationDeliveredUpdates)
        .where(eq(notificationDeliveredUpdates.notificationId, notificationId))
        .all();
      const clearedRow = getDb()
        .select({ pendingEvents: notifications.pendingEvents })
        .from(notifications)
        .where(eq(notifications.id, notificationId))
        .get();

      expect(requestMock.getRequestCount()).toBe(1);
      expect(delivered).toHaveLength(1);
      expect(clearedRow?.pendingEvents).toBeNull();
    } finally {
      requestMock.restore();
    }
  });

  test("startup migration seeds existing update channels and suppresses resend of current state", async () => {
    const systemId = createSystem("Alpha");
    upsertUpdates(systemId, [
      { pkgManager: "apt", packageName: "bash", currentVersion: "1.0", newVersion: "1.1" },
    ]);
    const notificationId = createNotification();
    getDb().delete(settings).where(eq(settings.key, "notification_update_dedupe_migrated")).run();

    closeDatabase();
    initDatabase(dbPath);

    const migrationFlag = getDb()
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "notification_update_dedupe_migrated"))
      .get();
    const seededRows = getDb()
      .select()
      .from(notificationDeliveredUpdates)
      .where(eq(notificationDeliveredUpdates.notificationId, notificationId))
      .all();

    const requestMock = mockHttpRequest(200, "ok");
    try {
      await processScheduledResults([resultFor(systemId, "Alpha", { updateCount: 1 })]);

      expect(migrationFlag?.value).toBe("true");
      expect(seededRows).toHaveLength(1);
      expect(requestMock.getRequestCount()).toBe(0);
    } finally {
      requestMock.restore();
    }
  });

  test("startup migration drops legacy pending update entries while preserving other pending events", () => {
    const systemId = createSystem("Alpha");
    upsertUpdates(systemId, [
      { pkgManager: "apt", packageName: "bash", currentVersion: "1.0", newVersion: "1.1" },
    ]);
    const notificationId = createNotification({
      schedule: "* * * * *",
      pendingEvents: JSON.stringify({
        updates: [resultFor(systemId, "Alpha", { updateCount: 1 })],
        unreachable: [{ systemId, systemName: "Alpha" }],
        appUpdate: {
          currentVersion: "2026.3.1",
          currentBranch: "main",
          remoteVersion: "2026.3.2",
          releaseUrl: "https://example.com/release",
          repoUrl: "https://example.com/repo",
        },
      }),
    });
    getDb().delete(settings).where(eq(settings.key, "notification_update_dedupe_migrated")).run();

    closeDatabase();
    initDatabase(dbPath);

    const row = getDb()
      .select({ pendingEvents: notifications.pendingEvents })
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .get();
    const pending = JSON.parse(row?.pendingEvents || "{}") as {
      updates?: unknown[];
      unreachable?: unknown[];
      appUpdate?: { remoteVersion?: string } | null;
    };

    expect(pending.updates).toEqual([]);
    expect(pending.unreachable).toHaveLength(1);
    expect(pending.appUpdate?.remoteVersion).toBe("2026.3.2");
  });
});
