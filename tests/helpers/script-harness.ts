/**
 * Shared harness for tests that run update-service operations against a fake SSH
 * connection and read back the recorded outcomes.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../server/db";
import { systems, updateCache, updateHistory } from "../../server/db/schema";
import { getEncryptor } from "../../server/security";
import { initSSHManager } from "../../server/ssh/connection";
import { SYSTEM_INFO_CMD } from "../../server/ssh/system-info";
import {
  createScript,
  getBuiltinScripts,
  setSystemOverrides,
  type ScriptDefinition,
  type ScriptOperation,
} from "../../server/services/script-service";
import { APK_PINNED_LIST, APK_PINNED_WORLD } from "../fixtures/apk-pins";

export const SYSTEM_INFO_OUTPUT = `===OS===
NAME="Alpine Linux"
PRETTY_NAME="Alpine Linux v3.22"
VERSION_ID="3.22.0"
===KERNEL===
6.12.0
===HOSTNAME===
baseline
===UPTIME===
up 1 day
===ARCH===
x86_64
===CPU===
2
===MEM===
Mem:           1.9Gi       512Mi       1.0Gi
===DISK===
/dev/root        20G    5G   14G  27% /
===BOOT_ID===
boot-id
===REBOOT_FILE===
ABSENT
===NEEDS_RESTARTING===
0
===INSTALLED_KERNELS===
6.12.0
`;

export const PERSISTENT_INFO = { pid: 1, logFile: "/tmp/ludash_log", exitFile: "/tmp/ludash_exit" };
export const PRE_MARK = "echo baseline-pre";
export const POST_MARK = "echo baseline-post";

export interface Reply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  persistentInfo?: typeof PERSISTENT_INFO;
}

export interface Harness {
  /** Replies for short commands such as check, inventory and repair steps. */
  run: (command: string) => Reply | undefined;
  /** Replies for persistent commands such as upgrades, autoremove and upgrade scripts. */
  persistent: (command: string) => Reply | undefined;
  resume: () => Reply;
  commands: string[];
  persistentCommands: string[];
}

export function installSsh(): Harness {
  const harness: Harness = {
    run: () => undefined,
    persistent: () => undefined,
    resume: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    commands: [],
    persistentCommands: [],
  };
  const reply = (value: Reply | undefined) => ({
    stdout: value?.stdout ?? "",
    stderr: value?.stderr ?? "",
    exitCode: value?.exitCode ?? 0,
    ...(value?.persistentInfo ? { persistentInfo: value.persistentInfo } : {}),
  });
  const sshManager = initSSHManager(5, 1, 1, getEncryptor()) as any;
  sshManager.connect = async () => ({});
  sshManager.disconnect = () => {};
  sshManager.runCommand = async (
    _conn: unknown,
    command: string,
    _timeout: unknown,
    _sudo: unknown,
    onData?: (chunk: string, stream: "stdout" | "stderr") => void,
  ) => {
    harness.commands.push(command);
    if (command === SYSTEM_INFO_CMD) return reply({ stdout: SYSTEM_INFO_OUTPUT });
    const result = reply(harness.run(command));
    // Real SSH sessions stream both outputs before the command returns.
    if (result.stdout) onData?.(result.stdout, "stdout");
    if (result.stderr) onData?.(result.stderr, "stderr");
    return result;
  };
  sshManager.runPersistentCommand = async (
    _conn: unknown,
    command: string,
    _timeout: unknown,
    _sudo: unknown,
    onData?: (chunk: string, stream: "stdout" | "stderr") => void,
    options?: { onPersistentInfo?: (info: typeof PERSISTENT_INFO) => void },
  ) => {
    harness.persistentCommands.push(command);
    options?.onPersistentInfo?.(PERSISTENT_INFO);
    const result = reply(harness.persistent(command));
    if (result.stdout) onData?.(result.stdout, "stdout");
    return result;
  };
  sshManager.resumePersistentCommand = async () => reply(harness.resume());
  return harness;
}

let systemCounter = 0;

export function resetSystemCounter(): void {
  systemCounter = 0;
}

export function insertSystem(pkgManager: string, managers: string[] = [pkgManager]): number {
  systemCounter += 1;
  return getDb().insert(systems).values({
    name: `${pkgManager}-${systemCounter}`,
    hostname: `host-${systemCounter}.local`,
    port: 22,
    authType: "password",
    username: "root",
    hostKeyVerificationEnabled: 0,
    pkgManager,
    detectedPkgManagers: JSON.stringify(managers),
  }).returning({ id: systems.id }).get().id;
}

export function cacheUpdate(systemId: number, pkgManager: string, packageName: string): void {
  getDb().insert(updateCache).values({
    systemId,
    pkgManager,
    packageName,
    currentVersion: "1",
    newVersion: "2",
    architecture: null,
    repository: null,
    isSecurity: 0,
    isKeptBack: 0,
  }).run();
}

export function builtin(pkgManager: string | null, operation: ScriptOperation): ScriptDefinition {
  const script = getBuiltinScripts().find((entry) =>
    entry.pkgManager === pkgManager && entry.operation === operation
  );
  if (!script) throw new Error(`No built-in ${pkgManager}/${operation} script`);
  return script;
}

/** Copies a built-in script the way the Scripts page does. */
export function copyOf(
  source: ScriptDefinition,
  steps = source.steps,
  extra: Partial<ScriptDefinition> = {},
): ScriptDefinition {
  return createScript({
    name: `Copy of ${source.name}`,
    description: source.description,
    type: source.type,
    operation: source.operation,
    pkgManager: source.pkgManager,
    steps,
    parserConfig: null,
    systemInfoConfig: null,
    sourceScriptId: source.id,
    ...extra,
  });
}

export function useScript(systemId: number, script: ScriptDefinition): void {
  const key = `${script.pkgManager ?? "system"}/${script.operation}`;
  setSystemOverrides(systemId, { [key]: script.id });
}

export function hookScript(
  operation: "pre_upgrade" | "post_upgrade",
  steps: Array<{ label: string; command: string }>,
  extra: Partial<ScriptDefinition> = {},
): ScriptDefinition {
  return createScript({
    name: `${operation} ${steps.map((step) => step.label).join(" ")}`,
    type: "system",
    operation,
    pkgManager: null,
    steps,
    ...extra,
  });
}

export interface StepOutcome {
  label: string | null;
  status: string;
  error: string | null;
}

export interface HistoryOutcome {
  status: string;
  error: string | null;
  steps: StepOutcome[];
}

export function history(systemId: number, action: string): HistoryOutcome[] {
  return getDb()
    .select()
    .from(updateHistory)
    .where(eq(updateHistory.systemId, systemId))
    .all()
    .filter((row) => row.action === action)
    .map((row) => ({
      status: row.status,
      error: row.error ?? null,
      steps: (JSON.parse(row.steps || "[]") as Array<Record<string, unknown>>).map((step) => ({
        label: (step.label as string | null) ?? null,
        status: step.status as string,
        error: (step.error as string | null) ?? null,
      })),
    }));
}

export function apkCheckReplies(simulation: string, overrides: Record<string, Reply> = {}): Harness["run"] {
  return (command) => {
    for (const [needle, reply] of Object.entries(overrides)) {
      if (command.includes(needle)) return reply;
    }
    if (command.includes("apk update")) return { stdout: "OK: 11234 distinct packages available\n" };
    if (command.includes("apk list -u")) return { stdout: APK_PINNED_LIST };
    if (command.includes("cat /etc/apk/world")) {
      return { stdout: `${APK_PINNED_WORLD}\n===LUDASH_APK_WORLD_STATUS:0===\n` };
    }
    if (command.includes("apk upgrade --simulate")) return { stdout: simulation };
    return undefined;
  };
}

export const HEALTHY_APK_SIMULATION = [
  "(1/1) Upgrading zlib (1.3.1-r1 -> 1.3.2-r0)",
  "OK: 11 MiB in 136 packages",
  "===LUDASH_APK_SIMULATION_STATUS:0===",
  "",
].join("\n");

export const BUILTIN_APK_SIMULATION_WARNING =
  "APK upgrade simulation failed (exit code 1). Only exact pins matching installed versions can be detected from /etc/apk/world; dependency-based holds could not be determined. Pins found by earlier checks are kept until detection succeeds. See the step output for details.";
