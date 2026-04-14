import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import {
  dismissNeedsReboot,
  filterVisibleSystemIds,
  filterVisibleSystemItems,
  isSystemVisible,
  updateSystemInfo,
} from "../../server/services/system-service";
import type { SSHConnectionManager } from "../../server/ssh/connection";

describe("updateSystemInfo reboot detection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-system-service-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("clears a stale reboot-required file after the host boots again", async () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Pi",
      hostname: "pi.local",
      port: 22,
      authType: "password",
      username: "pi",
    }).returning({ id: systems.id }).get();

    const outputs = [
      `===OS===
NAME="Debian GNU/Linux"
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
VERSION_ID="12"
===KERNEL===
6.6.74+rpt-rpi-v8
===HOSTNAME===
pi
===UPTIME===
up 3 days
===UPTIME_SECONDS===
259200
===ARCH===
aarch64
===CPU===
4
===MEM===
Mem:           7.7Gi       2.1Gi       4.2Gi       256Mi       1.4Gi       5.3Gi
===DISK===
/dev/root        50G   12G   35G  26% /
===BOOT_ID===
boot-old
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.6.74+rpt-rpi-v8
`,
      `===OS===
NAME="Debian GNU/Linux"
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
VERSION_ID="12"
===KERNEL===
6.6.74+rpt-rpi-v8
===HOSTNAME===
pi
===UPTIME===
up 2 minutes
===UPTIME_SECONDS===
120
===ARCH===
aarch64
===CPU===
4
===MEM===
Mem:           7.7Gi       2.1Gi       4.2Gi       256Mi       1.4Gi       5.3Gi
===DISK===
/dev/root        50G   12G   35G  26% /
===BOOT_ID===
boot-old
===REBOOT_FILE===
PRESENT
===NEEDS_RESTARTING===
UNAVAILABLE
===INSTALLED_KERNELS===
6.6.74+rpt-rpi-v8
`,
    ];

    let callIndex = 0;
    const sshManager = {
      runCommand: async () => ({
        stdout: outputs[callIndex++],
        stderr: "",
        exitCode: 0,
      }),
    } as unknown as SSHConnectionManager;

    await updateSystemInfo(inserted.id, sshManager, {} as never);

    let system = db.select().from(systems).where(eq(systems.id, inserted.id)).get();
    expect(system?.needsReboot).toBe(1);
    expect(system?.bootId).toBe("boot-old");

    db.update(systems)
      .set({ lastSeenAt: "2026-04-14 10:00:00" })
      .where(eq(systems.id, inserted.id))
      .run();

    const realDateNow = Date.now;
    Date.now = () => Date.UTC(2026, 3, 14, 12, 30, 0);
    try {
      await updateSystemInfo(inserted.id, sshManager, {} as never);
    } finally {
      Date.now = realDateNow;
    }

    system = db.select().from(systems).where(eq(systems.id, inserted.id)).get();
    expect(system?.needsReboot).toBe(0);
    expect(system?.bootId).toBe("boot-old");
  });
});

describe("dismissNeedsReboot", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-dismiss-reboot-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("clears the stored reboot-required flag", () => {
    const db = getDb();
    const inserted = db.insert(systems).values({
      name: "Pi",
      hostname: "pi.local",
      port: 22,
      authType: "password",
      username: "pi",
      needsReboot: 1,
    }).returning({ id: systems.id }).get();

    dismissNeedsReboot(inserted.id);

    const system = db.select().from(systems).where(eq(systems.id, inserted.id)).get();
    expect(system?.needsReboot).toBe(0);
  });
});

describe("system visibility helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-system-visibility-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns only visible systems and preserves caller item shape", () => {
    const db = getDb();
    const inserted = db.insert(systems).values([
      {
        name: "Visible",
        hostname: "visible.local",
        port: 22,
        authType: "password",
        username: "root",
        hidden: 0,
      },
      {
        name: "Hidden",
        hostname: "hidden.local",
        port: 22,
        authType: "password",
        username: "root",
        hidden: 1,
      },
    ]).returning({ id: systems.id, name: systems.name }).all();

    expect(isSystemVisible(inserted[0].id)).toBe(true);
    expect(isSystemVisible(inserted[1].id)).toBe(false);
    expect(filterVisibleSystemIds([inserted[0].id, inserted[1].id])).toEqual([inserted[0].id]);
    expect(
      filterVisibleSystemItems([
        { systemId: inserted[0].id, systemName: inserted[0].name, updateCount: 1 },
        { systemId: inserted[1].id, systemName: inserted[1].name, updateCount: 2 },
      ]),
    ).toEqual([
      { systemId: inserted[0].id, systemName: inserted[0].name, updateCount: 1 },
    ]);
  });
});
