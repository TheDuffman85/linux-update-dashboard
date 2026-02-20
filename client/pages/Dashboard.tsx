import { Link } from "react-router";
import { Layout } from "../components/Layout";
import { Badge } from "../components/Badge";
import { useDashboardStats, useDashboardSystems } from "../api/dashboard";
import { useRefreshCache } from "../api/updates";
import { useToast } from "../context/ToastContext";

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function SystemCard({ system }: { system: { id: number; name: string; hostname: string; port: number; osName: string | null; isReachable: number; updateCount: number; cacheAge: string | null; isStale?: boolean } }) {
  const borderColor =
    system.isReachable === -1
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
        <span
          className={`w-2 h-2 rounded-full ${
            system.isReachable === 1
              ? "bg-green-500"
              : system.isReachable === -1
                ? "bg-red-500"
                : "bg-slate-400"
          }`}
        />
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
        {system.hostname}
        {system.port !== 22 && `:${system.port}`}
      </p>
      {system.osName && (
        <p className="text-xs text-slate-400 truncate mt-0.5">{system.osName}</p>
      )}
      <div className="flex items-center justify-between mt-3">
        <div>
          {system.isReachable === -1 ? (
            <Badge variant="danger" small>Unreachable</Badge>
          ) : system.updateCount > 0 ? (
            <Badge variant="warning" small>{system.updateCount} updates</Badge>
          ) : system.isReachable === 1 ? (
            <Badge variant="success" small>Up to date</Badge>
          ) : (
            <Badge variant="muted" small>Unchecked</Badge>
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
  const { data: stats } = useDashboardStats();
  const { data: systems } = useDashboardSystems();
  const refreshCache = useRefreshCache();
  const { addToast } = useToast();

  const handleRefresh = () => {
    refreshCache.mutate(undefined, {
      onSuccess: () => addToast("Cache cleared. Refreshing all systems...", "info"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <Layout
      title="Dashboard"
      actions={
        <button
          onClick={handleRefresh}
          disabled={refreshCache.isPending}
          className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {refreshCache.isPending ? <span className="spinner spinner-sm" /> : "Refresh All"}
        </button>
      }
    >
      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
          <StatCard label="Total Systems" value={stats.total} color="text-slate-700 dark:text-slate-200" />
          <StatCard label="Up to Date" value={stats.upToDate} color="text-green-600" />
          <StatCard label="Need Updates" value={stats.needsUpdates} color="text-amber-600" />
          <StatCard label="Unreachable" value={stats.unreachable} color="text-red-600" />
          <StatCard label="Total Updates" value={stats.totalUpdates} color="text-blue-600" />
        </div>
      )}

      {/* System cards grid */}
      {systems && systems.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {systems.map((s) => (
            <SystemCard key={s.id} system={s} />
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
    </Layout>
  );
}
