import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { Layout } from "../components/Layout";
import { AgoLabel } from "../components/AgoLabel";
import { Badge } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useQueryClient } from "@tanstack/react-query";
import { useSystem, useRebootSystem } from "../lib/systems";
import { useCheckUpdates, useHideUpdate, useUnhideUpdate } from "../lib/updates";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";
import { useCommandOutput } from "../hooks/useCommandOutput";
import type { WsMessage } from "../hooks/useCommandOutput";
import { deriveLiveActivitySteps, getActivityStepLabel } from "../lib/activity-steps";
import type { CachedUpdate, HiddenUpdate, HistoryEntry, ActiveOperation, ActivityStep } from "../lib/systems";
import { deriveSystemUpdateState, getUpdatesPanelState } from "../lib/system-status";
import { getUpgradeBehaviorNotes } from "../lib/package-manager-configs";
import { getHostKeyStatusText } from "../lib/host-key-status";

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
  systemId,
  busy,
  onHide,
  hideBusy,
}: {
  updates: CachedUpdate[];
  systemId: number;
  busy?: boolean;
  onHide: (update: CachedUpdate) => void;
  hideBusy?: boolean;
}) {
  const { upgradePackage, isUpgrading } = useUpgrade();
  const { addToast } = useToast();
  const upgrading = isUpgrading(systemId) || busy;

  const handleUpgrade = (packageName: string) => {
    upgradePackage(systemId, packageName, {
      onSuccess: () => addToast(`${packageName} upgraded`, "success"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

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
                    disabled={upgrading || hideBusy}
                    className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-500 transition-colors disabled:opacity-50"
                    title={`Hide ${u.packageName} ${u.newVersion || ""}`.trim()}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3l18 18" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.584 10.587A2 2 0 0013.412 13.4" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.363 5.365A9.466 9.466 0 0112 5c4.478 0 8.268 2.943 9.543 7a9.97 9.97 0 01-4.132 5.411M6.228 6.228A9.965 9.965 0 002.458 12c1.274 4.057 5.064 7 9.542 7a9.46 9.46 0 005.057-1.47" />
                    </svg>
                  </button>
                  <button
                    onClick={() => handleUpgrade(u.packageName)}
                    disabled={upgrading}
                    className="p-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 transition-colors disabled:opacity-50"
                    title={`Upgrade ${u.packageName}`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
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

function UpdateCheckNotice({
  state,
}: {
  state: ReturnType<typeof getUpdatesPanelState>;
}) {
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
        <pre className={`mt-3 overflow-x-auto rounded-lg px-3 py-2 text-xs whitespace-pre-wrap ${tone.code}`}>
          {state.error}
        </pre>
      )}
    </div>
  );
}

function getStatusVariant(status: string): "success" | "warning" | "danger" | "muted" {
  if (status === "success") return "success";
  if (status === "warning") return "warning";
  if (status === "failed") return "danger";
  return "muted";
}

function StepPanel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className: string;
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 font-semibold">{title}</p>
      <pre className={className}>{children}</pre>
    </div>
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
        <StepPanel
          title="Command"
          className="text-xs font-mono bg-slate-900 text-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all"
        >
          {command}
        </StepPanel>
      )}
      {(command || output) && (
        <StepPanel
          title="Output"
          className="text-xs font-mono bg-slate-900 text-slate-300 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
        >
          {output || <span className="text-slate-500 italic">No output</span>}
        </StepPanel>
      )}
      {error && (
        <StepPanel
          title="Error"
          className="text-xs font-mono bg-red-950/50 text-red-300 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
        >
          {error}
        </StepPanel>
      )}
    </>
  );
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
  const [selectedIndex, setSelectedIndex] = useState(() =>
    defaultToLastStep && steps.length > 0 ? steps.length - 1 : 0
  );
  const prevStepCountRef = useRef(steps.length);

  useEffect(() => {
    const prevCount = prevStepCountRef.current;
    const shouldFollowNewest =
      defaultToLastStep &&
      prevCount > 0 &&
      selectedIndex === prevCount - 1 &&
      steps.length > prevCount;

    if (steps.length === 0) {
      setSelectedIndex(0);
    } else if (shouldFollowNewest) {
      setSelectedIndex(steps.length - 1);
    } else if (selectedIndex >= steps.length) {
      setSelectedIndex(steps.length - 1);
    }

    prevStepCountRef.current = steps.length;
  }, [defaultToLastStep, selectedIndex, steps.length]);

  const selectedStep = steps[selectedIndex];
  if (!selectedStep) {
    return (
      <div className="text-xs text-slate-500 italic">
        Waiting for output…
      </div>
    );
  }

  const isGlobalPhase = phase === "reconnecting" || phase === "rechecking";
  const showStepTabs = steps.length > 1;

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

      {showStepTabs && (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label="Activity steps"
        >
          {steps.map((step, index) => {
            const isSelected = index === selectedIndex;
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
                  {index + 1}/{steps.length} {step.pkgManager}
                </span>
                <span className="block text-xs font-medium">
                  {getActivityStepLabel(step, index)}
                </span>
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

        <StepPanel
          title="Command"
          className="text-xs font-mono bg-slate-900 text-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all"
        >
          {selectedStep.command}
        </StepPanel>

        <StepPanel
          title="Output"
          className="text-xs font-mono bg-slate-900 text-slate-300 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
        >
          {selectedStep.output || <span className="text-slate-500 italic">No output</span>}
        </StepPanel>

        {selectedStep.error && (
          <StepPanel
            title="Error"
            className="text-xs font-mono bg-red-950/50 text-red-300 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {selectedStep.error}
          </StepPanel>
        )}
      </div>
    </div>
  );
}

function HistoryList({
  history,
  commandOutput,
  activeOp,
}: {
  history: HistoryEntry[];
  commandOutput: ReturnType<typeof useCommandOutput>;
  activeOp: ActiveOperation | null | undefined;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // Tracks whether we're waiting for the DB result of a check-type op (no "started" row).
  // Using state (not ref) so that showSynthetic keeps the placeholder visible during the gap
  // between WS "done" and the next poll returning the new history entry.
  const [pendingExpand, setPendingExpand] = useState(false);
  // Initialised to current top so we don't re-trigger on mount
  const prevTopHistoryIdRef = useRef<number | undefined>(history[0]?.id);

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // isLive: stay true until messages are cleared (new command starts)
  const hasOutput = commandOutput.isActive || commandOutput.messages.length > 0;
  // The in-progress DB entry (status "started") — appears quickly after polling kicks in
  const startedEntry = hasOutput ? history.find((h) => h.status === "started") : undefined;
  // Keep the synthetic visible while the command is active OR while waiting for the DB result
  // to arrive (the gap between WS "done" and the next poll). This prevents the "vanish then
  // reappear" flicker for check-type ops.
  const showSynthetic = (commandOutput.isActive || pendingExpand) && !startedEntry;

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

  // Fallback label for the synthetic placeholder (before DB entry arrives)
  const syntheticStartedMsg = commandOutput.messages
    .findLast((m): m is Extract<WsMessage, { type: "started" }> => m.type === "started");
  const liveSteps = deriveLiveActivitySteps(commandOutput.messages);
  const syntheticLabel = (() => {
    if (activeOp) {
      if (activeOp.type === "check") return "Checking for updates";
      if (activeOp.type === "upgrade_all") return "Upgrading all packages";
      if (activeOp.type === "full_upgrade_all") return "Full upgrading all packages";
      if (activeOp.type === "reboot") return "Rebooting system";
        return `Upgrading ${activeOp.packageName || "package"}`;
    }
    if (syntheticStartedMsg) return `Running ${syntheticStartedMsg.pkgManager} command`;
    return "Running…";
  })();
  const syntheticSteps =
    liveSteps.length > 0
      ? liveSteps
      : syntheticStartedMsg?.command
        ? [{
            label: null,
            pkgManager: syntheticStartedMsg.pkgManager,
            command: syntheticStartedMsg.command,
            output: null,
            error: null,
            status: "started" as const,
          }]
        : [];

  if (!hasOutput && !history.length) {
    return (
      <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
        No activity yet
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {/* Synthetic placeholder shown only during the brief polling lag before the DB entry appears */}
      {showSynthetic && (
        <div>
          <div className="w-full flex items-start gap-3 text-sm px-2 py-2 rounded-lg text-left">
            <svg
              className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400 rotate-90"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <Badge variant="muted" small>running</Badge>
            <div className="flex-1 min-w-0">
              <p className="font-medium">
                {syntheticLabel}
                {activeOp?.type !== "check" && activeOp?.type !== "reboot" && (
                  <span className="relative group ml-2 inline-flex">
                    <Badge variant="info" small>SSH-safe</Badge>
                    <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-max max-w-xs rounded bg-slate-900 dark:bg-slate-700 px-2 py-1 text-[11px] text-white opacity-0 group-hover:opacity-100 transition-opacity z-10">
                      This command runs via nohup on the remote system and will continue even if the SSH connection drops.
                    </span>
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="ml-10 mr-2 mb-2 space-y-2">
            {syntheticSteps.length > 0 ? (
              <ActivityStepViewer
                viewerId="activity-synthetic"
                steps={syntheticSteps}
                defaultToLastStep
                isLive
                phase={commandOutput.phase}
              />
            ) : (
              <div className="text-xs text-slate-500 italic">Waiting for output…</div>
            )}
          </div>
        </div>
      )}
      {history.map((h) => {
        const isRunningEntry = h.id === startedEntry?.id;
        // A running entry has the command set; treat it as expandable even without output/error yet
        const hasDetails = !!(h.steps?.length || h.command || h.output || h.error) || isRunningEntry;
        const isOpen = expanded.has(h.id);
        const runningSteps =
          isRunningEntry && liveSteps.length > 0
            ? liveSteps
            : isRunningEntry && h.command
              ? [{
                  label: null,
                  pkgManager: h.pkgManager,
                  command: h.command,
                  output: null,
                  error: null,
                  status: "started" as const,
                }]
              : [];

        return (
          <div key={h.id}>
            <button
              type="button"
              onClick={() => hasDetails && toggle(h.id)}
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
                  h.status === "success"
                    ? "success"
                    : h.status === "warning"
                      ? "warning"
                      : h.status === "failed"
                        ? "danger"
                        : "muted"
                }
                small
              >
                {isRunningEntry ? "running" : h.status}
              </Badge>
              <div className="flex-1 min-w-0">
                <p className="font-medium">
                  {h.action === "check"
                    ? "Checked for updates"
                    : h.action === "upgrade_all"
                      ? "Upgraded all packages"
                      : h.action === "full_upgrade_all"
                        ? "Full upgraded all packages"
                        : h.action === "reboot"
                          ? "Rebooted system"
                          : `Upgraded ${h.packagesList?.join(", ") || "package"}`}
                  {h.action !== "check" && h.action !== "reboot" && (
                    <span className="relative group ml-2 inline-flex align-middle">
                      <Badge variant="info" small>SSH-safe</Badge>
                      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-max max-w-xs rounded bg-slate-900 dark:bg-slate-700 px-2 py-1 text-[11px] text-white opacity-0 group-hover:opacity-100 transition-opacity z-10">
                        This command ran via nohup on the remote system and would have continued even if the SSH connection dropped.
                      </span>
                    </span>
                  )}
                </p>
                {h.packageCount !== null && h.action === "check" && (
                  <p className="text-xs text-slate-500">
                    {h.packageCount} update{h.packageCount !== 1 ? "s" : ""} found
                  </p>
                )}
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                <span className="text-xs text-slate-400 whitespace-nowrap">
                  {h.pkgManager}
                </span>
                <AgoLabel timestamp={h.startedAt} />
              </div>
            </button>

            {isOpen && hasDetails && (
              <div className="ml-10 mr-2 mb-2 space-y-2">
                {isRunningEntry ? (
                  <ActivityStepViewer
                    viewerId={`activity-live-${h.id}`}
                    steps={runningSteps}
                    defaultToLastStep
                    isLive
                    phase={commandOutput.phase}
                  />
                ) : h.steps?.length ? (
                  <ActivityStepViewer
                    viewerId={`activity-history-${h.id}`}
                    steps={h.steps}
                  />
                ) : (
                  <LegacyActivityDetails
                    command={h.command}
                    output={h.output}
                    error={h.error}
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
  const { data, isLoading } = useSystem(systemId);
  const checkUpdates = useCheckUpdates();
  const hideUpdate = useHideUpdate();
  const unhideUpdate = useUnhideUpdate();
  const { upgradeAll, fullUpgradeAll, isUpgrading } = useUpgrade();
  const { addToast } = useToast();
  const rebootSystem = useRebootSystem();
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [showFullUpgradeConfirm, setShowFullUpgradeConfirm] = useState(false);
  const [showRebootConfirm, setShowRebootConfirm] = useState(false);
  const [pendingHideUpdate, setPendingHideUpdate] = useState<CachedUpdate | null>(null);
  const [showUpgradeDropdown, setShowUpgradeDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const commandOutput = useCommandOutput(systemId);
  const qc = useQueryClient();

  // When the WebSocket signals an active operation, kick the query into polling mode
  // (refetchInterval only activates when activeOperation is already in cached data)
  useEffect(() => {
    if (commandOutput.isActive) {
      qc.invalidateQueries({ queryKey: ["system", systemId] });
    }
  }, [commandOutput.isActive, systemId, qc]);

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
  const checking = checkUpdates.isPending || activeOp?.type === "check";
  const upgrading = isUpgrading(systemId) || activeOp?.type === "upgrade_all" || activeOp?.type === "full_upgrade_all" || activeOp?.type === "upgrade_package";
  const rebooting = rebootSystem.isPending || activeOp?.type === "reboot";

  if (isLoading || !data) {
    return (
      <Layout title="System Detail">
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      </Layout>
    );
  }

  const { system, updates, hiddenUpdates, history } = data;
  const updatesPanelState = getUpdatesPanelState(system, updates.length);
  const updateState = deriveSystemUpdateState(system, { upgrading, checking });
  const dotColor = updateState === "check_failed" || updateState === "unreachable"
    ? "bg-red-500"
    : updateState === "check_warning" || updateState === "updates_available"
      ? "bg-amber-500"
      : updateState === "up_to_date"
        ? "bg-green-500"
        : "bg-slate-400";
  const showUpgradeAllButton = system.updateCount > 0 || upgrading;
  const showUpgradeActions = showUpgradeAllButton;
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
      onSuccess: (d) =>
        addToast(
          `Check complete: ${d.updateCount} update${d.updateCount !== 1 ? "s" : ""} found`,
          d.updateCount === 0 ? "success" : "info"
        ),
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
              : "Upgrade failed",
          d.status === "failed" ? "danger" : d.status === "warning" ? "info" : "success"
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
              : "Full upgrade failed",
          d.status === "failed" ? "danger" : d.status === "warning" ? "info" : "success"
        ),
      onError: (err: Error) => addToast(err.message, "danger"),
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

  return (
    <Layout
      title={
        <span className="flex items-center gap-2 min-w-0">
          {upgrading || checking ? (
            <span className={`spinner spinner-sm !w-3.5 !h-3.5 shrink-0 ${upgrading ? "!border-blue-500" : "!border-sky-400"} !border-t-transparent`} />
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
          <button
            onClick={handleCheck}
            disabled={checking || upgrading}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {checking ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                Checking...
              </span>
            ) : "Refresh"}
          </button>
          {showUpgradeActions && (
            system.supportsFullUpgrade ? (
              showUpgradeAllButton ? (
                <div className="relative" ref={dropdownRef}>
                  <div className="flex">
                    <button
                      onClick={() => setShowUpgradeConfirm(true)}
                      disabled={upgrading || checking}
                      className="px-3 py-1.5 text-sm rounded-l-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
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
                      disabled={upgrading || checking}
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
                  disabled={upgrading || checking}
                  className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
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
                disabled={upgrading || checking}
                className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
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
            disabled={rebooting || upgrading || checking}
            className="ml-auto px-3 py-1 text-xs font-medium rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {rebooting ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                Rebooting...
              </span>
            ) : "Reboot"}
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
        <UpdateCheckNotice state={updatesPanelState} />
        {updates.length > 0 ? (
          <UpdatesTable
            updates={updates}
            systemId={systemId}
            busy={upgrading || checking}
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
        busy={unhideUpdate.isPending || hideUpdate.isPending || upgrading || checking}
        onUnhide={handleUnhideUpdate}
      />

      {/* History */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-border">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Activity</h2>
        </div>
        <div className="p-4">
          <HistoryList history={history} commandOutput={commandOutput} activeOp={activeOp} />
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
