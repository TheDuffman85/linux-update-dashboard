import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import systemsRoutes from "../../server/routes/systems";
import { copyBuiltinPackageManager, createCustomPackageManager, createScript } from "../../server/services/script-service";

describe("systems test-connection route", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-system-test-connection-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns a debug reference on connection failure", async () => {
    const credentialId = getDb().insert(credentials).values({
      name: "Ops password",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "ops",
        password: "encrypted-password",
      }),
    }).returning({ id: credentials.id }).get().id;
    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).testConnection = async () => ({
      success: false,
      message: "Permission denied (check credentials)",
      debugRef: "attempt-123",
    });

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "host.example",
        port: 22,
        credentialId,
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: false,
      message: "Permission denied (check credentials)",
      debugRef: "attempt-123",
    });
  });

  test("detects custom package managers through scripts", async () => {
    const credentialId = getDb().insert(credentials).values({
      name: "Ops password",
      kind: "usernamePassword",
      payload: JSON.stringify({
        username: "ops",
        password: "encrypted-password",
      }),
    }).returning({ id: credentials.id }).get().id;
    copyBuiltinPackageManager({
      sourceManager: "apt",
      name: "custom-apt",
      label: "Custom APT",
    });
    createCustomPackageManager({ name: "brewlinux", label: "Linuxbrew" });
    createScript({
      name: "Detect Linuxbrew",
      type: "package_manager",
      operation: "detect",
      pkgManager: "brewlinux",
      steps: [{ label: "Detect Linuxbrew", command: "command -v brew >/dev/null 2>&1 && echo 'found'" }],
    });

    const sshManager = initSSHManager(1, 1, 1, getEncryptor());
    (sshManager as any).testConnection = async () => ({
      success: true,
      message: "Connection successful",
    });
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command.includes("command -v apt")) {
        return { stdout: "found\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("command -v brew")) {
        return { stdout: "found\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };

    const app = new Hono();
    app.route("/api/systems", systemsRoutes);

    const res = await app.request("/api/systems/test-connection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hostname: "host.example",
        port: 22,
        credentialId,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.detectedManagers).toEqual(expect.arrayContaining(["apt", "custom-apt", "brewlinux"]));
  });
});
