import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { updateCache, updateHistory } from "../db/schema";
import { getSSHManager, EXIT_MONITORING_LOST, EXIT_FILES_GONE, type PersistentCommandInfo } from "../ssh/connection";
import { getParser, type ParsedUpdate } from "../ssh/parsers";
import type { CheckCommandResult } from "../ssh/parsers/types";
import { sudo } from "../ssh/parsers/types";
import * as cacheService from "./cache-service";
import * as hiddenUpdateService from "./hidden-update-service";
import * as systemService from "./system-service";
import * as outputStream from "./output-stream";
import { logger } from "../logger";
import { sanitizeOutput, sanitizeCommand } from "../utils/sanitize";
import {
  describeUpgradeBehaviors,
  getManagerConfig,
  parsePackageManagerConfigs,
  type PackageManagerConfigs,
} from "../package-manager-configs";
import { getActivityHistoryLimit } from "./settings-service";
import {
  clearActiveOperation,
  getActiveOperation as getStoredActiveOperation,
  getAllActiveOperations as getStoredActiveOperations,
  setActiveOperation,
  type ActiveOperation,
} from "./active-operation-store";
import { requestNotificationRuntimeSystemSync } from "./notification-runtime-events";
import { syncSystemNotificationHash } from "./notification-service";

export function getActiveOperation(systemId: number): ActiveOperation | null {
  return getStoredActiveOperation(systemId);
}

export function getAllActiveOperations(): ReadonlyMap<number, ActiveOperation> {
  return getStoredActiveOperations();
}

export interface LastCheckSummary {
  status: "success" | "warning" | "failed";
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export function getLatestCompletedChecks(systemIds: number[]): Map<number, LastCheckSummary> {
  const uniqueIds = Array.from(
    new Set(systemIds.filter((systemId) => Number.isInteger(systemId) && systemId > 0)),
  );
  if (uniqueIds.length === 0) return new Map();

  const rows = getDb()
    .select({
      systemId: updateHistory.systemId,
      status: updateHistory.status,
      error: updateHistory.error,
      startedAt: updateHistory.startedAt,
      completedAt: updateHistory.completedAt,
      id: updateHistory.id,
    })
    .from(updateHistory)
    .where(
      and(
        inArray(updateHistory.systemId, uniqueIds),
        eq(updateHistory.action, "check"),
        ne(updateHistory.status, "started"),
      ),
    )
    .orderBy(desc(updateHistory.startedAt), desc(updateHistory.id))
    .all();

  const latestChecks = new Map<number, LastCheckSummary>();
  for (const row of rows) {
    if (latestChecks.has(row.systemId)) continue;
    if (row.status !== "success" && row.status !== "warning" && row.status !== "failed") continue;
    latestChecks.set(row.systemId, {
      status: row.status,
      error: row.error,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    });
  }

  return latestChecks;
}

export function getLatestCompletedCheck(systemId: number): LastCheckSummary | null {
  return getLatestCompletedChecks([systemId]).get(systemId) ?? null;
}

export function pruneHistoryForSystem(systemId: number, limit = getActivityHistoryLimit()): void {
  if (!Number.isInteger(systemId) || systemId <= 0 || !Number.isInteger(limit) || limit < 1) {
    return;
  }

  getDb().run(sql`
    DELETE FROM update_history
    WHERE system_id = ${systemId}
      AND id NOT IN (
        SELECT id
        FROM update_history
        WHERE system_id = ${systemId}
        ORDER BY started_at DESC, id DESC
        LIMIT ${limit}
      )
  `);
}

export function pruneHistoryToConfiguredLimit(): void {
  const rows = getDb()
    .select({ systemId: updateHistory.systemId })
    .from(updateHistory)
    .groupBy(updateHistory.systemId)
    .all();

  const limit = getActivityHistoryLimit();
  for (const row of rows) {
    pruneHistoryForSystem(row.systemId, limit);
  }
}

// Per-system locks using a simple promise-based mutex
const systemLocks = new Map<number, Promise<void>>();

async function withLock<T>(
  systemId: number,
  fn: () => Promise<T>
): Promise<T> {
  // Wait for any existing lock
  while (systemLocks.has(systemId)) {
    await systemLocks.get(systemId);
  }

  let resolve: () => void;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  systemLocks.set(systemId, lock);

  try {
    return await fn();
  } finally {
    systemLocks.delete(systemId);
    resolve!();
  }
}

// Reconnection settings for when SSH drops during an upgrade
const RECONNECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const RECONNECT_INTERVAL_MS = 15 * 1000;     // retry every 15 seconds

interface ReconnectionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  serverRebooted: boolean;
}

export type ActivityStepStatus = "success" | "warning" | "failed" | "started";

export interface ActivityStep {
  label: string | null;
  pkgManager: string;
  command: string;
  output: string | null;
  error: string | null;
  status: ActivityStepStatus;
  startedAt?: string | null;
  completedAt?: string | null;
}

const STEP_OUTPUT_LIMIT = 5000;
const STEP_ERROR_LIMIT = 2000;

function getCurrentTimestamp(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function trimSanitizedOutput(value: string | null | undefined, limit: number): string | null {
  if (!value) return null;
  const sanitized = sanitizeOutput(value).slice(0, limit);
  return sanitized || null;
}

function serializeActivitySteps(steps: ActivityStep[] | undefined): string | null {
  if (!steps?.length) return null;
  return JSON.stringify(
    steps.map((step) => ({
      label: step.label ?? null,
      pkgManager: step.pkgManager,
      command: sanitizeCommand(step.command),
      output: trimSanitizedOutput(step.output, STEP_OUTPUT_LIMIT),
      error: trimSanitizedOutput(step.error, STEP_ERROR_LIMIT),
      status: step.status,
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
    }))
  );
}

function createActivityStep(step: ActivityStep): ActivityStep {
  return {
    label: step.label ?? null,
    pkgManager: step.pkgManager,
    command: step.command,
    output: step.output ?? null,
    error: step.error ?? null,
    status: step.status,
    startedAt: step.startedAt ?? null,
    completedAt: step.completedAt ?? null,
  };
}

function createSingleStepHistory(step: ActivityStep): ActivityStep[] {
  return [createActivityStep(step)];
}

function getSystemPackageManagerConfigs(system: {
  pkgManagerConfigs?: string | null;
}): PackageManagerConfigs | null {
  return parsePackageManagerConfigs(system.pkgManagerConfigs ?? null);
}

export function getConfiguredUpgradeBehaviorDescriptions(systemId: number): string[] {
  const system = systemService.getSystem(systemId);
  if (!system) return [];
  const pkgManagers = systemService.getActivePkgManagers(system);
  return describeUpgradeBehaviors(pkgManagers, getSystemPackageManagerConfigs(system));
}

/**
 * When SSH monitoring is lost during an upgrade (e.g. server rebooted),
 * attempt to reconnect and determine the actual result.
 */
async function attemptReconnection(
  systemId: number,
  persistentInfo: PersistentCommandInfo,
  preUpgradeUpdateCount: number,
  onData: (chunk: string, stream: "stdout" | "stderr") => void,
): Promise<ReconnectionResult> {
  const system = systemService.getSystem(systemId);
  if (!system) {
    return { exitCode: -1, stdout: "", stderr: "System not found during reconnection", serverRebooted: false };
  }

  const sshManager = getSSHManager();

  outputStream.publish(systemId, {
    type: "warning",
    message: "SSH connection lost. Attempting to reconnect...",
  });
  outputStream.publish(systemId, { type: "phase", phase: "reconnecting" });

  const startTime = Date.now();
  let attempt = 0;
  const maxAttempts = Math.ceil(RECONNECT_TIMEOUT_MS / RECONNECT_INTERVAL_MS);

  while (Date.now() - startTime < RECONNECT_TIMEOUT_MS) {
    attempt++;
    await new Promise((r) => setTimeout(r, RECONNECT_INTERVAL_MS));

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    outputStream.publish(systemId, {
      type: "output",
      data: `Reconnection attempt ${attempt}/${maxAttempts}... (${elapsed}s elapsed)\n`,
      stream: "stderr",
    });

    let conn;
    try {
      conn = await sshManager.connect(system as Record<string, unknown>, {
        systemId,
      });
    } catch {
      // Connection failed — server still down, keep retrying
      continue;
    }

    try {
      const result = await sshManager.resumePersistentCommand(
        conn,
        persistentInfo,
        3600,
        onData,
      );

      if (result.exitCode === EXIT_FILES_GONE) {
        // Server rebooted — /tmp was cleared. Infer result from update count.
        outputStream.publish(systemId, {
          type: "warning",
          message: "Server appears to have rebooted (temp files cleared). Checking upgrade result...",
        });

        sshManager.disconnect(conn);
        conn = null;

        // Run a fresh update check to see what's still pending.
        // The server may not be fully ready yet (SSH accepts connections
        // before all services are up), so retry a few times.
        const CHECK_RETRIES = 3;
        const CHECK_RETRY_DELAY_MS = 10_000;
        let checkSucceeded = false;

        for (let i = 0; i < CHECK_RETRIES; i++) {
          if (i > 0) {
            outputStream.publish(systemId, {
              type: "output",
              data: `Update check failed, retrying in ${CHECK_RETRY_DELAY_MS / 1000}s...\n`,
              stream: "stderr",
            });
            await new Promise((r) => setTimeout(r, CHECK_RETRY_DELAY_MS));
          }
          await checkUpdatesUnlocked(systemId, true);
          // checkUpdatesUnlocked sets isReachable=1 on success, -1 on failure
          const updated = systemService.getSystem(systemId);
          if (updated?.isReachable === 1) {
            checkSucceeded = true;
            break;
          }
        }

        if (!checkSucceeded) {
          outputStream.publish(systemId, {
            type: "warning",
            message: "Could not verify upgrade result — update check failed after reconnection.",
          });
          return {
            exitCode: -1,
            stdout: "",
            stderr: "Could not verify upgrade result after reconnection",
            serverRebooted: true,
          };
        }

        const db = getDb();
        const newCount = db
          .select()
          .from(updateCache)
          .where(eq(updateCache.systemId, systemId))
          .all().length;

        const success = newCount < preUpgradeUpdateCount;
        const message = success
          ? `Server rebooted during upgrade. Post-reboot check: ${preUpgradeUpdateCount} updates before, ${newCount} after. Upgrade appears successful.`
          : `Server rebooted during upgrade. Post-reboot check: ${preUpgradeUpdateCount} updates before, ${newCount} after. Upgrade may not have completed.`;

        outputStream.publish(systemId, {
          type: "warning",
          message,
        });

        return {
          exitCode: success ? 0 : -1,
          stdout: message,
          stderr: success ? "" : message,
          serverRebooted: true,
        };
      }

      // Files existed — we got an actual result
      sshManager.disconnect(conn);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        serverRebooted: false,
      };
    } catch (e) {
      if (conn) {
        try { sshManager.disconnect(conn); } catch {}
      }
      // Reconnected but something failed — keep retrying
      continue;
    }
  }

  // Timeout — could not reconnect
  outputStream.publish(systemId, {
    type: "warning",
    message: `Reconnection timed out after ${Math.round(RECONNECT_TIMEOUT_MS / 1000)}s. The upgrade process may still be running on the remote system.`,
  });

  return {
    exitCode: -1,
    stdout: "",
    stderr: `Reconnection timed out after ${Math.round(RECONNECT_TIMEOUT_MS / 1000)}s`,
    serverRebooted: false,
  };
}

function storeUpdates(systemId: number, updates: ParsedUpdate[]): void {
  if (!updates.length) return;
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  for (const u of updates) {
    db.insert(updateCache)
      .values({
        systemId,
        pkgManager: u.pkgManager,
        packageName: u.packageName,
        currentVersion: u.currentVersion,
        newVersion: u.newVersion ?? "",
        architecture: u.architecture,
        repository: u.repository,
        isSecurity: u.isSecurity ? 1 : 0,
        isKeptBack: u.isKeptBack ? 1 : 0,
        cachedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          updateCache.systemId,
          updateCache.pkgManager,
          updateCache.packageName,
        ],
        set: {
          currentVersion: u.currentVersion,
          newVersion: u.newVersion ?? "",
          architecture: u.architecture,
          repository: u.repository,
          isSecurity: u.isSecurity ? 1 : 0,
          isKeptBack: u.isKeptBack ? 1 : 0,
          cachedAt: now,
        },
      })
      .run();
  }
}

function logHistory(
  systemId: number,
  action: string,
  pkgManager: string,
  status: string,
  opts?: {
    packageCount?: number;
    packages?: string;
    command?: string;
    steps?: ActivityStep[];
    output?: string;
    error?: string;
    startedAt?: string;
    completedAt?: string;
  }
): void {
  const db = getDb();
  const now = getCurrentTimestamp();
  const inferredStartedAt =
    opts?.startedAt ??
    opts?.steps?.find((step) => !!step.startedAt)?.startedAt ??
    getStoredActiveOperation(systemId)?.startedAt ??
    now;
  const completedAt =
    opts?.completedAt ??
    (status === "success" || status === "failed" || status === "warning" ? now : null);

  db.insert(updateHistory)
    .values({
      systemId,
      action,
      pkgManager,
      status,
      packageCount: opts?.packageCount ?? null,
      packages: opts?.packages ?? null,
      command: opts?.command ? sanitizeCommand(opts.command) : null,
      steps: serializeActivitySteps(opts?.steps),
      output: opts?.output ? sanitizeOutput(opts.output) : null,
      error: opts?.error ? sanitizeOutput(opts.error) : null,
      startedAt: inferredStartedAt,
      completedAt,
    })
    .run();

  pruneHistoryForSystem(systemId);
}

/** Insert a "started" history row and return its ID. */
function insertStartedEntry(
  systemId: number,
  action: string,
  pkgManager: string,
  command: string,
  startedAt = getCurrentTimestamp()
): number {
  const db = getDb();
  const result = db
    .insert(updateHistory)
    .values({
      systemId,
      action,
      pkgManager,
      status: "started",
      command: sanitizeCommand(command),
      startedAt,
      completedAt: null,
    })
    .returning({ id: updateHistory.id })
    .get();
  pruneHistoryForSystem(systemId);
  return result.id;
}

/** Update an existing history row to its final status. */
function finishEntry(
  id: number,
  status: "success" | "failed" | "warning",
  opts?: {
    packageCount?: number;
    packages?: string;
    steps?: ActivityStep[];
    output?: string;
    error?: string;
  }
): void {
  const db = getDb();
  const now = getCurrentTimestamp();
  db.update(updateHistory)
    .set({
      status,
      packageCount: opts?.packageCount ?? null,
      packages: opts?.packages ?? null,
      steps: serializeActivitySteps(opts?.steps),
      output: opts?.output ? sanitizeOutput(opts.output) : null,
      error: opts?.error ? sanitizeOutput(opts.error) : null,
      completedAt: now,
    })
    .where(eq(updateHistory.id, id))
    .run();
}

async function checkUpdatesUnlocked(
  systemId: number,
  silent = false
): Promise<ParsedUpdate[]> {
  const pub = silent
    ? (_msg: outputStream.WsMessage) => {}
    : (msg: outputStream.WsMessage) => outputStream.publish(systemId, msg);

  const system = systemService.getSystem(systemId);
  if (!system) return [];
  const pkgManagerConfigs = getSystemPackageManagerConfigs(system);

  const sshManager = getSSHManager();
  const allUpdates: ParsedUpdate[] = [];
  const allCommands: string[] = [];
  const allSteps: ActivityStep[] = [];
  const checkErrors: string[] = [];
  let checkOutput = "";
  let successfulChecks = 0;
  const successfulPkgManagers: string[] = [];

  let conn;
  let pkgManagers: string[] = [];
  try {
    conn = await sshManager.connect(system as Record<string, unknown>, {
      systemId,
    });

    // Update system info
    await systemService.updateSystemInfo(
      systemId,
      sshManager,
      conn
    );

    // Detect package managers if not yet detected
    if (!system.detectedPkgManagers) {
      await systemService.detectAndStorePkgManager(systemId, sshManager, conn);
      // Re-read system to get updated detected list
      const updated = systemService.getSystem(systemId);
      if (updated) {
        pkgManagers = systemService.getActivePkgManagers(updated);
      }
    } else {
      pkgManagers = systemService.getActivePkgManagers(system);
    }

    if (!pkgManagers.length) return [];

    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);

    // Run check for each package manager

    for (const pmName of pkgManagers) {
      try {
        const parser = getParser(pmName);
        if (!parser) continue;

        const managerConfig = getManagerConfig(pkgManagerConfigs, pmName);
        const commands = parser.getCheckCommands(managerConfig);
        const labels = parser.getCheckCommandLabels?.(managerConfig) ?? [];
        allCommands.push(...commands);
        let lastStdout = "";
        let lastStderr = "";
        let lastExitCode = 0;
        const commandResults: CheckCommandResult[] = [];

        for (let i = 0; i < commands.length; i++) {
          const label = labels[i] ?? `Step ${i + 1}`;
          let streamedOutput = "";
          const stepStartedAt = getCurrentTimestamp();
          pub({ type: "started", command: commands[i], pkgManager: pmName, startedAt: stepStartedAt });
          pub({ type: "phase", phase: label });
          const result = await sshManager.runCommand(
            conn,
            commands[i],
            undefined,
            sudoPassword,
            (chunk, stream) => {
              streamedOutput += chunk;
              pub({ type: "output", data: chunk, stream });
            }
          );
          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || `${result.stdout}${result.stderr}`;
          const parserReportedError =
            parser.getCheckErrorMessage?.(result.stdout, result.stderr, result.exitCode) ?? null;
          const checkErrorMessage =
            parserReportedError
            || (result.exitCode !== 0
              ? result.stderr
                || result.stdout
                || combinedOutput
                || `Command exited with code ${result.exitCode}`
              : null);
          const commandFailed = result.exitCode !== 0 || checkErrorMessage !== null;
          checkOutput += combinedOutput;
          lastStdout = result.stdout;
          lastStderr = result.stderr;
          lastExitCode = result.exitCode;
          commandResults.push({
            command: commands[i],
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
          allSteps.push(
            createActivityStep({
              label,
              pkgManager: pmName,
              command: commands[i],
              output: combinedOutput,
              error: checkErrorMessage,
              status: commandFailed ? "failed" : "success",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            })
          );

          if (commandFailed) {
            throw new Error(
              checkErrorMessage
              || `Command exited with code ${result.exitCode}`
            );
          }
        }

        let updates = parser.parseCheckOutput(lastStdout, lastStderr, lastExitCode, {
          commandResults,
        });
        allUpdates.push(...updates);
        successfulChecks++;
        successfulPkgManagers.push(pmName);
      } catch (e) {
        const errorText = e instanceof Error ? e.message : String(e);
        checkErrors.push(`[${pmName}] ${errorText}`);
        logger.warn("System update check failed", {
          systemId,
          pkgManager: pmName,
          error: sanitizeOutput(errorText),
        });
        pub({ type: "error", message: errorText });
      }
    }
  } catch (e) {
    logger.warn("System SSH connection failed during update check", {
      systemId,
      error: sanitizeOutput(String(e)),
    });
    systemService.markUnreachable(systemId);
    pub({ type: "done", success: false, completedAt: getCurrentTimestamp() });
    if (!silent) {
      logHistory(systemId, "check", system.pkgManager || "unknown", "failed", {
        error: String(e),
      });
    }
    return [];
  } finally {
    if (conn) sshManager.disconnect(conn);
  }

  // Store in cache
  cacheService.invalidateCache(systemId);
  storeUpdates(systemId, allUpdates);
  if (successfulChecks > 0) {
    hiddenUpdateService.syncHiddenUpdatesForCheck(
      systemId,
      allUpdates,
      successfulPkgManagers,
    );
    hiddenUpdateService.autoHideKeptBackUpdatesForCheck(
      systemId,
      allUpdates,
      successfulPkgManagers,
    );
  }
  const visibleSummary =
    successfulChecks > 0
      ? hiddenUpdateService.getVisibleUpdateSummary(systemId)
      : { updateCount: 0, securityCount: 0, keptBackCount: 0 };

  const historyStatus =
    checkErrors.length === 0
      ? "success"
      : successfulChecks > 0
        ? "warning"
        : "failed";
  const combinedErrors =
    checkErrors.length > 0 ? checkErrors.join("\n\n") : undefined;

  // Log history (skip when silent — e.g. called from reconnection context)
  if (!silent) {
    logHistory(
      systemId,
      "check",
      allUpdates.length > 0
        ? [...new Set(allUpdates.map((u) => u.pkgManager))].join(",")
        : pkgManagers.join(","),
      historyStatus,
      {
        packageCount: visibleSummary.updateCount,
        command: allCommands.join(" && "),
        steps: allSteps,
        output: checkOutput.slice(0, 5000) || undefined,
        error: combinedErrors?.slice(0, 2000),
      }
    );
    pub({ type: "done", success: historyStatus === "success", completedAt: getCurrentTimestamp() });
  }

  if (!silent && successfulChecks === 0 && combinedErrors) {
    throw new Error(combinedErrors);
  }

  return allUpdates;
}

export async function checkUpdates(
  systemId: number
): Promise<ParsedUpdate[]> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "check", startedAt: now });
    outputStream.resetStream(systemId);
    try {
      return await checkUpdatesUnlocked(systemId);
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

export async function applyUpgradeAll(
  systemId: number
): Promise<{ success: boolean; output: string; warning?: boolean }> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "upgrade_all", startedAt: now });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }
    const pkgManagerConfigs = getSystemPackageManagerConfigs(system);

    // Collect all distinct package managers from the cached updates
    const db = getDb();
    const cachedManagers = db
      .selectDistinct({ pkgManager: updateCache.pkgManager })
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all()
      .map((r) => r.pkgManager);

    // Fall back to stored primary manager if cache is empty
    const pkgManagers =
      cachedManagers.length > 0
        ? cachedManagers
        : system.pkgManager
          ? [system.pkgManager]
          : [];

    if (!pkgManagers.length) {
      return { success: false, output: "No package manager detected" };
    }

    const allCommands: string[] = [];
    const allOutputs: string[] = [];
    let overallSuccess = true;
    let reconnectionUsed = false;

    const sshManager = getSSHManager();
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    try {
      conn = await sshManager.connect(system as Record<string, unknown>, {
        systemId,
      });

      for (const pmName of pkgManagers) {
        const parser = getParser(pmName);
        if (!parser) continue;

        const cmd = parser.getUpgradeAllCommand(getManagerConfig(pkgManagerConfigs, pmName));
        allCommands.push(cmd);
        const stepStartedAt = getCurrentTimestamp();
        const histId = insertStartedEntry(systemId, "upgrade_all", pmName, cmd, stepStartedAt);
        outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName, startedAt: stepStartedAt });
        let streamedOutput = "";

        const onDataCb = (chunk: string, stream: "stdout" | "stderr") => {
          streamedOutput += chunk;
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        };

        const result = await sshManager.runPersistentCommand(
          conn!,
          cmd,
          3600,
          sudoPassword,
          onDataCb,
        );

        let { stdout, stderr, exitCode } = result;

        if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
          // Connection lost — attempt reconnection
          try { sshManager.disconnect(conn!); } catch {}
          conn = undefined;

          const preCount = db
            .select()
            .from(updateCache)
            .where(eq(updateCache.systemId, systemId))
            .all().length;

          const reconResult = await attemptReconnection(
            systemId,
            result.persistentInfo,
            preCount,
            onDataCb,
          );

          stdout = reconResult.stdout || stdout;
          stderr = reconResult.stderr;
          exitCode = reconResult.exitCode;
          reconnectionUsed = true;
        }

        const success = exitCode === 0;
        if (!success) overallSuccess = false;
        const stepCompletedAt = getCurrentTimestamp();
        const combinedOutput = streamedOutput || stdout || stderr;
        allOutputs.push(`[${pmName}] ${success ? stdout : stderr || stdout}`);

        const histStatus = reconnectionUsed && success ? "warning" : success ? "success" : "failed";
        finishEntry(histId, histStatus, {
          steps: createSingleStepHistory({
            label: null,
            pkgManager: pmName,
            command: cmd,
            output: combinedOutput,
            error: success ? null : stderr || stdout || combinedOutput,
            status: histStatus,
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }),
          output: stdout.slice(0, STEP_OUTPUT_LIMIT),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        });

        // If connection was lost, can't continue with remaining package managers
        if (reconnectionUsed) break;
      }

      // Re-check after upgrade (skip if reconnection already ran one)
      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      if (!reconnectionUsed) {
        outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
        await checkUpdatesUnlocked(systemId, true);
      }
      syncSystemNotificationHash(systemId);

      const combinedOutput = allOutputs.join("\n\n");
      outputStream.publish(systemId, { type: "done", success: overallSuccess, completedAt: getCurrentTimestamp() });
      return { success: overallSuccess, output: combinedOutput, warning: reconnectionUsed && overallSuccess };
    } catch (e) {
      logHistory(
        systemId,
        "upgrade_all",
        pkgManagers.join(","),
        "failed",
        {
          command: allCommands.join(" && "),
          steps: allCommands.length
            ? createSingleStepHistory({
                label: null,
                pkgManager: pkgManagers[0] || "unknown",
                command: allCommands[allCommands.length - 1] || allCommands[0],
                output: null,
                error: String(e),
                status: "failed",
              })
            : undefined,
          error: String(e),
        }
      );
      outputStream.publish(systemId, { type: "error", message: String(e) });
      outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
    }
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

export function supportsFullUpgrade(systemId: number): boolean {
  const system = systemService.getSystem(systemId);
  if (!system) return false;
  const pkgManagerConfigs = getSystemPackageManagerConfigs(system);
  const pkgManagers = systemService.getActivePkgManagers(system);
  return pkgManagers.some((pmName) => {
    const parser = getParser(pmName);
    return parser?.getFullUpgradeAllCommand(getManagerConfig(pkgManagerConfigs, pmName)) != null;
  });
}

export async function applyFullUpgradeAll(
  systemId: number
): Promise<{ success: boolean; output: string; warning?: boolean }> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "full_upgrade_all", startedAt: now });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }
    const pkgManagerConfigs = getSystemPackageManagerConfigs(system);

    const db = getDb();
    const cachedManagers = db
      .selectDistinct({ pkgManager: updateCache.pkgManager })
      .from(updateCache)
      .where(eq(updateCache.systemId, systemId))
      .all()
      .map((r) => r.pkgManager);

    const pkgManagers =
      cachedManagers.length > 0
        ? cachedManagers
        : system.pkgManager
          ? [system.pkgManager]
          : [];

    if (!pkgManagers.length) {
      return { success: false, output: "No package manager detected" };
    }

    const allCommands: string[] = [];
    const allOutputs: string[] = [];
    let overallSuccess = true;
    let reconnectionUsed = false;

    const sshManager = getSSHManager();
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    try {
      conn = await sshManager.connect(system as Record<string, unknown>, {
        systemId,
      });

      for (const pmName of pkgManagers) {
        const parser = getParser(pmName);
        if (!parser) continue;

        const managerConfig = getManagerConfig(pkgManagerConfigs, pmName);
        const cmd = parser.getFullUpgradeAllCommand(managerConfig) ?? parser.getUpgradeAllCommand(managerConfig);
        allCommands.push(cmd);
        const stepStartedAt = getCurrentTimestamp();
        const histId = insertStartedEntry(systemId, "full_upgrade_all", pmName, cmd, stepStartedAt);
        outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName, startedAt: stepStartedAt });
        let streamedOutput = "";

        const onDataCb = (chunk: string, stream: "stdout" | "stderr") => {
          streamedOutput += chunk;
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        };

        const result = await sshManager.runPersistentCommand(
          conn!,
          cmd,
          3600,
          sudoPassword,
          onDataCb,
        );

        let { stdout, stderr, exitCode } = result;

        if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
          try { sshManager.disconnect(conn!); } catch {}
          conn = undefined;

          const preCount = db
            .select()
            .from(updateCache)
            .where(eq(updateCache.systemId, systemId))
            .all().length;

          const reconResult = await attemptReconnection(
            systemId,
            result.persistentInfo,
            preCount,
            onDataCb,
          );

          stdout = reconResult.stdout || stdout;
          stderr = reconResult.stderr;
          exitCode = reconResult.exitCode;
          reconnectionUsed = true;
        }

        const success = exitCode === 0;
        if (!success) overallSuccess = false;
        const stepCompletedAt = getCurrentTimestamp();
        const combinedOutput = streamedOutput || stdout || stderr;
        allOutputs.push(`[${pmName}] ${success ? stdout : stderr || stdout}`);

        const histStatus = reconnectionUsed && success ? "warning" : success ? "success" : "failed";
        finishEntry(histId, histStatus, {
          steps: createSingleStepHistory({
            label: null,
            pkgManager: pmName,
            command: cmd,
            output: combinedOutput,
            error: success ? null : stderr || stdout || combinedOutput,
            status: histStatus,
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }),
          output: stdout.slice(0, STEP_OUTPUT_LIMIT),
          error: success ? undefined : (stderr || stdout).slice(0, 2000),
        });

        // If connection was lost, can't continue with remaining package managers
        if (reconnectionUsed) break;
      }

      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      if (!reconnectionUsed) {
        outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
        await checkUpdatesUnlocked(systemId, true);
      }
      syncSystemNotificationHash(systemId);

      const combinedOutput = allOutputs.join("\n\n");
      outputStream.publish(systemId, { type: "done", success: overallSuccess, completedAt: getCurrentTimestamp() });
      return { success: overallSuccess, output: combinedOutput, warning: reconnectionUsed && overallSuccess };
    } catch (e) {
      logHistory(
        systemId,
        "full_upgrade_all",
        pkgManagers.join(","),
        "failed",
        {
          command: allCommands.join(" && "),
          steps: allCommands.length
            ? createSingleStepHistory({
                label: null,
                pkgManager: pkgManagers[0] || "unknown",
                command: allCommands[allCommands.length - 1] || allCommands[0],
                output: null,
                error: String(e),
                status: "failed",
              })
            : undefined,
          error: String(e),
        }
      );
      outputStream.publish(systemId, { type: "error", message: String(e) });
      outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
    }
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

export async function applyUpgradePackage(
  systemId: number,
  packageName: string
): Promise<{ success: boolean; output: string; warning?: boolean }> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "upgrade_package", startedAt: now, packageName });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }

    // Look up the package manager from the cache for this specific package
    const db = getDb();
    const cached = db
      .select({ pkgManager: updateCache.pkgManager })
      .from(updateCache)
      .where(
        sql`${updateCache.systemId} = ${systemId} AND ${updateCache.packageName} = ${packageName}`
      )
      .get();

    const pmName = cached?.pkgManager || system.pkgManager;
    if (!pmName) {
      return { success: false, output: "No package manager detected" };
    }

    const parser = getParser(pmName);
    if (!parser) return { success: false, output: "Unknown package manager" };

    const cmd = parser.getUpgradePackageCommand(packageName);
    const sshManager = getSSHManager();
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    let reconnectionUsed = false;

    const stepStartedAt = getCurrentTimestamp();
    const histId = insertStartedEntry(systemId, "upgrade_package", pmName, cmd, stepStartedAt);
    outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName, startedAt: stepStartedAt });

    try {
      conn = await sshManager.connect(system as Record<string, unknown>, {
        systemId,
      });
      let streamedOutput = "";
      const onDataCb = (chunk: string, stream: "stdout" | "stderr") => {
        streamedOutput += chunk;
        outputStream.publish(systemId, { type: "output", data: chunk, stream });
      };

      const result = await sshManager.runPersistentCommand(
        conn,
        cmd,
        300,
        sudoPassword,
        onDataCb,
      );

      let { stdout, stderr, exitCode } = result;

      if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
        try { sshManager.disconnect(conn); } catch {}
        conn = null;

        // For single package, pre-upgrade count is 1
        const reconResult = await attemptReconnection(
          systemId,
          result.persistentInfo,
          1,
          onDataCb,
        );

        stdout = reconResult.stdout || stdout;
        stderr = reconResult.stderr;
        exitCode = reconResult.exitCode;
        reconnectionUsed = true;
      }

      const success = exitCode === 0;
      const histStatus = reconnectionUsed && success ? "warning" : success ? "success" : "failed";
      const stepCompletedAt = getCurrentTimestamp();
      finishEntry(histId, histStatus, {
        packageCount: 1,
        packages: JSON.stringify([packageName]),
        steps: createSingleStepHistory({
          label: null,
          pkgManager: pmName,
          command: cmd,
          output: streamedOutput || stdout || stderr,
          error: success ? null : stderr || stdout || streamedOutput,
          status: histStatus,
          startedAt: stepStartedAt,
          completedAt: stepCompletedAt,
        }),
        output: stdout.slice(0, STEP_OUTPUT_LIMIT),
        error: success ? undefined : (stderr || stdout).slice(0, 2000),
      });

      // Always re-check after upgrade to reflect the actual package state,
      // even if the upgrade reported a non-zero exit code (e.g. flatpak in
      // Docker reports exit 1 due to cross-device hardlink errors despite the
      // update succeeding).
      if (conn) {
        sshManager.disconnect(conn);
        conn = null;
      }
      if (!reconnectionUsed) {
        outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
        await checkUpdatesUnlocked(systemId, true);
      }
      syncSystemNotificationHash(systemId);

      outputStream.publish(systemId, { type: "done", success, completedAt: getCurrentTimestamp() });
      return { success, output: success ? stdout : stderr || stdout, warning: reconnectionUsed && success };
    } catch (e) {
      finishEntry(histId, "failed", {
        steps: createSingleStepHistory({
          label: null,
          pkgManager: pmName,
          command: cmd,
          output: null,
          error: String(e),
          status: "failed",
        }),
        error: String(e),
      });
      outputStream.publish(systemId, { type: "error", message: String(e) });
      outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
      return { success: false, output: String(e) };
    } finally {
      if (conn) sshManager.disconnect(conn);
    }
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

export async function rebootSystem(
  systemId: number
): Promise<{ success: boolean; message: string }> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "reboot", startedAt: now });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
      const system = systemService.getSystem(systemId);
      if (!system) return { success: false, message: "System not found" };

      const sshManager = getSSHManager();
      const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
      const cmd = sudo("reboot");
      const stepStartedAt = getCurrentTimestamp();
      const histId = insertStartedEntry(systemId, "reboot", "system", cmd, stepStartedAt);
      outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: "system", startedAt: stepStartedAt });

      let conn;
      try {
        conn = await sshManager.connect(system as Record<string, unknown>, {
          systemId,
        });
        let streamedOutput = "";
        const result = await sshManager.runCommand(conn, cmd, 30, sudoPassword, (chunk, stream) => {
          streamedOutput += chunk;
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        });
        const stepCompletedAt = getCurrentTimestamp();

        if (result.exitCode !== 0) {
          const errorText = result.stderr || result.stdout || `reboot exited with code ${result.exitCode}`;
          finishEntry(histId, "failed", {
            steps: createSingleStepHistory({
              label: null,
              pkgManager: "system",
              command: cmd,
              output: streamedOutput || result.stdout || result.stderr,
              error: errorText,
              status: "failed",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }),
            error: errorText,
          });
          outputStream.publish(systemId, { type: "error", message: errorText });
          outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
          return { success: false, message: `Reboot failed: ${errorText}` };
        }

        // Reboot succeeded or the connection was dropped (expected)
        systemService.markUnreachable(systemId);
        finishEntry(histId, "success", {
          steps: createSingleStepHistory({
            label: null,
            pkgManager: "system",
            command: cmd,
            output: streamedOutput || result.stdout || "Reboot command sent",
            error: null,
            status: "success",
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }),
          output: result.stdout || "Reboot command sent",
        });
        outputStream.publish(systemId, { type: "done", success: true, completedAt: getCurrentTimestamp() });
        return { success: true, message: "Reboot command sent" };
      } catch (e) {
        const errMsg = String(e);
        const stepCompletedAt = getCurrentTimestamp();
        // A closed connection after reboot is expected
        if (errMsg.includes("ECONNRESET") || errMsg.includes("closed") || errMsg.includes("end")) {
          systemService.markUnreachable(systemId);
          finishEntry(histId, "success", {
            steps: createSingleStepHistory({
              label: null,
              pkgManager: "system",
              command: cmd,
              output: "Reboot command sent (connection closed)",
              error: null,
              status: "success",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }),
            output: "Reboot command sent (connection closed)",
          });
          outputStream.publish(systemId, { type: "done", success: true, completedAt: getCurrentTimestamp() });
          return { success: true, message: "Reboot command sent" };
        }
        finishEntry(histId, "failed", {
          steps: createSingleStepHistory({
            label: null,
            pkgManager: "system",
            command: cmd,
            output: null,
            error: errMsg,
            status: "failed",
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }),
          error: errMsg,
        });
        outputStream.publish(systemId, { type: "error", message: errMsg });
        outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
        return { success: false, message: `Reboot failed: ${errMsg}` };
      } finally {
        if (conn) {
          try { sshManager.disconnect(conn); } catch {}
        }
      }
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

export async function checkAllSystems(): Promise<void> {
  const allSystems = systemService.listSystems();
  await Promise.allSettled(allSystems.map((s) => checkUpdates(s.id)));
}

export function getHistory(systemId: number, limit = 50) {
  const db = getDb();
  return db
    .select()
    .from(updateHistory)
    .where(eq(updateHistory.systemId, systemId))
    .orderBy(desc(updateHistory.startedAt), desc(updateHistory.id))
    .limit(limit)
    .all();
}
