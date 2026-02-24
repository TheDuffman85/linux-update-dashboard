import { useState, useEffect } from "react";
import { Link } from "react-router";
import { Layout } from "../components/Layout";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { useDashboardStats, useDashboardSystems } from "../lib/dashboard";
import { useRefreshCache } from "../lib/updates";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function SystemCard({ system, upgrading, checking }: { system: { id: number; name: string; hostname: string; port: number; osName: string | null; isReachable: number; updateCount: number; needsReboot?: number; cacheAge: string | null; isStale?: boolean }; upgrading: boolean; checking: boolean }) {
  const borderColor = upgrading
    ? "border-l-blue-500"
    : checking
      ? "border-l-sky-400"
      : system.isReachable === -1
      ? "border-l-red-500"
      : system.updateCount > 0
        ? "border-l-amber-500"
        : system.isReachable === 1
          ? "border-l-green-500"
          : "border-l-slate-300 dark:border-l-slate-600";

  return (
    <Link
      to={`/systems/${system.id}`}
      className={`block bg-white dark:bg-slate-800 rounded-xl border border-border border-l-4 ${borderColor} p-4 hover:shadow-md transition-shadow`}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-sm truncate">{system.name}</h3>
        {upgrading || checking ? (
          <span className={`spinner spinner-sm !w-2.5 !h-2.5 ${upgrading ? "!border-blue-500" : "!border-sky-400"} !border-t-transparent`} />
        ) : (
          <span
            className={`w-2 h-2 rounded-full ${
              system.isReachable === 1
                ? "bg-green-500"
                : system.isReachable === -1
                  ? "bg-red-500"
                  : "bg-slate-400"
            }`}
          />
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
        {system.hostname}
        {system.port !== 22 && `:${system.port}`}
      </p>
      {system.osName && (
        <p className="text-xs text-slate-400 truncate mt-0.5">{system.osName}</p>
      )}
      <div className="flex items-center justify-between mt-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {upgrading ? (
            <Badge variant="info" small>Upgrading...</Badge>
          ) : checking ? (
            <Badge variant="muted" small>Checking...</Badge>
          ) : system.isReachable === -1 ? (
            <Badge variant="danger" small>Unreachable</Badge>
          ) : system.updateCount > 0 ? (
            <Badge variant="warning" small>{system.updateCount} updates</Badge>
          ) : system.isReachable === 1 ? (
            <Badge variant="success" small>Up to date</Badge>
          ) : (
            <Badge variant="muted" small>Unchecked</Badge>
          )}
          {system.needsReboot === 1 && (
            <span className="text-amber-500" title="Reboot required">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </span>
          )}
        </div>
        {system.cacheAge && (
          <span className={`text-[10px] ${system.isStale ? "text-amber-500" : "text-slate-400"}`}>
            {system.cacheAge}
          </span>
        )}
      </div>
    </Link>
  );
}

export default function Dashboard() {
  const { upgradeAll, isUpgrading, removeUpgrading, upgradingSystems, upgradingCount } = useUpgrade();
  const { data: systems, dataUpdatedAt } = useDashboardSystems(upgradingCount > 0);
  const hasActiveOps = systems?.some((s) => s.activeOperation) ?? false;
  const { data: stats } = useDashboardStats(hasActiveOps);
  const refreshCache = useRefreshCache();
  const { addToast } = useToast();
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);

  // Sync client-side upgrading state with server's activeOperation.
  // React Query only fires inline mutation callbacks for the last .mutate() call,
  // so when upgrading multiple systems concurrently, earlier callbacks are lost.
  // This effect clears stale entries when the server confirms no active upgrade.
  // We compare dataUpdatedAt with each entry's addedAt to avoid clearing entries
  // based on stale server data that was fetched before the upgrade started.
  useEffect(() => {
    if (!systems || upgradingSystems.size === 0) return;
    for (const [systemId, entry] of upgradingSystems) {
      if (dataUpdatedAt < entry.addedAt) continue;
      const serverSystem = systems.find((s) => s.id === systemId);
      if (serverSystem && !serverSystem.activeOperation) {
        removeUpgrading(systemId);
      }
    }
  }, [systems, dataUpdatedAt, upgradingSystems, removeUpgrading]);

  const handleRefresh = () => {
    refreshCache.mutate(undefined, {
      onSuccess: () => addToast("Cache cleared. Refreshing all systems...", "info"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const systemsWithUpdates = systems?.filter((s) => s.updateCount > 0 && !isUpgrading(s.id)) ?? [];
  const eligibleSystems = systemsWithUpdates.filter((s) => s.excludeFromUpgradeAll !== 1);
  const excludedSystems = systemsWithUpdates.filter((s) => s.excludeFromUpgradeAll === 1);
  const eligibleUpdateCount = eligibleSystems.reduce((sum, s) => sum + s.updateCount, 0);

  const handleUpgradeAll = () => {
    setShowUpgradeConfirm(false);
    for (const s of eligibleSystems) {
      upgradeAll(s.id, {
        onSuccess: (d: any) =>
          addToast(
            d.status === "success"
              ? `${s.name}: Upgrade complete`
              : `${s.name}: Upgrade failed`,
            d.status === "success" ? "success" : "danger"
          ),
        onError: (err: Error) => addToast(`${s.name}: ${err.message}`, "danger"),
      });
    }
  };

  return (
    <Layout
      title="Dashboard"
      actions={
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={handleRefresh}
            disabled={refreshCache.isPending}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {refreshCache.isPending ? <span className="spinner spinner-sm" /> : "Refresh All"}
          </button>
          {(eligibleSystems.length > 0 || upgradingCount > 0) && (
            <button
              onClick={() => setShowUpgradeConfirm(true)}
              disabled={upgradingCount > 0}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {upgradingCount > 0 ? (
                <span className="flex items-center gap-1.5">
                  <span className="spinner spinner-sm" />
                  Upgrading...
                </span>
              ) : (
                `Upgrade All (${eligibleUpdateCount})`
              )}
            </button>
          )}
        </div>
      }
    >
      {/* Stats */}
      {stats && (
        <div className={`grid grid-cols-2 sm:grid-cols-3 ${stats.needsReboot > 0 ? "lg:grid-cols-6" : "lg:grid-cols-5"} gap-3 mb-6`}>
          <StatCard label="Total Systems" value={stats.total} color="text-slate-700 dark:text-slate-200" />
          <StatCard label="Up to Date" value={stats.upToDate} color="text-green-600" />
          <StatCard label="Need Updates" value={stats.needsUpdates} color="text-amber-600" />
          <StatCard label="Unreachable" value={stats.unreachable} color="text-red-600" />
          <StatCard label="Total Updates" value={stats.totalUpdates} color="text-blue-600" />
          {stats.needsReboot > 0 && (
            <StatCard label="Needs Reboot" value={stats.needsReboot} color="text-amber-500" />
          )}
        </div>
      )}

      {/* System cards grid */}
      {systems && systems.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {systems.map((s) => (
            <SystemCard key={s.id} system={s} upgrading={isUpgrading(s.id) || !!s.activeOperation?.type?.includes("upgrade")} checking={!!s.activeOperation && !s.activeOperation.type.includes("upgrade")} />
          ))}
        </div>
      ) : (
        <div className="text-center py-16">
          <p className="text-slate-500 dark:text-slate-400 mb-4">No systems configured yet</p>
          <Link
            to="/systems"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Add System
          </Link>
        </div>
      )}

      <Modal open={showUpgradeConfirm} onClose={() => setShowUpgradeConfirm(false)} title="Upgrade All Systems">
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
          Apply {eligibleUpdateCount} update{eligibleUpdateCount !== 1 ? "s" : ""} across {eligibleSystems.length} system{eligibleSystems.length !== 1 ? "s" : ""}?
        </p>
        {eligibleSystems.length > 0 && (
          <ul className="mb-4 space-y-1">
            {eligibleSystems.map((s) => (
              <li key={s.id} className="flex items-center justify-between text-sm">
                <span>{s.name}</span>
                <Badge variant="warning" small>{s.updateCount} updates</Badge>
              </li>
            ))}
          </ul>
        )}
        {excludedSystems.length > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-700/50 border border-border">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-2">
              Excluded from Upgrade All
            </p>
            <ul className="space-y-1">
              {excludedSystems.map((s) => (
                <li key={s.id} className="flex items-center justify-between text-sm text-slate-400">
                  <span>{s.name}</span>
                  <Badge variant="muted" small>{s.updateCount} updates</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={() => setShowUpgradeConfirm(false)}
            className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleUpgradeAll}
            disabled={eligibleSystems.length === 0}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
          >
            Upgrade All
          </button>
        </div>
      </Modal>
    </Layout>
  );
}
