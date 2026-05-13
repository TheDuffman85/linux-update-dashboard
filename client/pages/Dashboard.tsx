import { useState, useEffect, useRef } from "react";
import { Link } from "react-router";
import Sortable from "sortablejs";
import { Layout } from "../components/Layout";
import { AgoLabel } from "../components/AgoLabel";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { useDashboardStats, useDashboardSystems } from "../lib/dashboard";
import { useRefreshCache } from "../lib/updates";
import {
  useReorderSystemUpgradeOrder,
  useUpdateSystemUpgradeAllExclusion,
  useUpdateSystemUpgradeMode,
} from "../lib/systems";
import type { System } from "../lib/systems";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";
import { deriveSystemUpdateState, isPostUpgradeRecheck } from "../lib/system-status";

function moveSystem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function compareUpgradeOrder(a: System, b: System): number {
  const orderDiff = (a.upgradeOrder ?? 1) - (b.upgradeOrder ?? 1);
  if (orderDiff !== 0) return orderDiff;
  return a.name.localeCompare(b.name) || a.id - b.id;
}

function parseManagerList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseConfigObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getConfigEntry(configs: Record<string, unknown>, manager: string): Record<string, unknown> {
  const entry = configs[manager];
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : {};
}

function getActiveManagers(system: System): string[] {
  const detectedManagers = parseManagerList(system.detectedPkgManagers);
  const disabledManagers = parseManagerList(system.disabledPkgManagers);
  const detected = detectedManagers.length
    ? detectedManagers
    : system.pkgManager
      ? [system.pkgManager]
      : [];
  const disabled = new Set(disabledManagers);
  return detected.filter((manager) => !disabled.has(manager));
}

function supportsDefaultUpgradeModeOverride(system: System): boolean {
  const managers = getActiveManagers(system);
  return managers.includes("apt") || managers.includes("dnf");
}

function isDefaultFullUpgradeEnabled(system: System): boolean {
  const managers = getActiveManagers(system);
  const configs = parseConfigObject(system.pkgManagerConfigs);
  return (
    managers.includes("apt") &&
    getConfigEntry(configs, "apt").defaultUpgradeMode === "full-upgrade"
  ) || (
    managers.includes("dnf") &&
    getConfigEntry(configs, "dnf").defaultUpgradeMode === "distro-sync"
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function SystemCard({ system, upgrading, checking }: { system: { id: number; name: string; hostname: string; port: number; osName: string | null; isReachable: number; updateCount: number; securityCount: number; keptBackCount: number; needsReboot?: number; cacheAge: string | null; cacheTimestamp?: string | null; isStale?: boolean; lastCheck: { status: "success" | "warning" | "failed"; error: string | null; startedAt: string; completedAt: string | null } | null; activeOperation?: { type: "check" | "upgrade_all" | "full_upgrade_all" | "upgrade_package" | "reboot"; startedAt: string; phase?: "reconnecting" | "rechecking"; packageName?: string; packageNames?: string[] } | null }; upgrading: boolean; checking: boolean }) {
  const updateState = deriveSystemUpdateState(system, { upgrading, checking });
  const dotColor = updateState === "check_failed" || updateState === "unreachable"
    ? "bg-red-500"
    : updateState === "check_warning" || updateState === "updates_available"
      ? "bg-amber-500"
      : updateState === "up_to_date"
        ? "bg-green-500"
        : "bg-slate-400";

  return (
    <Link
      to={`/systems/${system.id}`}
      className="block bg-white dark:bg-slate-800 rounded-xl border border-border p-4 hover:bg-slate-100 hover:border-slate-300 dark:hover:bg-slate-700 dark:hover:border-slate-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2 min-w-0">
        {upgrading || checking ? (
          <span className={`spinner spinner-sm !w-3.5 !h-3.5 shrink-0 ${upgrading ? "!border-blue-500" : "!border-sky-400"} !border-t-transparent`} />
        ) : (
          <span className={`w-3 h-3 rounded-full shrink-0 ${dotColor}`} />
        )}
        <h3 className="font-medium text-sm truncate">{system.name}</h3>
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
          {updateState === "upgrading" ? (
            <Badge variant="info" small>Upgrading...</Badge>
          ) : updateState === "checking" ? (
            <Badge variant="muted" small>Checking...</Badge>
          ) : updateState === "unreachable" ? (
            <Badge variant="danger" small>Unreachable</Badge>
          ) : updateState === "check_failed" ? (
            <Badge variant="danger" small>Check failed</Badge>
          ) : updateState === "check_warning" ? (
            <Badge variant="warning" small>Check warning</Badge>
          ) : updateState === "updates_available" ? (
            <Badge variant="warning" small>{system.updateCount} updates</Badge>
          ) : updateState === "up_to_date" ? (
            <Badge variant="success" small>Up to date</Badge>
          ) : (
            <Badge variant="muted" small>Unchecked</Badge>
          )}
          {updateState === "check_warning" && system.updateCount > 0 && (
            <Badge variant="warning" small>{system.updateCount} updates</Badge>
          )}
          {system.securityCount > 0 && (
            <Badge variant="danger" small>{system.securityCount} security</Badge>
          )}
          {system.keptBackCount > 0 && (
            <Badge variant="muted" small>{system.keptBackCount} kept back</Badge>
          )}
          {system.needsReboot === 1 && (
            <span className="text-amber-500" title="Reboot required">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </span>
          )}
        </div>
        {system.cacheTimestamp && (
          <AgoLabel
            timestamp={system.cacheTimestamp}
            stale={system.isStale}
            className="text-[10px]"
          />
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
  const reorderSystemUpgradeOrder = useReorderSystemUpgradeOrder();
  const updateSystemUpgradeAllExclusion = useUpdateSystemUpgradeAllExclusion();
  const updateSystemUpgradeMode = useUpdateSystemUpgradeMode();
  const { addToast } = useToast();
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [selectedSystemIds, setSelectedSystemIds] = useState<number[]>([]);
  const [fullUpgradeSelections, setFullUpgradeSelections] = useState<Record<number, boolean>>({});
  const [upgradeModalSystems, setUpgradeModalSystems] = useState<System[]>([]);
  const upgradeModalSystemsRef = useRef<System[]>([]);
  const upgradeListRef = useRef<HTMLUListElement | null>(null);
  const upgradeSortableRef = useRef<Sortable | null>(null);

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
      if (serverSystem && (!serverSystem.activeOperation || isPostUpgradeRecheck(serverSystem.activeOperation))) {
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
  const orderedSystemsWithUpdates = [...systemsWithUpdates].sort(compareUpgradeOrder);
  const modalSystems = showUpgradeConfirm ? upgradeModalSystems : orderedSystemsWithUpdates;
  const excludedSystems = orderedSystemsWithUpdates.filter((s) => s.excludeFromUpgradeAll === 1);
  const defaultSelectedSystemIds = orderedSystemsWithUpdates
    .filter((s) => s.excludeFromUpgradeAll !== 1)
    .map((s) => s.id);
  const defaultSelectedUpdateCount = orderedSystemsWithUpdates
    .filter((s) => s.excludeFromUpgradeAll !== 1)
    .reduce((sum, s) => sum + s.updateCount, 0);
  const selectedSystems = modalSystems.filter((s) => selectedSystemIds.includes(s.id));
  const selectedUpdateCount = selectedSystems.reduce((sum, s) => sum + s.updateCount, 0);

  useEffect(() => {
    upgradeModalSystemsRef.current = upgradeModalSystems;
  }, [upgradeModalSystems]);

  useEffect(() => {
    const list = upgradeListRef.current;
    if (!showUpgradeConfirm || !list || upgradeModalSystems.length <= 1) {
      upgradeSortableRef.current?.destroy();
      upgradeSortableRef.current = null;
      return;
    }

    upgradeSortableRef.current?.destroy();
    upgradeSortableRef.current = new Sortable(list, {
      animation: 150,
      handle: ".upgrade-drag-handle",
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (
          evt.oldIndex === undefined ||
          evt.newIndex === undefined ||
          evt.oldIndex === evt.newIndex
        ) {
          return;
        }

        const previousSystems = upgradeModalSystemsRef.current;
        const nextSystems = moveSystem(previousSystems, evt.oldIndex, evt.newIndex);

        setUpgradeModalSystems(nextSystems);
        reorderSystemUpgradeOrder.mutate(nextSystems.map((system) => system.id), {
          onError: (err) => {
            setUpgradeModalSystems(previousSystems);
            addToast(err.message, "danger");
          },
        });
      },
    });

    return () => {
      upgradeSortableRef.current?.destroy();
      upgradeSortableRef.current = null;
    };
  }, [showUpgradeConfirm, upgradeModalSystems.length, reorderSystemUpgradeOrder, addToast]);

  useEffect(() => {
    upgradeSortableRef.current?.option("disabled", reorderSystemUpgradeOrder.isPending);
  }, [reorderSystemUpgradeOrder.isPending]);

  const openUpgradeConfirm = () => {
    setSelectedSystemIds(defaultSelectedSystemIds);
    setUpgradeModalSystems(orderedSystemsWithUpdates);
    setFullUpgradeSelections(Object.fromEntries(
      orderedSystemsWithUpdates.map((s) => [s.id, isDefaultFullUpgradeEnabled(s)])
    ));
    setShowUpgradeConfirm(true);
  };

  const closeUpgradeConfirm = () => {
    setShowUpgradeConfirm(false);
    setSelectedSystemIds([]);
    setUpgradeModalSystems([]);
    setFullUpgradeSelections({});
  };

  const setModalSystemExclusion = (systemId: number, excluded: boolean) => {
    setUpgradeModalSystems((current) =>
      current.map((system) =>
        system.id === systemId
          ? { ...system, excludeFromUpgradeAll: excluded ? 1 : 0 }
          : system
      )
    );
  };

  const toggleSystemSelection = (systemId: number) => {
    const wasSelected = selectedSystemIds.includes(systemId);
    const excluded = wasSelected;

    setSelectedSystemIds((current) =>
      wasSelected
        ? current.filter((id) => id !== systemId)
        : [...current, systemId]
    );
    setModalSystemExclusion(systemId, excluded);
    updateSystemUpgradeAllExclusion.mutate(
      { systemId, excluded },
      {
        onError: (err) => {
          setSelectedSystemIds((current) =>
            wasSelected
              ? [...current, systemId]
              : current.filter((id) => id !== systemId)
          );
          setModalSystemExclusion(systemId, !excluded);
          addToast(err.message, "danger");
        },
      }
    );
  };

  const toggleFullUpgradeSelection = (systemId: number) => {
    const previous = fullUpgradeSelections[systemId] ?? false;
    const next = !previous;
    setFullUpgradeSelections((current) => ({ ...current, [systemId]: next }));
    updateSystemUpgradeMode.mutate(
      { systemId, fullUpgrade: next },
      {
        onError: (err) => {
          setFullUpgradeSelections((current) => ({
            ...current,
            [systemId]: previous,
          }));
          addToast(err.message, "danger");
        },
      }
    );
  };

  const handleUpgradeAll = () => {
    const systemsToUpgrade = selectedSystems;
    const fullUpgradeBySystemId = fullUpgradeSelections;
    closeUpgradeConfirm();
    for (const s of systemsToUpgrade) {
      const canOverrideMode = supportsDefaultUpgradeModeOverride(s);
      const override =
        !canOverrideMode
          ? undefined
          : {
              defaultUpgradeModeOverride: fullUpgradeBySystemId[s.id]
                ? "aggressive" as const
                : "standard" as const,
            };
      void upgradeAll(s.id, override, {
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
      contentWidth="wide"
      actions={
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={handleRefresh}
            disabled={refreshCache.isPending}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {refreshCache.isPending ? <span className="spinner spinner-sm" /> : "Refresh All"}
          </button>
          {(systemsWithUpdates.length > 0 || upgradingCount > 0) && (
            <button
              onClick={openUpgradeConfirm}
              disabled={upgradingCount > 0}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {upgradingCount > 0 ? (
                <span className="flex items-center gap-1.5">
                  <span className="spinner spinner-sm" />
                  Upgrading...
                </span>
              ) : (
                `Upgrade All (${defaultSelectedUpdateCount})`
              )}
            </button>
          )}
        </div>
      }
    >
      {/* Stats */}
      {stats && (
        <div className={`grid grid-cols-2 sm:grid-cols-3 ${stats.needsReboot > 0 ? "lg:grid-cols-7" : "lg:grid-cols-6"} gap-3 mb-6`}>
          <StatCard label="Total Systems" value={stats.total} color="text-slate-700 dark:text-slate-200" />
          <StatCard label="Up to Date" value={stats.upToDate} color="text-green-600" />
          <StatCard label="Need Updates" value={stats.needsUpdates} color="text-amber-600" />
          <StatCard label="Unreachable" value={stats.unreachable} color="text-red-600" />
          <StatCard label="Check Issues" value={stats.checkIssues} color="text-amber-500" />
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
            <SystemCard
              key={s.id}
              system={s}
              upgrading={!isPostUpgradeRecheck(s.activeOperation) && (isUpgrading(s.id) || !!s.activeOperation?.type?.includes("upgrade"))}
              checking={isPostUpgradeRecheck(s.activeOperation) || (!!s.activeOperation && !s.activeOperation.type.includes("upgrade"))}
            />
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

      <Modal open={showUpgradeConfirm} onClose={closeUpgradeConfirm} title="Upgrade All Systems">
        <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
          Apply {selectedUpdateCount} update{selectedUpdateCount !== 1 ? "s" : ""} across {selectedSystems.length} system{selectedSystems.length !== 1 ? "s" : ""}?
        </p>
        {systemsWithUpdates.length > 0 && (
          <div className="mb-4">
            <ul ref={upgradeListRef} className="space-y-2">
              {modalSystems.map((s) => {
                const isSelected = selectedSystemIds.includes(s.id);
                const canOverrideMode = supportsDefaultUpgradeModeOverride(s);
                const fullUpgradeEnabled = fullUpgradeSelections[s.id] ?? false;
                const fullUpgradeSaving =
                  updateSystemUpgradeMode.isPending &&
                  updateSystemUpgradeMode.variables?.systemId === s.id;

                return (
                  <li
                    key={s.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
                      isSelected
                        ? "bg-white dark:bg-slate-800/60"
                        : "bg-slate-50 dark:bg-slate-700/50"
                    } border-border`}
                  >
                    <span
                      className={`upgrade-drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                        reorderSystemUpgradeOrder.isPending || modalSystems.length < 2
                          ? "cursor-not-allowed opacity-40"
                          : "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                      }`}
                      title="Drag to set upgrade order"
                      aria-label={`Drag to set upgrade order for ${s.name}`}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                      </svg>
                    </span>
                    <div className="flex min-w-48 flex-1 items-center gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSystemSelection(s.id)}
                        disabled={updateSystemUpgradeAllExclusion.isPending}
                        className="rounded"
                        aria-label={`${isSelected ? "Exclude" : "Include"} ${s.name} in Upgrade All`}
                      />
                      <span className="block text-sm text-slate-700 dark:text-slate-200 truncate">
                        {s.name}
                      </span>
                      {canOverrideMode && (
                        <button
                          type="button"
                          onClick={() => toggleFullUpgradeSelection(s.id)}
                          disabled={!isSelected || fullUpgradeSaving}
                          aria-pressed={fullUpgradeEnabled}
                          className={`rounded-md border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            fullUpgradeEnabled
                              ? "border-blue-600 bg-blue-600 text-white"
                              : "border-border bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                          }`}
                          title="Toggle and save full upgrade for this system"
                        >
                          Full upgrade
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      <Badge variant="warning" small>{s.updateCount} updates</Badge>
                      {s.securityCount > 0 && (
                        <Badge variant="danger" small>{s.securityCount} security</Badge>
                      )}
                      {s.keptBackCount > 0 && (
                        <Badge variant="muted" small>{s.keptBackCount} kept back</Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {systemsWithUpdates.length > 1 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
                Drag systems to set the saved upgrade order. Upgrade jobs are started from top to bottom without waiting for earlier systems to finish.
              </p>
            )}
            {systemsWithUpdates.length > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
                Check a system to include it in future Upgrade All runs; uncheck it to exclude it.
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={closeUpgradeConfirm}
            className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleUpgradeAll}
            disabled={selectedSystemIds.length === 0}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
          >
            Upgrade All
          </button>
        </div>
      </Modal>
    </Layout>
  );
}
