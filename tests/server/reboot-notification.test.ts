import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications, systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import { updateSystemInfo } from "../../server/services/system-service";
import {
  processRebootRequiredResult,
  processScheduledNotificationDeliveries,
} from "../../server/services/notification-service";
import { webhookProvider } from "../../server/services/notifications/webhook";
import type { NotificationPayload } from "../../server/services/notifications";
import type { SSHConnectionManager } from "../../server/ssh/connection";

function systemInfoOutput(rebootFile: "PRESENT" | "ABSENT", packages = ""): string {
  return `===OS===
ID=ubuntu
===KERNEL===
6.8.0-45-generic
===HOSTNAME===
web-1
===UPTIME_SECONDS===
3600
===BOOT_ID===
boot-a
===REBOOT_FILE===
${rebootFile}
===REBOOT_PACKAGES===
${packages}
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.8.0-45-generic
`;
}

function createChannel(name: string, notifyOn: string[], systemIds: number[] | null, schedule: string | null = null) {
  return getDb().insert(notifications).values({
    name,
    type: "webhook",
    notifyOn: JSON.stringify(notifyOn),
    systemIds: systemIds === null ? null : JSON.stringify(systemIds),
    schedule,
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
  }).returning({ id: notifications.id }).get().id;
}

describe("reboot required notifications", () => {
  let tempDir: string;
  let systemId: number;
  let payloads: NotificationPayload[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-reboot-notification-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
    systemId = getDb().insert(systems).values({
      name: "Web server",
      hostname: "web-1.local",
      port: 22,
      authType: "password",
      username: "root",
    }).returning({ id: systems.id }).get().id;
    payloads = [];
    vi.spyOn(webhookProvider, "send").mockImplementation(async (payload) => {
      payloads.push(payload);
      return { success: true };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function refresh(rebootFile: "PRESENT" | "ABSENT", packages = "") {
    const sshManager = {
      runCommand: async () => ({
        stdout: systemInfoOutput(rebootFile, packages),
        stderr: "",
        exitCode: 0,
      }),
    } as unknown as SSHConnectionManager;
    const event = await updateSystemInfo(systemId, sshManager, {} as never);
    if (event) await processRebootRequiredResult(event);
    return event;
  }

  test("fires once per pending reboot and includes valid triggering packages", async () => {
    createChannel("reboot alerts", ["rebootRequired"], [systemId]);
    createChannel("other system", ["rebootRequired"], [systemId + 1]);
    createChannel("updates only", ["updates"], null);

    expect(await refresh("ABSENT")).toBeUndefined();
    expect(await refresh("PRESENT", "linux-image-6.8.0-45-generic\nlibc6\nlibc6\ninvalid package\n")).toEqual({
      systemId,
      systemName: "Web server",
      packages: ["linux-image-6.8.0-45-generic", "libc6"],
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].event.eventTypes).toEqual(["rebootRequired"]);
    expect(payloads[0].event.rebootRequired).toEqual([{
      systemId,
      systemName: "Web server",
      packages: ["linux-image-6.8.0-45-generic", "libc6"],
    }]);
    expect(payloads[0].body).toContain("linux-image-6.8.0-45-generic, libc6");

    expect(await refresh("PRESENT", "new-package")).toBeUndefined();
    expect(payloads).toHaveLength(1);
    expect(await refresh("ABSENT")).toBeUndefined();
    expect(await refresh("PRESENT", "new-package")).toBeDefined();
    expect(payloads).toHaveLength(2);
    expect(payloads[1].body).toContain("new-package");
  });

  test("queues a scoped reboot event until its notification schedule runs", async () => {
    const channelId = createChannel("digest", ["rebootRequired"], [systemId], "0 0 * * *");
    await refresh("PRESENT", "linux-image-6.8.0-45-generic");
    expect(payloads).toHaveLength(0);

    const pending = getDb().select({ pendingEvents: notifications.pendingEvents })
      .from(notifications).where(eq(notifications.id, channelId)).get();
    expect(JSON.parse(pending?.pendingEvents || "{}").rebootRequired).toEqual([{
      systemId,
      systemName: "Web server",
      packages: ["linux-image-6.8.0-45-generic"],
    }]);

    expect(await processScheduledNotificationDeliveries([channelId])).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].event.eventTypes).toEqual(["rebootRequired"]);
    expect(getDb().select({ pendingEvents: notifications.pendingEvents })
      .from(notifications).where(eq(notifications.id, channelId)).get()?.pendingEvents).toBeNull();
  });
});
