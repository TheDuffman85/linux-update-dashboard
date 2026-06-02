import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems } from "../../server/db/schema";
import systemsRoutes from "../../server/routes/systems";
import { getEncryptor, initEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";

describe("sudoers preview route", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-sudoers-preview-route-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSystem(username = "updater") {
    return getDb().insert(systems).values({
      name: "Preview host",
      hostname: "preview.local",
      port: 22,
      authType: "password",
      username,
      pkgManager: "apt",
      detectedPkgManagers: JSON.stringify(["apt"]),
    }).returning({ id: systems.id }).get().id;
  }

  test("returns resolved paths from one read-only SSH lookup", async () => {
    const systemId = createSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = vi.fn(async () => ({}));
    (sshManager as any).disconnect = vi.fn();
    (sshManager as any).runCommand = vi.fn(async () => ({
      stdout: [
        "dpkg\t/usr/bin/dpkg",
        "apt-get\t/usr/bin/apt-get",
        "reboot\t/usr/sbin/reboot",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const response = await app.request(`/api/systems/${systemId}/sudoers-preview`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.resolution).toBe("resolved");
    expect(body.content).toContain("/usr/bin/apt-get");
    expect(body.content).not.toContain("pvesh");
    expect((sshManager as any).runCommand).toHaveBeenCalledTimes(1);
  });

  test("returns a fallback template when required reboot is unavailable", async () => {
    const systemId = createSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = vi.fn(async () => ({}));
    (sshManager as any).disconnect = vi.fn();
    (sshManager as any).runCommand = vi.fn(async () => ({
      stdout: [
        "dpkg\t/usr/bin/dpkg",
        "apt-get\t/usr/bin/apt-get",
        "reboot\t",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const response = await app.request(`/api/systems/${systemId}/sudoers-preview`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.resolution).toBe("fallback");
    expect(body.resolutionError).toBe("Could not resolve: reboot");
    expect(body.content).toContain("REPLACE_WITH_ABSOLUTE_PATH/reboot");
  });

  test("returns a fallback template when SSH resolution fails", async () => {
    const systemId = createSystem();
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = vi.fn(async () => {
      throw new Error("Host is offline");
    });
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const response = await app.request(`/api/systems/${systemId}/sudoers-preview`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.resolution).toBe("fallback");
    expect(body.resolutionError).toBe("Host is offline");
    expect(body.content).toContain("REPLACE_WITH_ABSOLUTE_PATH/apt-get");
  });

  test("generates a resolved preview for root users", async () => {
    const systemId = createSystem("root");
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).connect = vi.fn(async () => ({}));
    (sshManager as any).disconnect = vi.fn();
    (sshManager as any).runCommand = vi.fn(async () => ({
      stdout: [
        "dpkg\t/usr/bin/dpkg",
        "apt-get\t/usr/bin/apt-get",
        "reboot\t/usr/sbin/reboot",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    }));
    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const response = await app.request(`/api/systems/${systemId}/sudoers-preview`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.resolution).toBe("resolved");
    expect(body.required).toBe(true);
    expect(body.content).toContain("Defaults:root !requiretty");
    expect((sshManager as any).connect).toHaveBeenCalledTimes(1);
  });
});
