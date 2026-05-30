import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { Layout } from "../components/Layout";
import { AgoLabel } from "../components/AgoLabel";
import { Badge } from "../components/Badge";
import { CopyableCodeBlock } from "../components/CopyableCodeBlock";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { TerminalText } from "../components/TerminalText";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSystem,
  useRebootSystem,
  useDismissNeedsReboot,
  useSolvePackageIssue,
  useDismissPackageIssue,
} from "../lib/systems";
import { getCheckResultToast, useCancelOperation, useCheckUpdates, useHideUpdate, useUnhideUpdate } from "../lib/updates";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";
import { useCommandOutput } from "../hooks/useCommandOutput";
import type { WsMessage } from "../hooks/useCommandOutput";
import { deriveLiveActivitySteps, getActivityStepLabel } from "../lib/activity-steps";
import type {
  CachedUpdate,
  HiddenUpdate,
  HistoryEntry,
  ActiveOperation,
  ActivityStep,
  LastCheckSummary,
  PackageManagerIssue,
} from "../lib/systems";
import { deriveSystemUpdateState, getUpdatesPanelState, isPostUpgradeRecheck, shouldClearLocalUpgrade, type UpdatesPanelState } from "../lib/system-status";
import { getUpgradeBehaviorNotes } from "../lib/package-manager-configs";
import { getHostKeyStatusText } from "../lib/host-key-status";
import { formatDurationBetween } from "../lib/time";
import { highlightShell } from "../lib/shell-highlight";
import { formatScriptCommand } from "../lib/scripts";

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function InfoCard({ title, items }: { title: string; items: { label: string; value: string | null }[] }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">{title}</h3>
      <dl className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between text-sm gap-3">
            <dt className="text-slate-500 dark:text-slate-400 shrink-0">{item.label}</dt>
            <dd className="font-medium truncate text-right">{item.value || "-"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function UpdatesTable({
  updates,
  onHide,
  onTogglePackage,
  selectedPackageNames,
  selectionDisabled,
  hideBusy,
}: {
  updates: CachedUpdate[];
  onHide: (update: CachedUpdate) => void;
  onTogglePackage: (packageName: string) => void;
  selectedPackageNames: string[];
  selectionDisabled?: boolean;
  hideBusy?: boolean;
}) {
  if (!updates.length) {
    return (
      <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
        No updates available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-slate-500 uppercase tracking-wide">
            <th className="px-2 sm:px-4 py-2 w-10" />
            <th className="px-2 sm:px-4 py-2">Package</th>
            <th className="px-2 sm:px-4 py-2 hidden sm:table-cell">Current</th>
            <th className="px-2 sm:px-4 py-2">Available</th>
            <th className="px-2 sm:px-4 py-2 hidden md:table-cell">Manager</th>
            <th className="px-2 sm:px-4 py-2 hidden lg:table-cell">Repository</th>
            <th className="px-2 sm:px-4 py-2 text-right whitespace-nowrap">Actions</th>
          </tr>
        </thead>
        <tbody>
          {updates.map((u) => (
            <tr key={u.id} className="border-b border-border last:border-0">
              <td className="px-2 sm:px-4 py-2 align-top">
                <input
                  type="checkbox"
                  aria-label={`Select ${u.packageName}`}
                  checked={selectedPackageNames.includes(u.packageName)}
                  disabled={selectionDisabled}
                  onChange={() => onTogglePackage(u.packageName)}
                  className="mt-0.5 rounded border-border text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                />
              </td>
              <td className="px-2 sm:px-4 py-2 break-all">
                {u.packageName}
                {u.isSecurity ? (
                  <Badge variant="danger" small>security</Badge>
                ) : null}
                {u.isKeptBack ? (
                  <Badge variant="muted" small>kept back</Badge>
                ) : null}
              </td>
              <td className="px-2 sm:px-4 py-2 hidden sm:table-cell text-slate-500 font-mono text-xs">
                {u.currentVersion || "-"}
              </td>
              <td className="px-2 sm:px-4 py-2 font-mono text-xs font-medium break-all">
                {u.newVersion || "-"}
              </td>
              <td className="px-2 sm:px-4 py-2 hidden md:table-cell text-slate-500">
                {u.pkgManager}
              </td>
              <td className="px-2 sm:px-4 py-2 hidden lg:table-cell text-slate-500 truncate max-w-[150px]">
                {u.repository || "-"}
              </td>
              <td className="px-2 sm:px-4 py-2 text-right">
                <div className="inline-flex items-center gap-1">
                  <button
                    onClick={() => onHide(u)}
                    disabled={selectionDisabled || hideBusy}
                    className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 transition-colors disabled:opacity-50"
                    title={`Hide ${u.packageName} ${u.newVersion || ""}`.trim()}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.584 10.587A2 2 0 0013.412 13.4" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.363 5.365A9.466 9.466 0 0112 5c4.478 0 8.268 2.943 9.543 7a9.97 9.97 0 01-4.132 5.411M6.228 6.228A9.965 9.965 0 002.458 12c1.274 4.057 5.064 7 9.542 7a9.46 9.46 0 005.057-1.47" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HiddenUpdatesSection({
  hiddenUpdates,
  busy,
  onUnhide,
}: {
  hiddenUpdates: HiddenUpdate[];
  busy?: boolean;
  onUnhide: (hiddenUpdate: HiddenUpdate) => void;
}) {
  if (hiddenUpdates.length === 0) return null;

  return (
    <details className="bg-white dark:bg-slate-800 rounded-xl border border-border mb-6">
      <summary className="px-4 py-3 border-b border-border flex items-center justify-between cursor-pointer select-none">
        <span className="text-sm font-semibold">
          Hidden Updates
          <Badge variant="muted" small>{hiddenUpdates.length}</Badge>
        </span>
        <span className="text-xs text-slate-400">Hidden until this exact update disappears</span>
      </summary>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-slate-500 uppercase tracking-wide">
              <th className="px-2 sm:px-4 py-2">Package</th>
              <th className="px-2 sm:px-4 py-2 hidden sm:table-cell">Current</th>
              <th className="px-2 sm:px-4 py-2">Hidden Version</th>
              <th className="px-2 sm:px-4 py-2 hidden md:table-cell">Manager</th>
              <th className="px-2 sm:px-4 py-2 hidden lg:table-cell">Repository</th>
              <th className="px-2 sm:px-4 py-2 text-right whitespace-nowrap">Action</th>
            </tr>
          </thead>
          <tbody>
            {hiddenUpdates.map((update) => (
              <tr key={update.id} className="border-b border-border last:border-0">
                <td className="px-2 sm:px-4 py-2 break-all">
                  {update.packageName}
                  {update.isSecurity ? (
                    <Badge variant="danger" small>security</Badge>
                  ) : null}
                  {update.isKeptBack ? (
                    <Badge variant="muted" small>kept back</Badge>
                  ) : null}
                </td>
                <td className="px-2 sm:px-4 py-2 hidden sm:table-cell text-slate-500 font-mono text-xs">
                  {update.currentVersion || "-"}
                </td>
                <td className="px-2 sm:px-4 py-2 font-mono text-xs font-medium break-all">
                  {update.newVersion || "-"}
                </td>
                <td className="px-2 sm:px-4 py-2 hidden md:table-cell text-slate-500">
                  {update.pkgManager}
                </td>
                <td className="px-2 sm:px-4 py-2 hidden lg:table-cell text-slate-500 truncate max-w-[150px]">
                  {update.repository || "-"}
                </td>
                <td className="px-2 sm:px-4 py-2 text-right">
                  <button
                    onClick={() => onUnhide(update)}
                    disabled={busy}
                    className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 transition-colors disabled:opacity-50"
                    title={`Unhide ${update.packageName} ${update.newVersion || ""}`.trim()}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.522 5 12 5s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S3.732 16.057 2.458 12z" />
                      <circle cx="12" cy="12" r="3" strokeWidth={2} />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function isPackageIssueWarningBlock(
  block: string,
  packageIssues: PackageManagerIssue[],
): boolean {
  const normalizedBlock = block.trim().toLowerCase();
  if (!normalizedBlock) return true;
  return packageIssues.some((issue) => {
    if (issue.active !== 1) return false;
    const message = issue.message.trim().toLowerCase();
    if (!message) return false;
    return normalizedBlock === `[${issue.pkgManager}] ${message}` || normalizedBlock.includes(message);
  });
}

export function dedupePackageIssueUpdateNotice(
  state: UpdatesPanelState,
  packageIssues: PackageManagerIssue[],
): UpdatesPanelState | null {
  if (state.kind !== "check_warning" || !state.error || packageIssues.length === 0) return state;

  const remainingErrors = state.error
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => !isPackageIssueWarningBlock(block, packageIssues));

  if (remainingErrors.length === 0) return null;
  return { ...state, error: remainingErrors.join("\n\n") };
}

function isSudoCredentialFailure(lastCheck: LastCheckSummary | null): boolean {
  if (lastCheck?.status !== "failed" || !lastCheck.error) return false;
  return /sudo:.*(?:password is required|authentication failure|incorrect password)|sudo password/i.test(lastCheck.error);
}

export function getVisiblePackageIssuesForCurrentCheck(
  packageIssues: PackageManagerIssue[],
  lastCheck: LastCheckSummary | null,
): PackageManagerIssue[] {
  return isSudoCredentialFailure(lastCheck) ? [] : packageIssues;
}

function UpdateCheckNotice({
  state,
}: {
  state: UpdatesPanelState | null;
}) {
  if (!state) return null;
  if (state.kind !== "check_failed" && state.kind !== "check_warning") return null;

  const tone = state.kind === "check_failed"
    ? {
        wrapper: "border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20",
        title: "text-red-700 dark:text-red-300",
        body: "text-red-600 dark:text-red-400",
        code: "bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-300",
      }
    : {
        wrapper: "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20",
        title: "text-amber-700 dark:text-amber-300",
        body: "text-amber-700 dark:text-amber-400",
        code: "bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300",
      };

  return (
    <div className={`mx-4 mt-4 mb-4 rounded-xl border px-4 py-3 ${tone.wrapper}`}>
      <p className={`text-sm font-medium ${tone.title}`}>{state.title}</p>
      <p className={`mt-1 text-sm ${tone.body}`}>{state.message}</p>
      {state.error && (
        <div className="mt-3">
          <CopyableCodeBlock
            text={state.error}
            className={`overflow-x-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap ${tone.code}`}
            successMessage="Copied check output"
          >
            {state.error}
          </CopyableCodeBlock>
        </div>
      )}
    </div>
  );
}

export function PackageManagerIssueBanner({
  issues,
  busy,
  solvingIssueId,
  dismissingIssueId,
  onSolve,
  onDismiss,
}: {
  issues: PackageManagerIssue[];
  busy?: boolean;
  solvingIssueId?: number | null;
  dismissingIssueId?: number | null;
  onSolve: (issue: PackageManagerIssue) => void;
  onDismiss: (issue: PackageManagerIssue) => void;
}) {
  if (issues.length === 0) return null;

  return (
    <div className="space-y-3 mb-6">
      {issues.map((issue) => {
        const solving = solvingIssueId === issue.id;
        const dismissing = dismissingIssueId === issue.id;
        return (
          <div
            key={issue.id}
            className="flex items-center gap-2 px-4 py-3 rounded-xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm"
          >
            <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M4.93 19h14.14c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.2 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{issue.title}</span>
                <Badge variant="danger" small>{issue.pkgManager}</Badge>
              </div>
              <p className="text-red-600 dark:text-red-400">{issue.message}</p>
            </div>
            <button
              onClick={() => onSolve(issue)}
              disabled={busy || solving || dismissing}
              className="px-3 py-1 text-xs font-medium rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {solving ? (
                <span className="flex items-center gap-1.5">
                  <span className="spinner spinner-sm" />
                  Solving...
                </span>
              ) : "Solve"}
            </button>
            <button
              onClick={() => onDismiss(issue)}
              disabled={busy || solving || dismissing}
              className="px-3 py-1 text-xs font-medium rounded-lg border border-red-300 dark:border-red-800 bg-white/70 dark:bg-slate-900/30 text-red-700 dark:text-red-300 hover:bg-white dark:hover:bg-slate-900/50 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {dismissing ? (
                <span className="flex items-center gap-1.5">
                  <span className="spinner spinner-sm" />
                  Dismissing...
                </span>
              ) : "Dismiss"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function getStatusVariant(status: string): "success" | "warning" | "danger" | "muted" {
  if (status === "success") return "success";
  if (status === "warning") return "warning";
  if (status === "cancelled") return "warning";
  if (status === "failed") return "danger";
  return "muted";
}

function useNowTicker(enabled: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;

    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  return nowMs;
}

function joinMetaParts(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part).join(" • ");
}

export function isScrollNearBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight < 50;
}

function getActionForActiveOperation(
  type: ActiveOperation["type"],
): HistoryEntry["action"] {
  return type;
}

function getLastDoneMessage(messages: WsMessage[]): Extract<WsMessage, { type: "done" }> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === "done") return message;
  }
  return null;
}

function getActivityDisplayKey(input: {
  action: string;
  startedAt: string | null;
  historyId?: number | null;
}): string {
  if (input.startedAt) return `${input.action}:${input.startedAt}`;
  if (input.historyId) return `history:${input.historyId}`;
  return `activity:${input.action}:pending`;
}

export function getActivityTitle(
  action: string,
  packagesList: string[],
  packageName?: string,
): string {
  if (action === "check") return "Checked for updates";
  if (action === "upgrade_all") return "Upgraded all packages";
  if (action === "full_upgrade_all") return "Full upgraded all packages";
  if (action === "reboot") return "Rebooted system";
  if (action === "package_manager_repair") return "Repaired package manager";
  return `Upgraded ${packagesList.join(", ") || packageName || "package"}`;
}

function getActiveOperationPackageNames(activeOp: ActiveOperation | null | undefined): string[] {
  if (activeOp?.packageNames?.length) return activeOp.packageNames;
  if (activeOp?.packageName) return [activeOp.packageName];
  return [];
}

export function getSelectablePackageNames(updates: Array<Pick<CachedUpdate, "packageName">>): string[] {
  return Array.from(new Set(updates.map((update) => update.packageName)));
}

export function normalizeSelectedPackageNames(
  selectedPackageNames: string[],
  updates: Array<Pick<CachedUpdate, "packageName">>,
): string[] {
  const visiblePackageNames = new Set(getSelectablePackageNames(updates));
  return Array.from(new Set(selectedPackageNames)).filter((packageName) => visiblePackageNames.has(packageName));
}

export function toggleSelectedPackageName(selectedPackageNames: string[], packageName: string): string[] {
  const next = new Set(selectedPackageNames);
  if (next.has(packageName)) {
    next.delete(packageName);
  } else {
    next.add(packageName);
  }
  return Array.from(next);
}

export function getPackageSelectionState(
  selectedPackageNames: string[],
  updates: Array<Pick<CachedUpdate, "packageName">>,
  disabled = false,
) {
  const visiblePackageNames = getSelectablePackageNames(updates);
  const normalizedSelectedPackageNames = normalizeSelectedPackageNames(selectedPackageNames, updates);
  const selectedCount = normalizedSelectedPackageNames.length;
  const totalCount = visiblePackageNames.length;

  return {
    visiblePackageNames,
    selectedPackageNames: normalizedSelectedPackageNames,
    selectedCount,
    totalCount,
    allSelected: totalCount > 0 && selectedCount === totalCount,
    indeterminate: selectedCount > 0 && selectedCount < totalCount,
    selectionDisabled: disabled,
  };
}

function isSshSafeActivity(action: string): boolean {
  return action !== "check" && action !== "reboot";
}

type ActivityDisplayRow = {
  key: string;
  historyId: number | null;
  action: string;
  pkgManager: string;
  packageCount: number | null;
  packagesList: string[];
  command: string | null;
  steps: ActivityStep[] | null;
  output: string | null;
  error: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  isRunning: boolean;
  isConnecting: boolean;
  useLiveDetails: boolean;
  liveSteps: ActivityStep[];
  packageName?: string;
};

type ActivitySession = {
  key: string;
  action: HistoryEntry["action"];
  activeStartedAt: string | null;
  firstCommandStartedAt: string | null;
  packageName?: string;
  packageNames?: string[];
};

type ActivityScrollAnchor = {
  key: string;
  index: number;
  top: number;
};

function getVisibleActivityScrollAnchor(container: HTMLDivElement | null): ActivityScrollAnchor | null {
  if (!container || typeof window === "undefined") return null;

  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-activity-row-key]"));
  const viewportTop = 72;
  const viewportBottom = window.innerHeight;

  for (const [index, row] of rows.entries()) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewportTop && rect.top < viewportBottom) {
      return {
        key: row.dataset.activityRowKey ?? "",
        index,
        top: rect.top,
      };
    }
  }

  return null;
}

function useActivityScrollAnchor(renderKey: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingAnchorRef = useRef<ActivityScrollAnchor | null>(null);

  useBrowserLayoutEffect(() => {
    const pendingAnchor = pendingAnchorRef.current;
    if (pendingAnchor?.key && typeof window !== "undefined") {
      const rows = Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>("[data-activity-row-key]") ?? [],
      );
      const nextAnchor =
        rows.find((row) => row.dataset.activityRowKey === pendingAnchor.key) ??
        rows[pendingAnchor.index];

      if (nextAnchor) {
        const delta = nextAnchor.getBoundingClientRect().top - pendingAnchor.top;
        if (Math.abs(delta) > 1) {
          window.scrollBy(0, delta);
        }
      }
    }

    return () => {
      pendingAnchorRef.current = getVisibleActivityScrollAnchor(containerRef.current);
    };
  }, [renderKey]);

  return containerRef;
}

function getFirstStartedMessage(
  messages: WsMessage[],
): Extract<WsMessage, { type: "started" }> | undefined {
  return messages.find((message): message is Extract<WsMessage, { type: "started" }> => message.type === "started");
}

export function matchesHistoryEntryToSession(
  historyEntry: HistoryEntry,
  session: ActivitySession,
): boolean {
  if (historyEntry.action !== session.action) return false;

  if (session.firstCommandStartedAt) {
    if (historyEntry.startedAt === session.firstCommandStartedAt) {
      return true;
    }

    if (session.activeStartedAt) {
      return historyEntry.startedAt >= session.activeStartedAt;
    }

    return false;
  }

  if (session.activeStartedAt) {
    return historyEntry.startedAt >= session.activeStartedAt;
  }

  return false;
}

export function resolveCurrentActivitySession({
  previousSession,
  nextSessionKey,
  history,
  activeOp,
  actionHint,
  messages,
  isCommandActive,
  pendingTransition,
}: {
  previousSession: ActivitySession | null;
  nextSessionKey: () => string;
  history: HistoryEntry[];
  activeOp: ActiveOperation | null | undefined;
  actionHint?: HistoryEntry["action"] | null;
  messages: WsMessage[];
  isCommandActive: boolean;
  pendingTransition: boolean;
}): ActivitySession | null {
  const startedEntry = history.find((entry) => entry.status === "started");
  const firstStartedMessage = getFirstStartedMessage(messages);
  const topHistory = history[0] ?? null;
  const activeAction = activeOp ? getActionForActiveOperation(activeOp.type) : null;
  const observedAction =
    startedEntry?.action ??
    activeAction ??
    actionHint ??
    previousSession?.action ??
    null;
  const observedActiveStartedAt =
    activeOp?.startedAt ??
    previousSession?.activeStartedAt ??
    startedEntry?.startedAt ??
    firstStartedMessage?.startedAt ??
    null;
  const observedCommandStartedAt =
    firstStartedMessage?.startedAt ??
    startedEntry?.startedAt ??
    previousSession?.firstCommandStartedAt ??
    null;
  const observedPackageNames =
    getActiveOperationPackageNames(activeOp).length > 0
      ? getActiveOperationPackageNames(activeOp)
      : previousSession?.packageNames ?? [];
  const topHistoryMatchesPrevious =
    !!topHistory &&
    !!previousSession &&
    matchesHistoryEntryToSession(topHistory, previousSession);
  const hasLiveSignal =
    !!activeOp ||
    !!startedEntry ||
    isCommandActive ||
    (pendingTransition && (!!firstStartedMessage || !!previousSession));

  if (!hasLiveSignal) {
    return topHistoryMatchesPrevious ? previousSession : null;
  }

  if (!observedAction) return null;

  if (previousSession && previousSession.action === observedAction) {
    const activeStartedAtMatches =
      !activeOp?.startedAt ||
      !previousSession.activeStartedAt ||
      previousSession.activeStartedAt === activeOp.startedAt;
    const commandStartedAtMatches =
      !observedCommandStartedAt ||
      !previousSession.firstCommandStartedAt ||
      previousSession.firstCommandStartedAt === observedCommandStartedAt;

    if (activeStartedAtMatches && commandStartedAtMatches) {
      return {
        ...previousSession,
        activeStartedAt: previousSession.activeStartedAt ?? observedActiveStartedAt,
        firstCommandStartedAt: previousSession.firstCommandStartedAt ?? observedCommandStartedAt,
        packageName: observedPackageNames[0] ?? previousSession.packageName,
        packageNames: observedPackageNames.length > 0 ? observedPackageNames : previousSession.packageNames,
      };
    }
  }

  return {
    key: nextSessionKey(),
    action: observedAction,
    activeStartedAt: observedActiveStartedAt,
    firstCommandStartedAt: observedCommandStartedAt,
    packageName: observedPackageNames[0],
    packageNames: observedPackageNames,
  };
}

function createHistoryDisplayRow(
  historyEntry: HistoryEntry,
  liveSteps: ActivityStep[] = [],
  keyOverride?: string,
  packagesListOverride?: string[],
): ActivityDisplayRow {
  const packagesList = packagesListOverride?.length ? packagesListOverride : historyEntry.packagesList;
  return {
    key: keyOverride ?? getActivityDisplayKey({
      action: historyEntry.action,
      startedAt: historyEntry.startedAt,
      historyId: historyEntry.id,
    }),
    historyId: historyEntry.id,
    action: historyEntry.action,
    pkgManager: historyEntry.pkgManager,
    packageCount: historyEntry.packageCount,
    packagesList,
    command: historyEntry.command,
    steps: historyEntry.steps,
    output: historyEntry.output,
    error: historyEntry.error,
    status: historyEntry.status,
    startedAt: historyEntry.startedAt,
    completedAt: historyEntry.completedAt,
    isRunning: historyEntry.status === "started",
    isConnecting: isActivityConnecting(liveSteps),
    useLiveDetails: historyEntry.status === "started" && liveSteps.length > 0,
    liveSteps,
  };
}

function isActivityConnecting(steps: ActivityStep[]): boolean {
  if (!steps.length) return false;
  const connectionStep = steps.find(isSshConnectionStep);
  if (!connectionStep || connectionStep.status !== "started" || connectionStep.completedAt) return false;
  return steps.every(isSshConnectionStep);
}

export function buildActivityDisplayRows({
  history,
  activeOp,
  messages,
  isCommandActive,
  pendingTransition,
  currentSession,
}: {
  history: HistoryEntry[];
  activeOp: ActiveOperation | null | undefined;
  messages: WsMessage[];
  isCommandActive: boolean;
  pendingTransition: boolean;
  currentSession: ActivitySession | null;
}): ActivityDisplayRow[] {
  const startedEntry = history.find((entry) => entry.status === "started");
  const liveSteps = deriveLiveActivitySteps(messages);
  const firstStartedMessage = getFirstStartedMessage(messages);
  const lastDoneMessage = getLastDoneMessage(messages);
  const liveStatus = lastDoneMessage
    ? lastDoneMessage.success
      ? "success"
      : "failed"
    : "started";
  const livePackageNames = getActiveOperationPackageNames(activeOp).length > 0
    ? getActiveOperationPackageNames(activeOp)
    : currentSession?.packageNames ?? [];
  const liveAction =
    startedEntry?.action ??
    (activeOp ? getActionForActiveOperation(activeOp.type) : currentSession?.action ?? null);
  const liveStartedAt =
    startedEntry?.startedAt ??
    firstStartedMessage?.startedAt ??
    activeOp?.startedAt ??
    currentSession?.firstCommandStartedAt ??
    currentSession?.activeStartedAt ??
    null;
  const topHistory = history[0] ?? null;
  const matchedTopHistory =
    !!topHistory &&
    !!currentSession &&
    matchesHistoryEntryToSession(topHistory, currentSession)
      ? topHistory
      : null;
  const currentHistoryEntry = startedEntry ?? matchedTopHistory;
  const showCurrentRow =
    !!currentHistoryEntry ||
    ((isCommandActive || pendingTransition) && !!liveAction && !!currentSession);

  const rows: ActivityDisplayRow[] = [];
  if (showCurrentRow) {
    if (currentHistoryEntry) {
      const row = createHistoryDisplayRow(
        currentHistoryEntry,
        currentHistoryEntry.status === "started" ? liveSteps : [],
        currentSession?.key,
        currentHistoryEntry.status === "started" && currentHistoryEntry.packagesList.length === 0
          ? livePackageNames
          : undefined,
      );
      rows.push(
        currentHistoryEntry.status === "started" && lastDoneMessage
          ? {
              ...row,
              status: liveStatus,
              completedAt: lastDoneMessage.completedAt,
              isRunning: false,
              useLiveDetails: liveSteps.length > 0,
            }
          : row,
      );
    } else if (liveAction) {
      rows.push({
        key: currentSession?.key ?? getActivityDisplayKey({ action: liveAction, startedAt: liveStartedAt }),
        historyId: null,
        action: liveAction,
        pkgManager: firstStartedMessage?.pkgManager ?? "system",
        packageCount: null,
        packagesList: livePackageNames,
        command: firstStartedMessage?.command ?? null,
        steps: null,
        output: null,
        error: null,
        status: liveStatus,
        startedAt: liveStartedAt,
        completedAt: lastDoneMessage?.completedAt ?? null,
        isRunning: liveStatus === "started",
        isConnecting: isActivityConnecting(liveSteps),
        useLiveDetails: true,
        liveSteps,
        packageName: livePackageNames[0] ?? currentSession?.packageName,
      });
    }
  }

  const consumedHistoryId = currentHistoryEntry?.id ?? null;
  for (const historyEntry of history) {
    if (historyEntry.id === consumedHistoryId) continue;
    rows.push(createHistoryDisplayRow(historyEntry));
  }

  return rows;
}

function StepPanel({
  title,
  children,
  className,
  copyText,
  followContentKey,
}: {
  title: string;
  children: React.ReactNode;
  className: string;
  copyText: string;
  followContentKey?: string;
}) {
  const containerRef = useRef<HTMLPreElement>(null);
  const isFollowingRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isFollowingRef.current = isScrollNearBottom(el.scrollHeight, el.scrollTop, el.clientHeight);
  }, []);

  useEffect(() => {
    if (!followContentKey || !isFollowingRef.current || !containerRef.current) return;
    containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [followContentKey]);

  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 font-semibold">{title}</p>
      <CopyableCodeBlock
        text={copyText}
        ref={containerRef}
        onScroll={followContentKey ? handleScroll : undefined}
        className={className}
        successMessage={`Copied ${title.toLowerCase()}`}
        expandable
      >
        {children}
      </CopyableCodeBlock>
    </div>
  );
}

function ShellCommandPanel({ command }: { command: string }) {
  const [displayCommand, setDisplayCommand] = useState(command);

  useEffect(() => {
    let cancelled = false;
    setDisplayCommand(command);
    if (!command.trim()) return;

    formatScriptCommand(command)
      .then((formatted) => {
        if (!cancelled) setDisplayCommand(formatted);
      })
      .catch(() => {
        if (!cancelled) setDisplayCommand(command);
      });

    return () => {
      cancelled = true;
    };
  }, [command]);

  const highlighted = useMemo(() => highlightShell(displayCommand), [displayCommand]);

  return (
    <StepPanel
      title="Command"
      className="script-code text-xs font-mono bg-slate-900 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-words"
      copyText={displayCommand}
    >
      <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    </StepPanel>
  );
}

function TerminalOutputPanel({
  title,
  output,
  emptyText = "No output",
  followContentKey,
  tone = "default",
}: {
  title: string;
  output: string | null;
  emptyText?: string;
  followContentKey?: string;
  tone?: "default" | "error";
}) {
  return (
    <StepPanel
      title={title}
      className={`text-xs font-mono rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all ${
        tone === "error"
          ? "bg-red-950 text-red-100 dark:bg-red-950/50 dark:text-red-200"
          : "bg-slate-900 text-slate-300"
      }`}
      copyText={output ?? ""}
      followContentKey={followContentKey}
    >
      {output ? (
        <TerminalText text={output} stream={tone === "error" ? "stderr" : "stdout"} />
      ) : (
        <span className="text-slate-500 italic">{emptyText}</span>
      )}
    </StepPanel>
  );
}

function LegacyActivityDetails({
  command,
  output,
  error,
}: {
  command: string | null;
  output: string | null;
  error: string | null;
}) {
  return (
    <>
      {command && (
        <ShellCommandPanel command={command} />
      )}
      {(command || output) && (
        <TerminalOutputPanel
          title="Output"
          output={output}
        />
      )}
      {error && (
        <TerminalOutputPanel
          title="Error"
          output={error}
          tone="error"
        />
      )}
    </>
  );
}

function isSshConnectionStep(step: ActivityStep): boolean {
  return step.label === "Connect over SSH" && step.command.trim() === "";
}

function SshConnectionSummary({ step, nowMs }: { step: ActivityStep; nowMs: number }) {
  const runtime = formatDurationBetween(step.startedAt, step.completedAt, nowMs);
  const isConnecting = step.status === "started" && !step.completedAt;
  const text = isConnecting
    ? runtime
      ? `Connecting over SSH for ${runtime}`
      : "Connecting over SSH"
    : runtime
      ? `SSH connected in ${runtime}`
      : "SSH connected";

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <Badge variant={getStatusVariant(step.status)} small>
        {isConnecting ? "connecting" : step.status}
      </Badge>
      <span>{text}</span>
    </div>
  );
}

function getDefaultActivityStepIndex(steps: ActivityStep[], defaultToLastStep: boolean): number {
  if (steps.length === 0) return 0;
  if (defaultToLastStep) return steps.length - 1;
  const problemIndex = steps.findIndex((step) =>
    step.status === "failed" || step.status === "cancelled" || step.status === "warning"
  );
  return problemIndex >= 0 ? problemIndex : 0;
}

export function ActivityStepViewer({
  viewerId,
  steps,
  defaultToLastStep = false,
  isLive = false,
  phase = null,
}: {
  viewerId: string;
  steps: ActivityStep[];
  defaultToLastStep?: boolean;
  isLive?: boolean;
  phase?: string | null;
}) {
  const connectionStep = steps.find(isSshConnectionStep);
  const visibleSteps = steps.filter((step) => !isSshConnectionStep(step));
  const [selectedIndex, setSelectedIndex] = useState(() =>
    getDefaultActivityStepIndex(visibleSteps, defaultToLastStep)
  );
  const prevStepCountRef = useRef(visibleSteps.length);
  const nowMs = useNowTicker(steps.some((step) => !!step.startedAt && !step.completedAt));

  useEffect(() => {
    const prevCount = prevStepCountRef.current;
    const shouldFollowNewest =
      defaultToLastStep &&
      prevCount > 0 &&
      selectedIndex === prevCount - 1 &&
      visibleSteps.length > prevCount;

    if (visibleSteps.length === 0) {
      setSelectedIndex(0);
    } else if (shouldFollowNewest) {
      setSelectedIndex(visibleSteps.length - 1);
    } else if (selectedIndex >= visibleSteps.length) {
      setSelectedIndex(visibleSteps.length - 1);
    }

    prevStepCountRef.current = visibleSteps.length;
  }, [defaultToLastStep, selectedIndex, visibleSteps.length]);

  const selectedStep = visibleSteps[selectedIndex];
  if (!selectedStep) {
    return (
      <div className="space-y-2">
        {connectionStep && (
          <SshConnectionSummary step={connectionStep} nowMs={nowMs} />
        )}
        <div className="text-xs text-slate-500 italic">
          Waiting for output…
        </div>
      </div>
    );
  }

  const isGlobalPhase = phase === "reconnecting" || phase === "rechecking";
  const showStepTabs = visibleSteps.length > 1;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {isLive && (
          <span className="flex items-center gap-1 text-[10px] text-green-500">
            <span className="spinner spinner-sm !w-2.5 !h-2.5" />
            live
          </span>
        )}
        {isGlobalPhase && (
          <Badge variant={phase === "reconnecting" ? "warning" : "muted"} small>
            {phase === "reconnecting" ? "reconnecting" : "rechecking"}
          </Badge>
        )}
      </div>

      {connectionStep && (
        <SshConnectionSummary step={connectionStep} nowMs={nowMs} />
      )}

      {showStepTabs && (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label="Activity steps"
        >
          {visibleSteps.map((step, index) => {
            const isSelected = index === selectedIndex;
            const stepRuntime = formatDurationBetween(step.startedAt, step.completedAt, nowMs);
            return (
              <button
                key={`${viewerId}-step-${index}`}
                id={`${viewerId}-tab-${index}`}
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-controls={`${viewerId}-panel-${index}`}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => setSelectedIndex(index)}
                className={`shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
                  isSelected
                    ? "border-blue-400 bg-blue-50 text-blue-900 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-100"
                    : "border-border bg-white/80 text-slate-600 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                }`}
              >
                <span className="block text-[10px] uppercase tracking-wide opacity-70">
                  {index + 1}/{visibleSteps.length} {step.pkgManager}
                </span>
                <span className="block text-xs font-medium">
                  {getActivityStepLabel(step, index)}
                </span>
                {stepRuntime && (
                  <span className="mt-1 block text-[11px] opacity-75">
                    {stepRuntime}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <div
        id={`${viewerId}-panel-${selectedIndex}`}
        role={showStepTabs ? "tabpanel" : undefined}
        aria-labelledby={showStepTabs ? `${viewerId}-tab-${selectedIndex}` : undefined}
        className="space-y-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={getStatusVariant(selectedStep.status)} small>
            {selectedStep.status}
          </Badge>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {selectedStep.pkgManager}
          </span>
        </div>

        {selectedStep.command.trim() && (
          <ShellCommandPanel command={selectedStep.command} />
        )}

        <TerminalOutputPanel
          title="Output"
          output={selectedStep.output}
          followContentKey={isLive ? `${selectedIndex}:${selectedStep.output || ""}` : undefined}
        />

        {selectedStep.error && (
          <TerminalOutputPanel
            title="Error"
            output={selectedStep.error}
            tone="error"
          />
        )}
      </div>
    </div>
  );
}

function HistoryList({
  history,
  commandOutput,
  activeOp,
  liveActionHint,
}: {
  history: HistoryEntry[];
  commandOutput: ReturnType<typeof useCommandOutput>;
  activeOp: ActiveOperation | null | undefined;
  liveActionHint?: HistoryEntry["action"] | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Tracks whether we're waiting for the DB result of a check-type op (no "started" row).
  // Using state (not ref) so that showSynthetic keeps the placeholder visible during the gap
  // between WS "done" and the next poll returning the new history entry.
  const [pendingExpand, setPendingExpand] = useState(false);
  const sessionRef = useRef<ActivitySession | null>(null);
  const sessionCounterRef = useRef(0);
  // Initialised to current top so we don't re-trigger on mount
  const prevTopHistoryIdRef = useRef<number | undefined>(history[0]?.id);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const hasOutput = commandOutput.isActive || commandOutput.messages.length > 0;
  const startedEntry = history.find((h) => h.status === "started");
  const currentSession = resolveCurrentActivitySession({
    previousSession: sessionRef.current,
    nextSessionKey: () => {
      sessionCounterRef.current += 1;
      return `activity-current-${sessionCounterRef.current}`;
    },
    history,
    activeOp,
    actionHint: liveActionHint,
    messages: commandOutput.messages,
    isCommandActive: commandOutput.isActive,
    pendingTransition: pendingExpand,
  });
  sessionRef.current = currentSession;

  const displayRows = buildActivityDisplayRows({
    history,
    activeOp,
    messages: commandOutput.messages,
    isCommandActive: commandOutput.isActive,
    pendingTransition: pendingExpand,
    currentSession,
  });
  const showSynthetic = displayRows.some((row) => row.historyId === null);
  const nowMs = useNowTicker(showSynthetic || !!startedEntry);
  const activityRenderKey = displayRows
    .map((row) => [
      row.key,
      row.historyId ?? "live",
      row.status,
      row.isRunning ? "running" : "done",
      row.useLiveDetails ? "live-details" : "stored-details",
      row.steps?.length ?? 0,
      row.liveSteps.length,
    ].join(":"))
    .join("|");
  const activityScrollRef = useActivityScrollAnchor(activityRenderKey);

  // For upgrade-type ops: clear pendingExpand when the "started" DB entry appears.
  useEffect(() => {
    if (startedEntry) {
      setPendingExpand(false);
    }
  }, [startedEntry?.id]);

  // For check-type ops: set pendingExpand so showSynthetic stays true after "done" fires
  // and until the new history entry arrives.
  useEffect(() => {
    if (commandOutput.isActive) {
      setPendingExpand(true);
    }
  }, [commandOutput.isActive]);

  // When the top history entry changes (new result landed) or its status transitions
  // from "started" to a finalized status (upgrade-type ops update in-place), clear the
  // pending flag. Without the status check, upgrade ops would keep the synthetic
  // "running" placeholder visible indefinitely since the row ID stays the same.
  const topHistoryId = history[0]?.id;
  const topHistoryStatus = history[0]?.status;
  useEffect(() => {
    if (!pendingExpand) return;
    const idChanged = topHistoryId !== prevTopHistoryIdRef.current;
    const statusFinalized =
      topHistoryId === prevTopHistoryIdRef.current &&
      topHistoryStatus !== "started" &&
      topHistoryStatus !== undefined;
    if (!idChanged && !statusFinalized) return;
    prevTopHistoryIdRef.current = topHistoryId;
    setPendingExpand(false);
  }, [topHistoryId, topHistoryStatus, pendingExpand]);

  if (!displayRows.length && !hasOutput) {
    return (
      <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
        No activity yet
      </div>
    );
  }

  return (
    <div ref={activityScrollRef} className="space-y-1">
      {displayRows.map((row) => {
        const totalRuntime = formatDurationBetween(
          row.startedAt,
          row.isRunning ? null : row.completedAt,
          nowMs,
        );
        const activityStateLabel = row.isConnecting ? "connecting" : row.isRunning ? "running" : row.status;
        const activityRuntime = totalRuntime
          ? `${row.isConnecting ? "connecting for" : row.isRunning ? "running for" : "completed in"} ${totalRuntime}`
          : null;
        const displaySteps =
          row.useLiveDetails && row.liveSteps.length > 0
            ? row.liveSteps
            : row.isRunning && row.command
              ? [{
                  label: null,
                  pkgManager: row.pkgManager,
                  command: row.command,
                  output: null,
                  error: null,
                  status: "started" as const,
                  startedAt: row.startedAt,
                  completedAt: null,
                }]
              : [];
        const hasDetails = !!(row.steps?.length || row.command || row.output || row.error) || row.isRunning;
        const isOpen = expanded.has(row.key);

        return (
          <div key={row.key} data-activity-row-key={row.key}>
            <button
              type="button"
              onClick={() => hasDetails && toggle(row.key)}
              className={`w-full flex items-start gap-3 text-sm px-2 py-2 rounded-lg transition-colors text-left ${hasDetails
                  ? "hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer"
                  : "cursor-default"
                }`}
            >
              {hasDetails && (
                <svg
                  className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
              {!hasDetails && <span className="w-3.5 shrink-0" />}
              <Badge
                variant={
                  row.isConnecting
                    ? "info"
                    : row.status === "success"
                    ? "success"
                    : row.status === "warning"
                      ? "warning"
                      : row.status === "cancelled"
                        ? "warning"
                      : row.status === "failed"
                        ? "danger"
                        : "muted"
                }
                small
              >
                {activityStateLabel}
              </Badge>
              <div className="flex-1 min-w-0">
                <p className="font-medium">
                  {getActivityTitle(row.action, row.packagesList, row.packageName)}
                  {isSshSafeActivity(row.action) && (
                    <span className="relative group ml-2 inline-flex align-middle">
                      <Badge variant="info" small>SSH-safe</Badge>
                      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-max max-w-xs rounded bg-slate-900 dark:bg-slate-700 px-2 py-1 text-[11px] text-white opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        {row.isRunning
                          ? "This command runs via nohup on the remote system and will continue even if the SSH connection drops."
                          : "This command ran via nohup on the remote system and would have continued even if the SSH connection dropped."}
                      </span>
                    </span>
                  )}
                </p>
                {row.packageCount !== null && row.action === "check" && (
                  <p className="text-xs text-slate-500">
                    {joinMetaParts([
                      `${row.packageCount} update${row.packageCount !== 1 ? "s" : ""} found`,
                      row.pkgManager,
                      activityRuntime,
                    ])}
                  </p>
                )}
                {(row.packageCount === null || row.action !== "check") && (
                  <p className="text-xs text-slate-500">
                    {joinMetaParts([
                      row.pkgManager,
                      activityRuntime,
                    ])}
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0 pt-0.5">
                {row.startedAt && (
                  <AgoLabel timestamp={row.startedAt} />
                )}
              </div>
            </button>

            {isOpen && hasDetails && (
              <div className="ml-10 mr-2 mb-2 space-y-2">
                {row.useLiveDetails && displaySteps.length > 0 ? (
                  <ActivityStepViewer
                    viewerId={`activity-live-${row.key}`}
                    steps={displaySteps}
                    defaultToLastStep
                    isLive={row.isRunning}
                    phase={commandOutput.phase}
                  />
                ) : row.steps?.length ? (
                  <ActivityStepViewer
                    viewerId={`activity-history-${row.key}`}
                    steps={row.steps}
                  />
                ) : (
                  <LegacyActivityDetails
                    command={row.command}
                    output={row.output}
                    error={row.error}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function SystemDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const systemId = parseInt(id!, 10);
  const { data, isLoading, dataUpdatedAt } = useSystem(systemId);
  const checkUpdates = useCheckUpdates();
  const hideUpdate = useHideUpdate();
  const unhideUpdate = useUnhideUpdate();
  const { upgradeAll, fullUpgradeAll, upgradePackages, isUpgrading, removeUpgrading, upgradingSystems } = useUpgrade();
  const { addToast } = useToast();
  const cancelOperation = useCancelOperation();
  const rebootSystem = useRebootSystem();
  const dismissNeedsReboot = useDismissNeedsReboot();
  const solvePackageIssue = useSolvePackageIssue();
  const dismissPackageIssue = useDismissPackageIssue();
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [showUpgradeSelectedConfirm, setShowUpgradeSelectedConfirm] = useState(false);
  const [showFullUpgradeConfirm, setShowFullUpgradeConfirm] = useState(false);
  const [showRebootConfirm, setShowRebootConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showDismissNeedsRebootConfirm, setShowDismissNeedsRebootConfirm] = useState(false);
  const [pendingSolveIssue, setPendingSolveIssue] = useState<PackageManagerIssue | null>(null);
  const [pendingDismissIssue, setPendingDismissIssue] = useState<PackageManagerIssue | null>(null);
  const [pendingHideUpdate, setPendingHideUpdate] = useState<CachedUpdate | null>(null);
  const [selectedPackageNames, setSelectedPackageNames] = useState<string[]>([]);
  const [showUpgradeDropdown, setShowUpgradeDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const updatesSignatureRef = useRef<string | null>(null);
  const commandOutput = useCommandOutput(systemId);
  const qc = useQueryClient();
  const wasCommandActiveRef = useRef(false);

  // When the WebSocket signals an active operation, kick the query into polling mode
  // (refetchInterval only activates when activeOperation is already in cached data)
  useEffect(() => {
    if (commandOutput.isActive) {
      wasCommandActiveRef.current = true;
      qc.invalidateQueries({ queryKey: ["system", systemId] });
    } else if (wasCommandActiveRef.current) {
      wasCommandActiveRef.current = false;
      qc.invalidateQueries({ queryKey: ["system", systemId] });
    }
  }, [commandOutput.isActive, systemId, qc]);

  useEffect(() => {
    if (commandOutput.phase === "rechecking" && isUpgrading(systemId)) {
      removeUpgrading(systemId);
    }
  }, [commandOutput.phase, isUpgrading, removeUpgrading, systemId]);

  // Keep the local header/status pill in sync if the mutation callback is
  // delayed or missed but the server has already finalized the operation.
  useEffect(() => {
    const localUpgrade = upgradingSystems.get(systemId);
    if (!data || !localUpgrade || dataUpdatedAt < localUpgrade.addedAt) return;
    if (shouldClearLocalUpgrade(data.system.activeOperation)) {
      removeUpgrading(systemId);
    }
  }, [data, dataUpdatedAt, removeUpgrading, systemId, upgradingSystems]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowUpgradeDropdown(false);
      }
    }
    if (showUpgradeDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showUpgradeDropdown]);

  // Combine client-side mutation state with server-side active operation
  const activeOp = data?.system?.activeOperation;
  const postUpgradeRechecking = isPostUpgradeRecheck(activeOp) || commandOutput.phase === "rechecking";
  const checking = checkUpdates.isPending || activeOp?.type === "check" || postUpgradeRechecking;
  const upgrading = !postUpgradeRechecking && (
    isUpgrading(systemId) ||
    activeOp?.type === "upgrade_all" ||
    activeOp?.type === "full_upgrade_all" ||
    activeOp?.type === "upgrade_package"
  );
  const rebooting = rebootSystem.isPending || activeOp?.type === "reboot";
  const repairingPackageIssue = solvePackageIssue.isPending || activeOp?.type === "package_manager_repair";
  const dismissingNeedsReboot = dismissNeedsReboot.isPending;
  const dismissingPackageIssue = dismissPackageIssue.isPending;
  const operationCancellable = !!activeOp && !activeOp.cancelRequested && !cancelOperation.isPending;
  const updatesSignature = data?.updates
    .map((update) => `${update.pkgManager}:${update.packageName}:${update.newVersion || ""}`)
    .join("|") ?? "";

  useEffect(() => {
    if (!data) return;

    if (updatesSignatureRef.current === null) {
      updatesSignatureRef.current = updatesSignature;
      return;
    }

    if (updatesSignatureRef.current !== updatesSignature) {
      setSelectedPackageNames([]);
      updatesSignatureRef.current = updatesSignature;
    }
  }, [data, updatesSignature]);

  if (isLoading || !data) {
    return (
      <Layout title="System Detail">
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      </Layout>
    );
  }

  const { system, updates, hiddenUpdates, packageIssues, history } = data;
  const visiblePackageIssues = getVisiblePackageIssuesForCurrentCheck(packageIssues, system.lastCheck);
  const selectionBusy = upgrading || checking || rebooting || repairingPackageIssue || hideUpdate.isPending || unhideUpdate.isPending;
  const packageSelectionState = getPackageSelectionState(selectedPackageNames, updates, selectionBusy);
  const selectedVisiblePackageNames = packageSelectionState.selectedPackageNames;
  const updatesPanelState = getUpdatesPanelState(system, updates.length);
  const dedupedUpdatesPanelState = dedupePackageIssueUpdateNotice(updatesPanelState, visiblePackageIssues);
  const updateState = deriveSystemUpdateState(system, { upgrading, checking: checking || repairingPackageIssue });
  const dotColor = updateState === "check_failed" || updateState === "unreachable"
    ? "bg-red-500"
    : updateState === "check_warning" || updateState === "updates_available"
      ? "bg-amber-500"
      : updateState === "up_to_date"
        ? "bg-green-500"
        : "bg-slate-400";
  const showUpgradeAllButton = system.updateCount > 0 || upgrading;
  const showUpgradeActions = showUpgradeAllButton;
  const hasSelectedPackages = packageSelectionState.selectedCount > 0;
  const activeManagers = (system.detectedPkgManagers ?? (system.pkgManager ? [system.pkgManager] : []))
    .filter((manager) => !(system.disabledPkgManagers ?? []).includes(manager));
  const upgradeBehaviorNotes = getUpgradeBehaviorNotes(activeManagers, system.pkgManagerConfigs);
  const upgradeConfirmMessage = [
    `Apply all ${system.updateCount} updates to ${system.name}?`,
    ...upgradeBehaviorNotes,
  ].join(" ");

  const handleCheck = () => {
    commandOutput.clear();
    checkUpdates.mutate(systemId, {
      onSuccess: (d) => {
        const toast = getCheckResultToast(d);
        addToast(toast.message, toast.type);
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleUpgradeAll = () => {
    setShowUpgradeConfirm(false);
    upgradeAll(systemId, {
      onSuccess: (d: any) =>
        addToast(
          d.status === "success" ? "Upgrade complete"
            : d.status === "warning" ? "Upgrade likely complete (inferred after reboot)"
              : d.status === "cancelled" ? "Upgrade cancelled"
                : "Upgrade failed",
          d.status === "failed" ? "danger" : d.status === "warning" || d.status === "cancelled" ? "info" : "success"
        ),
      onError: (err: Error) => addToast(err.message, "danger"),
    });
  };

  const handleFullUpgradeAll = () => {
    setShowFullUpgradeConfirm(false);
    fullUpgradeAll(systemId, {
      onSuccess: (d: any) =>
        addToast(
          d.status === "success" ? "Full upgrade complete"
            : d.status === "warning" ? "Full upgrade likely complete (inferred after reboot)"
              : d.status === "cancelled" ? "Full upgrade cancelled"
                : "Full upgrade failed",
          d.status === "failed" ? "danger" : d.status === "warning" || d.status === "cancelled" ? "info" : "success"
        ),
      onError: (err: Error) => addToast(err.message, "danger"),
    });
  };

  const handleUpgradeSelected = () => {
    if (selectedVisiblePackageNames.length === 0) return;

    const selectedNames = selectedVisiblePackageNames;
    setShowUpgradeSelectedConfirm(false);
    setSelectedPackageNames([]);
    upgradePackages(systemId, selectedNames, {
      onSuccess: (d: any) =>
        addToast(
          d.status === "success"
            ? `Selected update${selectedNames.length !== 1 ? "s" : ""} complete`
            : d.status === "warning"
              ? `Selected update${selectedNames.length !== 1 ? "s" : ""} likely complete (inferred after reboot)`
              : d.status === "cancelled"
                ? `Selected update${selectedNames.length !== 1 ? "s" : ""} cancelled`
                : `Selected update${selectedNames.length !== 1 ? "s" : ""} failed`,
          d.status === "failed" ? "danger" : d.status === "warning" || d.status === "cancelled" ? "info" : "success"
        ),
      onError: (err: Error) => {
        setSelectedPackageNames(selectedNames);
        addToast(err.message, "danger");
      },
    });
  };

  const handleReboot = () => {
    setShowRebootConfirm(false);
    rebootSystem.mutate(systemId, {
      onSuccess: (d) =>
        addToast(d.success ? "Reboot command sent" : d.message, d.success ? "success" : "danger"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleDismissNeedsReboot = () => {
    setShowDismissNeedsRebootConfirm(false);
    dismissNeedsReboot.mutate(systemId, {
      onSuccess: () => addToast("Reboot warning dismissed", "success"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleSolvePackageIssue = () => {
    if (!pendingSolveIssue) return;
    const issue = pendingSolveIssue;
    setPendingSolveIssue(null);
    solvePackageIssue.mutate(
      { systemId, issueId: issue.id },
      {
        onSuccess: (d) =>
          addToast(
            d.status === "success" ? "Package manager issue solved"
              : d.status === "cancelled" ? "Package manager repair cancelled"
                : d.output || "Package manager repair failed",
            d.status === "success" ? "success" : d.status === "cancelled" ? "info" : "danger",
          ),
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const handleDismissPackageIssue = () => {
    if (!pendingDismissIssue) return;
    const issue = pendingDismissIssue;
    setPendingDismissIssue(null);
    dismissPackageIssue.mutate(
      { systemId, issueId: issue.id },
      {
        onSuccess: () => addToast("Package manager warning dismissed", "success"),
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const handleCancelOperation = () => {
    setShowCancelConfirm(false);
    cancelOperation.mutate(systemId, {
      onSuccess: () => addToast("Cancellation requested", "info"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleHideUpdate = () => {
    if (!pendingHideUpdate?.newVersion) return;
    hideUpdate.mutate(
      {
        systemId,
        pkgManager: pendingHideUpdate.pkgManager,
        packageName: pendingHideUpdate.packageName,
        newVersion: pendingHideUpdate.newVersion,
      },
      {
        onSuccess: () => {
          addToast(
            `Hidden ${pendingHideUpdate.packageName} ${pendingHideUpdate.newVersion}`,
            "success",
          );
          setPendingHideUpdate(null);
        },
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const handleUnhideUpdate = (hiddenUpdateRow: HiddenUpdate) => {
    unhideUpdate.mutate(
      {
        systemId,
        hiddenUpdateId: hiddenUpdateRow.id,
      },
      {
        onSuccess: () =>
          addToast(
            `Unhid ${hiddenUpdateRow.packageName} ${hiddenUpdateRow.newVersion || ""}`.trim(),
            "success",
          ),
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const handleTogglePackageSelection = (packageName: string) => {
    setSelectedPackageNames((current) => toggleSelectedPackageName(current, packageName));
  };

  const renderRunningCancelAction = (label: string, className: string) => (
    <button
      type="button"
      onClick={() => setShowCancelConfirm(true)}
      disabled={!operationCancellable}
      className={className}
      aria-label={`Cancel ${label.toLowerCase().replace("...", "")}`}
    >
      <span className="flex items-center justify-center gap-1.5">
        <span className="spinner spinner-sm" />
        <span>{activeOp?.cancelRequested || cancelOperation.isPending ? "Cancelling..." : label}</span>
        <span className="mx-0.5 h-4 w-px bg-current opacity-25" aria-hidden="true" />
        <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </span>
    </button>
  );
  const checkingCancelClass =
    "px-3 py-1.5 text-sm rounded-lg border border-border hover:border-red-300 dark:hover:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50 min-w-32";
  const upgradeCancelClass =
    "px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-red-600 text-white transition-colors disabled:opacity-50 whitespace-nowrap min-w-40";

  return (
    <Layout
      title={
        <span className="flex items-center gap-2 min-w-0">
          {upgrading || checking || repairingPackageIssue ? (
            <span className={`spinner spinner-sm !w-3.5 !h-3.5 shrink-0 ${upgrading || repairingPackageIssue ? "!border-blue-500" : "!border-sky-400"} !border-t-transparent`} />
          ) : (
            <span className={`w-3 h-3 rounded-full shrink-0 ${dotColor}`} />
          )}
          <span className="truncate">{system.name}</span>
        </span>
      }
      actions={
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={() => navigate(-1)}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
          {(checking || repairingPackageIssue) && activeOp ? (
            renderRunningCancelAction(repairingPackageIssue ? "Repairing..." : "Checking...", checkingCancelClass)
          ) : (
            <button
              onClick={handleCheck}
              disabled={checking || upgrading || repairingPackageIssue}
              className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 min-w-24"
            >
              {checking ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                Checking...
              </span>
              ) : "Refresh"}
            </button>
          )}
          {showUpgradeActions && (
            activeOp && upgrading ? (
              renderRunningCancelAction("Upgrading...", upgradeCancelClass)
            ) : hasSelectedPackages ? (
              <button
                onClick={() => setShowUpgradeSelectedConfirm(true)}
                disabled={upgrading || checking || repairingPackageIssue}
                className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap min-w-36"
              >
                {upgrading ? (
                  <span className="flex items-center gap-1.5">
                    <span className="spinner spinner-sm" />
                    Upgrading...
                  </span>
                ) : (
                  `Upgrade Selected (${packageSelectionState.selectedCount})`
                )}
              </button>
            ) : system.supportsFullUpgrade ? (
              showUpgradeAllButton ? (
                <div className="relative" ref={dropdownRef}>
                  <div className="flex">
                    <button
                      onClick={() => setShowUpgradeConfirm(true)}
                      disabled={upgrading || checking || repairingPackageIssue}
                      className="px-3 py-1.5 text-sm rounded-l-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap min-w-32"
                    >
                      {upgrading ? (
                        <span className="flex items-center gap-1.5">
                          <span className="spinner spinner-sm" />
                          Upgrading...
                        </span>
                      ) : (
                        `Upgrade All (${system.updateCount})`
                      )}
                    </button>
                    <button
                      onClick={() => setShowUpgradeDropdown((v) => !v)}
                      disabled={upgrading || checking || repairingPackageIssue}
                      className="px-1.5 py-1.5 text-sm rounded-r-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 border-l border-blue-500"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </div>
                  {showUpgradeDropdown && (
                    <div className="absolute right-0 mt-1 w-48 bg-white dark:bg-slate-800 border border-border rounded-lg shadow-lg z-10">
                      <button
                        onClick={() => {
                          setShowUpgradeDropdown(false);
                          setShowFullUpgradeConfirm(true);
                        }}
                        className="w-full px-3 py-2 text-sm text-left text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                      >
                        Full Upgrade
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  onClick={() => setShowFullUpgradeConfirm(true)}
                  disabled={upgrading || checking || repairingPackageIssue}
                  className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap min-w-36"
                >
                  {upgrading ? (
                    <span className="flex items-center gap-1.5">
                      <span className="spinner spinner-sm" />
                      Upgrading...
                    </span>
                  ) : (
                    "Full Upgrade"
                  )}
                </button>
              )
            ) : (
              <button
                onClick={() => setShowUpgradeConfirm(true)}
                disabled={upgrading || checking || repairingPackageIssue}
                className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap min-w-36"
              >
                {upgrading ? (
                  <span className="flex items-center gap-1.5">
                    <span className="spinner spinner-sm" />
                    Upgrading...
                  </span>
                ) : (
                  `Upgrade All (${system.updateCount})`
                )}
              </button>
            )
          )}
        </div>
      }
    >
      {/* Info grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <InfoCard
          title="Connection"
          items={[
            { label: "Hostname", value: `${system.hostname}${system.port !== 22 ? `:${system.port}` : ""}` },
            { label: "Username", value: system.username },
            { label: "Auth Type", value: system.authType },
            {
              label: "ProxyJump",
              value: system.proxyJumpChain.length > 0
                ? system.proxyJumpChain.map((hop) => hop.name).join(" -> ")
                : "Direct",
            },
            {
              label: "Host Key",
              value: getHostKeyStatusText(system.hostKeyStatus),
            },
            { label: "Status", value: system.isReachable === 1 ? "Online" : system.isReachable === -1 ? "Offline" : "Unknown" },
          ]}
        />
        <InfoCard
          title="System"
          items={[
            { label: "OS", value: system.osName },
            { label: "Version", value: system.osVersion },
            { label: "Kernel", value: system.kernel },
            { label: "Architecture", value: system.arch },
            {
              label: "Pkg Managers", value: (() => {
                const detected: string[] = system.detectedPkgManagers ?? (system.pkgManager ? [system.pkgManager] : []);
                const disabled: string[] = system.disabledPkgManagers ?? [];
                const active = detected.filter((m) => !disabled.includes(m));
                return active.length > 0 ? active.join(", ") : null;
              })()
            },
            ...(system.needsReboot === 1 ? [{ label: "Reboot", value: "Required" }] : []),
          ]}
        />
        <InfoCard
          title="Resources"
          items={[
            { label: "Hostname", value: system.hostnameRemote },
            { label: "Uptime", value: system.uptime },
            { label: "CPU Cores", value: system.cpuCores },
            { label: "Memory", value: system.memory },
            { label: "Disk", value: system.disk },
          ]}
        />
      </div>

      <PackageManagerIssueBanner
        issues={visiblePackageIssues}
        busy={upgrading || checking || rebooting || repairingPackageIssue}
        solvingIssueId={solvePackageIssue.isPending ? solvePackageIssue.variables?.issueId ?? null : null}
        dismissingIssueId={dismissPackageIssue.isPending ? dismissPackageIssue.variables?.issueId ?? null : null}
        onSolve={setPendingSolveIssue}
        onDismiss={setPendingDismissIssue}
      />

      {/* Reboot required warning */}
      {system.needsReboot === 1 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-sm">
          <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="font-medium">Reboot required</span>
          <span className="text-amber-600 dark:text-amber-500 flex-1">A kernel update has been installed. Reboot this system to apply it.</span>
          <button
            onClick={() => setShowRebootConfirm(true)}
            disabled={rebooting || upgrading || checking || repairingPackageIssue || dismissingNeedsReboot}
            className="px-3 py-1 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {rebooting ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                Rebooting...
              </span>
            ) : "Reboot"}
          </button>
          <button
            onClick={() => setShowDismissNeedsRebootConfirm(true)}
            disabled={dismissingNeedsReboot || rebooting || upgrading || checking || repairingPackageIssue}
            className="px-3 py-1 text-xs font-medium rounded-lg border border-amber-300 dark:border-amber-700 bg-white/70 dark:bg-slate-900/30 text-amber-700 dark:text-amber-400 hover:bg-white dark:hover:bg-slate-900/50 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {dismissingNeedsReboot ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                Dismissing...
              </span>
            ) : "Dismiss"}
          </button>
        </div>
      )}

      {/* Available updates */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-border mb-6">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Available Updates
            {updates.length > 0 && (
              <Badge variant="warning" small>{updates.length}</Badge>
            )}
            {system.securityCount > 0 && (
              <Badge variant="danger" small>{system.securityCount} security</Badge>
            )}
            {system.keptBackCount > 0 && (
              <Badge variant="muted" small>{system.keptBackCount} kept back</Badge>
            )}
          </h2>
          {system.cacheTimestamp && (
            <AgoLabel timestamp={system.cacheTimestamp} stale={system.isStale} />
          )}
        </div>
        <UpdateCheckNotice state={dedupedUpdatesPanelState} />
        {updates.length > 0 ? (
          <UpdatesTable
            updates={updates}
            onTogglePackage={handleTogglePackageSelection}
            selectedPackageNames={selectedVisiblePackageNames}
            selectionDisabled={packageSelectionState.selectionDisabled}
            hideBusy={hideUpdate.isPending}
            onHide={setPendingHideUpdate}
          />
        ) : updatesPanelState.kind === "up_to_date" ? (
          <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
            No updates available
          </div>
        ) : null}
      </div>

      <HiddenUpdatesSection
        hiddenUpdates={hiddenUpdates}
        busy={unhideUpdate.isPending || hideUpdate.isPending || upgrading || checking || repairingPackageIssue}
        onUnhide={handleUnhideUpdate}
      />

      {/* History */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-border">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Activity</h2>
        </div>
        <div className="p-4">
          <HistoryList
            history={history}
            commandOutput={commandOutput}
            activeOp={activeOp}
            liveActionHint={checkUpdates.isPending ? "check" : null}
          />
        </div>
      </div>

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={showUpgradeConfirm}
        onClose={() => setShowUpgradeConfirm(false)}
        onConfirm={handleUpgradeAll}
        title="Upgrade All Packages"
        message={upgradeConfirmMessage}
        confirmLabel="Upgrade All"
        loading={upgrading}
      />
      <ConfirmDialog
        open={showUpgradeSelectedConfirm}
        onClose={() => setShowUpgradeSelectedConfirm(false)}
        onConfirm={handleUpgradeSelected}
        title="Upgrade Selected Packages"
        message={
          `Apply ${packageSelectionState.selectedCount} selected update${packageSelectionState.selectedCount !== 1 ? "s" : ""} to ${system.name}?`
        }
        confirmLabel={`Upgrade Selected (${packageSelectionState.selectedCount})`}
        loading={upgrading}
      />
      <ConfirmDialog
        open={showFullUpgradeConfirm}
        onClose={() => setShowFullUpgradeConfirm(false)}
        onConfirm={handleFullUpgradeAll}
        title="Full Upgrade All Packages"
        message={
          `Perform a full upgrade on ${system.name}? This may install new dependencies or remove obsolete packages to complete the upgrade of all ${system.updateCount} packages.`
        }
        confirmLabel="Full Upgrade"
        danger
        loading={upgrading}
      />
      <ConfirmDialog
        open={showRebootConfirm}
        onClose={() => setShowRebootConfirm(false)}
        onConfirm={handleReboot}
        title="Reboot System"
        message={`Reboot ${system.name}? The system will be temporarily unavailable while it restarts.`}
        confirmLabel="Reboot"
        danger
        loading={rebooting}
      />
      <ConfirmDialog
        open={showCancelConfirm}
        onClose={() => setShowCancelConfirm(false)}
        onConfirm={handleCancelOperation}
        title="Cancel Running Operation"
        message={`Cancel the running command on ${system.name}?`}
        confirmLabel="Cancel Operation"
        danger
        loading={cancelOperation.isPending}
      />
      <ConfirmDialog
        open={showDismissNeedsRebootConfirm}
        onClose={() => setShowDismissNeedsRebootConfirm(false)}
        onConfirm={handleDismissNeedsReboot}
        title="Dismiss Reboot Warning"
        message={`Dismiss the reboot warning for ${system.name}? It will stay hidden until a later system scan detects that the host has rebooted.`}
        confirmLabel="Dismiss Warning"
        loading={dismissingNeedsReboot}
      />
      <ConfirmDialog
        open={pendingSolveIssue !== null}
        onClose={() => setPendingSolveIssue(null)}
        onConfirm={handleSolvePackageIssue}
        title="Solve Package Manager Issue"
        message={
          pendingSolveIssue
            ? `Run the repair action for ${pendingSolveIssue.title} on ${system.name}? The dashboard will refresh updates afterwards.`
            : ""
        }
        confirmLabel="Solve"
        loading={repairingPackageIssue}
      />
      <ConfirmDialog
        open={pendingDismissIssue !== null}
        onClose={() => setPendingDismissIssue(null)}
        onConfirm={handleDismissPackageIssue}
        title="Dismiss Package Manager Warning"
        message={
          pendingDismissIssue
            ? `Dismiss ${pendingDismissIssue.title} for ${system.name}? It will stay hidden for this boot, or until a later check no longer detects it.`
            : ""
        }
        confirmLabel="Dismiss Warning"
        loading={dismissingPackageIssue}
      />
      <ConfirmDialog
        open={pendingHideUpdate !== null}
        onClose={() => setPendingHideUpdate(null)}
        onConfirm={handleHideUpdate}
        title="Hide Update"
        message={
          pendingHideUpdate
            ? `Hide ${pendingHideUpdate.packageName} ${pendingHideUpdate.newVersion || ""} from visible update lists and counts on ${system.name}? Upgrade commands will still install it if run.`
            : ""
        }
        confirmLabel="Hide Update"
        loading={hideUpdate.isPending}
      />

    </Layout>
  );
}
