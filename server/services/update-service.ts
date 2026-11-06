import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { updateCache, updateHistory } from "../db/schema";
import {
  getSSHManager,
  EXIT_MONITORING_LOST,
  EXIT_FILES_GONE,
  EXIT_CANCELLED,
  type PersistentCommandInfo,
  type PersistentCommandResult,
} from "../ssh/connection";
import { getParser, type ParsedUpdate } from "../ssh/parsers";
import type { CheckCommandResult } from "../ssh/parsers/types";
import { sudo, validatePackageName } from "../ssh/parsers/types";
import { getDnfLikeEulaPromptMessage, hasDnfLikeEulaPrompt } from "../ssh/parsers/dnf";
import * as cacheService from "./cache-service";
import * as hiddenUpdateService from "./hidden-update-service";
import { reconcileKnownPins } from "./known-pin-service";
import * as installedPackageService from "./installed-package-service";
import * as packageIssueService from "./package-manager-issue-service";
import * as systemService from "./system-service";
import * as outputStream from "./output-stream";
import { logger } from "../logger";
import { sanitizeOutput, sanitizeCommand } from "../utils/sanitize";
import { resolveSecretInput, withSecretEnvNote } from "./package-manager-secret-service";
import { applyPackageOwnershipClaims } from "./package-ownership";
import type { SecretInput } from "../ssh/secret-input";
import {
  describeUpgradeBehaviors,
  getManagerConfig,
  parsePackageManagerConfigs,
  type PackageManagerConfigs,
} from "../package-manager-configs";
import { getActivityHistoryLimit } from "./settings-service";
import { isPinnedUpdate } from "../../shared/pinned-updates";
import {
  clearActiveOperation,
  cancelActiveOperation as requestActiveOperationCancellation,
  getActiveOperation as getStoredActiveOperation,
  getAllActiveOperations as getStoredActiveOperations,
  getActiveOperationSignal,
  isOperationCancelledError,
  setActiveOperation,
  throwIfActiveOperationCancelled,
  OperationCancelledError,
  renewActiveOperationSignal,
  type ActiveOperation,
} from "./active-operation-store";
import { requestNotificationRuntimeSystemSync } from "./notification-runtime-events";
import { processRebootRequiredResult, syncSystemNotificationHash } from "./notification-service";
import {
  buildMaintenanceCommand,
  getCustomCheckErrorMessage,
  isCustomPackageManager,
  listPackageManagerDefinitions,
  parseUpdatesWithScript,
  parseInstalledPackagesWithScript,
  resolveRuntimeSteps,
  resolveScript,
  type RuntimeScriptStep,
} from "./script-service";
import type { OutputRuleMatch } from "../../shared/output-rules";
import { OUTPUT_RULE_REGEX_TIMEOUT_MS, evaluateOutputRulesBounded } from "./output-rule-regex";

type VisibleCachedUpdate = ReturnType<typeof hiddenUpdateService.getVisibleCachedUpdates>[number];
export type DefaultUpgradeModeOverride = "standard" | "aggressive";
type OperationResult = {
  success: boolean;
  output: string;
  warning?: boolean;
  cancelled?: boolean;
  /** A pre- or post-upgrade script failed, so later systems in a rolling upgrade should wait. */
  hookFailed?: boolean;
};
type RebootResult = { success: boolean; message: string; blocked?: boolean };

export interface UpgradeAllCommandSnapshot {
  systemId: number;
  pkgManagers: string[];
  command: string | null;
  pkgManager: string;
  commands: Array<{ pkgManager: string; command: string }>;
}

interface QueuedUpgradeResumeState {
  historyId: number;
  pkgManager: string;
  command: string;
  persistentInfo: PersistentCommandInfo;
  preUpgradeUpdateCount: number;
}

interface UpgradeAllExecutionOptions {
  defaultUpgradeModeOverride?: DefaultUpgradeModeOverride;
  queuedHistoryId?: number;
  resume?: QueuedUpgradeResumeState;
  onStepStarted?: (input: {
    historyId: number;
    pkgManager: string;
    command: string;
    preUpgradeUpdateCount: number;
  }) => void;
  onPersistentInfo?: (input: {
    historyId: number;
    pkgManager: string;
    command: string;
    info: PersistentCommandInfo;
  }) => void;
  /** Continues a pre- or post-upgrade script that a dashboard restart interrupted. */
  resumeHook?: UpgradeHookProgress;
  /**
   * Warnings of a pre-upgrade script that finished before a restart interrupted the
   * upgrade itself, so the resumed upgrade still reports them.
   */
  preUpgradeWarnings?: string[];
  onHookProgress?: (progress: UpgradeHookProgress) => void;
}

/**
 * Enough to pick a script up again after a dashboard restart. The steps are a
 * snapshot, so editing the script in between cannot shift the step position.
 */
interface UpgradeHookProgressBase {
  steps: RuntimeScriptStep[];
  /** The step in progress, or `steps.length` once every step has finished. */
  stepIndex: number;
  /** Set once the step has started on the host. It keeps running under nohup. */
  persistentInfo: PersistentCommandInfo | null;
  /** Warnings of the steps that already finished, so a resumed script still reports them. */
  warnings?: string[];
}

export type UpgradeHookProgress =
  | (UpgradeHookProgressBase & { phase: "pre_upgrade"; wasPostPending: boolean })
  | (UpgradeHookProgressBase & {
      phase: "post_upgrade";
      upgradeResult: OperationResult;
      completion?: { recheck: boolean };
    });

function withDefaultUpgradeModeOverride(
  configs: PackageManagerConfigs | null,
  override?: DefaultUpgradeModeOverride,
): PackageManagerConfigs | null {
  if (!override) return configs;
  return {
    ...(configs ?? {}),
    apt: {
      ...((configs?.apt ?? {}) as object),
      defaultUpgradeMode: override === "aggressive" ? "full-upgrade" : "upgrade",
    },
    dnf: {
      ...((configs?.dnf ?? {}) as object),
      defaultUpgradeMode: override === "aggressive" ? "distro-sync" : "upgrade",
    },
  };
}

export function getActiveOperation(systemId: number): ActiveOperation | null {
  return getStoredActiveOperation(systemId);
}

export function getAllActiveOperations(): ReadonlyMap<number, ActiveOperation> {
  return getStoredActiveOperations();
}

export function cancelActiveOperation(systemId: number): boolean {
  return requestActiveOperationCancellation(systemId);
}

export { isOperationCancelledError };

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

  const latestCompletedCheckId = getDb()
    .select({ id: updateHistory.id })
    .from(updateHistory)
    .where(
      and(
        eq(updateHistory.systemId, systemId),
        eq(updateHistory.action, "check"),
        ne(updateHistory.status, "started"),
      ),
    )
    .orderBy(desc(updateHistory.startedAt), desc(updateHistory.id))
    .get()?.id ?? null;

  getDb().run(sql`
    DELETE FROM update_history
    WHERE system_id = ${systemId}
      ${latestCompletedCheckId !== null
        ? sql`AND id != ${latestCompletedCheckId}`
        : sql``}
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
// Stops following a remote command that never finishes across repeated drops.
const RECONNECT_MONITORING_LIMIT_MS = 6 * 60 * 60 * 1000;

function isExpectedRebootDisconnect(message: string): boolean {
  return /ECONNRESET|connection reset|SSH connection (?:closed|ended)|connection (?:closed|ended)|\bclosed\b|\bended\b/i.test(message);
}

interface ReconnectionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  serverRebooted: boolean;
  /** The host never came back, so the remote command may still be running. */
  timedOut?: boolean;
  persistentInfo?: PersistentCommandInfo;
}

export type ActivityStepStatus = "success" | "warning" | "failed" | "started" | "cancelled";

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

function getCancellationSignal(systemId: number): AbortSignal | null {
  return getActiveOperationSignal(systemId);
}

function isCancelledResult(exitCode: number): boolean {
  return exitCode === EXIT_CANCELLED;
}

function createCancelledError(): OperationCancelledError {
  return new OperationCancelledError("Operation cancelled");
}

function setActiveOperationPhase(systemId: number, phase: ActiveOperation["phase"]): void {
  const current = getStoredActiveOperation(systemId);
  if (!current || !phase) return;
  setActiveOperation(systemId, { ...current, phase });
}

function setActiveOperationPersistentInfo(
  systemId: number,
  info: PersistentCommandInfo,
): void {
  const current = getStoredActiveOperation(systemId);
  if (!current) return;
  setActiveOperation(systemId, {
    ...current,
    remotePid: info.pid,
    remoteLogFile: info.logFile,
    remoteExitFile: info.exitFile,
  });
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

type PublishMessage = (message: outputStream.WsMessage) => void;

/** Reports a rule whose pattern ran out of time, live and in the server log. */
function slowRuleReporter(systemId: number, publish: PublishMessage): (ruleNumber: number) => void {
  return (ruleNumber) => {
    const message = `Output rule ${ruleNumber} took longer than ${OUTPUT_RULE_REGEX_TIMEOUT_MS} ms to match and was skipped. Simplify its patterns.`;
    logger.warn("Output rule timed out", { systemId, ruleNumber });
    publish({ type: "warning", message });
  };
}

/**
 * Applies the output rules of a step that ran as its own command. Results that are
 * not a real exit status, such as an unknown result after a reboot, are never matched.
 */
function matchStepOutputRules(
  step: RuntimeScriptStep | undefined,
  index: number,
  exitCode: number,
  output: string,
  onSlowRule: (ruleNumber: number) => void,
): OutputRuleMatch | null {
  if (!step?.outputRules?.length || exitCode < 0) return null;
  return evaluateOutputRulesBounded(step.outputRules, {
    exitCode,
    output,
    step: { index, label: step.label },
  }, onSlowRule);
}

function outputRuleFailureMessage(match: OutputRuleMatch, exitCode: number, fallback: string): string {
  if (match.message) return match.message;
  return exitCode === 0 ? `Output rule ${match.ruleNumber} marked the result as failed.` : fallback;
}

function outputRuleWarningMessage(match: OutputRuleMatch, exitCode: number, fallback?: string | null): string {
  if (match.message) return match.message;
  if (fallback) return fallback;
  return exitCode === 0
    ? `Output rule ${match.ruleNumber} marked the result as a warning.`
    : `Command exited with code ${exitCode}. Output rule ${match.ruleNumber} marked the result as a warning.`;
}

interface CommandOutcome {
  status: "success" | "warning" | "failed";
  /** The error for failures and the warning text for warnings. */
  message: string | null;
}

/**
 * Classifies a maintenance command whose steps ran as one command. Its rules apply
 * to the combined output and the final exit code. Without a matching rule, exit code
 * 0 succeeds and anything else fails with the default error.
 */
function resolveCommandOutcome(
  steps: RuntimeScriptStep[],
  result: { exitCode: number; inferred: boolean; output: string },
  defaultError: () => string,
  onSlowRule: (ruleNumber: number) => void,
): CommandOutcome {
  const match = result.inferred || result.exitCode < 0
    ? null
    : evaluateOutputRulesBounded(
        steps[0]?.outputRules,
        { exitCode: result.exitCode, output: result.output },
        onSlowRule,
      );
  if (!match) {
    return result.exitCode === 0
      ? { status: "success", message: null }
      : { status: "failed", message: defaultError() };
  }
  if (match.outcome === "failed") {
    return { status: "failed", message: outputRuleFailureMessage(match, result.exitCode, defaultError()) };
  }
  if (match.outcome === "warning") {
    return { status: "warning", message: outputRuleWarningMessage(match, result.exitCode) };
  }
  return { status: "success", message: null };
}

function appendLine(text: string, line: string | null): string {
  if (!line) return text;
  if (!text) return line;
  return `${text}${text.endsWith("\n") ? "" : "\n"}${line}`;
}

interface UpgradeCommandOutcome {
  success: boolean;
  /** Status of the command's activity row. */
  status: "success" | "warning" | "failed";
  /** The error, or the warning text, shown on the activity step. */
  stepError: string | null;
  /** This manager's part of the operation output. */
  output: string;
}

/** Classifies an upgrade or autoremove command and records a package-manager issue when it failed. */
function classifyMaintenanceCommand(args: {
  systemId: number;
  pmName: string;
  steps: RuntimeScriptStep[];
  stdout: string;
  stderr: string;
  exitCode: number;
  combinedOutput: string;
  /** The result was guessed from the update count after a reboot, so there is no real exit status. */
  inferred: boolean;
  reconnectionUsed: boolean;
}): UpgradeCommandOutcome {
  const { systemId, pmName, stdout, stderr, combinedOutput } = args;
  const outcome = resolveCommandOutcome(
    args.steps,
    { exitCode: args.exitCode, inferred: args.inferred, output: combinedOutput },
    () => formatUpgradeFailureOutput(pmName, stdout, stderr, combinedOutput),
    slowRuleReporter(systemId, (message) => outputStream.publish(systemId, message)),
  );
  if (outcome.status === "failed") {
    recordPackageManagerIssueFromFailure(
      systemId,
      pmName,
      `${stdout}\n${stderr}\n${combinedOutput}\n${outcome.message ?? ""}`,
    );
    return { success: false, status: "failed", stepError: outcome.message, output: `[${pmName}] ${outcome.message}` };
  }
  const warning = outcome.status === "warning" ? outcome.message : null;
  if (warning) outputStream.publish(systemId, { type: "warning", message: warning });
  return {
    success: true,
    status: warning || args.reconnectionUsed ? "warning" : "success",
    stepError: warning,
    output: `[${pmName}] ${appendLine(stdout, warning)}`,
  };
}

/** The value of LUDASH_UPGRADE_RESULT for a finished upgrade. */
function upgradeResultEnv(result: OperationResult): string {
  if (result.cancelled) return "cancelled";
  if (!result.success) return "failed";
  return result.warning ? "warning" : "success";
}

function formatUpgradeFailureOutput(
  pkgManager: string,
  stdout: string,
  stderr: string,
  combinedOutput: string,
): string {
  const rawError = stderr || stdout || combinedOutput || "Upgrade failed";
  if ((pkgManager === "dnf" || pkgManager === "yum") && hasDnfLikeEulaPrompt(combinedOutput)) {
    return `${rawError}\n\n${getDnfLikeEulaPromptMessage(pkgManager)}`;
  }
  return rawError;
}

function recordPackageManagerIssueFromFailure(
  systemId: number,
  pkgManager: string,
  output: string,
): void {
  const detectedIssue = detectPackageManagerIssue(systemId, pkgManager, output);
  if (!detectedIssue) return;
  packageIssueService.upsertPackageManagerIssue(systemId, detectedIssue);
}

function detectPackageManagerIssue(
  systemId: number,
  pkgManager: string,
  output: string,
): packageIssueService.PackageManagerIssueInput | null {
  const builtinIssue = packageIssueService.detectPackageManagerIssue(pkgManager, output);
  if (builtinIssue) return builtinIssue;

  const manager = listPackageManagerDefinitions().find((entry) => entry.name === pkgManager);
  if (!manager || manager.builtin) return null;
  const repairScript = resolveScript(systemId, "repair_issue", pkgManager);
  return packageIssueService.detectCustomPackageManagerIssue(
    pkgManager,
    manager.label,
    repairScript?.parserConfig,
    output,
  );
}

function getSystemPackageManagerConfigs(system: {
  pkgManagerConfigs?: string | null;
}): PackageManagerConfigs | null {
  return parsePackageManagerConfigs(system.pkgManagerConfigs ?? null, listPackageManagerDefinitions());
}

export function getConfiguredUpgradeBehaviorDescriptions(systemId: number): string[] {
  const system = systemService.getSystem(systemId);
  if (!system) return [];
  const pkgManagers = systemService.getActivePkgManagers(system);
  return describeUpgradeBehaviors(pkgManagers, getSystemPackageManagerConfigs(system));
}

function getUpgradeAllPkgManagers(systemId: number, system: { pkgManager?: string | null }): string[] {
  const db = getDb();
  const cachedManagers = db
    .selectDistinct({ pkgManager: updateCache.pkgManager })
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .all()
    .map((r) => r.pkgManager);

  return cachedManagers.length > 0
    ? cachedManagers
    : system.pkgManager
      ? [system.pkgManager]
      : [];
}

export function getUpgradeAllCommandSnapshot(
  systemId: number,
  options?: { defaultUpgradeModeOverride?: DefaultUpgradeModeOverride },
): UpgradeAllCommandSnapshot {
  const system = systemService.getSystem(systemId);
  if (!system) {
    return { systemId, pkgManagers: [], command: null, pkgManager: "system", commands: [] };
  }
  const pkgManagerConfigs = withDefaultUpgradeModeOverride(
    getSystemPackageManagerConfigs(system),
    options?.defaultUpgradeModeOverride,
  );
  const pkgManagers = getUpgradeAllPkgManagers(systemId, system);
  const commands = pkgManagers.flatMap((pmName) => {
    const steps = resolveRuntimeSteps({
      systemId,
      operation: "upgrade_all",
      pkgManager: pmName,
      pkgManagerConfig: getManagerConfig(pkgManagerConfigs, pmName),
    });
    const command = buildMaintenanceCommand(steps);
    return command ? [{ pkgManager: pmName, command }] : [];
  });
  return {
    systemId,
    pkgManagers,
    command: commands.map((entry) => entry.command).join(" && ") || null,
    pkgManager: commands.map((entry) => entry.pkgManager).join(",") || pkgManagers.join(",") || "system",
    commands,
  };
}

interface SelectedPackageUpgradeResolution {
  packageNames: string[];
  updates: VisibleCachedUpdate[];
}

function normalizeRequestedPackageNames(packageNames: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const raw of packageNames) {
    const safeName = validatePackageName(raw);
    if (seen.has(safeName)) continue;
    seen.add(safeName);
    normalized.push(safeName);
  }

  return normalized;
}

function resolveSelectedPackageUpgrades(
  systemId: number,
  packageNames: string[],
): SelectedPackageUpgradeResolution {
  const normalizedNames = normalizeRequestedPackageNames(packageNames);
  if (normalizedNames.length === 0) {
    throw new Error("At least one package name is required");
  }

  const visibleUpdates = hiddenUpdateService.getVisibleCachedUpdates(systemId);
  const requestedNameSet = new Set(normalizedNames);
  const selectedUpdates = visibleUpdates.filter((update) => requestedNameSet.has(update.packageName));
  const availableNameSet = new Set(selectedUpdates.map((update) => update.packageName));
  const missingNames = normalizedNames.filter((packageName) => !availableNameSet.has(packageName));

  if (missingNames.length > 0) {
    throw new Error(
      `Selected package updates are no longer available: ${missingNames.join(", ")}`,
    );
  }

  const pinnedNames = Array.from(new Set(
    selectedUpdates.filter(isPinnedUpdate).map((update) => update.packageName),
  ));
  if (pinnedNames.length > 0) {
    throw new Error(
      `Selected packages are pinned or held on this system and cannot be upgraded individually: ${pinnedNames.join(", ")}`,
    );
  }

  return {
    packageNames: normalizedNames,
    updates: selectedUpdates,
  };
}

export function validateSelectedPackageUpgradeRequest(
  systemId: number,
  packageNames: string[],
): { packageNames: string[] } {
  const resolved = resolveSelectedPackageUpgrades(systemId, packageNames);
  return { packageNames: resolved.packageNames };
}

/**
 * When SSH monitoring is lost during an upgrade (e.g. server rebooted),
 * attempt to reconnect and determine the actual result.
 */
function resolveSecretInputForRedaction(
  system: Parameters<typeof resolveSecretInput>[0],
  pkgManager: string,
): SecretInput | null {
  try {
    return resolveSecretInput(system, pkgManager);
  } catch {
    return null;
  }
}

async function attemptReconnection(
  systemId: number,
  persistentInfo: PersistentCommandInfo,
  preUpgradeUpdateCount: number,
  onData: (chunk: string, stream: "stdout" | "stderr") => void,
  secretInput: SecretInput | null = null,
  options?: { inferResultFromUpdateCount?: boolean },
): Promise<ReconnectionResult> {
  const system = systemService.getSystem(systemId);
  if (!system) {
    return { exitCode: -1, stdout: "", stderr: "System not found during reconnection", serverRebooted: false };
  }

  const sshManager = getSSHManager();
  const signal = getCancellationSignal(systemId);
  const cancelledUnreached = (): ReconnectionResult => {
    const message = "Operation cancelled, but the host could not be reached, so the remote command may still be running.";
    outputStream.publish(systemId, { type: "warning", message });
    return { exitCode: EXIT_CANCELLED, stdout: "", stderr: message, serverRebooted: false, timedOut: true };
  };

  outputStream.publish(systemId, {
    type: "warning",
    message: "SSH connection lost. Attempting to reconnect...",
  });
  outputStream.publish(systemId, { type: "phase", phase: "reconnecting" });

  const monitoringStartTime = Date.now();
  let startTime = monitoringStartTime;
  let attempt = 0;
  const maxAttempts = Math.ceil(RECONNECT_TIMEOUT_MS / RECONNECT_INTERVAL_MS);

  while (Date.now() - startTime < RECONNECT_TIMEOUT_MS) {
    attempt++;
    await waitForRetry(RECONNECT_INTERVAL_MS, signal);
    // Cancelling gets one immediate try to stop the command, not a wait for the host.
    const finalAttempt = !!signal?.aborted;

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
      if (finalAttempt) return cancelledUnreached();
      continue;
    }

    try {
      const result = await sshManager.resumePersistentCommand(
        conn,
        persistentInfo,
        3600,
        onData,
        { secretInput, signal },
      );

      if (result.exitCode === EXIT_MONITORING_LOST) {
        // The command is still running, so this is not a result. Reaching the
        // host again earns a new reconnect window.
        sshManager.disconnect(conn);
        conn = null;
        if (finalAttempt) return cancelledUnreached();
        if (Date.now() - monitoringStartTime < RECONNECT_MONITORING_LIMIT_MS) {
          startTime = Date.now();
          attempt = 0;
        }
        outputStream.publish(systemId, {
          type: "warning",
          message: "SSH connection lost again. Attempting to reconnect...",
        });
        continue;
      }

      if (result.exitCode === EXIT_FILES_GONE && signal?.aborted) {
        // Nothing is left to stop, and the user has stopped waiting for a result.
        sshManager.disconnect(conn);
        conn = null;
        return { exitCode: EXIT_CANCELLED, stdout: "", stderr: "Operation cancelled", serverRebooted: false };
      }

      if (result.exitCode === EXIT_FILES_GONE && options?.inferResultFromUpdateCount === false) {
        sshManager.disconnect(conn);
        conn = null;
        return {
          exitCode: -1,
          stdout: "",
          stderr: "The result is unknown because the remote temp files no longer exist (server likely rebooted).",
          serverRebooted: true,
        };
      }

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
      if (finalAttempt) return cancelledUnreached();
      continue;
    }
  }

  if (signal?.aborted) return cancelledUnreached();

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
    timedOut: true,
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
    (status === "success" || status === "failed" || status === "warning" || status === "cancelled" ? now : null);

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

/** Record a repository source edit; the unified diff is kept as its output. */
export function recordRepositorySourceEdit(
  systemId: number,
  pkgManager: string,
  status: "success" | "failed",
  opts: { path: string; command: string; diff?: string; error?: string; startedAt: string },
): void {
  logHistory(systemId, "repository_source_edit", pkgManager, status, {
    packages: JSON.stringify([opts.path]),
    command: opts.command,
    output: opts.diff || undefined,
    error: opts.error,
    startedAt: opts.startedAt,
  });
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

function markEntryStarted(
  id: number,
  pkgManager: string,
  command: string,
  startedAt = getCurrentTimestamp(),
): void {
  getDb().update(updateHistory)
    .set({
      pkgManager,
      status: "started",
      command: sanitizeCommand(command),
      startedAt,
      completedAt: null,
      output: null,
      error: null,
    })
    .where(eq(updateHistory.id, id))
    .run();
}

/** Update an existing history row to its final status. */
function finishEntry(
  id: number,
  status: "success" | "failed" | "warning" | "cancelled",
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

/** Finalize a queue entry even if setup failed before a command was started. */
export function finishPendingHistoryEntry(id: number, status: "failed" | "cancelled", error: string): void {
  const row = getDb().select({ status: updateHistory.status }).from(updateHistory)
    .where(eq(updateHistory.id, id)).get();
  if (row?.status === "queued" || row?.status === "started") {
    finishEntry(id, status, { error });
  }
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
  const signal = getCancellationSignal(systemId);
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
    throwIfActiveOperationCancelled(systemId);
    publishSshConnectionStep(
      pub,
      getStoredActiveOperation(systemId)?.startedAt ?? getCurrentTimestamp(),
    );
    conn = await sshManager.connect(system as Record<string, unknown>, {
      systemId,
    });
    throwIfActiveOperationCancelled(systemId);

    // Update system info
    const rebootRequired = await systemService.updateSystemInfo(
      systemId,
      sshManager,
      conn
    );
    if (rebootRequired) {
      await processRebootRequiredResult(rebootRequired).catch((error) =>
        logger.error("Reboot notification processing error", { systemId, error: String(error) }),
      );
    }
    throwIfActiveOperationCancelled(systemId);

    // Detect package managers if not yet detected
    if (!system.detectedPkgManagers) {
      await systemService.detectAndStorePkgManager(systemId, sshManager, conn);
      throwIfActiveOperationCancelled(systemId);
      // Re-read system to get updated detected list
      const updated = systemService.getSystem(systemId);
      if (updated) {
        pkgManagers = systemService.getActivePkgManagers(updated);
      }
    } else {
      pkgManagers = systemService.getActivePkgManagers(system);
    }

    if (!pkgManagers.length) {
      installedPackageService.pruneInstalledPackagesForInactiveManagers(systemId, []);
      return [];
    }

    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);

    // Run check for each package manager

    for (const pmName of pkgManagers) {
      throwIfActiveOperationCancelled(systemId);
      try {
        const parser = getParser(pmName);
        const managerConfig = getManagerConfig(pkgManagerConfigs, pmName);
        const steps = resolveRuntimeSteps({
          systemId,
          operation: "check_updates",
          pkgManager: pmName,
          pkgManagerConfig: managerConfig,
        });
        if (!steps.length || (!parser && !isCustomPackageManager(pmName))) continue;
        const secretInput = resolveSecretInput(system, pmName);
        const commands = steps.map((step) => withSecretEnvNote(step.command, secretInput));
        allCommands.push(...commands);
        let lastStdout = "";
        let lastStderr = "";
        let lastExitCode = 0;
        const commandResults: CheckCommandResult[] = [];
        const detectedIssues = new Map<string, packageIssueService.PackageManagerIssueInput>();

        for (let i = 0; i < commands.length; i++) {
          const label = steps[i]?.label ?? `Step ${i + 1}`;
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
            },
            signal,
            { secretInput }
          );
          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || `${result.stdout}${result.stderr}`;
          checkOutput += combinedOutput;
          if (isCancelledResult(result.exitCode)) {
            allSteps.push(
              createActivityStep({
                label,
                pkgManager: pmName,
                command: commands[i],
                output: combinedOutput,
                error: "Operation cancelled",
                status: "cancelled",
                startedAt: stepStartedAt,
                completedAt: stepCompletedAt,
              })
            );
            throw createCancelledError();
          }
          const customScript = parser ? null : resolveScript(systemId, "check_updates", pmName);
          const parserReportedError =
            parser?.getCheckErrorMessage?.(result.stdout, result.stderr, result.exitCode)
            ?? getCustomCheckErrorMessage(customScript?.parserConfig, result.stdout, result.stderr, result.exitCode);
          const getParserWarning = () => parser?.getCheckWarningMessage?.({
            command: commands[i],
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          }, { commandResults }) ?? null;
          // A matching output rule replaces the exit-code and parser judgement of this
          // step. The parser still reads the output as usual.
          const ruleMatch = matchStepOutputRules(steps[i], i, result.exitCode, combinedOutput, slowRuleReporter(systemId, pub));
          let checkErrorMessage: string | null;
          let checkWarningMessage: string | null;
          if (ruleMatch?.outcome === "failed") {
            checkErrorMessage = outputRuleFailureMessage(
              ruleMatch,
              result.exitCode,
              parserReportedError ?? `Command exited with code ${result.exitCode}`,
            );
            checkWarningMessage = null;
          } else if (ruleMatch) {
            checkErrorMessage = null;
            checkWarningMessage = ruleMatch.outcome === "warning"
              ? outputRuleWarningMessage(ruleMatch, result.exitCode, getParserWarning())
              : null;
          } else {
            checkErrorMessage = parserReportedError;
            checkWarningMessage = checkErrorMessage === null ? getParserWarning() : null;
          }
          const commandFailed = checkErrorMessage !== null;
          if (checkWarningMessage) {
            checkErrors.push(`[${pmName}] ${checkWarningMessage}`);
            pub({ type: "warning", message: checkWarningMessage });
          }
          const detectedIssue = detectPackageManagerIssue(
            systemId,
            pmName,
            `${result.stdout}\n${result.stderr}\n${combinedOutput}\n${checkErrorMessage ?? ""}`,
          );
          if (detectedIssue) {
            detectedIssues.set(detectedIssue.issueKey, detectedIssue);
            packageIssueService.upsertPackageManagerIssue(systemId, detectedIssue);
            if (commandFailed && !ruleMatch?.message) {
              checkErrorMessage = detectedIssue.message;
            }
          }
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
              error: checkErrorMessage ?? checkWarningMessage,
              status: commandFailed ? "failed" : checkWarningMessage ? "warning" : "success",
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

        const customScript = parser ? null : resolveScript(systemId, "check_updates", pmName);
        let updates = parser
          ? parser.parseCheckOutput(lastStdout, lastStderr, lastExitCode, {
              commandResults,
            })
          : parseUpdatesWithScript(pmName, customScript, commandResults);
        if (parser?.isPinDetectionIncomplete) {
          updates = reconcileKnownPins(
            systemId,
            pmName,
            updates,
            parser.isPinDetectionIncomplete(commandResults),
          );
        }
        allUpdates.push(...updates);
        successfulChecks++;
        successfulPkgManagers.push(pmName);
        if (detectedIssues.size === 0) {
          packageIssueService.resolvePackageManagerIssuesForManager(systemId, pmName);
        } else {
          for (const issue of detectedIssues.values()) {
            checkErrors.push(`[${pmName}] ${issue.message}`);
          }
        }
      } catch (e) {
        if (isOperationCancelledError(e)) {
          throw e;
        }
        const errorText = e instanceof Error ? e.message : String(e);
        checkErrors.push(`[${pmName}] ${errorText}`);
        logger.warn("System update check failed", {
          systemId,
          pkgManager: pmName,
          error: sanitizeOutput(errorText),
        });
        pub({ type: "error", message: errorText });
      }

      throwIfActiveOperationCancelled(systemId);
      const installedPackageScript = resolveScript(systemId, "list_installed_packages", pmName);
      const installedPackageSteps = resolveRuntimeSteps({
        systemId,
        operation: "list_installed_packages",
        pkgManager: pmName,
        pkgManagerConfig: getManagerConfig(pkgManagerConfigs, pmName),
      });
      if (!installedPackageScript || installedPackageSteps.length === 0) continue;

      let lastInventoryStepIndex: number | null = null;
      try {
        const secretInput = resolveSecretInput(system, pmName);
        const commandResults: CheckCommandResult[] = [];
        const activityStepIndexes: number[] = [];
        for (const [stepIndex, step] of installedPackageSteps.entries()) {
          throwIfActiveOperationCancelled(systemId);
          const command = withSecretEnvNote(step.command, secretInput);
          const label = step.label || `Listing installed ${pmName} packages`;
          const stepStartedAt = getCurrentTimestamp();
          allCommands.push(command);
          pub({ type: "started", command, pkgManager: pmName, startedAt: stepStartedAt });
          pub({ type: "phase", phase: label });
          const result = await sshManager.runCommand(
            conn,
            command,
            undefined,
            sudoPassword,
            undefined,
            signal,
            { secretInput },
          );
          const stepCompletedAt = getCurrentTimestamp();
          if (isCancelledResult(result.exitCode)) {
            allSteps.push(createActivityStep({
              label,
              pkgManager: pmName,
              command,
              output: null,
              error: "Operation cancelled",
              status: "cancelled",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }));
            throw createCancelledError();
          }
          const defaultErrorMessage = result.exitCode === 0
            ? null
            : getCustomCheckErrorMessage(
                installedPackageScript.parserConfig,
                result.stdout,
                result.stderr,
                result.exitCode,
              );
          const ruleMatch = matchStepOutputRules(
            step,
            stepIndex,
            result.exitCode,
            `${result.stdout}${result.stderr}`,
            slowRuleReporter(systemId, pub),
          );
          const errorMessage = ruleMatch
            ? ruleMatch.outcome === "failed"
              ? outputRuleFailureMessage(ruleMatch, result.exitCode, defaultErrorMessage ?? `Command exited with code ${result.exitCode}`)
              : null
            : defaultErrorMessage;
          const warningMessage = ruleMatch?.outcome === "warning"
            ? outputRuleWarningMessage(ruleMatch, result.exitCode)
            : null;
          if (warningMessage) {
            checkErrors.push(`[${pmName} installed packages] ${warningMessage}`);
            pub({ type: "warning", message: `Installed package inventory: ${warningMessage}` });
          }
          commandResults.push({
            command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
          });
          activityStepIndexes.push(allSteps.length);
          lastInventoryStepIndex = allSteps.length;
          allSteps.push(createActivityStep({
            label,
            pkgManager: pmName,
            command,
            output: null,
            error: errorMessage ?? warningMessage,
            status: errorMessage ? "failed" : warningMessage ? "warning" : "success",
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }));
          if (errorMessage) throw new Error(errorMessage);
        }

        const installedPackages = parseInstalledPackagesWithScript(
          pmName,
          installedPackageScript,
          commandResults,
        );
        installedPackageService.replaceInstalledPackagesForManager(
          systemId,
          pmName,
          installedPackages,
        );
        const lastActivityStepIndex = activityStepIndexes.at(-1);
        if (lastActivityStepIndex !== undefined) {
          allSteps[lastActivityStepIndex].output =
            `Collected ${installedPackages.length} installed package${installedPackages.length === 1 ? "" : "s"}`;
        }
      } catch (e) {
        if (isOperationCancelledError(e)) throw e;
        const errorText = e instanceof Error ? e.message : String(e);
        if (lastInventoryStepIndex !== null && allSteps[lastInventoryStepIndex].status === "success") {
          allSteps[lastInventoryStepIndex].status = "warning";
          allSteps[lastInventoryStepIndex].error = errorText;
        }
        checkErrors.push(`[${pmName} installed packages] ${errorText}`);
        logger.warn("Installed package collection failed", {
          systemId,
          pkgManager: pmName,
          error: sanitizeOutput(errorText),
        });
        pub({ type: "warning", message: `Installed package inventory: ${errorText}` });
      }
    }
  } catch (e) {
    if (isOperationCancelledError(e)) {
      const message = e.message || "Operation cancelled";
      pub({ type: "warning", message });
      pub({ type: "done", success: false, completedAt: getCurrentTimestamp() });
      if (!silent) {
        logHistory(systemId, "check", pkgManagers.join(",") || system.pkgManager || "unknown", "cancelled", {
          command: allCommands.join(" && "),
          steps: allSteps,
          output: checkOutput.slice(0, 5000) || undefined,
          error: message,
        });
      }
      throw e;
    }
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

  installedPackageService.pruneInstalledPackagesForInactiveManagers(systemId, pkgManagers);
  const ownedUpdates = applyPackageOwnershipClaims(systemId, pkgManagers, allUpdates);
  allUpdates.splice(0, allUpdates.length, ...ownedUpdates);

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
    pub({
      type: "done",
      success: historyStatus !== "failed",
      warning: historyStatus === "warning",
      completedAt: getCurrentTimestamp(),
    });
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

export async function solvePackageManagerIssue(
  systemId: number,
  issueId: number,
): Promise<OperationResult> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "package_manager_repair", startedAt: now });
    outputStream.resetStream(systemId);
    await requestNotificationRuntimeSystemSync(systemId);
    try {
      const system = systemService.getSystem(systemId);
      if (!system) return { success: false, output: "System not found" };
      const issue = packageIssueService.getPackageManagerIssue(systemId, issueId);
      if (!issue || issue.active !== 1) {
        return { success: false, output: "Package manager issue not found" };
      }
      const steps = resolveRuntimeSteps({
        systemId,
        operation: "repair_issue",
        pkgManager: issue.pkgManager,
        pkgManagerConfig: getManagerConfig(getSystemPackageManagerConfigs(system), issue.pkgManager),
      });
      if (!steps.length) {
        return { success: false, output: "No repair command is available for this package manager issue" };
      }

      const sshManager = getSSHManager();
      const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
      const signal = getCancellationSignal(systemId);
      const activitySteps: ActivityStep[] = [];
      const allCommands: string[] = [];
      const repairWarnings: string[] = [];
      let repairOutput = "";
      let conn;
      try {
        throwIfActiveOperationCancelled(systemId);
        publishSshConnectionStep(
          (msg) => outputStream.publish(systemId, msg),
          getStoredActiveOperation(systemId)?.startedAt ?? getCurrentTimestamp(),
        );
        conn = await sshManager.connect(system as Record<string, unknown>, { systemId });
        throwIfActiveOperationCancelled(systemId);

        const secretInput = resolveSecretInput(system, issue.pkgManager);
        for (const [stepIndex, step] of steps.entries()) {
          const cmd = withSecretEnvNote(step.command, secretInput);
          allCommands.push(cmd);
          const label = step.label || "Repairing package manager";
          const stepStartedAt = getCurrentTimestamp();
          outputStream.publish(systemId, {
            type: "started",
            command: cmd,
            pkgManager: issue.pkgManager,
            startedAt: stepStartedAt,
          });
          outputStream.publish(systemId, { type: "phase", phase: label });
          let streamedOutput = "";
          const result = await sshManager.runCommand(
            conn,
            cmd,
            undefined,
            sudoPassword,
            (chunk, stream) => {
              streamedOutput += chunk;
              outputStream.publish(systemId, { type: "output", data: chunk, stream });
            },
            signal,
            { secretInput },
          );
          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || `${result.stdout}${result.stderr}`;
          repairOutput += combinedOutput;

          if (isCancelledResult(result.exitCode)) {
            const message = "Operation cancelled";
            activitySteps.push(createActivityStep({
              label,
              pkgManager: issue.pkgManager,
              command: cmd,
              output: combinedOutput,
              error: message,
              status: "cancelled",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }));
            logHistory(systemId, "package_manager_repair", issue.pkgManager, "cancelled", {
              command: allCommands.join(" && "),
              steps: activitySteps,
              output: repairOutput.slice(0, STEP_OUTPUT_LIMIT),
              error: message,
            });
            outputStream.publish(systemId, { type: "warning", message });
            outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
            return { success: false, output: message, cancelled: true };
          }

          const ruleMatch = matchStepOutputRules(
            step,
            stepIndex,
            result.exitCode,
            combinedOutput,
            slowRuleReporter(systemId, (message) => outputStream.publish(systemId, message)),
          );
          const failed = ruleMatch ? ruleMatch.outcome === "failed" : result.exitCode !== 0;
          if (failed) {
            const defaultErrorText =
              result.stderr || result.stdout || combinedOutput || `Repair command exited with code ${result.exitCode}`;
            const errorText = ruleMatch
              ? outputRuleFailureMessage(ruleMatch, result.exitCode, defaultErrorText)
              : defaultErrorText;
            recordPackageManagerIssueFromFailure(systemId, issue.pkgManager, `${combinedOutput}\n${errorText}`);
            activitySteps.push(createActivityStep({
              label,
              pkgManager: issue.pkgManager,
              command: cmd,
              output: combinedOutput,
              error: errorText,
              status: "failed",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }));
            logHistory(systemId, "package_manager_repair", issue.pkgManager, "failed", {
              command: allCommands.join(" && "),
              steps: activitySteps,
              output: repairOutput.slice(0, STEP_OUTPUT_LIMIT),
              error: errorText,
            });
            outputStream.publish(systemId, { type: "error", message: errorText });
            outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
            return { success: false, output: errorText };
          }

          const warningText = ruleMatch?.outcome === "warning"
            ? outputRuleWarningMessage(ruleMatch, result.exitCode)
            : null;
          if (warningText) {
            repairWarnings.push(warningText);
            outputStream.publish(systemId, { type: "warning", message: warningText });
          }
          activitySteps.push(createActivityStep({
            label,
            pkgManager: issue.pkgManager,
            command: cmd,
            output: combinedOutput,
            error: warningText,
            status: warningText ? "warning" : "success",
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }));
        }

        logHistory(systemId, "package_manager_repair", issue.pkgManager, repairWarnings.length ? "warning" : "success", {
          command: allCommands.join(" && "),
          steps: activitySteps,
          output: repairOutput.slice(0, STEP_OUTPUT_LIMIT),
          ...(repairWarnings.length ? { error: repairWarnings.join("\n\n").slice(0, STEP_ERROR_LIMIT) } : {}),
        });
      } finally {
        if (conn) sshManager.disconnect(conn);
      }

      setActiveOperationPhase(systemId, "rechecking");
      outputStream.publish(systemId, { type: "phase", phase: "Refreshing updates" });
      await checkUpdatesUnlocked(systemId, true);
      const refreshedIssue = packageIssueService.getPackageManagerIssue(systemId, issueId);
      const repaired = !refreshedIssue || refreshedIssue.active !== 1;
      // Warnings from output rules stay visible when the repair itself worked.
      const warning = repaired && repairWarnings.length > 0;
      outputStream.publish(systemId, {
        type: "done",
        success: repaired,
        ...(warning ? { warning: true } : {}),
        completedAt: getCurrentTimestamp(),
      });
      return {
        success: repaired,
        output: repaired
          ? ["Package manager issue repaired", ...repairWarnings].join("\n\n")
          : "Repair command ran, but the package manager issue is still detected.",
        ...(warning ? { warning: true } : {}),
      };
    } catch (error) {
      if (isOperationCancelledError(error)) {
        return { success: false, output: error.message, cancelled: true };
      }
      const message = error instanceof Error ? error.message : String(error);
      outputStream.publish(systemId, { type: "error", message });
      outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
      return { success: false, output: message };
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

const UPGRADE_HOOK_LABELS = {
  pre_upgrade: "Pre-upgrade script",
  post_upgrade: "Post-upgrade script",
} as const;
// The host may still be restarting services when the post-upgrade script is due.
const POST_UPGRADE_CONNECT_ATTEMPTS = 4;
const UPGRADE_STATE_UNKNOWN_REASON =
  "the host did not come back, so the upgrade may still be running. Run it from the system page once the upgrade has finished.";

type UpgradeHookKind = keyof typeof UPGRADE_HOOK_LABELS;
/** A warning means every step ran and an output rule flagged at least one of them. */
type UpgradeHookStatus = "success" | "warning" | "failed" | "cancelled";

interface UpgradeHookRunResult {
  status: UpgradeHookStatus;
  message: string;
  /** False when the script never started on the host, so it changed nothing. */
  remoteStarted: boolean;
  exitCode: number | null;
}

interface PostUpgradeOutcome {
  status: UpgradeHookStatus | "skipped";
  message: string;
}

interface UpgradeHookSession {
  systemId: number;
  operation: ActiveOperation["type"];
  preSteps: RuntimeScriptStep[];
  postSteps: RuntimeScriptStep[];
  setupError: string | null;
  wasPostPending: boolean;
  /** Post only undoes what pre did, so it waits until pre has passed. */
  preStagePassed: boolean;
  /** Set once post has been dealt with, so every exit path can finalize safely. */
  postOutcome: PostUpgradeOutcome | null | undefined;
  postBlockedReason: string | null;
  /** Set when the pre-upgrade script passed with warnings, so the upgrade result reports them. */
  preWarning: string | null;
  resumeHook?: UpgradeHookProgress;
  onHookProgress?: (progress: UpgradeHookProgress) => void;
}

function buildUpgradeHookCommand(command: string, env: Record<string, string>): string {
  // Values come from fixed internal lists and never from user input.
  const exports = Object.entries(env).map(([key, value]) => `${key}=${value}; export ${key}`);
  return [...exports, command].join("\n");
}

function createUpgradeHookSession(
  systemId: number,
  operation: ActiveOperation["type"],
  options?: Pick<UpgradeAllExecutionOptions, "resumeHook" | "onHookProgress" | "preUpgradeWarnings">,
): UpgradeHookSession {
  const session: UpgradeHookSession = {
    systemId,
    operation,
    preSteps: [],
    postSteps: [],
    setupError: null,
    wasPostPending: false,
    preStagePassed: false,
    postOutcome: undefined,
    postBlockedReason: null,
    preWarning: options?.preUpgradeWarnings?.length ? options.preUpgradeWarnings.join("\n") : null,
    resumeHook: options?.resumeHook,
    onHookProgress: options?.onHookProgress,
  };
  try {
    session.preSteps = resolveRuntimeSteps({ systemId, operation: "pre_upgrade" });
    session.postSteps = resolveRuntimeSteps({ systemId, operation: "post_upgrade" });
  } catch (error) {
    session.setupError = error instanceof Error ? error.message : String(error);
  }
  return session;
}

function waitForRetry(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Runs a hook on its own connection, so the caller must not be holding one. Each
 * step is its own remote command because the sudo password is delivered once per
 * command, and a script that stops a service often needs several privileged steps.
 */
async function runUpgradeHookSteps(
  systemId: number,
  kind: UpgradeHookKind,
  steps: RuntimeScriptStep[],
  env: Record<string, string>,
  options: {
    connectAttempts?: number;
    resume?: { stepIndex: number; persistentInfo: PersistentCommandInfo | null; warnings?: string[] };
    onProgress?: (stepIndex: number, persistentInfo: PersistentCommandInfo | null, warnings: string[]) => void;
  } = {},
): Promise<UpgradeHookRunResult> {
  const { connectAttempts = 1, resume, onProgress } = options;
  const label = UPGRADE_HOOK_LABELS[kind];
  const startIndex = resume?.stepIndex ?? 0;
  // Steps that finished before a dashboard restart keep their warnings.
  const warnings: string[] = [...(resume?.warnings ?? [])];
  if (startIndex >= steps.length && !resume?.persistentInfo) {
    return warnings.length
      ? { status: "warning", message: warnings.join("\n"), remoteStarted: true, exitCode: 0 }
      : { status: "success", message: `${label} finished`, remoteStarted: true, exitCode: 0 };
  }
  const sshManager = getSSHManager();
  const signal = getCancellationSignal(systemId);
  const commands = steps.map((step) => ({
    label: `${label}: ${step.label}`,
    command: buildUpgradeHookCommand(step.command, env),
  }));
  const histId = insertStartedEntry(
    systemId,
    kind,
    "system",
    commands.slice(startIndex).map((step) => step.command).join("\n\n"),
    getCurrentTimestamp(),
  );

  const activitySteps: ActivityStep[] = [];
  let remoteStarted = startIndex > 0;
  let current: { label: string; command: string; startedAt: string; output: string } | null = null;
  const onData = (chunk: string, stream: "stdout" | "stderr") => {
    if (current) current.output += chunk;
    outputStream.publish(systemId, { type: "output", data: chunk, stream });
  };
  const recordCurrentStep = (status: UpgradeHookStatus, error: string | null) => {
    if (!current) return;
    activitySteps.push(createActivityStep({
      label: current.label,
      pkgManager: "system",
      command: current.command,
      output: current.output || null,
      error,
      status,
      startedAt: current.startedAt,
      completedAt: getCurrentTimestamp(),
    }));
    current = null;
  };
  const finish = (
    status: UpgradeHookStatus,
    message: string,
    exitCode: number | null,
  ): UpgradeHookRunResult => {
    const error = status === "success" ? null : message;
    recordCurrentStep(status, error);
    finishEntry(histId, status, {
      steps: activitySteps,
      output: activitySteps.map((step) => step.output ?? "").join("").slice(0, STEP_OUTPUT_LIMIT),
      error: error ?? undefined,
    });
    if (status === "cancelled") outputStream.publish(systemId, { type: "warning", message });
    if (status === "failed") outputStream.publish(systemId, { type: "error", message });
    return { status, message, remoteStarted, exitCode };
  };

  let conn: Awaited<ReturnType<typeof sshManager.connect>> | undefined;
  try {
    const system = systemService.getSystem(systemId);
    if (!system) return finish("failed", `${label} failed: system not found`, null);
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);

    for (const [index, step] of commands.entries()) {
      if (index < startIndex) continue;
      const startedAt = getCurrentTimestamp();
      current = { ...step, startedAt, output: "" };
      outputStream.publish(systemId, { type: "started", command: step.command, pkgManager: "system", startedAt });
      outputStream.publish(systemId, { type: "phase", phase: step.label });

      const interrupted = index === startIndex ? resume?.persistentInfo : null;
      let result: PersistentCommandResult;
      if (interrupted) {
        // The step is still running on the host, so attach to it instead of starting it again.
        remoteStarted = true;
        setActiveOperationPersistentInfo(systemId, interrupted);
        result = { stdout: "", stderr: "", exitCode: EXIT_MONITORING_LOST, persistentInfo: interrupted };
      } else {
        for (let attempt = 1; !conn; attempt++) {
          throwIfActiveOperationCancelled(systemId);
          try {
            conn = await sshManager.connect(system as Record<string, unknown>, { systemId });
          } catch (error) {
            if (attempt >= connectAttempts) throw error;
            onData(`Could not connect over SSH, retrying in ${RECONNECT_INTERVAL_MS / 1000}s...\n`, "stderr");
            await waitForRetry(RECONNECT_INTERVAL_MS, signal);
          }
        }
        throwIfActiveOperationCancelled(systemId);

        result = await sshManager.runPersistentCommand(conn, step.command, 3600, sudoPassword, onData, {
          signal,
          onPersistentInfo: (info) => {
            remoteStarted = true;
            setActiveOperationPersistentInfo(systemId, info);
            onProgress?.(index, info, [...warnings]);
          },
        });
      }
      let { stdout, stderr, exitCode } = result;

      if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
        if (conn) {
          try { sshManager.disconnect(conn); } catch {}
          conn = undefined;
        }
        const reconnected = await attemptReconnection(systemId, result.persistentInfo, 0, onData, null, {
          inferResultFromUpdateCount: false,
        });
        stdout = reconnected.stdout || stdout;
        stderr = reconnected.stderr;
        exitCode = reconnected.exitCode;
      }

      if (isCancelledResult(exitCode)) return finish("cancelled", `${label} cancelled`, null);

      const stepLabel = step.label.slice(label.length + 2);
      const ruleMatch = matchStepOutputRules(
        steps[index],
        index,
        exitCode,
        current?.output || `${stdout}${stderr}`,
        slowRuleReporter(systemId, (message) => outputStream.publish(systemId, message)),
      );
      const failed = ruleMatch ? ruleMatch.outcome === "failed" : exitCode !== 0;
      if (failed) {
        if (current && !current.output) current.output = stdout;
        const detail = sanitizeOutput(stderr || "").trim();
        const exitMessage = `${label} failed at "${stepLabel}" with exit code ${exitCode}${detail ? `: ${detail.slice(0, 500)}` : ""}`;
        const message = ruleMatch?.message
          ? `${label} failed at "${stepLabel}": ${ruleMatch.message}`
          : ruleMatch && exitCode === 0
            ? `${label} failed at "${stepLabel}": output rule ${ruleMatch.ruleNumber} marked the step as failed.`
            : exitMessage;
        return finish("failed", message, exitCode);
      }

      if (current && !current.output) current.output = stdout;
      const warning = ruleMatch?.outcome === "warning"
        ? `${label} step "${stepLabel}": ${outputRuleWarningMessage(ruleMatch, exitCode)}`
        : null;
      if (warning) {
        warnings.push(warning);
        outputStream.publish(systemId, { type: "warning", message: warning });
      }
      recordCurrentStep(warning ? "warning" : "success", warning);
      onProgress?.(index + 1, null, [...warnings]);
    }
    return warnings.length
      ? finish("warning", warnings.join("\n"), 0)
      : finish("success", `${label} finished`, 0);
  } catch (error) {
    if (isOperationCancelledError(error)) return finish("cancelled", `${label} cancelled`, null);
    return finish("failed", `${label} failed: ${String(error)}`, null);
  } finally {
    if (conn) sshManager.disconnect(conn);
  }
}

/**
 * Returns the result to stop with when the upgrade must not go ahead. A resumed
 * upgrade already ran its pre-upgrade script before the dashboard restarted.
 */
async function runPreUpgradeHook(
  session: UpgradeHookSession,
  resuming: boolean,
): Promise<OperationResult | null> {
  const { systemId } = session;
  if (session.setupError) {
    session.postOutcome = null;
    const message = `Could not prepare the upgrade scripts: ${session.setupError}`;
    outputStream.publish(systemId, { type: "error", message });
    return { success: false, output: message, hookFailed: true };
  }

  // The flag is already set by the interrupted run, so it cannot answer this any more.
  const interrupted = session.resumeHook?.phase === "pre_upgrade" ? session.resumeHook : undefined;
  if (session.postSteps.length > 0) {
    session.wasPostPending = interrupted
      ? interrupted.wasPostPending
      : !!systemService.getSystem(systemId)?.postUpgradePendingAt;
    if (!session.wasPostPending) systemService.setPostUpgradePending(systemId, true);
  }
  if (resuming || (!interrupted && session.preSteps.length === 0)) {
    session.preStagePassed = true;
    return null;
  }

  const steps = interrupted?.steps ?? session.preSteps;
  const reportProgress = (stepIndex: number, persistentInfo: PersistentCommandInfo | null, warnings: string[] = []) => {
    session.onHookProgress?.({
      phase: "pre_upgrade",
      steps,
      stepIndex,
      persistentInfo,
      wasPostPending: session.wasPostPending,
      ...(warnings.length ? { warnings } : {}),
    });
  };
  if (!interrupted) reportProgress(0, null);
  const result = await runUpgradeHookSteps(
    systemId,
    "pre_upgrade",
    steps,
    { LUDASH_OPERATION: session.operation },
    { resume: interrupted, onProgress: reportProgress },
  );
  if (result.status === "success" || result.status === "warning") {
    session.preStagePassed = true;
    if (result.status === "warning") session.preWarning = result.message;
    return null;
  }

  session.postOutcome = null;
  // Exiting non-zero, or an output rule failing a finished step, is a deliberate veto
  // and the script undoes its own work, so only a run with an unknown end state still
  // needs the post-upgrade script.
  const endStateKnown = !result.remoteStarted || (result.exitCode !== null && result.exitCode >= 0);
  if (session.postSteps.length > 0 && !session.wasPostPending && endStateKnown) {
    systemService.setPostUpgradePending(systemId, false);
  }
  if (result.status !== "cancelled") {
    return { success: false, output: result.message, hookFailed: true };
  }
  // Cancelling is not a veto, so the script may have stopped halfway. Later nodes
  // wait whenever this one may still need recovery.
  const recoveryPending = !endStateKnown || session.wasPostPending;
  return {
    success: false,
    output: result.message,
    cancelled: true,
    ...(recoveryPending ? { hookFailed: true } : {}),
  };
}

async function runPostUpgradeHook(
  session: UpgradeHookSession,
  result: OperationResult,
  completion?: { recheck: boolean },
): Promise<PostUpgradeOutcome | null> {
  if (session.postOutcome !== undefined) return session.postOutcome;
  if (!session.preStagePassed) {
    session.postOutcome = null;
    return null;
  }
  const { systemId } = session;

  if (session.postSteps.length === 0) {
    session.postOutcome = null;
    return null;
  }

  if (session.postBlockedReason) {
    const message = `${UPGRADE_HOOK_LABELS.post_upgrade} did not run: ${session.postBlockedReason}`;
    outputStream.publish(systemId, { type: "warning", message });
    session.postOutcome = { status: "skipped", message };
    return session.postOutcome;
  }

  // Claim the run first so a failure later in finalizing cannot start it twice.
  session.postOutcome = { status: "failed", message: `${UPGRADE_HOOK_LABELS.post_upgrade} did not finish` };
  renewActiveOperationSignal(systemId);
  const interrupted = session.resumeHook?.phase === "post_upgrade" ? session.resumeHook : undefined;
  const reportProgress = (stepIndex: number, persistentInfo: PersistentCommandInfo | null, warnings: string[] = []) => {
    session.onHookProgress?.({
      phase: "post_upgrade",
      steps: session.postSteps,
      stepIndex,
      persistentInfo,
      upgradeResult: { ...result, output: sanitizeOutput(result.output).slice(0, STEP_ERROR_LIMIT) },
      completion,
      ...(warnings.length ? { warnings } : {}),
    });
  };
  if (!interrupted) reportProgress(0, null);
  const hookResult = await runUpgradeHookSteps(
    systemId,
    "post_upgrade",
    session.postSteps,
    {
      LUDASH_OPERATION: session.operation,
      LUDASH_UPGRADE_RESULT: upgradeResultEnv(result),
    },
    { connectAttempts: POST_UPGRADE_CONNECT_ATTEMPTS, resume: interrupted, onProgress: reportProgress },
  );
  if (hookResult.status === "success" || hookResult.status === "warning") {
    systemService.setPostUpgradePending(systemId, false);
  }
  session.postOutcome = { status: hookResult.status, message: hookResult.message };
  return session.postOutcome;
}

/**
 * The one exit for an upgrade: runs the post-upgrade script, then the recheck,
 * then publishes `done`. Every path that leaves an upgrade must disconnect first,
 * because the script needs its own connection from the same limited pool.
 */
async function finalizeUpgrade(
  session: UpgradeHookSession,
  result: OperationResult,
  completion?: { recheck: boolean },
): Promise<OperationResult> {
  const { systemId } = session;
  // Warnings from the pre-upgrade script belong to the upgrade, including the
  // result the post-upgrade script receives.
  // The message is kept even when the upgrade has its own warning or failed.
  const upgradeResult: OperationResult = session.preWarning
    ? {
        ...result,
        ...(result.success ? { warning: true } : {}),
        output: [result.output, session.preWarning].filter(Boolean).join("\n\n"),
      }
    : result;
  const post = await runPostUpgradeHook(session, upgradeResult, completion);

  if (completion) {
    if (completion.recheck) {
      // Cancelling the script should not also cancel the recheck after a real upgrade.
      if (post?.status === "cancelled") renewActiveOperationSignal(systemId);
      setActiveOperationPhase(systemId, "rechecking");
      await requestNotificationRuntimeSystemSync(systemId);
      outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
      await checkUpdatesUnlocked(systemId, true);
    }
    syncSystemNotificationHash(systemId);
  }

  const merged: OperationResult = !post || post.status === "success"
    ? upgradeResult
    : post.status === "warning"
      ? {
          ...upgradeResult,
          warning: upgradeResult.success || upgradeResult.warning,
          output: [upgradeResult.output, post.message].filter(Boolean).join("\n\n"),
        }
      : {
          ...upgradeResult,
          success: false,
          warning: false,
          hookFailed: true,
          cancelled: upgradeResult.cancelled || post.status === "cancelled",
          output: [upgradeResult.output, post.message].filter(Boolean).join("\n\n"),
        };
  outputStream.publish(systemId, {
    type: "done",
    success: merged.success,
    ...(merged.warning ? { warning: true } : {}),
    completedAt: getCurrentTimestamp(),
  });
  return merged;
}

/** Re-runs a post-upgrade script that did not finish, from the system page. */
export async function runPendingPostUpgradeScript(systemId: number): Promise<OperationResult> {
  return withLock(systemId, async () => {
    const system = systemService.getSystem(systemId);
    if (!system) return { success: false, output: "System not found" };
    setActiveOperation(systemId, { type: "post_upgrade", startedAt: getCurrentTimestamp() });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
      const steps = resolveRuntimeSteps({ systemId, operation: "post_upgrade" });
      if (steps.length === 0) {
        const output = "No post-upgrade script is assigned to this system";
        outputStream.publish(systemId, { type: "error", message: output });
        outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
        return { success: false, output };
      }
      const result = await runUpgradeHookSteps(systemId, "post_upgrade", steps, {
        LUDASH_OPERATION: "manual",
        LUDASH_UPGRADE_RESULT: "unknown",
      });
      const success = result.status === "success" || result.status === "warning";
      if (success) systemService.setPostUpgradePending(systemId, false);
      const warning = result.status === "warning";
      outputStream.publish(systemId, {
        type: "done",
        success,
        ...(warning ? { warning: true } : {}),
        completedAt: getCurrentTimestamp(),
      });
      return {
        success,
        output: result.message,
        cancelled: result.status === "cancelled",
        hookFailed: !success,
        ...(warning ? { warning: true } : {}),
      };
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

export async function applyUpgradeAll(
  systemId: number,
  options?: UpgradeAllExecutionOptions,
): Promise<OperationResult> {
  return withLock(systemId, async () => {
    let unfinishedHistoryId = options?.resume?.historyId ?? options?.queuedHistoryId;
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "upgrade_all", startedAt: now });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }
    if (options?.resumeHook?.phase === "post_upgrade") {
      // The upgrade already ended before the restart, so only its script is left.
      const hooks = createUpgradeHookSession(systemId, "upgrade_all", options);
      hooks.postSteps = options.resumeHook.steps;
      hooks.preStagePassed = true;
      return await finalizeUpgrade(hooks, options.resumeHook.upgradeResult, options.resumeHook.completion);
    }
    const pkgManagerConfigs = withDefaultUpgradeModeOverride(
      getSystemPackageManagerConfigs(system),
      options?.defaultUpgradeModeOverride,
    );

    const db = getDb();
    const pkgManagers = getUpgradeAllPkgManagers(systemId, system);

    if (!pkgManagers.length) {
      if (options?.queuedHistoryId) {
        finishEntry(options.queuedHistoryId, "failed", {
          error: "No package manager detected",
        });
      }
      return { success: false, output: "No package manager detected" };
    }

    const allCommands: string[] = [];
    const allOutputs: string[] = [];
    let overallSuccess = true;
    let reconnectionUsed = false;
    let ruleWarning = false;

    const sshManager = getSSHManager();
    const signal = getCancellationSignal(systemId);
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    const hooks = createUpgradeHookSession(systemId, "upgrade_all", options);
    try {
      throwIfActiveOperationCancelled(systemId);
      const preHookStop = await runPreUpgradeHook(hooks, !!options?.resume);
      if (preHookStop) {
        if (options?.queuedHistoryId) {
          finishEntry(options.queuedHistoryId, preHookStop.cancelled ? "cancelled" : "failed", {
            error: preHookStop.output,
          });
          unfinishedHistoryId = undefined;
        }
        return await finalizeUpgrade(hooks, preHookStop);
      }
      throwIfActiveOperationCancelled(systemId);
      if (!options?.resume) {
        publishSshConnectionStep(
          (msg) => outputStream.publish(systemId, msg),
          getStoredActiveOperation(systemId)?.startedAt ?? getCurrentTimestamp(),
        );
        conn = await sshManager.connect(system as Record<string, unknown>, {
          systemId,
        });
        throwIfActiveOperationCancelled(systemId);
      }

      const resumeIndex = options?.resume
        ? pkgManagers.findIndex((pmName) => pmName === options.resume?.pkgManager)
        : -1;
      const startIndex = resumeIndex >= 0 ? resumeIndex : 0;

      for (const pmName of pkgManagers.slice(startIndex)) {
        throwIfActiveOperationCancelled(systemId);
        const steps = resolveRuntimeSteps({
          systemId,
          operation: "upgrade_all",
          pkgManager: pmName,
          pkgManagerConfig: getManagerConfig(pkgManagerConfigs, pmName),
        });
        const isResumeStep = options?.resume?.pkgManager === pmName;
        // A resumed process already has its environment; the secrets are only
        // needed to keep redacting its output.
        const secretInput = isResumeStep
          ? resolveSecretInputForRedaction(system, pmName)
          : resolveSecretInput(system, pmName);
        const maintenanceCommand = buildMaintenanceCommand(steps);
        const cmd = isResumeStep
          ? options!.resume!.command
          : maintenanceCommand && withSecretEnvNote(maintenanceCommand, secretInput);
        if (!cmd) continue;
        if (!isResumeStep && !conn) {
          conn = await sshManager.connect(system as Record<string, unknown>, {
            systemId,
          });
          throwIfActiveOperationCancelled(systemId);
        }
        allCommands.push(cmd);
        const stepStartedAt = getCurrentTimestamp();
        const histId =
          isResumeStep
            ? options.resume!.historyId
            : options?.queuedHistoryId && allCommands.length === 1 && startIndex === 0
              ? options.queuedHistoryId
              : insertStartedEntry(systemId, "upgrade_all", pmName, cmd, stepStartedAt);
        unfinishedHistoryId = histId;
        if (isResumeStep || histId === options?.queuedHistoryId) {
          markEntryStarted(histId, pmName, cmd, stepStartedAt);
        }
        const preCount = db
          .select()
          .from(updateCache)
          .where(eq(updateCache.systemId, systemId))
          .all().length;
        options?.onStepStarted?.({
          historyId: histId,
          pkgManager: pmName,
          command: cmd,
          preUpgradeUpdateCount: preCount,
        });
        outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName, startedAt: stepStartedAt });
        let streamedOutput = "";

        const onDataCb = (chunk: string, stream: "stdout" | "stderr") => {
          streamedOutput += chunk;
          outputStream.publish(systemId, { type: "output", data: chunk, stream });
        };

        const result = isResumeStep
          ? await attemptReconnection(
              systemId,
              options!.resume!.persistentInfo,
              options!.resume!.preUpgradeUpdateCount,
              onDataCb,
              secretInput,
            )
          : await sshManager.runPersistentCommand(
              conn!,
              cmd,
              3600,
              sudoPassword,
              onDataCb,
              {
                signal,
                secretInput,
                onPersistentInfo: (info) => {
                  setActiveOperationPersistentInfo(systemId, info);
                  options?.onPersistentInfo?.({
                    historyId: histId,
                    pkgManager: pmName,
                    command: cmd,
                    info,
                  });
                },
              },
            );

        let { stdout, stderr, exitCode } = result;
        let inferred = "serverRebooted" in result && result.serverRebooted === true;
        if ("timedOut" in result && result.timedOut) {
          hooks.postBlockedReason = UPGRADE_STATE_UNKNOWN_REASON;
        }

        if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
          // Connection lost — attempt reconnection
          try { sshManager.disconnect(conn!); } catch {}
          conn = undefined;

          const reconResult = await attemptReconnection(
            systemId,
            result.persistentInfo,
            preCount,
            onDataCb,
            secretInput,
          );
          if (reconResult.timedOut) hooks.postBlockedReason = UPGRADE_STATE_UNKNOWN_REASON;

          stdout = reconResult.stdout || stdout;
          stderr = reconResult.stderr;
          exitCode = reconResult.exitCode;
          inferred = reconResult.serverRebooted;
          reconnectionUsed = true;
        }

        if (isCancelledResult(exitCode)) {
          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || stdout || stderr;
          finishEntry(histId, "cancelled", {
            steps: createSingleStepHistory({
              label: null,
              pkgManager: pmName,
              command: cmd,
              output: combinedOutput,
              error: "Operation cancelled",
              status: "cancelled",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }),
            output: stdout.slice(0, STEP_OUTPUT_LIMIT),
            error: "Operation cancelled",
          });
          outputStream.publish(systemId, { type: "warning", message: "Operation cancelled" });
          if (conn) {
            sshManager.disconnect(conn);
            conn = undefined;
          }
          return await finalizeUpgrade(hooks, { success: false, output: "Operation cancelled", cancelled: true });
        }

        const stepCompletedAt = getCurrentTimestamp();
        const combinedOutput = streamedOutput || stdout || stderr;
        const outcome = classifyMaintenanceCommand({
          systemId,
          pmName,
          steps,
          stdout,
          stderr,
          exitCode,
          combinedOutput,
          inferred,
          reconnectionUsed,
        });
        if (!outcome.success) overallSuccess = false;
        if (outcome.status === "warning" && !reconnectionUsed) ruleWarning = true;
        allOutputs.push(outcome.output);

        finishEntry(histId, outcome.status, {
          steps: createSingleStepHistory({
            label: null,
            pkgManager: pmName,
            command: cmd,
            output: combinedOutput,
            error: outcome.stepError,
            status: outcome.status,
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }),
          output: stdout.slice(0, STEP_OUTPUT_LIMIT),
          error: outcome.stepError?.slice(0, 2000),
        });
        unfinishedHistoryId = undefined;

        // If connection was lost, can't continue with remaining package managers
        if (reconnectionUsed) break;
      }

      if (allCommands.length === 0 && options?.queuedHistoryId) {
        finishEntry(options.queuedHistoryId, "failed", {
          error: "No upgrade command available",
        });
        if (conn) {
          sshManager.disconnect(conn);
          conn = undefined;
        }
        return await finalizeUpgrade(hooks, { success: false, output: "No upgrade command available" });
      }

      // Re-check after upgrade (skip if reconnection already ran one)
      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      return await finalizeUpgrade(
        hooks,
        { success: overallSuccess, output: allOutputs.join("\n\n"), warning: (reconnectionUsed || ruleWarning) && overallSuccess },
        { recheck: !reconnectionUsed },
      );
    } catch (e) {
      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      if (isOperationCancelledError(e)) {
        if (unfinishedHistoryId) finishEntry(unfinishedHistoryId, "cancelled", { error: e.message });
        outputStream.publish(systemId, { type: "warning", message: e.message });
        return await finalizeUpgrade(hooks, { success: false, output: e.message, cancelled: true });
      }
      if (unfinishedHistoryId) {
        finishEntry(unfinishedHistoryId, "failed", { error: String(e) });
      } else logHistory(
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
      return await finalizeUpgrade(hooks, { success: false, output: String(e) });
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
    return resolveRuntimeSteps({
      systemId,
      operation: "full_upgrade_all",
      pkgManager: pmName,
      pkgManagerConfig: getManagerConfig(pkgManagerConfigs, pmName),
    }).length > 0;
  });
}

export interface AutoremoveSupport {
  supportedManagers: string[];
  skippedManagers: string[];
}

export function getAutoremoveSupport(systemId: number): AutoremoveSupport {
  const system = systemService.getSystem(systemId);
  if (!system) return { supportedManagers: [], skippedManagers: [] };
  const pkgManagerConfigs = getSystemPackageManagerConfigs(system);
  const supportedManagers: string[] = [];
  const skippedManagers: string[] = [];

  for (const pmName of systemService.getActivePkgManagers(system)) {
    const steps = resolveRuntimeSteps({
      systemId,
      operation: "autoremove",
      pkgManager: pmName,
      pkgManagerConfig: getManagerConfig(pkgManagerConfigs, pmName),
    });
    (steps[0]?.command ? supportedManagers : skippedManagers).push(pmName);
  }

  return { supportedManagers, skippedManagers };
}

export async function applyAutoremove(systemId: number): Promise<OperationResult> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "autoremove", startedAt: now });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
      const system = systemService.getSystem(systemId);
      if (!system) return { success: false, output: "System not found" };

      const pkgManagerConfigs = getSystemPackageManagerConfigs(system);
      const { supportedManagers } = getAutoremoveSupport(systemId);
      if (!supportedManagers.length) {
        return { success: false, output: "Autoremove is not supported for this system" };
      }

      const allCommands: string[] = [];
      const allOutputs: string[] = [];
      let overallSuccess = true;
      let monitoringLost = false;
      let ruleWarning = false;
      const sshManager = getSSHManager();
      const signal = getCancellationSignal(systemId);
      const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
      let conn;

      try {
        throwIfActiveOperationCancelled(systemId);
        publishSshConnectionStep(
          (msg) => outputStream.publish(systemId, msg),
          getStoredActiveOperation(systemId)?.startedAt ?? getCurrentTimestamp(),
        );
        conn = await sshManager.connect(system as Record<string, unknown>, { systemId });
        throwIfActiveOperationCancelled(systemId);

        for (const pmName of supportedManagers) {
          throwIfActiveOperationCancelled(systemId);
          const steps = resolveRuntimeSteps({
            systemId,
            operation: "autoremove",
            pkgManager: pmName,
            pkgManagerConfig: getManagerConfig(pkgManagerConfigs, pmName),
          });
          const maintenanceCommand = buildMaintenanceCommand(steps);
          if (!maintenanceCommand) continue;
          const secretInput = resolveSecretInput(system, pmName);
          const cmd = withSecretEnvNote(maintenanceCommand, secretInput);

          allCommands.push(cmd);
          const stepStartedAt = getCurrentTimestamp();
          const histId = insertStartedEntry(systemId, "autoremove", pmName, cmd, stepStartedAt);
          outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: pmName, startedAt: stepStartedAt });
          let streamedOutput = "";
          let result;
          try {
            result = await sshManager.runPersistentCommand(
              conn,
              cmd,
              3600,
              sudoPassword,
              (chunk, stream) => {
                streamedOutput += chunk;
                outputStream.publish(systemId, { type: "output", data: chunk, stream });
              },
              {
                signal,
                secretInput,
                onPersistentInfo: (info) => setActiveOperationPersistentInfo(systemId, info),
              },
            );
          } catch (error) {
            if (isOperationCancelledError(error)) throw error;
            result = { stdout: "", stderr: String(error), exitCode: -1 };
          }
          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || result.stdout || result.stderr;

          if (isCancelledResult(result.exitCode)) {
            finishEntry(histId, "cancelled", {
              steps: createSingleStepHistory({
                label: null,
                pkgManager: pmName,
                command: cmd,
                output: combinedOutput,
                error: "Operation cancelled",
                status: "cancelled",
                startedAt: stepStartedAt,
                completedAt: stepCompletedAt,
              }),
              output: result.stdout.slice(0, STEP_OUTPUT_LIMIT),
              error: "Operation cancelled",
            });
            outputStream.publish(systemId, { type: "warning", message: "Operation cancelled" });
            outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
            return { success: false, output: "Operation cancelled", cancelled: true };
          }

          if (result.exitCode === EXIT_MONITORING_LOST) {
            monitoringLost = true;
            overallSuccess = false;
            const warning = "SSH connection lost while autoremove was running. The remote process may still be running.";
            allOutputs.push(`[${pmName}] ${warning}`);
            finishEntry(histId, "warning", {
              steps: createSingleStepHistory({
                label: null,
                pkgManager: pmName,
                command: cmd,
                output: combinedOutput,
                error: warning,
                status: "warning",
                startedAt: stepStartedAt,
                completedAt: stepCompletedAt,
              }),
              output: result.stdout.slice(0, STEP_OUTPUT_LIMIT),
              error: warning,
            });
            outputStream.publish(systemId, { type: "warning", message: warning });
            break;
          }

          const outcome = classifyMaintenanceCommand({
            systemId,
            pmName,
            steps,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            combinedOutput,
            inferred: false,
            reconnectionUsed: false,
          });
          if (!outcome.success) overallSuccess = false;
          if (outcome.status === "warning") ruleWarning = true;
          allOutputs.push(outcome.output);
          finishEntry(histId, outcome.status, {
            steps: createSingleStepHistory({
              label: null,
              pkgManager: pmName,
              command: cmd,
              output: combinedOutput,
              error: outcome.stepError,
              status: outcome.status,
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }),
            output: result.stdout.slice(0, STEP_OUTPUT_LIMIT),
            error: outcome.stepError?.slice(0, STEP_ERROR_LIMIT),
          });
        }

        if (conn) {
          sshManager.disconnect(conn);
          conn = undefined;
        }
        if (!monitoringLost) {
          setActiveOperationPhase(systemId, "rechecking");
          await requestNotificationRuntimeSystemSync(systemId);
          outputStream.publish(systemId, { type: "phase", phase: "rechecking" });
          await checkUpdatesUnlocked(systemId, true);
          syncSystemNotificationHash(systemId);
        }

        const combinedOutput = allOutputs.join("\n\n");
        const warning = monitoringLost || (ruleWarning && overallSuccess);
        outputStream.publish(systemId, {
          type: "done",
          success: overallSuccess,
          ...(warning && overallSuccess ? { warning: true } : {}),
          completedAt: getCurrentTimestamp(),
        });
        return { success: overallSuccess, output: combinedOutput, warning };
      } catch (error) {
        if (isOperationCancelledError(error)) {
          outputStream.publish(systemId, { type: "warning", message: error.message });
          outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
          return { success: false, output: error.message, cancelled: true };
        }
        logHistory(systemId, "autoremove", supportedManagers.join(","), "failed", {
          command: allCommands.join(" && "),
          error: String(error),
        });
        outputStream.publish(systemId, { type: "error", message: String(error) });
        outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
        return { success: false, output: String(error) };
      } finally {
        if (conn) sshManager.disconnect(conn);
      }
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

export async function applyFullUpgradeAll(
  systemId: number
): Promise<OperationResult> {
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
    let ruleWarning = false;

    const sshManager = getSSHManager();
    const signal = getCancellationSignal(systemId);
    const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
    let conn;
    const hooks = createUpgradeHookSession(systemId, "full_upgrade_all");
    try {
      throwIfActiveOperationCancelled(systemId);
      const preHookStop = await runPreUpgradeHook(hooks, false);
      if (preHookStop) return await finalizeUpgrade(hooks, preHookStop);
      throwIfActiveOperationCancelled(systemId);
      publishSshConnectionStep(
        (msg) => outputStream.publish(systemId, msg),
        getStoredActiveOperation(systemId)?.startedAt ?? getCurrentTimestamp(),
      );
      conn = await sshManager.connect(system as Record<string, unknown>, {
        systemId,
      });
      throwIfActiveOperationCancelled(systemId);

      for (const pmName of pkgManagers) {
        throwIfActiveOperationCancelled(systemId);
        const managerConfig = getManagerConfig(pkgManagerConfigs, pmName);
        let steps = resolveRuntimeSteps({
          systemId,
          operation: "full_upgrade_all",
          pkgManager: pmName,
          pkgManagerConfig: managerConfig,
        });
        if (!steps.length) {
          steps = resolveRuntimeSteps({
            systemId,
            operation: "upgrade_all",
            pkgManager: pmName,
            pkgManagerConfig: managerConfig,
          });
        }
        const maintenanceCommand = buildMaintenanceCommand(steps);
        if (!maintenanceCommand) continue;
        const secretInput = resolveSecretInput(system, pmName);
        const cmd = withSecretEnvNote(maintenanceCommand, secretInput);
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
          {
            signal,
            secretInput,
            onPersistentInfo: (info) => setActiveOperationPersistentInfo(systemId, info),
          },
        );

        let { stdout, stderr, exitCode } = result;
        let inferred = false;

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
            secretInput,
          );
          if (reconResult.timedOut) hooks.postBlockedReason = UPGRADE_STATE_UNKNOWN_REASON;

          stdout = reconResult.stdout || stdout;
          stderr = reconResult.stderr;
          exitCode = reconResult.exitCode;
          inferred = reconResult.serverRebooted;
          reconnectionUsed = true;
        }

        if (isCancelledResult(exitCode)) {
          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || stdout || stderr;
          finishEntry(histId, "cancelled", {
            steps: createSingleStepHistory({
              label: null,
              pkgManager: pmName,
              command: cmd,
              output: combinedOutput,
              error: "Operation cancelled",
              status: "cancelled",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }),
            output: stdout.slice(0, STEP_OUTPUT_LIMIT),
            error: "Operation cancelled",
          });
          outputStream.publish(systemId, { type: "warning", message: "Operation cancelled" });
          if (conn) {
            sshManager.disconnect(conn);
            conn = undefined;
          }
          return await finalizeUpgrade(hooks, { success: false, output: "Operation cancelled", cancelled: true });
        }

        const stepCompletedAt = getCurrentTimestamp();
        const combinedOutput = streamedOutput || stdout || stderr;
        const outcome = classifyMaintenanceCommand({
          systemId,
          pmName,
          steps,
          stdout,
          stderr,
          exitCode,
          combinedOutput,
          inferred,
          reconnectionUsed,
        });
        if (!outcome.success) overallSuccess = false;
        if (outcome.status === "warning" && !reconnectionUsed) ruleWarning = true;
        allOutputs.push(outcome.output);

        finishEntry(histId, outcome.status, {
          steps: createSingleStepHistory({
            label: null,
            pkgManager: pmName,
            command: cmd,
            output: combinedOutput,
            error: outcome.stepError,
            status: outcome.status,
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }),
          output: stdout.slice(0, STEP_OUTPUT_LIMIT),
          error: outcome.stepError?.slice(0, 2000),
        });

        // If connection was lost, can't continue with remaining package managers
        if (reconnectionUsed) break;
      }

      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      return await finalizeUpgrade(
        hooks,
        { success: overallSuccess, output: allOutputs.join("\n\n"), warning: (reconnectionUsed || ruleWarning) && overallSuccess },
        { recheck: !reconnectionUsed },
      );
    } catch (e) {
      if (conn) {
        sshManager.disconnect(conn);
        conn = undefined;
      }
      if (isOperationCancelledError(e)) {
        outputStream.publish(systemId, { type: "warning", message: e.message });
        return await finalizeUpgrade(hooks, { success: false, output: e.message, cancelled: true });
      }
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
      return await finalizeUpgrade(hooks, { success: false, output: String(e) });
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
): Promise<OperationResult> {
  return applyUpgradePackages(systemId, [packageName]);
}

export async function applyUpgradePackages(
  systemId: number,
  packageNames: string[],
): Promise<OperationResult> {
  return withLock(systemId, async () => {
    const system = systemService.getSystem(systemId);
    if (!system) {
      return { success: false, output: "System not found" };
    }
    const pkgManagerConfigs = getSystemPackageManagerConfigs(system);

    let selected: SelectedPackageUpgradeResolution;
    try {
      selected = resolveSelectedPackageUpgrades(systemId, packageNames);
    } catch (error) {
      return { success: false, output: String(error instanceof Error ? error.message : error) };
    }

    const now = getCurrentTimestamp();
    setActiveOperation(systemId, {
      type: "upgrade_package",
      startedAt: now,
      packageName: selected.packageNames[0],
      packageNames: selected.packageNames,
    });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);

    try {
      const groupedUpdates = new Map<string, string[]>();
      for (const update of selected.updates) {
        const packagesForManager = groupedUpdates.get(update.pkgManager) ?? [];
        packagesForManager.push(update.packageName);
        groupedUpdates.set(update.pkgManager, packagesForManager);
      }

      const sshManager = getSSHManager();
      const signal = getCancellationSignal(systemId);
      const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
      const selectedPackagesJson = JSON.stringify(selected.packageNames);
      const allCommands: string[] = [];
      const allOutputs: string[] = [];
      let overallSuccess = true;
      let reconnectionUsed = false;
      let ruleWarning = false;
      let conn;
      const hooks = createUpgradeHookSession(systemId, "upgrade_package");

      try {
        throwIfActiveOperationCancelled(systemId);
        const preHookStop = await runPreUpgradeHook(hooks, false);
        if (preHookStop) return await finalizeUpgrade(hooks, preHookStop);
        throwIfActiveOperationCancelled(systemId);
        publishSshConnectionStep(
          (msg) => outputStream.publish(systemId, msg),
          getStoredActiveOperation(systemId)?.startedAt ?? getCurrentTimestamp(),
        );
        conn = await sshManager.connect(system as Record<string, unknown>, {
          systemId,
        });
        throwIfActiveOperationCancelled(systemId);

        for (const [pmName, packagesForManager] of groupedUpdates) {
          throwIfActiveOperationCancelled(systemId);
          const steps = resolveRuntimeSteps({
            systemId,
            operation: "upgrade_selected",
            pkgManager: pmName,
            pkgManagerConfig: getManagerConfig(pkgManagerConfigs, pmName),
            packages: packagesForManager,
          });
          const maintenanceCommand = buildMaintenanceCommand(steps);
          if (!maintenanceCommand) {
            overallSuccess = false;
            allOutputs.push(`[${pmName}] No selected-package upgrade script`);
            continue;
          }
          const secretInput = resolveSecretInput(system, pmName);
          const cmd = withSecretEnvNote(maintenanceCommand, secretInput);
          allCommands.push(cmd);

          const stepStartedAt = getCurrentTimestamp();
          const histId = insertStartedEntry(systemId, "upgrade_package", pmName, cmd, stepStartedAt);
          outputStream.publish(systemId, {
            type: "started",
            command: cmd,
            pkgManager: pmName,
            startedAt: stepStartedAt,
          });

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
            {
              signal,
              secretInput,
              onPersistentInfo: (info) => setActiveOperationPersistentInfo(systemId, info),
            },
          );

          let { stdout, stderr, exitCode } = result;
          let inferred = false;

          if (exitCode === EXIT_MONITORING_LOST && result.persistentInfo) {
            try { sshManager.disconnect(conn!); } catch {}
            conn = null;

            const reconResult = await attemptReconnection(
              systemId,
              result.persistentInfo,
              selected.packageNames.length,
              onDataCb,
              secretInput,
            );
            if (reconResult.timedOut) hooks.postBlockedReason = UPGRADE_STATE_UNKNOWN_REASON;

            stdout = reconResult.stdout || stdout;
            stderr = reconResult.stderr;
            exitCode = reconResult.exitCode;
            inferred = reconResult.serverRebooted;
            reconnectionUsed = true;
          }

          if (isCancelledResult(exitCode)) {
            const stepCompletedAt = getCurrentTimestamp();
            const combinedOutput = streamedOutput || stdout || stderr;
            finishEntry(histId, "cancelled", {
              packageCount: selected.packageNames.length,
              packages: selectedPackagesJson,
              steps: createSingleStepHistory({
                label: null,
                pkgManager: pmName,
                command: cmd,
                output: combinedOutput,
                error: "Operation cancelled",
                status: "cancelled",
                startedAt: stepStartedAt,
                completedAt: stepCompletedAt,
              }),
              output: stdout.slice(0, STEP_OUTPUT_LIMIT),
              error: "Operation cancelled",
            });
            outputStream.publish(systemId, { type: "warning", message: "Operation cancelled" });
            if (conn) {
              sshManager.disconnect(conn);
              conn = null;
            }
            return await finalizeUpgrade(hooks, { success: false, output: "Operation cancelled", cancelled: true });
          }

          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || stdout || stderr;
          const outcome = classifyMaintenanceCommand({
            systemId,
            pmName,
            steps,
            stdout,
            stderr,
            exitCode,
            combinedOutput,
            inferred,
            reconnectionUsed,
          });
          if (!outcome.success) overallSuccess = false;
          if (outcome.status === "warning" && !reconnectionUsed) ruleWarning = true;
          finishEntry(histId, outcome.status, {
            packageCount: selected.packageNames.length,
            packages: selectedPackagesJson,
            steps: createSingleStepHistory({
              label: null,
              pkgManager: pmName,
              command: cmd,
              output: combinedOutput,
              error: outcome.stepError,
              status: outcome.status,
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }),
            output: stdout.slice(0, STEP_OUTPUT_LIMIT),
            error: outcome.stepError?.slice(0, 2000),
          });
          allOutputs.push(outcome.output);

          if (reconnectionUsed) break;
        }

        if (conn) {
          sshManager.disconnect(conn);
          conn = null;
        }

        return await finalizeUpgrade(
          hooks,
          {
            success: overallSuccess,
            output: allOutputs.join("\n\n"),
            warning: (reconnectionUsed || ruleWarning) && overallSuccess,
          },
          { recheck: !reconnectionUsed },
        );
      } catch (e) {
        if (conn) {
          sshManager.disconnect(conn);
          conn = null;
        }
        if (isOperationCancelledError(e)) {
          outputStream.publish(systemId, { type: "warning", message: e.message });
          return await finalizeUpgrade(hooks, { success: false, output: e.message, cancelled: true });
        }
        logHistory(systemId, "upgrade_package", Array.from(groupedUpdates.keys()).join(","), "failed", {
          packageCount: selected.packageNames.length,
          packages: selectedPackagesJson,
          command: allCommands.join(" && "),
          steps: allCommands.length
            ? createSingleStepHistory({
                label: null,
                pkgManager: Array.from(groupedUpdates.keys())[0] || "unknown",
                command: allCommands[allCommands.length - 1] || allCommands[0],
                output: null,
                error: String(e),
                status: "failed",
              })
            : undefined,
          error: String(e),
        });
        outputStream.publish(systemId, { type: "error", message: String(e) });
        return await finalizeUpgrade(hooks, { success: false, output: String(e) });
      } finally {
        if (conn) sshManager.disconnect(conn);
      }
    } finally {
      clearActiveOperation(systemId);
      await requestNotificationRuntimeSystemSync(systemId);
    }
  });
}

const PRE_REBOOT_SAFETY_CHECKS_LABEL = "Pre-reboot safety checks";
const SSH_CONNECT_STEP_LABEL = "Connect over SSH";

function publishSshConnectionStep(
  publish: (msg: outputStream.WsMessage) => void,
  startedAt: string,
  pkgManager = "system",
): void {
  publish({
    type: "started",
    command: "",
    pkgManager,
    startedAt,
  });
  publish({ type: "phase", phase: SSH_CONNECT_STEP_LABEL });
}

function isProxmoxBackupGuardStep(step: { label: string | null }): boolean {
  return step.label === PRE_REBOOT_SAFETY_CHECKS_LABEL;
}

function normalizeProxmoxBackupGuardMessage(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const blockedLine = lines.find((line) => line.startsWith("Reboot blocked:"));
  if (blockedLine) return blockedLine;
  return "Reboot blocked: could not verify Proxmox backup activity.";
}

export async function rebootSystem(systemId: number): Promise<RebootResult> {
  return withLock(systemId, async () => {
    const now = getCurrentTimestamp();
    setActiveOperation(systemId, { type: "reboot", startedAt: now });
    await requestNotificationRuntimeSystemSync(systemId);
    outputStream.resetStream(systemId);
    try {
      const system = systemService.getSystem(systemId);
      if (!system) return { success: false, message: "System not found" };

      const sshManager = getSSHManager();
      const signal = getCancellationSignal(systemId);
      const sudoPassword = systemService.getSudoPassword(system as Record<string, unknown>);
      const steps = resolveRuntimeSteps({ systemId, operation: "reboot" });
      if (!steps.length) return { success: false, message: "No reboot script configured" };
      const historyStartedAt = getCurrentTimestamp();
      const histId = insertStartedEntry(
        systemId,
        "reboot",
        "system",
        steps.map((step) => step.command).join(" && "),
        historyStartedAt,
      );
      const activitySteps: ActivityStep[] = [];
      let connectionStep: ActivityStep | null = null;
      const getStoredSteps = () => connectionStep ? [connectionStep, ...activitySteps] : activitySteps;

      let conn;
      try {
        throwIfActiveOperationCancelled(systemId);
        publishSshConnectionStep((msg) => outputStream.publish(systemId, msg), historyStartedAt);
        conn = await sshManager.connect(system as Record<string, unknown>, {
          systemId,
        });
        connectionStep = createActivityStep({
          label: SSH_CONNECT_STEP_LABEL,
          pkgManager: "system",
          command: "",
          output: null,
          error: null,
          status: "success",
          startedAt: historyStartedAt,
          completedAt: getCurrentTimestamp(),
        });
        throwIfActiveOperationCancelled(systemId);

        for (const step of steps) {
          const cmd = step.command;
          const label = step.label || null;
          const stepStartedAt = getCurrentTimestamp();
          outputStream.publish(systemId, { type: "started", command: cmd, pkgManager: "system", startedAt: stepStartedAt });
          if (label) outputStream.publish(systemId, { type: "phase", phase: label });

          let streamedOutput = "";
          const result = await sshManager.runCommand(conn, cmd, 30, sudoPassword, (chunk, stream) => {
            streamedOutput += chunk;
            outputStream.publish(systemId, { type: "output", data: chunk, stream });
          }, signal);
          const stepCompletedAt = getCurrentTimestamp();
          const combinedOutput = streamedOutput || result.stdout || result.stderr;

          if (isCancelledResult(result.exitCode)) {
            const message = "Operation cancelled";
            activitySteps.push(createActivityStep({
              label,
              pkgManager: "system",
              command: cmd,
              output: combinedOutput,
              error: message,
              status: "cancelled",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }));
            finishEntry(histId, "cancelled", {
              steps: getStoredSteps(),
              error: message,
            });
            outputStream.publish(systemId, { type: "warning", message });
            outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
            return { success: false, message };
          }

          if (result.exitCode !== 0) {
            const errorText = result.stderr || result.stdout || combinedOutput || `reboot exited with code ${result.exitCode}`;
            if (!isProxmoxBackupGuardStep(step) && isExpectedRebootDisconnect(errorText)) {
              const outputText = combinedOutput || "Reboot command sent (connection closed)";
              activitySteps.push(createActivityStep({
                label,
                pkgManager: "system",
                command: cmd,
                output: outputText,
                error: null,
                status: "success",
                startedAt: stepStartedAt,
                completedAt: stepCompletedAt,
              }));
              systemService.markUnreachable(systemId);
              finishEntry(histId, "success", {
                steps: getStoredSteps(),
                output: outputText,
              });
              outputStream.publish(systemId, { type: "done", success: true, completedAt: getCurrentTimestamp() });
              return { success: true, message: "Reboot command sent" };
            }

            const blocked = isProxmoxBackupGuardStep(step);
            const message = blocked
              ? normalizeProxmoxBackupGuardMessage(errorText)
              : `Reboot failed: ${errorText}`;
            activitySteps.push(createActivityStep({
              label,
              pkgManager: "system",
              command: cmd,
              output: combinedOutput,
              error: message,
              status: "failed",
              startedAt: stepStartedAt,
              completedAt: stepCompletedAt,
            }));
            finishEntry(histId, "failed", {
              steps: getStoredSteps(),
              output: combinedOutput,
              error: message,
            });
            outputStream.publish(systemId, { type: "error", message });
            outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
            return { success: false, message, blocked };
          }

          activitySteps.push(createActivityStep({
            label,
            pkgManager: "system",
            command: cmd,
            output: combinedOutput,
            error: null,
            status: "success",
            startedAt: stepStartedAt,
            completedAt: stepCompletedAt,
          }));
        }

        systemService.markUnreachable(systemId);
        finishEntry(histId, "success", {
          steps: getStoredSteps(),
          output: "Reboot command sent",
        });
        outputStream.publish(systemId, { type: "done", success: true, completedAt: getCurrentTimestamp() });
        return { success: true, message: "Reboot command sent" };
      } catch (e) {
        if (isOperationCancelledError(e)) {
          const stepCompletedAt = getCurrentTimestamp();
          const step = conn ? steps[Math.min(activitySteps.length, steps.length - 1)] : null;
          if (!conn && !connectionStep) {
            connectionStep = createActivityStep({
              label: SSH_CONNECT_STEP_LABEL,
              pkgManager: "system",
              command: "",
              output: null,
              error: e.message,
              status: "cancelled",
              startedAt: historyStartedAt,
              completedAt: stepCompletedAt,
            });
          } else if (step) {
            activitySteps.push(createActivityStep({
              label: step.label || null,
              pkgManager: "system",
              command: step.command,
              output: null,
              error: e.message,
              status: "cancelled",
              startedAt: stepCompletedAt,
              completedAt: stepCompletedAt,
            }));
          }
          finishEntry(histId, "cancelled", {
            steps: getStoredSteps(),
            error: e.message,
          });
          outputStream.publish(systemId, { type: "warning", message: e.message });
          outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
          return { success: false, message: e.message };
        }
        const errMsg = String(e);
        const stepCompletedAt = getCurrentTimestamp();
        if (!conn) {
          const message = `Reboot failed: ${errMsg}`;
          connectionStep = createActivityStep({
            label: SSH_CONNECT_STEP_LABEL,
            pkgManager: "system",
            command: "",
            output: null,
            error: message,
            status: "failed",
            startedAt: historyStartedAt,
            completedAt: stepCompletedAt,
          });
          finishEntry(histId, "failed", {
            steps: getStoredSteps(),
            error: message,
          });
          outputStream.publish(systemId, { type: "error", message });
          outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
          return { success: false, message };
        }
        const currentStep = steps[Math.min(activitySteps.length, steps.length - 1)];
        if (currentStep && isProxmoxBackupGuardStep(currentStep)) {
          const message = "Reboot blocked: could not verify Proxmox backup activity.";
          activitySteps.push(createActivityStep({
            label: currentStep.label || null,
            pkgManager: "system",
            command: currentStep.command,
            output: null,
            error: message,
            status: "failed",
            startedAt: stepCompletedAt,
            completedAt: stepCompletedAt,
          }));
          finishEntry(histId, "failed", {
            steps: getStoredSteps(),
            error: message,
          });
          outputStream.publish(systemId, { type: "error", message });
          outputStream.publish(systemId, { type: "done", success: false, completedAt: getCurrentTimestamp() });
          return { success: false, message, blocked: true };
        }
        if (isExpectedRebootDisconnect(errMsg)) {
          if (currentStep) {
            activitySteps.push(createActivityStep({
              label: currentStep.label || null,
              pkgManager: "system",
              command: currentStep.command,
              output: "Reboot command sent (connection closed)",
              error: null,
              status: "success",
              startedAt: stepCompletedAt,
              completedAt: stepCompletedAt,
            }));
          }
          systemService.markUnreachable(systemId);
          finishEntry(histId, "success", {
            steps: getStoredSteps(),
            output: "Reboot command sent (connection closed)",
          });
          outputStream.publish(systemId, { type: "done", success: true, completedAt: getCurrentTimestamp() });
          return { success: true, message: "Reboot command sent" };
        }
        if (currentStep) {
          activitySteps.push(createActivityStep({
            label: currentStep.label || null,
            pkgManager: "system",
            command: currentStep.command,
            output: null,
            error: errMsg,
            status: "failed",
            startedAt: stepCompletedAt,
            completedAt: stepCompletedAt,
          }));
        }
        finishEntry(histId, "failed", {
          steps: getStoredSteps(),
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
