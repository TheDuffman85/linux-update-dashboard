import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { systems, updateHistory } from "../../server/db/schema";
import { initEncryptor, getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { getProxmoxBackupGuardCommand } from "../../server/ssh/reboot";
import { buildOperationKey, createScript, setSystemOverrides } from "../../server/services/script-service";
import { rebootSystem } from "../../server/services/update-service";

const sshConnectStep = {
  label: "Connect over SSH",
  pkgManager: "system",
  command: "",
  status: "success",
};

describe("rebootSystem", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-reboot-test-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns failure when reboot command exits non-zero", async () => {
    const db = getDb();
    const encryptor = getEncryptor();
    const inserted = db.insert(systems).values({
      name: "CentOS",
      hostname: "localhost",
      port: 2003,
      authType: "password",
      username: "testuser",
      encryptedPassword: encryptor.encrypt("testpass"),
    }).returning({ id: systems.id }).get();

    const sshManager = initSSHManager(1, 1, 1, encryptor);
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command.includes("/cluster/tasks")) {
        return { stdout: "[]", stderr: "", exitCode: 0 };
      }
      return {
        stdout: "",
        stderr: "Failed to talk to init daemon.\n",
        exitCode: 1,
      };
    };

    const result = await rebootSystem(inserted.id);
    expect(result.success).toBe(false);
    expect(result.message).toContain("Failed to talk to init daemon");

    const system = db.select().from(systems).where(eq(systems.id, inserted.id)).get();
    expect(system?.isReachable).toBe(0);

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, inserted.id))
      .all()
      .at(-1);
    expect(JSON.parse(history?.steps || "[]")).toMatchObject([
      sshConnectStep,
      { label: "Pre-reboot safety checks", pkgManager: "system", status: "success" },
      {
        pkgManager: "system",
        status: "failed",
        command: expect.stringContaining("reboot"),
        error: "Reboot failed: Failed to talk to init daemon.\n",
      },
    ]);
  });

  test("treats an SSH reset during reboot as a sent reboot command", async () => {
    const db = getDb();
    const encryptor = getEncryptor();
    const inserted = db.insert(systems).values({
      name: "Debian",
      hostname: "localhost",
      port: 2004,
      authType: "password",
      username: "testuser",
      encryptedPassword: encryptor.encrypt("testpass"),
    }).returning({ id: systems.id }).get();

    const sshManager = initSSHManager(1, 1, 1, encryptor);
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      if (command.includes("/cluster/tasks")) {
        return { stdout: "[]", stderr: "", exitCode: 0 };
      }
      return {
        stdout: "",
        stderr: "read ECONNRESET",
        exitCode: -1,
      };
    };

    const result = await rebootSystem(inserted.id);
    expect(result).toEqual({ success: true, message: "Reboot command sent" });

    const system = db.select().from(systems).where(eq(systems.id, inserted.id)).get();
    expect(system?.isReachable).toBe(-1);

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, inserted.id))
      .all()
      .at(-1);
    expect(history?.status).toBe("success");
    expect(JSON.parse(history?.steps || "[]")).toMatchObject([
      sshConnectStep,
      { label: "Pre-reboot safety checks", pkgManager: "system", status: "success" },
      {
        pkgManager: "system",
        status: "success",
        command: expect.stringContaining("reboot"),
        error: null,
      },
    ]);
  });

  test("uses a Proxmox backup guard compatible with pvesh versions without task filters", () => {
    const command = getProxmoxBackupGuardCommand();

    expect(command).toContain("pvesh get /cluster/tasks --output-format json");
    expect(command).not.toContain("--typefilter");
    expect(command).not.toContain("--statusfilter");
    expect(command).toContain("exists $task->{pid}");
    expect(command).toContain('($task->{status} // "") eq "running"');
  });

  test("blocks reboot when Proxmox backup activity is detected", async () => {
    const db = getDb();
    const encryptor = getEncryptor();
    const inserted = db.insert(systems).values({
      name: "Proxmox",
      hostname: "localhost",
      port: 2006,
      authType: "password",
      username: "testuser",
      encryptedPassword: encryptor.encrypt("testpass"),
    }).returning({ id: systems.id }).get();

    const sshManager = initSSHManager(1, 1, 1, encryptor);
    const commands: string[] = [];
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      return {
        stdout: 'Reboot blocked: Proxmox backup task is running.\n[{"type":"vzdump","status":"running"}]\n',
        stderr: "",
        exitCode: 1,
      };
    };

    const result = await rebootSystem(inserted.id);

    expect(result).toEqual({
      success: false,
      message: "Reboot blocked: Proxmox backup task is running.",
      blocked: true,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("/cluster/tasks");

    const system = db.select().from(systems).where(eq(systems.id, inserted.id)).get();
    expect(system?.isReachable).toBe(0);

    const history = db.select()
      .from(updateHistory)
      .where(eq(updateHistory.systemId, inserted.id))
      .all()
      .at(-1);
    expect(history?.status).toBe("failed");
    expect(history?.error).toBe("Reboot blocked: Proxmox backup task is running.");
    expect(JSON.parse(history?.steps || "[]")).toMatchObject([
      sshConnectStep,
      {
        label: "Pre-reboot safety checks",
        pkgManager: "system",
        status: "failed",
        error: "Reboot blocked: Proxmox backup task is running.",
      },
    ]);
  });

  test("runs the configured reboot script command", async () => {
    const db = getDb();
    const encryptor = getEncryptor();
    const inserted = db.insert(systems).values({
      name: "Debian",
      hostname: "localhost",
      port: 2005,
      authType: "password",
      username: "testuser",
      encryptedPassword: encryptor.encrypt("testpass"),
    }).returning({ id: systems.id }).get();
    const script = createScript({
      name: "Custom reboot",
      type: "system",
      operation: "reboot",
      steps: [{ label: "Custom reboot", command: "echo custom-reboot" }],
    });
    setSystemOverrides(inserted.id, {
      [buildOperationKey("reboot")]: script.id,
    });

    const sshManager = initSSHManager(1, 1, 1, encryptor);
    const commands: string[] = [];
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      return { stdout: "ok", stderr: "", exitCode: 0 };
    };

    const result = await rebootSystem(inserted.id);

    expect(result).toEqual({ success: true, message: "Reboot command sent" });
    expect(commands).toEqual(["echo custom-reboot"]);
  });

  test("stops multi-step reboot scripts before later steps when an earlier step fails", async () => {
    const db = getDb();
    const encryptor = getEncryptor();
    const inserted = db.insert(systems).values({
      name: "Debian",
      hostname: "localhost",
      port: 2007,
      authType: "password",
      username: "testuser",
      encryptedPassword: encryptor.encrypt("testpass"),
    }).returning({ id: systems.id }).get();
    const script = createScript({
      name: "Guarded reboot",
      type: "system",
      operation: "reboot",
      steps: [
        { label: "Local preflight", command: "echo custom-preflight" },
        { label: "Custom reboot", command: "echo custom-reboot" },
      ],
    });
    setSystemOverrides(inserted.id, {
      [buildOperationKey("reboot")]: script.id,
    });

    const sshManager = initSSHManager(1, 1, 1, encryptor);
    const commands: string[] = [];
    (sshManager as any).connect = async () => ({});
    (sshManager as any).disconnect = () => {};
    (sshManager as any).runCommand = async (_conn: unknown, command: string) => {
      commands.push(command);
      if (command.includes("/cluster/tasks")) {
        return { stdout: "[]", stderr: "", exitCode: 0 };
      }
      if (command === "echo custom-preflight") {
        return { stdout: "", stderr: "preflight failed", exitCode: 2 };
      }
      return { stdout: "should not run", stderr: "", exitCode: 0 };
    };

    const result = await rebootSystem(inserted.id);

    expect(result).toEqual({ success: false, message: "Reboot failed: preflight failed", blocked: false });
    expect(commands).toEqual(["echo custom-preflight"]);
  });
});
