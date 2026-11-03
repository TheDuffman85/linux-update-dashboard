import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { credentials, systems, updateCache, updateHistory, upgradeBatchItems, upgradeBatches } from "../../server/db/schema";
import { getEncryptor, initEncryptor } from "../../server/security";
import { EXIT_CANCELLED, EXIT_FILES_GONE, EXIT_MONITORING_LOST, initSSHManager } from "../../server/ssh/connection";
import { createSystem, getSystem } from "../../server/services/system-service";
import { createScript, setSystemOverrides } from "../../server/services/script-service";
import * as outputStream from "../../server/services/output-stream";
import {
  applyFullUpgradeAll,
  applyUpgradeAll,
  applyUpgradePackages,
  cancelActiveOperation,
  runPendingPostUpgradeScript,
} from "../../server/services/update-service";
import { createUpgradeBatch, runUpgradeBatches } from "../../server/services/upgrade-batch-service";

const PRE_MARK = "echo run-pre-script";
const POST_MARK = "echo run-post-script";
const PERSISTENT_INFO = { pid: 1, logFile: "/tmp/ludash_log", exitFile: "/tmp/ludash_exit" };

type PersistentResult = { stdout: string; stderr: string; exitCode: number; persistentInfo?: typeof PERSISTENT_INFO };
type Kind = "pre" | "post" | "upgrade";
const LOST: PersistentResult = {
  stdout: "",
  stderr: "lost",
  exitCode: EXIT_MONITORING_LOST,
  persistentInfo: PERSISTENT_INFO,
};

type BatchItem = typeof upgradeBatchItems.$inferSelect;
type HistoryRow = typeof updateHistory.$inferSelect;
interface RestartState {
  batchId: number;
  systemId: number;
  item: BatchItem;
  history: HistoryRow;
  pendingAt: string | null;
}

interface Harness {
  events: string[];
  commands: Record<Kind, string[]>;
  respond: Partial<Record<Kind, (signal: AbortSignal | null) => Promise<PersistentResult> | PersistentResult>>;
  connect: (attempt: number) => Promise<void> | void;
  resume: (signal: AbortSignal | null) => Promise<PersistentResult> | PersistentResult;
  maxOpenConnections: number;
}

function classify(command: string): Kind {
  if (command.includes(PRE_MARK)) return "pre";
  if (command.includes(POST_MARK)) return "post";
  return "upgrade";
}

function installSsh(): Harness {
  const harness: Harness = {
    events: [],
    commands: { pre: [], post: [], upgrade: [] },
    respond: {},
    connect: () => {},
    resume: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    maxOpenConnections: 0,
  };
  const sshManager = initSSHManager(5, 1, 1, getEncryptor()) as any;
  let open = 0;
  let attempts = 0;
  sshManager.connect = async () => {
    attempts += 1;
    await harness.connect(attempts);
    open += 1;
    harness.maxOpenConnections = Math.max(harness.maxOpenConnections, open);
    return {};
  };
  sshManager.disconnect = () => {
    open -= 1;
  };
  sshManager.runPersistentCommand = async (
    _conn: unknown,
    command: string,
    _timeout: number,
    _sudoPassword: string | undefined,
    _onData: unknown,
    options?: { signal?: AbortSignal | null; onPersistentInfo?: (info: typeof PERSISTENT_INFO) => void },
  ) => {
    const kind = classify(command);
    harness.events.push(kind === "upgrade" ? `upgrade:${command.includes("snap") ? "snap" : "apt"}` : kind);
    harness.commands[kind].push(command);
    options?.onPersistentInfo?.(PERSISTENT_INFO);
    const respond = harness.respond[kind];
    return respond ? respond(options?.signal ?? null) : { stdout: `${kind} ok`, stderr: "", exitCode: 0 };
  };
  sshManager.resumePersistentCommand = async (
    _conn: unknown,
    _info: unknown,
    _timeout: unknown,
    _onData: unknown,
    options?: { signal?: AbortSignal | null },
  ) => harness.resume(options?.signal ?? null);
  sshManager.runCommand = async (_conn: unknown, command: string) => {
    if (command.includes("apt list --upgradable") || command.includes("snap refresh --list")) {
      if (!harness.events.includes("recheck")) harness.events.push("recheck");
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return harness;
}

let portCounter = 2200;
function seedSystem(options?: { managers?: string[]; pre?: boolean; post?: boolean }): number {
  const db = getDb();
  const encryptor = getEncryptor();
  const managers = options?.managers ?? ["apt"];
  const credentialId = db.insert(credentials).values({
    name: "Test password",
    kind: "usernamePassword",
    payload: JSON.stringify({ username: "testuser", password: encryptor.encrypt("testpass") }),
  }).returning({ id: credentials.id }).get().id;
  const systemId = createSystem({
    name: "Node",
    hostname: "127.0.0.1",
    port: (portCounter += 1),
    credentialId,
    hostKeyVerificationEnabled: false,
  });
  db.update(systems)
    .set({ pkgManager: managers[0], detectedPkgManagers: JSON.stringify(managers) })
    .where(eq(systems.id, systemId))
    .run();
  for (const pkgManager of managers) {
    db.insert(updateCache).values({
      systemId,
      pkgManager,
      packageName: `pkg-${pkgManager}`,
      currentVersion: "1",
      newVersion: "2",
      architecture: null,
      repository: null,
      isSecurity: 0,
      isKeptBack: 0,
    }).run();
  }
  const overrides: Record<string, string> = {};
  if (options?.pre !== false) overrides["system/pre_upgrade"] = hookScript("pre_upgrade", PRE_MARK);
  if (options?.post !== false) overrides["system/post_upgrade"] = hookScript("post_upgrade", POST_MARK);
  setSystemOverrides(systemId, overrides);
  return systemId;
}

let scriptCounter = 0;
function hookScript(operation: "pre_upgrade" | "post_upgrade", command: string): string {
  scriptCounter += 1;
  return createScript({
    name: `${operation} ${scriptCounter}`,
    type: "system",
    operation,
    pkgManager: null,
    steps: [{ label: "Run", command }],
  }).id;
}

function historyStatus(systemId: number, action: string): string[] {
  return getDb()
    .select()
    .from(updateHistory)
    .where(eq(updateHistory.systemId, systemId))
    .all()
    .filter((row) => row.action === action)
    .map((row) => row.status);
}

function isPending(systemId: number): boolean {
  return !!getSystem(systemId)?.postUpgradePendingAt;
}

/** An attached monitor that keeps running until cancelled, then stops the remote command. */
function runUntilCancelled(signal: AbortSignal | null): Promise<PersistentResult> {
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => {
      resolve({ stdout: "", stderr: "Operation cancelled", exitCode: EXIT_CANCELLED });
    }, { once: true });
  });
}

function batchItems(batchId: number): BatchItem[] {
  return getDb().select().from(upgradeBatchItems).where(eq(upgradeBatchItems.batchId, batchId)).all();
}

describe("pre- and post-upgrade scripts", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-upgrade-hooks-"));
    initEncryptor(randomBytes(32).toString("base64"));
    initDatabase(join(tempDir, "dashboard.db"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("runs each script once around all package managers, before the recheck and done", async () => {
    const harness = installSsh();
    const systemId = seedSystem({ managers: ["apt", "snap"] });
    const publish = vi.spyOn(outputStream, "publish");

    const result = await applyUpgradeAll(systemId);

    expect(result.success).toBe(true);
    expect(harness.events).toEqual(["pre", "upgrade:apt", "upgrade:snap", "post", "recheck"]);
    expect(harness.commands.pre[0]).toContain("LUDASH_OPERATION=upgrade_all; export LUDASH_OPERATION");
    expect(harness.commands.post[0]).toContain("LUDASH_UPGRADE_RESULT=success; export LUDASH_UPGRADE_RESULT");
    expect(historyStatus(systemId, "pre_upgrade")).toEqual(["success"]);
    expect(historyStatus(systemId, "post_upgrade")).toEqual(["success"]);
    expect(isPending(systemId)).toBe(false);

    const doneMessages = publish.mock.calls.filter(([, message]) => message.type === "done");
    expect(doneMessages).toHaveLength(1);
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ type: "done", success: true });
  });

  test("changes nothing for systems without an assigned script", async () => {
    const harness = installSsh();
    const systemId = seedSystem({ pre: false, post: false });
    // A script that exists but is not assigned must never run.
    hookScript("pre_upgrade", PRE_MARK);
    hookScript("post_upgrade", POST_MARK);

    const result = await applyUpgradeAll(systemId);

    expect(result.success).toBe(true);
    expect(result.hookFailed).toBeUndefined();
    expect(harness.events).toEqual(["upgrade:apt", "recheck"]);
    expect(harness.maxOpenConnections).toBe(1);
    expect(historyStatus(systemId, "pre_upgrade")).toEqual([]);
    expect(historyStatus(systemId, "post_upgrade")).toEqual([]);
  });

  test("a default script runs on systems without a choice, and opting out skips it", async () => {
    const harness = installSsh();
    const defaultPost = createScript({
      name: "Default post",
      type: "system",
      operation: "post_upgrade",
      pkgManager: null,
      isDefault: true,
      steps: [{ label: "Run", command: POST_MARK }],
    });
    createScript({
      name: "Default pre",
      type: "system",
      operation: "pre_upgrade",
      pkgManager: null,
      isDefault: true,
      steps: [{ label: "Run", command: PRE_MARK }],
    });
    const followsDefault = seedSystem({ pre: false, post: false });
    const optedOut = seedSystem({ pre: false, post: false });
    setSystemOverrides(optedOut, { "system/pre_upgrade": "none", "system/post_upgrade": "none" });

    await applyUpgradeAll(followsDefault);
    expect(harness.events).toEqual(["pre", "upgrade:apt", "post", "recheck"]);
    expect(defaultPost.isDefault).toBe(true);

    harness.events.length = 0;
    const result = await applyUpgradeAll(optedOut);
    expect(result.success).toBe(true);
    expect(harness.events).toEqual(["upgrade:apt", "recheck"]);
    expect(historyStatus(optedOut, "pre_upgrade")).toEqual([]);
    expect(isPending(optedOut)).toBe(false);
  });

  test.each([
    ["full upgrade", "full_upgrade_all", (id: number) => applyFullUpgradeAll(id)],
    ["selected packages", "upgrade_package", (id: number) => applyUpgradePackages(id, ["pkg-apt"])],
  ])("also wraps %s", async (_name, operation, run) => {
    const harness = installSsh();
    const systemId = seedSystem();

    const result = await run(systemId);

    expect(result.success).toBe(true);
    expect(harness.events).toEqual(["pre", "upgrade:apt", "post", "recheck"]);
    expect(harness.commands.pre[0]).toContain(`LUDASH_OPERATION=${operation};`);
    expect(harness.commands.post[0]).toContain(`LUDASH_OPERATION=${operation};`);
  });

  test("a pre-upgrade script that exits non-zero vetoes the upgrade and the post script", async () => {
    const harness = installSsh();
    harness.respond.pre = () => ({ stdout: "cluster unhealthy", stderr: "", exitCode: 3 });
    const systemId = seedSystem();

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(result.output).toContain("exit code 3");
    expect(harness.events).toEqual(["pre"]);
    expect(historyStatus(systemId, "pre_upgrade")).toEqual(["failed"]);
    expect(isPending(systemId)).toBe(false);
  });

  test("runs script steps as separate commands and stops at the first failed one", async () => {
    const harness = installSsh();
    const systemId = seedSystem({ pre: false, post: false });
    const script = createScript({
      name: "Three steps",
      type: "system",
      operation: "pre_upgrade",
      pkgManager: null,
      steps: [
        { label: "Drain", command: `${PRE_MARK} drain` },
        { label: "Stop", command: `${PRE_MARK} stop` },
        { label: "Never", command: `${PRE_MARK} never` },
      ],
    });
    setSystemOverrides(systemId, { "system/pre_upgrade": script.id });
    let calls = 0;
    harness.respond.pre = () => {
      calls += 1;
      return { stdout: `step ${calls}`, stderr: "", exitCode: calls === 2 ? 7 : 0 };
    };

    const result = await applyUpgradeAll(systemId);

    expect(result.output).toContain('"Stop" with exit code 7');
    expect(harness.commands.pre).toHaveLength(2);
    for (const command of harness.commands.pre) {
      expect(command).toContain("LUDASH_OPERATION=upgrade_all;");
    }
    const row = getDb().select().from(updateHistory).where(eq(updateHistory.systemId, systemId)).all()
      .find((entry) => entry.action === "pre_upgrade");
    const steps = JSON.parse(row?.steps ?? "[]");
    expect(steps.map((step: { label: string; status: string }) => [step.label, step.status])).toEqual([
      ["Pre-upgrade script: Drain", "success"],
      ["Pre-upgrade script: Stop", "failed"],
    ]);
  });

  test("a veto finishes the queued activity row of a batch upgrade", async () => {
    const harness = installSsh();
    harness.respond.pre = () => ({ stdout: "", stderr: "", exitCode: 1 });
    const systemId = seedSystem();
    const queuedHistoryId = getDb().insert(updateHistory).values({
      systemId,
      action: "upgrade_all",
      pkgManager: "apt",
      status: "queued",
      startedAt: "2026-01-01 00:00:00",
    }).returning({ id: updateHistory.id }).get().id;

    await applyUpgradeAll(systemId, { queuedHistoryId });

    expect(historyStatus(systemId, "upgrade_all")).toEqual(["failed"]);
  });

  test("a veto keeps a post script that was already pending from an earlier run", async () => {
    const harness = installSsh();
    harness.respond.pre = () => ({ stdout: "", stderr: "", exitCode: 1 });
    const systemId = seedSystem();
    getDb().update(systems).set({ postUpgradePendingAt: "2026-01-01 00:00:00" }).where(eq(systems.id, systemId)).run();

    await applyUpgradeAll(systemId);

    expect(getSystem(systemId)?.postUpgradePendingAt).toBe("2026-01-01 00:00:00");
  });

  test("cancelling a running pre-upgrade script skips the upgrade, flags the post script and holds later priorities", async () => {
    const harness = installSsh();
    harness.respond.pre = () => ({ stdout: "", stderr: "Operation cancelled", exitCode: EXIT_CANCELLED });
    const systemId = seedSystem();

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
    expect(harness.events).toEqual(["pre"]);
    expect(isPending(systemId)).toBe(true);
  });

  test("a pre-upgrade script that could not connect changed nothing, so nothing is flagged", async () => {
    const harness = installSsh();
    harness.connect = () => {
      throw new Error("connect ECONNREFUSED");
    };
    const systemId = seedSystem();

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(harness.events).toEqual([]);
    expect(isPending(systemId)).toBe(false);
  });

  test("a failed upgrade still runs the post script and reports the failure to it", async () => {
    const harness = installSsh();
    harness.respond.upgrade = () => ({ stdout: "", stderr: "dpkg error", exitCode: 100 });
    const systemId = seedSystem();

    const result = await applyUpgradeAll(systemId);

    expect(result.success).toBe(false);
    expect(result.hookFailed).toBeUndefined();
    expect(harness.events).toEqual(["pre", "upgrade:apt", "post", "recheck"]);
    expect(harness.commands.post[0]).toContain("LUDASH_UPGRADE_RESULT=failed;");
    expect(isPending(systemId)).toBe(false);
  });

  test("a failed SSH connection for the upgrade still runs the post script", async () => {
    const harness = installSsh();
    harness.connect = (attempt) => {
      if (attempt === 2) throw new Error("connect ETIMEDOUT");
    };
    const systemId = seedSystem();

    const result = await applyUpgradeAll(systemId);

    expect(result.success).toBe(false);
    expect(harness.events).toEqual(["pre", "post"]);
    expect(harness.commands.post[0]).toContain("LUDASH_UPGRADE_RESULT=failed;");
  });

  test("a cancelled upgrade still runs the post script on a fresh signal and a free connection", async () => {
    const harness = installSsh();
    const systemId = seedSystem();
    let postSignalAborted: boolean | undefined;
    harness.respond.upgrade = () => {
      cancelActiveOperation(systemId);
      return { stdout: "", stderr: "Operation cancelled", exitCode: EXIT_CANCELLED };
    };
    harness.respond.post = (signal) => {
      postSignalAborted = signal?.aborted;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, cancelled: true });
    expect(harness.events).toEqual(["pre", "upgrade:apt", "post"]);
    expect(harness.commands.post[0]).toContain("LUDASH_UPGRADE_RESULT=cancelled;");
    expect(postSignalAborted).toBe(false);
    // The pool is limited, so holding the upgrade connection could deadlock the script.
    expect(harness.maxOpenConnections).toBe(1);
    expect(isPending(systemId)).toBe(false);
  });

  test("the post script can be cancelled on its own, and the recheck still runs", async () => {
    const harness = installSsh();
    const systemId = seedSystem();
    harness.respond.post = () => {
      cancelActiveOperation(systemId);
      return { stdout: "", stderr: "Operation cancelled", exitCode: EXIT_CANCELLED };
    };

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
    expect(harness.events).toEqual(["pre", "upgrade:apt", "post", "recheck"]);
    expect(isPending(systemId)).toBe(true);
  });

  test("a failed post script fails the operation and stays flagged", async () => {
    const harness = installSsh();
    harness.respond.post = () => ({ stdout: "", stderr: "unit not found", exitCode: 5 });
    const systemId = seedSystem();
    const publish = vi.spyOn(outputStream, "publish");

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, warning: false, hookFailed: true });
    expect(result.output).toContain("exit code 5");
    expect(harness.events).toEqual(["pre", "upgrade:apt", "post", "recheck"]);
    expect(historyStatus(systemId, "post_upgrade")).toEqual(["failed"]);
    expect(historyStatus(systemId, "upgrade_all")).toEqual(["success"]);
    expect(isPending(systemId)).toBe(true);
    expect(publish.mock.calls.at(-1)?.[1]).toMatchObject({ type: "done", success: false });
  });

  test("the post script runs after reconnecting when SSH drops during the upgrade", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.upgrade = () => ({
      stdout: "",
      stderr: "lost",
      exitCode: EXIT_MONITORING_LOST,
      persistentInfo: PERSISTENT_INFO,
    });
    const systemId = seedSystem();

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await running;

    expect(result).toMatchObject({ success: true, warning: true });
    expect(harness.events).toEqual(["pre", "upgrade:apt", "post"]);
    expect(isPending(systemId)).toBe(false);
  });

  test("the post script does not run while the upgrade may still be running remotely", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.upgrade = () => ({
      stdout: "",
      stderr: "lost",
      exitCode: EXIT_MONITORING_LOST,
      persistentInfo: PERSISTENT_INFO,
    });
    harness.connect = (attempt) => {
      if (attempt > 2) throw new Error("host down");
    };
    const systemId = seedSystem();

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    const result = await running;

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(result.output).toContain("did not run");
    expect(harness.events).toEqual(["pre", "upgrade:apt"]);
    expect(isPending(systemId)).toBe(true);
  });

  test("a pre script that started before SSH dropped keeps its warning when the host stays away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.pre = () => LOST;
    harness.connect = (attempt) => {
      if (attempt > 1) throw new Error("host down");
    };
    const systemId = seedSystem();

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    const result = await running;

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(harness.commands.upgrade).toEqual([]);
    expect(harness.commands.post).toEqual([]);
    expect(isPending(systemId)).toBe(true);
  });

  test("a host that reboots during a script gives an unknown result instead of counting updates", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.post = () => ({
      stdout: "",
      stderr: "lost",
      exitCode: EXIT_MONITORING_LOST,
      persistentInfo: PERSISTENT_INFO,
    });
    harness.resume = () => ({ stdout: "", stderr: "gone", exitCode: -3 });
    const systemId = seedSystem();

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await running;

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(isPending(systemId)).toBe(true);
    expect(historyStatus(systemId, "post_upgrade")).toEqual(["failed"]);
  });

  test("the post script retries its connection while the host restarts services", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.connect = (attempt) => {
      if (attempt === 2 || attempt === 3) throw new Error("connection refused");
    };
    const systemId = seedSystem({ pre: false });

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await running;

    expect(result.success).toBe(true);
    expect(harness.events).toEqual(["upgrade:apt", "post", "recheck"]);
    expect(isPending(systemId)).toBe(false);
  });

  test("resuming after a restart skips the pre script and still runs the post script", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    const systemId = seedSystem();
    getDb().update(systems).set({ postUpgradePendingAt: "2026-01-01 00:00:00" }).where(eq(systems.id, systemId)).run();
    const historyId = getDb().insert(updateHistory).values({
      systemId,
      action: "upgrade_all",
      pkgManager: "apt",
      status: "started",
      startedAt: "2026-01-01 00:00:00",
    }).returning({ id: updateHistory.id }).get().id;
    const onHookProgress = vi.fn();

    const running = applyUpgradeAll(systemId, {
      onHookProgress,
      resume: {
        historyId,
        pkgManager: "apt",
        command: "apt-get upgrade",
        persistentInfo: PERSISTENT_INFO,
        preUpgradeUpdateCount: 1,
      },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await running;

    expect(result.success).toBe(true);
    expect(harness.commands.pre).toEqual([]);
    expect(harness.events).toEqual(["post", "recheck"]);
    expect(onHookProgress.mock.calls.map(([progress]) => progress.phase)).not.toContain("pre_upgrade");
    expect(onHookProgress.mock.calls.at(-1)?.[0]).toMatchObject({ phase: "post_upgrade", stepIndex: 1, persistentInfo: null });
    expect(isPending(systemId)).toBe(false);
  });

  test("a second SSH drop keeps waiting, and the post script runs only once the upgrade has ended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.upgrade = () => LOST;
    let resumes = 0;
    harness.resume = () => {
      resumes += 1;
      harness.events.push(`resume:${resumes}`);
      return resumes === 1 ? LOST : { stdout: "", stderr: "", exitCode: 0 };
    };
    const systemId = seedSystem();

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await running;

    expect(result).toMatchObject({ success: true, warning: true });
    expect(harness.events).toEqual(["pre", "upgrade:apt", "resume:1", "resume:2", "post"]);
    expect(isPending(systemId)).toBe(false);
  });

  test("the post script does not run when the host goes away after a second SSH drop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.upgrade = () => LOST;
    harness.resume = () => LOST;
    harness.connect = (attempt) => {
      if (attempt > 3) throw new Error("host down");
    };
    const systemId = seedSystem();

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    const result = await running;

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(result.output).toContain("did not run");
    expect(harness.events).toEqual(["pre", "upgrade:apt"]);
    expect(isPending(systemId)).toBe(true);
  });

  test("gives up on a remote upgrade that never ends without running the post script", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.upgrade = () => LOST;
    harness.resume = () => LOST;
    const systemId = seedSystem();

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 10 * 60 * 1000);
    const result = await running;

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(harness.commands.post).toEqual([]);
    expect(isPending(systemId)).toBe(true);
  });

  test.each([
    ["no scripts", { pre: false, post: false }, 1],
    ["only a pre-upgrade script", { pre: true, post: false }, 2],
  ])("a reconnection timeout with %s is an ordinary failure", async (_name, hooks, connections) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const harness = installSsh();
    harness.respond.upgrade = () => LOST;
    harness.connect = (attempt) => {
      if (attempt > connections) throw new Error("host down");
    };
    const systemId = seedSystem(hooks);

    const running = applyUpgradeAll(systemId);
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000);
    const result = await running;

    expect(result.success).toBe(false);
    expect(result.hookFailed).toBeUndefined();
    expect(result.output).not.toContain("did not run");
    expect(isPending(systemId)).toBe(false);
  });

  test("cancelling a running pre-upgrade script holds later priorities even without a post script", async () => {
    const harness = installSsh();
    harness.respond.pre = () => ({ stdout: "", stderr: "Operation cancelled", exitCode: EXIT_CANCELLED });
    const systemId = seedSystem({ post: false });

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
    expect(isPending(systemId)).toBe(false);
  });

  test("cancelling before the pre-upgrade script started does not hold later priorities", async () => {
    const harness = installSsh();
    const systemId = seedSystem();
    harness.connect = () => {
      cancelActiveOperation(systemId);
    };

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, cancelled: true });
    expect(result.hookFailed).toBeUndefined();
    expect(harness.events).toEqual([]);
    expect(isPending(systemId)).toBe(false);
  });

  test("cancelling before the pre-upgrade script started still holds when a post script is already pending", async () => {
    const harness = installSsh();
    const systemId = seedSystem();
    getDb().update(systems).set({ postUpgradePendingAt: "2026-01-01 00:00:00" }).where(eq(systems.id, systemId)).run();
    harness.connect = () => {
      cancelActiveOperation(systemId);
    };

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
  });

  test("a cancelled pre-upgrade script stops the next node of a batch from starting", async () => {
    const harness = installSsh();
    const first = seedSystem();
    const second = seedSystem();
    getDb().update(systems).set({ updatePriority: 1 }).where(eq(systems.id, first)).run();
    getDb().update(systems).set({ updatePriority: 2 }).where(eq(systems.id, second)).run();
    harness.respond.pre = () => ({ stdout: "", stderr: "Operation cancelled", exitCode: EXIT_CANCELLED });

    const { batchId } = createUpgradeBatch([{ systemId: first }, { systemId: second }], { autoRun: false });
    await runUpgradeBatches();

    expect(harness.commands.pre).toHaveLength(1);
    const items = batchItems(batchId);
    expect(items.find((item) => item.systemId === first)?.status).toBe("cancelled");
    const held = items.find((item) => item.systemId === second);
    expect(held?.status).toBe("cancelled");
    expect(held?.error).toContain("did not finish");
  });

  describe("dashboard restart during a batch", () => {
    const stepsScript = (operation: "pre_upgrade" | "post_upgrade", mark: string) => {
      scriptCounter += 1;
      return createScript({
        name: `${operation} steps ${scriptCounter}`,
        type: "system",
        operation,
        pkgManager: null,
        steps: [
          { label: "First", command: `${mark} first` },
          { label: "Second", command: `${mark} second` },
        ],
      }).id;
    };

    function captureState(batchId: number, systemId: number): RestartState {
      const item = batchItems(batchId)[0];
      return {
        batchId,
        systemId,
        item,
        history: getDb().select().from(updateHistory).where(eq(updateHistory.id, item.historyId!)).get()!,
        pendingAt: getSystem(systemId)?.postUpgradePendingAt ?? null,
      };
    }

    /** Puts the database back as it was at the captured moment, then starts up on it again. */
    function restartAt(state: RestartState, harness: Harness): void {
      const db = getDb();
      db.update(upgradeBatches).set({ status: "running", completedAt: null }).where(eq(upgradeBatches.id, state.batchId)).run();
      db.update(upgradeBatchItems).set(state.item).where(eq(upgradeBatchItems.id, state.item.id)).run();
      db.update(updateHistory).set(state.history).where(eq(updateHistory.id, state.history.id)).run();
      db.update(systems).set({ postUpgradePendingAt: state.pendingAt }).where(eq(systems.id, state.systemId)).run();
      closeDatabase();
      initDatabase(join(tempDir, "dashboard.db"));
      for (const list of Object.values(harness.commands)) list.length = 0;
      harness.events.length = 0;
      harness.connect = () => {};
      harness.respond = {};
    }

    async function resumeBatch(): Promise<void> {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const running = runUpgradeBatches();
      await vi.advanceTimersByTimeAsync(60_000);
      await running;
    }

    test.each([
      ["succeeded", 0, "success", "success"],
      ["failed", 100, "failed", "failed"],
    ])("attaches to a running post script after an upgrade that %s", async (_name, upgradeExit, env, itemStatus) => {
      const harness = installSsh();
      const systemId = seedSystem({ post: false });
      setSystemOverrides(systemId, { "system/post_upgrade": stepsScript("post_upgrade", POST_MARK) });
      const { batchId } = createUpgradeBatch([{ systemId }], { autoRun: false });
      let state: RestartState | undefined;
      harness.respond.upgrade = () => ({ stdout: "", stderr: "", exitCode: upgradeExit });
      harness.respond.post = () => {
        state ??= captureState(batchId, systemId);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpgradeBatches();

      restartAt(state!, harness);
      expect(batchItems(batchId)[0].remotePid).toBe(PERSISTENT_INFO.pid);
      await resumeBatch();

      // Only the step after the interrupted one starts, and nothing before it repeats.
      expect(harness.commands.pre).toEqual([]);
      expect(harness.commands.upgrade).toEqual([]);
      expect(harness.commands.post).toHaveLength(1);
      expect(harness.commands.post[0]).toContain(`${POST_MARK} second`);
      expect(harness.commands.post[0]).toContain(`LUDASH_UPGRADE_RESULT=${env};`);
      const item = batchItems(batchId)[0];
      expect(item.status).toBe(itemStatus);
      expect(item.hookProgress).toBeNull();
      expect(isPending(systemId)).toBe(false);
      expect(getDb().select().from(upgradeBatches).where(eq(upgradeBatches.id, batchId)).get()?.status).toBe(itemStatus);
    });

    test("keeps later priorities waiting until the attached post script has finished", async () => {
      const harness = installSsh();
      const first = seedSystem();
      const second = seedSystem();
      getDb().update(systems).set({ updatePriority: 1 }).where(eq(systems.id, first)).run();
      getDb().update(systems).set({ updatePriority: 2 }).where(eq(systems.id, second)).run();
      const { batchId } = createUpgradeBatch([{ systemId: first }, { systemId: second }], { autoRun: false });
      let state: { item: BatchItem; history: HistoryRow; second: BatchItem; secondHistory: HistoryRow } | undefined;
      const captured = () => {
        const items = batchItems(batchId);
        const firstItem = items.find((item) => item.systemId === first)!;
        const secondItem = items.find((item) => item.systemId === second)!;
        const row = (id: number) => getDb().select().from(updateHistory).where(eq(updateHistory.id, id)).get()!;
        return { item: firstItem, history: row(firstItem.historyId!), second: secondItem, secondHistory: row(secondItem.historyId!) };
      };
      harness.respond.post = () => {
        state ??= captured();
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpgradeBatches();

      restartAt({
        batchId,
        systemId: first,
        item: state!.item,
        history: state!.history,
        pendingAt: "2026-01-01 00:00:00",
      }, harness);
      getDb().update(upgradeBatchItems).set(state!.second).where(eq(upgradeBatchItems.id, state!.second.id)).run();
      getDb().update(updateHistory).set(state!.secondHistory).where(eq(updateHistory.id, state!.secondHistory.id)).run();
      harness.resume = () => ({ stdout: "", stderr: "unit not found", exitCode: 5 });
      await resumeBatch();

      expect(harness.commands.pre).toEqual([]);
      expect(harness.commands.upgrade).toEqual([]);
      const items = batchItems(batchId);
      expect(items.find((item) => item.systemId === first)?.status).toBe("failed");
      expect(items.find((item) => item.systemId === second)?.status).toBe("cancelled");
      expect(isPending(first)).toBe(true);
    });

    test("a reattached post script can be cancelled, which holds later priorities", async () => {
      const harness = installSsh();
      const first = seedSystem();
      const second = seedSystem();
      getDb().update(systems).set({ updatePriority: 1 }).where(eq(systems.id, first)).run();
      getDb().update(systems).set({ updatePriority: 2 }).where(eq(systems.id, second)).run();
      const { batchId } = createUpgradeBatch([{ systemId: first }, { systemId: second }], { autoRun: false });
      let state: { item: BatchItem; history: HistoryRow; second: BatchItem; secondHistory: HistoryRow } | undefined;
      harness.respond.post = () => {
        if (!state) {
          const items = batchItems(batchId);
          const firstItem = items.find((item) => item.systemId === first)!;
          const secondItem = items.find((item) => item.systemId === second)!;
          const row = (id: number) => getDb().select().from(updateHistory).where(eq(updateHistory.id, id)).get()!;
          state = { item: firstItem, history: row(firstItem.historyId!), second: secondItem, secondHistory: row(secondItem.historyId!) };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpgradeBatches();

      restartAt({ batchId, systemId: first, item: state!.item, history: state!.history, pendingAt: "2026-01-01 00:00:00" }, harness);
      getDb().update(upgradeBatchItems).set(state!.second).where(eq(upgradeBatchItems.id, state!.second.id)).run();
      getDb().update(updateHistory).set(state!.secondHistory).where(eq(updateHistory.id, state!.secondHistory.id)).run();
      let attached = false;
      harness.resume = (signal) => {
        attached = true;
        return runUntilCancelled(signal);
      };

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const running = runUpgradeBatches();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(attached).toBe(true);
      cancelActiveOperation(first);
      await vi.advanceTimersByTimeAsync(0);
      await running;

      const items = batchItems(batchId);
      const firstItem = items.find((item) => item.systemId === first);
      expect(firstItem?.status).toBe("cancelled");
      expect(firstItem?.hookFailed).toBe(1);
      expect(items.find((item) => item.systemId === second)?.status).toBe("cancelled");
      expect(harness.commands.pre).toEqual([]);
      expect(harness.commands.upgrade).toEqual([]);
      expect(isPending(first)).toBe(true);
    });

    test("a post script that finished before the restart is not started again", async () => {
      const harness = installSsh();
      const systemId = seedSystem({ pre: false });
      const { batchId } = createUpgradeBatch([{ systemId }], { autoRun: false });
      let state: RestartState | undefined;
      harness.respond.post = () => {
        state ??= captureState(batchId, systemId);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpgradeBatches();

      const progress = JSON.parse(state!.item.hookProgress!);
      state!.item.hookProgress = JSON.stringify({ ...progress, stepIndex: progress.steps.length, persistentInfo: null });
      restartAt(state!, harness);
      await resumeBatch();

      expect(harness.commands.post).toEqual([]);
      expect(harness.commands.upgrade).toEqual([]);
      expect(batchItems(batchId)[0].status).toBe("success");
      expect(isPending(systemId)).toBe(false);
    });

    test("attaches to a running pre script, then carries on with the upgrade", async () => {
      const harness = installSsh();
      const systemId = seedSystem({ pre: false });
      setSystemOverrides(systemId, { "system/pre_upgrade": stepsScript("pre_upgrade", PRE_MARK) });
      const { batchId } = createUpgradeBatch([{ systemId }], { autoRun: false });
      let state: RestartState | undefined;
      harness.respond.pre = () => {
        state ??= captureState(batchId, systemId);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpgradeBatches();

      restartAt(state!, harness);
      expect(batchItems(batchId)[0].status).toBe("running");
      await resumeBatch();

      expect(harness.commands.pre).toHaveLength(1);
      expect(harness.commands.pre[0]).toContain(`${PRE_MARK} second`);
      expect(harness.events).toEqual(["pre", "upgrade:apt", "post", "recheck"]);
      expect(batchItems(batchId)[0].status).toBe("success");
      expect(historyStatus(systemId, "upgrade_all")).toEqual(["success"]);
      expect(isPending(systemId)).toBe(false);
    });

    test("an attached pre script that vetoes clears the flag its own run set", async () => {
      const harness = installSsh();
      const systemId = seedSystem();
      const { batchId } = createUpgradeBatch([{ systemId }], { autoRun: false });
      let state: RestartState | undefined;
      harness.respond.pre = () => {
        state ??= captureState(batchId, systemId);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpgradeBatches();

      restartAt(state!, harness);
      expect(isPending(systemId)).toBe(true);
      harness.resume = () => ({ stdout: "", stderr: "cluster unhealthy", exitCode: 3 });
      await resumeBatch();

      expect(harness.commands.upgrade).toEqual([]);
      expect(harness.commands.post).toEqual([]);
      expect(batchItems(batchId)[0].status).toBe("failed");
      expect(isPending(systemId)).toBe(false);
    });

    test("a pre script that finished before the restart does not run again when the upgrade starts", async () => {
      const harness = installSsh();
      const systemId = seedSystem();
      const { batchId } = createUpgradeBatch([{ systemId }], { autoRun: false });
      let state: RestartState | undefined;
      harness.connect = (attempt) => {
        if (attempt === 2) state ??= captureState(batchId, systemId);
      };
      await runUpgradeBatches();

      expect(JSON.parse(state!.item.hookProgress!)).toMatchObject({ phase: "pre_upgrade", stepIndex: 1, persistentInfo: null });
      restartAt(state!, harness);
      await resumeBatch();

      expect(harness.events).toEqual(["upgrade:apt", "post", "recheck"]);
      expect(batchItems(batchId)[0].status).toBe("success");
    });

    test("a post script step that had not started yet runs after the restart", async () => {
      const harness = installSsh();
      const systemId = seedSystem({ pre: false });
      const { batchId } = createUpgradeBatch([{ systemId }], { autoRun: false });
      let state: RestartState | undefined;
      harness.respond.post = () => {
        state ??= captureState(batchId, systemId);
        return { stdout: "", stderr: "", exitCode: 0 };
      };
      await runUpgradeBatches();

      const progress = JSON.parse(state!.item.hookProgress!);
      state!.item.hookProgress = JSON.stringify({ ...progress, persistentInfo: null });
      restartAt(state!, harness);
      await resumeBatch();

      expect(harness.commands.post).toHaveLength(1);
      expect(harness.commands.upgrade).toEqual([]);
      expect(batchItems(batchId)[0].status).toBe("success");
    });
  });

  describe("cancelling while reconnected or reconnecting", () => {
    test.each([
      ["pre", (h: Harness) => { h.respond.pre = () => LOST; }, "pre_upgrade", ["pre"]],
      ["post", (h: Harness) => { h.respond.post = () => LOST; }, "post_upgrade", ["pre", "upgrade:apt", "post", "recheck"]],
    ])("stops an attached %s script", async (_name, arrange, action, events) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      arrange(harness);
      const systemId = seedSystem();
      let attached = false;
      harness.resume = (signal) => {
        attached = true;
        return runUntilCancelled(signal);
      };

      const running = applyUpgradeAll(systemId);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(attached).toBe(true);
      cancelActiveOperation(systemId);
      const result = await running;

      expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
      expect(harness.events).toEqual(events);
      expect(historyStatus(systemId, action)).toEqual(["cancelled"]);
      expect(isPending(systemId)).toBe(true);
    });

    test("stops a script without waiting for a host that stays away", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.respond.post = () => LOST;
      const systemId = seedSystem();
      harness.connect = (attempt) => {
        if (attempt > 2) throw new Error("host down");
      };

      const running = applyUpgradeAll(systemId);
      await vi.advanceTimersByTimeAsync(40_000);
      cancelActiveOperation(systemId);
      // No timers advance from here, so a wait for the reconnect window would hang.
      const result = await running;

      expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
      expect(historyStatus(systemId, "post_upgrade")).toEqual(["cancelled"]);
      expect(isPending(systemId)).toBe(true);
    });

    test.each([
      ["upgrade all", "upgrade_all", (id: number) => applyUpgradeAll(id)],
      ["full upgrade", "full_upgrade_all", (id: number) => applyFullUpgradeAll(id)],
      ["selected packages", "upgrade_package", (id: number) => applyUpgradePackages(id, ["pkg-apt"])],
    ])("%s: a stopped upgrade still runs the post script on a fresh signal", async (_name, action, run) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.respond.upgrade = () => LOST;
      harness.resume = (signal) => runUntilCancelled(signal);
      const systemId = seedSystem();
      let postSignalAborted: boolean | undefined;
      harness.respond.post = (signal) => {
        postSignalAborted = signal?.aborted;
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const running = run(systemId);
      await vi.advanceTimersByTimeAsync(20_000);
      cancelActiveOperation(systemId);
      const result = await running;

      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(result.hookFailed).toBeUndefined();
      expect(harness.commands.post[0]).toContain("LUDASH_UPGRADE_RESULT=cancelled;");
      expect(postSignalAborted).toBe(false);
      expect(historyStatus(systemId, action)).toEqual(["cancelled"]);
      expect(isPending(systemId)).toBe(false);
    });

    test.each([
      ["upgrade all", "upgrade_all", (id: number) => applyUpgradeAll(id)],
      ["full upgrade", "full_upgrade_all", (id: number) => applyFullUpgradeAll(id)],
      ["selected packages", "upgrade_package", (id: number) => applyUpgradePackages(id, ["pkg-apt"])],
    ])("%s: an upgrade that could not be stopped blocks the post script", async (_name, action, run) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.respond.upgrade = () => LOST;
      harness.connect = (attempt) => {
        if (attempt > 2) throw new Error("host down");
      };
      const systemId = seedSystem();

      const running = run(systemId);
      await vi.advanceTimersByTimeAsync(40_000);
      cancelActiveOperation(systemId);
      const result = await running;

      expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
      expect(result.output).toContain("did not run");
      expect(harness.commands.post).toEqual([]);
      expect(historyStatus(systemId, action)).toEqual(["cancelled"]);
      expect(isPending(systemId)).toBe(true);
    });

    // No timers advance in these, so waiting out the reconnect interval would hang.
    describe("when the stop command is lost with the connection", () => {
      const operations = [
        ["upgrade all", "upgrade_all", (id: number) => applyUpgradeAll(id)],
        ["full upgrade", "full_upgrade_all", (id: number) => applyFullUpgradeAll(id)],
        ["selected packages", "upgrade_package", (id: number) => applyUpgradePackages(id, ["pkg-apt"])],
      ] as const;

      function cancelThenLose(harness: Harness, kind: Kind, systemId: number) {
        harness.respond[kind] = () => {
          cancelActiveOperation(systemId);
          return LOST;
        };
      }

      test.each(operations)("%s: the post script runs only after a reconnect stopped the upgrade", async (_name, action, run) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const harness = installSsh();
        const systemId = seedSystem();
        cancelThenLose(harness, "upgrade", systemId);
        harness.resume = (signal) => {
          harness.events.push(`stop:${signal?.aborted}`);
          return { stdout: "", stderr: "Operation cancelled", exitCode: EXIT_CANCELLED };
        };

        const result = await run(systemId);

        expect(result).toMatchObject({ success: false, cancelled: true });
        expect(result.hookFailed).toBeUndefined();
        expect(harness.events).toEqual(["pre", "upgrade:apt", "stop:true", "post"]);
        expect(harness.commands.post[0]).toContain("LUDASH_UPGRADE_RESULT=cancelled;");
        expect(historyStatus(systemId, action)).toEqual(["cancelled"]);
        expect(isPending(systemId)).toBe(false);
      });

      test.each(operations)("%s: the post script is blocked when the host cannot be reached", async (_name, action, run) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const harness = installSsh();
        const systemId = seedSystem();
        cancelThenLose(harness, "upgrade", systemId);
        harness.connect = (attempt) => {
          if (attempt > 2) throw new Error("host down");
        };

        const result = await run(systemId);

        expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
        expect(result.output).toContain("did not run");
        expect(harness.commands.post).toEqual([]);
        expect(historyStatus(systemId, action)).toEqual(["cancelled"]);
        expect(isPending(systemId)).toBe(true);
      });

      test.each([
        ["pre", "pre_upgrade", 1],
        ["post", "post_upgrade", 3],
      ] as const)("a %s script stays flagged when the host cannot be reached", async (kind, action, connections) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        const harness = installSsh();
        const systemId = seedSystem();
        cancelThenLose(harness, kind, systemId);
        harness.connect = (attempt) => {
          if (attempt > connections) throw new Error("host down");
        };

        const result = await applyUpgradeAll(systemId);

        expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
        expect(historyStatus(systemId, action)).toEqual(["cancelled"]);
        expect(isPending(systemId)).toBe(true);
      });
    });

    test("without scripts, an upgrade that could not be stopped holds nothing back", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.respond.upgrade = () => LOST;
      harness.connect = (attempt) => {
        if (attempt > 1) throw new Error("host down");
      };
      const systemId = seedSystem({ pre: false, post: false });

      const running = applyUpgradeAll(systemId);
      await vi.advanceTimersByTimeAsync(40_000);
      cancelActiveOperation(systemId);
      const result = await running;

      expect(result).toMatchObject({ success: false, cancelled: true });
      expect(result.hookFailed).toBeUndefined();
    });

    test("a command that already ended keeps its real result when the cancel comes too late", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.respond.upgrade = () => LOST;
      const systemId = seedSystem();
      harness.resume = () => {
        cancelActiveOperation(systemId);
        return { stdout: "", stderr: "", exitCode: 0 };
      };

      const running = applyUpgradeAll(systemId);
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await running;

      expect(result).toMatchObject({ success: true, warning: true });
      expect(historyStatus(systemId, "upgrade_all")).toEqual(["warning"]);
    });

    test("reports a script whose files vanished as cancelled once cancel was requested", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const harness = installSsh();
      harness.respond.post = () => LOST;
      const systemId = seedSystem();
      harness.resume = () => {
        cancelActiveOperation(systemId);
        return { stdout: "", stderr: "gone", exitCode: EXIT_FILES_GONE };
      };

      const running = applyUpgradeAll(systemId);
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await running;

      expect(result).toMatchObject({ success: false, cancelled: true, hookFailed: true });
      expect(historyStatus(systemId, "post_upgrade")).toEqual(["cancelled"]);
    });
  });

  test("a script that cannot be rendered stops the upgrade before anything runs", async () => {
    const harness = installSsh();
    const systemId = seedSystem({ pre: false, post: false });
    setSystemOverrides(systemId, {
      "system/pre_upgrade": hookScript("pre_upgrade", "echo {{nope}}"),
    });

    const result = await applyUpgradeAll(systemId);

    expect(result).toMatchObject({ success: false, hookFailed: true });
    expect(harness.events).toEqual([]);
  });

  test("running a pending post script by hand clears the flag and only on success", async () => {
    const harness = installSsh();
    const systemId = seedSystem();
    getDb().update(systems).set({ postUpgradePendingAt: "2026-01-01 00:00:00" }).where(eq(systems.id, systemId)).run();

    harness.respond.post = () => ({ stdout: "", stderr: "still broken", exitCode: 1 });
    expect(await runPendingPostUpgradeScript(systemId)).toMatchObject({ success: false, hookFailed: true });
    expect(isPending(systemId)).toBe(true);

    harness.respond.post = undefined;
    expect(await runPendingPostUpgradeScript(systemId)).toMatchObject({ success: true });
    expect(isPending(systemId)).toBe(false);
    expect(harness.commands.post[1]).toContain("LUDASH_OPERATION=manual;");
    expect(harness.commands.post[1]).toContain("LUDASH_UPGRADE_RESULT=unknown;");
  });

  test("running a pending post script fails cleanly when none is assigned", async () => {
    installSsh();
    const systemId = seedSystem({ pre: false, post: false });

    const result = await runPendingPostUpgradeScript(systemId);

    expect(result.success).toBe(false);
    expect(result.output).toContain("No post-upgrade script");
  });

  test("a restart during a script leaves its activity row as a warning", () => {
    const systemId = seedSystem();
    getDb().insert(updateHistory).values({
      systemId,
      action: "post_upgrade",
      pkgManager: "system",
      status: "started",
      startedAt: "2026-01-01 00:00:00",
    }).run();

    closeDatabase();
    initDatabase(join(tempDir, "dashboard.db"));

    expect(historyStatus(systemId, "post_upgrade")).toEqual(["warning"]);
  });
});
