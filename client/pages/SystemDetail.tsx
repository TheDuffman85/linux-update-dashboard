import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import { Layout } from "../components/Layout";
import { Badge } from "../components/Badge";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useSystem, useDeleteSystem } from "../api/systems";
import { useCheckUpdates, useUpgradeAll, useUpgradePackage } from "../api/updates";
import { useToast } from "../context/ToastContext";
import type { CachedUpdate, HistoryEntry } from "../api/systems";

function InfoCard({ title, items }: { title: string; items: { label: string; value: string | null }[] }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">{title}</h3>
      <dl className="space-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex justify-between text-sm">
            <dt className="text-slate-500 dark:text-slate-400">{item.label}</dt>
            <dd className="font-medium truncate ml-4">{item.value || "-"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function UpdatesTable({
  updates,
  systemId,
}: {
  updates: CachedUpdate[];
  systemId: number;
}) {
  const upgradePackage = useUpgradePackage();
  const { addToast } = useToast();

  const handleUpgrade = (packageName: string) => {
    upgradePackage.mutate(
      { systemId, packageName },
      {
        onSuccess: () => addToast(`${packageName} upgraded`, "success"),
        onError: (err) => addToast(err.message, "danger"),
      }
    );
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
            <th className="px-4 py-2">Package</th>
            <th className="px-4 py-2 hidden sm:table-cell">Current</th>
            <th className="px-4 py-2">Available</th>
            <th className="px-4 py-2 hidden md:table-cell">Manager</th>
            <th className="px-4 py-2 hidden lg:table-cell">Repository</th>
            <th className="px-4 py-2 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {updates.map((u) => (
            <tr key={u.id} className="border-b border-border last:border-0">
              <td className="px-4 py-2">
                {u.packageName}
                {u.isSecurity ? (
                  <Badge variant="danger" small>security</Badge>
                ) : null}
              </td>
              <td className="px-4 py-2 hidden sm:table-cell text-slate-500 font-mono text-xs">
                {u.currentVersion || "-"}
              </td>
              <td className="px-4 py-2 font-mono text-xs font-medium">
                {u.newVersion}
              </td>
              <td className="px-4 py-2 hidden md:table-cell text-slate-500">
                {u.pkgManager}
              </td>
              <td className="px-4 py-2 hidden lg:table-cell text-slate-500 truncate max-w-[150px]">
                {u.repository || "-"}
              </td>
              <td className="px-4 py-2 text-right">
                <button
                  onClick={() => handleUpgrade(u.packageName)}
                  disabled={upgradePackage.isPending}
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

function HistoryList({ history }: { history: HistoryEntry[] }) {
  if (!history.length) {
    return (
      <div className="text-center py-8 text-sm text-slate-500 dark:text-slate-400">
        No activity yet
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {history.map((h) => (
        <div key={h.id} className="flex items-start gap-3 text-sm">
          <Badge
            variant={
              h.status === "success"
                ? "success"
                : h.status === "failed"
                  ? "danger"
                  : "muted"
            }
            small
          >
            {h.status}
          </Badge>
          <div className="flex-1 min-w-0">
            <p className="font-medium">
              {h.action === "check"
                ? "Checked for updates"
                : h.action === "upgrade_all"
                  ? "Upgraded all packages"
                  : `Upgraded ${h.packagesList?.join(", ") || "package"}`}
            </p>
            {h.packageCount !== null && h.action === "check" && (
              <p className="text-xs text-slate-500">
                {h.packageCount} update{h.packageCount !== 1 ? "s" : ""} found
              </p>
            )}
            {h.error && (
              <p className="text-xs text-red-500 mt-1 font-mono truncate">
                {h.error}
              </p>
            )}
          </div>
          <span className="text-xs text-slate-400 whitespace-nowrap">
            {h.pkgManager}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function SystemDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const systemId = parseInt(id!, 10);
  const { data, isLoading } = useSystem(systemId);
  const checkUpdates = useCheckUpdates();
  const upgradeAll = useUpgradeAll();
  const deleteSystem = useDeleteSystem();
  const { addToast } = useToast();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);

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
    upgradeAll.mutate(systemId, {
      onSuccess: (d) =>
        addToast(
          d.status === "success" ? "Upgrade complete" : "Upgrade failed",
          d.status === "success" ? "success" : "danger"
        ),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleDelete = () => {
    deleteSystem.mutate(systemId, {
      onSuccess: () => {
        addToast("System deleted", "success");
        navigate("/systems");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <Layout
      title={system.name}
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={handleCheck}
            disabled={checkUpdates.isPending}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {checkUpdates.isPending ? <span className="spinner spinner-sm" /> : "Refresh"}
          </button>
          {system.updateCount > 0 && (
            <button
              onClick={() => setShowUpgradeConfirm(true)}
              disabled={upgradeAll.isPending}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
            >
              {upgradeAll.isPending ? (
                <span className="spinner spinner-sm" />
              ) : (
                `Upgrade All (${system.updateCount})`
              )}
            </button>
          )}
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
            title="Delete system"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
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
            { label: "Pkg Manager", value: system.pkgManager },
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
        <UpdatesTable updates={updates} systemId={systemId} />
      </div>

      {/* History */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-border">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Recent Activity</h2>
        </div>
        <div className="p-4">
          <HistoryList history={history} />
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
        loading={upgradeAll.isPending}
      />
      <ConfirmDialog
        open={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
        title="Delete System"
        message={`Are you sure you want to delete ${system.name}? This action cannot be undone.`}
        confirmLabel="Delete"
        danger
        loading={deleteSystem.isPending}
      />
    </Layout>
  );
}
