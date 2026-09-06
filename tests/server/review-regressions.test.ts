import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateKeyPairSync,
  createHash,
  sign,
  randomBytes,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import type { Client } from "ssh2";
import {
  issueWebAuthnChallenge,
  consumeWebAuthnChallenge,
} from "../../server/auth/webauthn-challenge";
import { createApp } from "../../server/app";
import { initDatabase, closeDatabase, getDb } from "../../server/db";
import {
  users,
  webauthnCredentials,
  systems,
  updateCache,
  updateHistory,
  schedules,
} from "../../server/db/schema";
import { validateProxyJumpConfiguration } from "../../server/services/system-service";
import * as scheduler from "../../server/services/scheduler";
import * as scheduleService from "../../server/services/schedule-service";
import { initSession } from "../../server/auth/session";
import { initEncryptor, getEncryptor } from "../../server/security";
import ssh2 from "ssh2";
import {
  buildTailMonitorCommand,
  initSSHManager,
  getSSHManager,
} from "../../server/ssh/connection";
import {
  checkUpdates,
  applyUpgradeAll,
} from "../../server/services/update-service";
import * as scriptService from "../../server/services/script-service";
import * as systemService from "../../server/services/system-service";
import {
  createUpgradeBatch,
  runUpgradeBatches,
} from "../../server/services/upgrade-batch-service";
import * as output from "../../server/services/output-stream";

let dir: string;
const incoming = {
  socket: {
    remoteAddress: "127.0.0.1",
    remotePort: 43210,
    remoteFamily: "IPv4",
  },
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ludash-review-"));
  initEncryptor(randomBytes(32).toString("base64"));
  initSession("isolated-review-session-secret");
  initDatabase(join(dir, "test.db"));
});
afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});
function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  extraCookie = "",
) {
  return app.request(
    "http://localhost:3001/api/auth/" + path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": "review",
        cookie: "ludash_csrf=review; " + extraCookie,
      },
      body: JSON.stringify(body),
    },
    { incoming },
  );
}
test("allows only one concurrent initial administrator registration", async () => {
  const app = createApp();
  const responses = await Promise.all(
    ["review-one", "review-two"].map((username) =>
      post(app, "setup", { username, password: "Password123" }),
    ),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(getDb().select().from(users).all()).toHaveLength(1);
});
test("rejects replay of a real signed zero-counter passkey assertion", async () => {
  const db = getDb();
  const user = db
    .insert(users)
    .values({ username: "review", passwordHash: "unused" })
    .returning()
    .get();
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  // COSE EC2: { 1:2, 3:-7, -1:1, -2:x, -3:y }
  const cose = Buffer.concat([
    Buffer.from("a5010203262001215820", "hex"),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from("225820", "hex"),
    Buffer.from(jwk.y!, "base64url"),
  ]);
  const credentialId = randomBytes(32).toString("base64url");
  db.insert(webauthnCredentials)
    .values({
      userId: user.id,
      credentialId,
      publicKey: cose.toString("base64url"),
      signCount: 0,
    })
    .run();
  const app = createApp();
  const optionsResponse = await post(app, "webauthn/login/options", {
    username: "review",
  });
  const { challenge } = (await optionsResponse.json()) as { challenge: string };
  const challengeCookie = optionsResponse.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("webauthn_challenge="))!
    .split(";")[0];
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: "http://localhost:3001",
    }),
  );
  const authData = Buffer.concat([
    createHash("sha256").update("localhost").digest(),
    Buffer.from([5, 0, 0, 0, 0]),
  ]);
  const signature = sign(
    "sha256",
    Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
    privateKey,
  );
  const assertion = {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: {
      clientDataJSON: clientData.toString("base64url"),
      authenticatorData: authData.toString("base64url"),
      signature: signature.toString("base64url"),
    },
    clientExtensionResults: {},
  };
  for (let i = 0; i < 2; i++) {
    const res = await post(
      app,
      "webauthn/login/verify",
      assertion,
      challengeCookie,
    );
    expect(res.status).toBe(i === 0 ? 200 : 400);
    expect(
      res.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("ludash_session=")),
    ).toBe(i === 0);
  }
});
test("streams all existing remote log lines", async () => {
  const path = join(dir, "remote.log");
  writeFileSync(
    path,
    Array.from({ length: 100 }, (_, i) => `line-${i + 1}\n`).join(""),
  );
  const { stdout: text } = await promisify(execFile)(
    "sh",
    ["-c", buildTailMonitorCommand(path, 2147483647)],
    { timeout: 4000 },
  );
  expect(text).toContain("line-1\n");
  expect(text.trim().split("\n")).toHaveLength(100);
});
test("records failed SSH checks even when the update list is empty", async () => {
  const id = getDb()
    .insert(systems)
    .values({
      name: "review",
      hostname: "review.invalid",
      username: "root",
      pkgManager: "apt",
      detectedPkgManagers: '["apt"]',
    })
    .returning()
    .get().id;
  initSSHManager(2, 1, 1, getEncryptor());
  vi.spyOn(getSSHManager(), "connect").mockRejectedValue(
    new Error("review connection refused"),
  );
  await expect(checkUpdates(id)).resolves.toEqual([]);
  expect(getDb().select().from(updateHistory).all().at(-1)?.status).toBe(
    "failed",
  );
});
test("finalizes queued history when batch connection fails", async () => {
  const db = getDb();
  const id = db
    .insert(systems)
    .values({
      name: "review",
      hostname: "review.invalid",
      username: "root",
      pkgManager: "apt",
      detectedPkgManagers: '["apt"]',
    })
    .returning()
    .get().id;
  db.insert(updateCache)
    .values({
      systemId: id,
      packageName: "bash",
      pkgManager: "apt",
      newVersion: "5.3",
    })
    .run();
  initSSHManager(2, 1, 1, getEncryptor());
  vi.spyOn(getSSHManager(), "connect").mockRejectedValue(
    new Error("review connection refused"),
  );
  createUpgradeBatch([{ systemId: id }], { autoRun: false });
  await runUpgradeBatches();
  expect(
    db
      .select()
      .from(updateHistory)
      .all()
      .map((r) => r.status),
  ).toEqual(["failed"]);
});
test("resets terminal state before replaying on reconnect", () => {
  output.removeStream(98765);
  output.publish(98765, { type: "output", stream: "stdout", data: "first\n" });
  const messages: unknown[] = [];
  const ws = { send: (s: string) => messages.push(JSON.parse(s)), close() {} };
  output.subscribe(98765, ws as any);
  output.unsubscribe(98765, ws as any);
  output.subscribe(98765, ws as any);
  expect(messages).toEqual([
    { type: "reset" },
    { type: "output", stream: "stdout", data: "first\n" },
    { type: "reset" },
    { type: "output", stream: "stdout", data: "first\n" },
  ]);
  output.removeStream(98765);
});
test("never authenticates with an unapproved replacement host key", async () => {
  const manager = initSSHManager(1, 1, 1, getEncryptor());
  const authenticatedWith: unknown[] = [];
  vi.spyOn(ssh2.Client.prototype, "connect").mockImplementation(function (
    this: Client,
    options,
  ) {
    queueMicrotask(() => {
      const approved = (options.hostVerifier as any)(
        Buffer.from("replacement-host-key"),
      );
      if (approved) {
        authenticatedWith.push(options.password);
        this.emit("ready");
      } else this.emit("error", new Error("Host denied"));
    });
    return this;
  });
  const result = await manager.testConnection({
    hostname: "review.invalid",
    username: "root",
    authType: "password",
    encryptedPassword: getEncryptor().encrypt("isolated-review-password"),
    hostKeyVerificationEnabled: true,
    trustedHostKey: Buffer.from("previously-trusted-key").toString("base64"),
  });
  expect(result.success).toBe(false);
  expect(result.hostKeyChallenges).toHaveLength(1);
  expect(authenticatedWith).toEqual([]);
});
test("releases the SSH slot when resolving an invalid jump chain", async () => {
  const manager = initSSHManager(1, 1, 1, getEncryptor());
  await expect(
    manager.connect({ hostname: "target.invalid", proxyJumpSystemId: 999 }),
  ).rejects.toThrow("does not exist");
  const connectHop = vi
    .spyOn(manager as any, "connectSingleHop")
    .mockResolvedValue({ end() {} });
  const conn = await manager.connect({ hostname: "good.invalid" });
  expect(connectHop).toHaveBeenCalledOnce();
  manager.disconnect(conn);
});
test("accepts the same maximum jump depth in validation and connection", async () => {
  let jump: number | null = null;
  for (let i = 0; i < 10; i++) {
    jump = getDb()
      .insert(systems)
      .values({
        name: `jump-${i}`,
        hostname: `jump-${i}.invalid`,
        username: "root",
        proxyJumpSystemId: jump,
      })
      .returning()
      .get().id;
  }
  expect(() => validateProxyJumpConfiguration(jump)).not.toThrow();
  const manager = initSSHManager(1, 1, 1, getEncryptor());
  const connectHop = vi
    .spyOn(manager as any, "connectSingleHop")
    .mockResolvedValue({ end() {} });
  vi.spyOn(manager as any, "openForwardStream").mockResolvedValue({});
  const conn = await manager.connect({
    hostname: "target.invalid",
    proxyJumpSystemId: jump,
  });
  expect(connectHop).toHaveBeenCalledTimes(11);
  manager.disconnect(conn);
});
test("reports refresh schedule failure after an SSH failure", async () => {
  vi.useFakeTimers();
  const db = getDb();
  db.update(schedules).set({ enabled: 0 }).run();
  const id = db
    .insert(systems)
    .values({
      name: "review",
      hostname: "review.invalid",
      username: "root",
      pkgManager: "apt",
      detectedPkgManagers: '["apt"]',
    })
    .returning()
    .get().id;
  const scheduleId = scheduleService.createSchedule({
    name: "review-refresh",
    type: "refresh",
    enabled: true,
    systemIds: [id],
    config: { cron: "0 0 1 1 *", cacheDurationHours: 0 },
  });
  initSSHManager(2, 1, 1, getEncryptor());
  vi.spyOn(getSSHManager(), "connect").mockRejectedValue(
    new Error("review connection refused"),
  );
  scheduler.start();
  await vi.advanceTimersByTimeAsync(30000);
  expect(scheduleService.getSchedule(scheduleId)?.lastRunStatus).toBe("failed");
  expect(db.select().from(updateHistory).all().at(-1)?.status).toBe("failed");
});
test.each([
  "upgrade_all",
  "full_upgrade_all",
  "autoremove",
  "upgrade_selected",
] as const)(
  "executes every %s step in one persistent script",
  async (operation) => {
    const db = getDb();
    const id = db
      .insert(systems)
      .values({
        name: "review",
        hostname: "review.invalid",
        username: "root",
        pkgManager: "apt",
        detectedPkgManagers: '["apt"]',
      })
      .returning()
      .get().id;
    db.insert(updateCache)
      .values({
        systemId: id,
        packageName: "bash",
        pkgManager: "apt",
        newVersion: "5.3",
      })
      .run();
    const script = scriptService.createScript({
      name: "review-upgrade",
      type: "package_manager",
      operation,
      pkgManager: "apt",
      steps: [
        { label: "Prepare", command: "echo prepare" },
        { label: "Upgrade", command: "echo actual-upgrade" },
      ],
    });
    scriptService.setSystemOverrides(id, {
      [scriptService.buildOperationKey(operation, "apt")]: script.id,
    });
    const manager = initSSHManager(2, 1, 1, getEncryptor());
    vi.spyOn(manager, "connect").mockResolvedValue({ end() {} } as any);
    vi.spyOn(manager, "disconnect").mockImplementation(() => {});
    vi.spyOn(systemService, "updateSystemInfo").mockResolvedValue(undefined);
    vi.spyOn(manager, "runCommand").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const persistent = vi
      .spyOn(manager, "runPersistentCommand")
      .mockImplementation(async (_conn, command) => {
        const { stdout } = await promisify(execFile)("sh", ["-c", command]);
        return { stdout, stderr: "", exitCode: 0 };
      });
    const { applyAutoremove, applyFullUpgradeAll, applyUpgradePackages } =
      await import("../../server/services/update-service");
    const result = await (operation === "upgrade_all"
      ? applyUpgradeAll(id)
      : operation === "autoremove"
        ? applyAutoremove(id)
        : operation === "full_upgrade_all"
          ? applyFullUpgradeAll(id)
          : applyUpgradePackages(id, ["bash"]));
    expect(result.success).toBe(true);
    expect(persistent).toHaveBeenCalledOnce();
    expect(result.output).toContain("prepare\nactual-upgrade\n");
  },
);
test("accepts configured nonzero update exit codes", async () => {
  const db = getDb();
  scriptService.createCustomPackageManager({
    name: "reviewpm",
    label: "Review PM",
  });
  const script = scriptService.createScript({
    name: "review-check",
    type: "package_manager",
    operation: "check_updates",
    pkgManager: "reviewpm",
    steps: [{ label: "Check", command: "echo check-review" }],
    parserConfig: {
      updateRegex: "^(?<packageName>\\S+) (?<newVersion>\\S+)$",
      updatesExitCodes: [100],
    },
  });
  const id = db
    .insert(systems)
    .values({
      name: "review",
      hostname: "review.invalid",
      username: "root",
      pkgManager: "reviewpm",
      detectedPkgManagers: '["reviewpm"]',
    })
    .returning()
    .get().id;
  scriptService.setSystemOverrides(id, {
    [scriptService.buildOperationKey("check_updates", "reviewpm")]: script.id,
  });
  const manager = initSSHManager(2, 1, 1, getEncryptor());
  vi.spyOn(manager, "connect").mockResolvedValue({ end() {} } as any);
  vi.spyOn(manager, "disconnect").mockImplementation(() => {});
  vi.spyOn(systemService, "updateSystemInfo").mockResolvedValue(undefined);
  vi.spyOn(manager, "runCommand").mockResolvedValue({
    stdout: "widget 2.0\n",
    stderr: "",
    exitCode: 100,
  });
  await expect(checkUpdates(id)).resolves.toMatchObject([
    { packageName: "widget", newVersion: "2.0" },
  ]);
  expect(db.select().from(updateCache).all()).toHaveLength(1);
});

test("expires and binds WebAuthn challenges to their ceremony and account", () => {
  vi.useFakeTimers();
  const expired = issueWebAuthnChallenge("value", "login");
  vi.advanceTimersByTime(300_000);
  expect(consumeWebAuthnChallenge(expired, "login")).toBeNull();
  expect(
    consumeWebAuthnChallenge("arbitrary-client-challenge", "login"),
  ).toBeNull();
  const wrongKind = issueWebAuthnChallenge("value", "register", 1);
  expect(consumeWebAuthnChallenge(wrongKind, "login")).toBeNull();
  const wrongUser = issueWebAuthnChallenge("value", "register", 1);
  expect(consumeWebAuthnChallenge(wrongUser, "register", 2)).toBeNull();
  const valid = issueWebAuthnChallenge("value", "register", 1);
  expect(consumeWebAuthnChallenge(valid, "register", 1)).toBe("value");
  expect(consumeWebAuthnChallenge(valid, "register", 1)).toBeNull();
});
test("stops maintenance steps on failure and preserves explicit exit status", async () => {
  const command = scriptService.buildMaintenanceCommand([
    { label: "Fail", command: "printf failed; exit 7" },
    { label: "Must not execute", command: "printf unsafe" },
  ])!;
  await expect(
    promisify(execFile)("sh", ["-c", command]),
  ).rejects.toMatchObject({ code: 7, stdout: "failed" });
});

test.each(["running", "finished"])(
  "resumes a %s remote log without replaying emitted bytes",
  async (state) => {
    const manager = initSSHManager(1, 1, 1, getEncryptor());
    const conn = new EventEmitter() as Client;
    let monitoringAttempt = 0;
    const exec = vi.fn(
      (
        _command: string,
        callback: (error: Error | null, stream: unknown) => void,
      ) => {
        const stream = new EventEmitter() as EventEmitter & {
          stderr: EventEmitter;
          close: () => void;
        };
        stream.stderr = new EventEmitter();
        stream.close = () => stream.emit("close");
        callback(null, stream);
        queueMicrotask(() => {
          monitoringAttempt++;
          stream.emit(
            "data",
            Buffer.from(monitoringAttempt === 1 ? "alpha\n" : "beta\n"),
          );
          if (monitoringAttempt === 1) conn.emit("close");
          else stream.emit("close");
        });
      },
    );
    conn.exec = exec as unknown as Client["exec"];
    const runCommand = vi.spyOn(manager, "runCommand");
    runCommand.mockResolvedValueOnce({
      stdout:
        "LUDASH_BG PID=123 LOG=/tmp/review.log EXIT=/tmp/review.exit SCRIPT=/tmp/review.sh",
      stderr: "",
      exitCode: 0,
    });
    const onData = vi.fn();
    const lost = await manager.runPersistentCommand(
      conn,
      "echo command",
      10,
      undefined,
      onData,
    );
    expect(lost.persistentInfo).toBeDefined();
    runCommand.mockImplementation(async (_conn, command) => ({
      stdout: command.startsWith("test -f")
        ? command.includes(".log") || state === "finished"
          ? "exists"
          : "gone"
        : command.includes("/proc/")
          ? "alive"
          : command.startsWith("cat") && command.includes(".log")
            ? "alpha\nbeta\n"
            : "0",
      stderr: "",
      exitCode: 0,
    }));
    const result = await manager.resumePersistentCommand(
      conn,
      lost.persistentInfo!,
      10,
      onData,
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "alpha\nbeta\n" });
    expect(onData.mock.calls.map(([chunk]) => chunk).join("")).toBe(
      "alpha\nbeta\n",
    );
    if (state === "running")
      expect(exec.mock.calls[1][0]).toContain("tail -c +7");
  },
);
