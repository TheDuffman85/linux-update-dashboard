import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { Layout } from "../components/Layout";
import { Badge } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useQueryClient } from "@tanstack/react-query";
import { useSystem, useRebootSystem } from "../lib/systems";
import { useCheckUpdates } from "../lib/updates";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";
import { useCommandOutput } from "../hooks/useCommandOutput";
import type { WsMessage } from "../hooks/useCommandOutput";
import type { CachedUpdate, HistoryEntry, ActiveOperation } from "../lib/systems";

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
}: {
  updates: CachedUpdate[];
  systemId: number;
  busy?: boolean;
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
            <th className="px-2 sm:px-4 py-2 text-right whitespace-nowrap">Action</th>
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
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr + "Z");
  const now = Date.now();
  const diffMs = now - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function LiveOutput({ messages, isActive }: { messages: WsMessage[]; isActive: boolean }) {
  const containerRef = useRef<HTMLPreElement>(null);
  const isScrolledToBottom = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isScrolledToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  };

  useEffect(() => {
    if (isScrolledToBottom.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <p className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 font-semibold">Output</p>
        {isActive && (
          <span className="flex items-center gap-1 text-[10px] text-green-500">
            <span className="spinner spinner-sm !w-2.5 !h-2.5" />
            live
          </span>
        )}
      </div>
      <pre
        ref={containerRef}
        onScroll={handleScroll}
        className="text-xs font-mono bg-slate-900 text-slate-300 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all"
      >
        {!messages.some((m) => m.type === "output" || m.type === "error") && (
          <span className="text-slate-500 italic">Waiting for output…</span>
        )}
        {messages.map((msg, i) => {
          switch (msg.type) {
            case "started":
              return null;
            case "output":
              return (
                <span key={i} className={msg.stream === "stderr" ? "text-red-400" : undefined}>
                  {msg.data}
                </span>
              );
            case "phase":
              return null;
            case "done":
              return null;
            case "error":
              return (
                <span key={i} className="text-red-400">
                  Error: {msg.message}
                </span>
              );
            case "warning":
              return (
                <span key={i} className="text-amber-400 font-semibold">
                  {"\n"}Warning: {msg.message}{"\n"}
                </span>
              );
            default:
              return null;
          }
        })}
      </pre>
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

  // When the top history entry changes (new result landed), clear the pending flag.
  const topHistoryId = history[0]?.id;
  useEffect(() => {
    if (!pendingExpand) return;
    if (topHistoryId === prevTopHistoryIdRef.current) return;
    prevTopHistoryIdRef.current = topHistoryId;
    setPendingExpand(false);
  }, [topHistoryId, pendingExpand]);

  // Fallback label for the synthetic placeholder (before DB entry arrives)
  const syntheticStartedMsg = commandOutput.messages
    .findLast((m): m is Extract<WsMessage, { type: "started" }> => m.type === "started");
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
            {syntheticStartedMsg?.command && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 font-semibold">Command</p>
                <pre className="text-xs font-mono bg-slate-900 text-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">{syntheticStartedMsg.command}</pre>
              </div>
            )}
            <LiveOutput messages={commandOutput.messages} isActive={commandOutput.isActive} />
          </div>
        </div>
      )}
      {history.map((h) => {
        const isRunningEntry = h.id === startedEntry?.id;
        // A running entry has the command set; treat it as expandable even without output/error yet
        const hasDetails = !!(h.command || h.output || h.error) || isRunningEntry;
        const isOpen = expanded.has(h.id);

        return (
          <div key={h.id}>
            <button
              type="button"
              onClick={() => hasDetails && toggle(h.id)}
              className={`w-full flex items-start gap-3 text-sm px-2 py-2 rounded-lg transition-colors text-left ${
                hasDetails
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
                <span className="text-[11px] text-slate-500 dark:text-slate-500 whitespace-nowrap">
                  {formatTimeAgo(h.startedAt)}
                </span>
              </div>
            </button>

            {isOpen && hasDetails && (
              <div className="ml-10 mr-2 mb-2 space-y-2">
                {h.command && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 font-semibold">Command</p>
                    <pre className="text-xs font-mono bg-slate-900 text-slate-200 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">{h.command}</pre>
                  </div>
                )}
                {isRunningEntry ? (
                  <LiveOutput messages={commandOutput.messages} isActive={commandOutput.isActive} />
                ) : (
                  <>
                    {(h.command || h.output) && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 font-semibold">Output</p>
                        <pre className="text-xs font-mono bg-slate-900 text-slate-300 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                          {h.output || <span className="text-slate-500 italic">No output</span>}
                        </pre>
                      </div>
                    )}
                    {h.error && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-red-500 mb-1 font-semibold">Error</p>
                        <pre className="text-xs font-mono bg-red-950/50 text-red-300 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">{h.error}</pre>
                      </div>
                    )}
                  </>
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
  const { upgradeAll, fullUpgradeAll, isUpgrading } = useUpgrade();
  const { addToast } = useToast();
  const rebootSystem = useRebootSystem();
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [showFullUpgradeConfirm, setShowFullUpgradeConfirm] = useState(false);
  const [showRebootConfirm, setShowRebootConfirm] = useState(false);
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

  const { system, updates, history } = data;

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

  return (
    <Layout
      title={system.name}
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
          {(system.updateCount > 0 || upgrading) && (
            system.supportsFullUpgrade ? (
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
            { label: "Pkg Managers", value: (() => {
              const detected: string[] = system.detectedPkgManagers ?? (system.pkgManager ? [system.pkgManager] : []);
              const disabled: string[] = system.disabledPkgManagers ?? [];
              const active = detected.filter((m) => !disabled.includes(m));
              return active.length > 0 ? active.join(", ") : null;
            })() },
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
          </h2>
          {system.cacheAge && (
            <span className={`text-xs ${system.isStale ? "text-amber-500" : "text-slate-400"}`}>
              {system.cacheAge}
            </span>
          )}
        </div>
        <UpdatesTable
          updates={updates}
          systemId={systemId}
          busy={upgrading || checking}
        />
      </div>

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
        message={`Apply all ${system.updateCount} updates to ${system.name}?`}
        confirmLabel="Upgrade All"
        loading={upgrading}
      />
      <ConfirmDialog
        open={showFullUpgradeConfirm}
        onClose={() => setShowFullUpgradeConfirm(false)}
        onConfirm={handleFullUpgradeAll}
        title="Full Upgrade All Packages"
        message={`Perform a full upgrade on ${system.name}? This may install new dependencies or remove obsolete packages to complete the upgrade of all ${system.updateCount} packages.`}
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
    </Layout>
  );
}
