import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router";
import { Layout } from "../components/Layout";
import { AgoLabel } from "../components/AgoLabel";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { DashboardSystemGroups } from "../components/dashboard/DashboardSystemGroups";
import { useDashboardStats, useDashboardSystems } from "../lib/dashboard";
import { useRefreshCache, useUpgradeAllBatch } from "../lib/updates";
import {
  useCreateDashboardGroup,
  useDashboardGroups,
  useDeleteDashboardGroup,
  useReorderDashboardGroups,
  useUpdateSystemDashboardGroups,
  useUpdateDashboardGroup,
  useUpdateDashboardGroupPriority,
  useUpdateSystemPriority,
  useUpdateSystemUpgradeAllExclusion,
  useUpdateSystemUpgradeMode,
} from "../lib/systems";
import type { DashboardGroup, System } from "../lib/systems";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";
import { useI18n } from "../lib/i18n";
import { deriveSystemUpdateState, getSystemStatusDotClass, isPostAutoremoveRecheck, isPostUpgradeRecheck, shouldClearLocalUpgrade } from "../lib/system-status";

function compareDashboardOrder(a: System, b: System): number {
  const orderDiff = (a.dashboardOrder ?? 0) - (b.dashboardOrder ?? 0);
  if (orderDiff !== 0) return orderDiff;
  return a.name.localeCompare(b.name) || a.id - b.id;
}

export function compareUpgradeModalSystems(a: System, b: System): number {
  return (
    (a.updatePriority ?? 1) - (b.updatePriority ?? 1) ||
    compareDashboardOrder(a, b)
  );
}

type UpgradeModalGroup = {
  key: string;
  id: number | null;
  name: string;
  updatePriority: number;
  systems: System[];
};

export function compareUpgradeModalGroups(
  a: Pick<UpgradeModalGroup, "id" | "name" | "updatePriority">,
  b: Pick<UpgradeModalGroup, "id" | "name" | "updatePriority">,
  dashboardGroupSortById: ReadonlyMap<number, number>,
  ungroupedSortOrder: number,
): number {
  const aDashboardOrder =
    a.id === null
      ? ungroupedSortOrder
      : dashboardGroupSortById.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  const bDashboardOrder =
    b.id === null
      ? ungroupedSortOrder
      : dashboardGroupSortById.get(b.id) ?? Number.MAX_SAFE_INTEGER;

  return (
    a.updatePriority - b.updatePriority ||
    aDashboardOrder - bDashboardOrder ||
    a.name.localeCompare(b.name)
  );
}

export function UpgradeModalGroupHeading({
  name,
  systemCount,
  updatePriority,
}: {
  name: string;
  systemCount: number;
  updatePriority: number;
}) {
  const { t } = useI18n();

  return (
    <div className="mb-2 flex items-center gap-2">
      <h3 className="min-w-0 truncate text-sm font-semibold text-slate-700 dark:text-slate-100">
        {name}
      </h3>
      <Badge variant="muted" small>{systemCount}</Badge>
      <span
        className="ml-auto"
        title={t("pages.dashboard.upgradePriorityHelp")}
      >
        <Badge variant="muted" small>
          {t("pages.dashboard.updatePriority")}: {updatePriority}
        </Badge>
      </span>
    </div>
  );
}

function isUpgradeAllEligible(system: System, locallyUpgrading: boolean): boolean {
  return system.updateCount > 0 && !locallyUpgrading && !system.activeOperation;
}

export function isUpgradePresetSelected(
  system: Pick<System, "id">,
  selectedSystemIds: number[],
): boolean {
  return selectedSystemIds.includes(system.id);
}

export function canToggleUpgradePreset(
  system: Pick<System, "updateCount">,
): boolean {
  return system.updateCount > 0;
}

export function isUpgradeAllSubmitDisabled(selectedSystemsCount: number, busy: boolean): boolean {
  return selectedSystemsCount === 0 || busy;
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

function getUpgradeSystemRowClass({
  hasUpdates,
  isSelected,
}: {
  hasUpdates: boolean;
  isSelected: boolean;
}): string {
  const baseClass =
    "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg border p-3 transition-colors sm:grid-cols-[auto_minmax(0,1fr)_auto]";

  if (!hasUpdates) {
    return [
      baseClass,
      "border-dashed border-slate-300 bg-slate-50/60",
      "dark:border-slate-600 dark:bg-slate-900/20",
    ].join(" ");
  }

  if (isSelected) {
    return [
      baseClass,
      "border-slate-300 bg-white ring-1 ring-inset ring-slate-100",
      "dark:border-slate-500 dark:bg-slate-700/55 dark:ring-slate-500/20",
    ].join(" ");
  }

  return [
    baseClass,
    "border-slate-200 bg-slate-50/70",
    "dark:border-slate-700 dark:bg-slate-800/45",
  ].join(" ");
}

function getUpgradeSystemNameClass({
  hasUpdates,
  isSelected,
}: {
  hasUpdates: boolean;
  isSelected: boolean;
}): string {
  if (!hasUpdates) {
    return "block min-w-0 flex-1 truncate text-sm text-slate-500 dark:text-slate-400";
  }

  return isSelected
    ? "block min-w-0 flex-1 truncate text-sm font-medium text-slate-900 dark:text-slate-50"
    : "block min-w-0 flex-1 truncate text-sm text-slate-500 dark:text-slate-400";
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

export function getDashboardUpgradeToast(
  systemName: string,
  status: string,
): { message: string; type: "success" | "danger" | "info" } {
  if (status === "success") {
    return { message: `${systemName}: Upgrade complete`, type: "success" };
  }
  if (status === "warning") {
    return {
      message: `${systemName}: Upgrade state resynced after backend restart`,
      type: "info",
    };
  }
  return { message: `${systemName}: Upgrade failed`, type: "danger" };
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-border p-4 text-center">
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function getStatsGridClass(stats: { needsReboot: number; lifecycleWarnings: number }): string {
  const optionalCards = (stats.needsReboot > 0 ? 1 : 0) + (stats.lifecycleWarnings > 0 ? 1 : 0);
  return optionalCards === 2
    ? "lg:grid-cols-8"
    : optionalCards === 1
      ? "lg:grid-cols-7"
      : "lg:grid-cols-6";
}

function hasLtsLifecycleLabel(system: Pick<System, "osLifecycleLabel">): boolean {
  return /\bLTS\b/.test(system.osLifecycleLabel);
}

function getLifecycleWarningLabel(
  system: Pick<System, "osLifecycleStatus" | "osLifecycleLabel">,
  t: (key: string) => string,
): string {
  if (system.osLifecycleStatus === "eol") return t("pages.systemDetail.lifecycle.eol");
  if (system.osLifecycleStatus === "support_ended") {
    if (hasLtsLifecycleLabel(system)) return t("pages.systemDetail.lifecycle.lts");
    return t("pages.systemDetail.lifecycle.regularSupportEnded");
  }
  if (system.osLifecycleStatus === "support_ending") {
    return t("pages.systemDetail.lifecycle.securitySupportEndingSoon");
  }
  return t("pages.systemDetail.lifecycle.eolSoon");
}

function SystemCard({ system, upgrading, checking }: { system: Pick<System, "id" | "name" | "hostname" | "port" | "osName" | "isReachable" | "updateCount" | "securityCount" | "keptBackCount" | "needsReboot" | "osLifecycleStatus" | "osLifecycleEolDate" | "osLifecycleDaysUntilEol" | "osLifecycleDaysUntilSupportEnd" | "osLifecycleLabel" | "cacheAge" | "cacheTimestamp" | "isStale" | "lastCheck" | "activeOperation">; upgrading: boolean; checking: boolean }) {
  const { t } = useI18n();
  const updateState = deriveSystemUpdateState(system, { upgrading, checking });
  const maintaining = updateState === "maintaining";
  const dotColor = getSystemStatusDotClass(updateState, system);

  return (
    <Link
      to={`/systems/${system.id}`}
      className="block bg-white dark:bg-slate-800 rounded-xl border border-border p-4 hover:bg-slate-100 hover:border-slate-300 dark:hover:bg-slate-700 dark:hover:border-slate-600 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2 min-w-0">
        {upgrading || maintaining || checking ? (
          <span className={`spinner spinner-sm !w-3.5 !h-3.5 shrink-0 ${upgrading || maintaining ? "!border-blue-500" : "!border-sky-400"} !border-t-transparent`} />
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
            <Badge variant="info" small>{t("pages.dashboard.upgrading")}</Badge>
          ) : updateState === "maintaining" ? (
            <Badge variant="info" small>{t("pages.dashboard.maintaining")}</Badge>
          ) : updateState === "checking" ? (
            <Badge variant="muted" small>{t("pages.dashboard.checking")}</Badge>
          ) : updateState === "unreachable" ? (
            <Badge variant="danger" small>{t("pages.dashboard.unreachable")}</Badge>
          ) : updateState === "check_failed" ? (
            <Badge variant="danger" small>{t("pages.dashboard.checkFailed")}</Badge>
          ) : updateState === "check_warning" ? (
            <Badge variant="warning" small>{t("pages.dashboard.checkWarning")}</Badge>
          ) : updateState === "updates_available" ? (
            <Badge variant="warning" small>{t("pages.dashboard.countUpdates", { count: system.updateCount })}</Badge>
          ) : updateState === "lifecycle_warning" ? (
            <Badge variant={system.osLifecycleStatus === "eol" ? "danger" : "warning"} small>{getLifecycleWarningLabel(system, t)}</Badge>
          ) : updateState === "up_to_date" ? (
            <Badge variant="success" small>{t("pages.dashboard.upToDate")}</Badge>
          ) : (
            <Badge variant="muted" small>{t("pages.dashboard.unchecked")}</Badge>
          )}
          {updateState === "check_warning" && system.updateCount > 0 && (
            <Badge variant="warning" small>{t("pages.dashboard.countUpdates", { count: system.updateCount })}</Badge>
          )}
          {system.securityCount > 0 && (
            <Badge variant="danger" small>{t("pages.dashboard.countSecurity", { count: system.securityCount })}</Badge>
          )}
          {system.keptBackCount > 0 && (
            <Badge variant="muted" small>{t("pages.dashboard.countKeptBack", { count: system.keptBackCount })}</Badge>
          )}
          {system.needsReboot === 1 && (
            <span className="text-amber-500" title={t("pages.dashboard.rebootRequired")}>
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
  const { isUpgrading, removeUpgrading, upgradingSystems, upgradingCount } = useUpgrade();
  const { data: systems, dataUpdatedAt } = useDashboardSystems(upgradingCount > 0);
  const hasActiveOps = systems?.some((s) => s.activeOperation) ?? false;
  const { data: stats } = useDashboardStats(hasActiveOps);
  const { data: dashboardGroupConfig = {
    groups: [],
    ungroupedSortOrder: 1_000_000,
    ungroupedUpdatePriority: 99,
  } } = useDashboardGroups();
  const ungroupedUpdatePriority =
    dashboardGroupConfig.ungroupedUpdatePriority ??
    Math.min(99, Math.max(1, dashboardGroupConfig.ungroupedSortOrder + 1));
  const dashboardGroups = dashboardGroupConfig.groups;
  const refreshCache = useRefreshCache();
  const upgradeAllBatch = useUpgradeAllBatch();
  const createDashboardGroup = useCreateDashboardGroup();
  const updateDashboardGroup = useUpdateDashboardGroup();
  const updateDashboardGroupPriority = useUpdateDashboardGroupPriority();
  const updateSystemPriority = useUpdateSystemPriority();
  const deleteDashboardGroup = useDeleteDashboardGroup();
  const reorderDashboardGroups = useReorderDashboardGroups();
  const updateSystemDashboardGroups = useUpdateSystemDashboardGroups();
  const updateSystemUpgradeAllExclusion = useUpdateSystemUpgradeAllExclusion();
  const updateSystemUpgradeMode = useUpdateSystemUpgradeMode();
  const { addToast } = useToast();
  const { t } = useI18n();
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [selectedSystemIds, setSelectedSystemIds] = useState<number[]>([]);
  const [fullUpgradeSelections, setFullUpgradeSelections] = useState<Record<number, boolean>>({});
  const [upgradeModalSystems, setUpgradeModalSystems] = useState<System[]>([]);
  const [dashboardGroupEditMode, setDashboardGroupEditMode] = useState(false);
  const [renameDashboardGroup, setRenameDashboardGroup] = useState<DashboardGroup | null>(null);
  const [deleteDashboardGroupTarget, setDeleteDashboardGroupTarget] = useState<DashboardGroup | null>(null);

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
      if (serverSystem && shouldClearLocalUpgrade(serverSystem.activeOperation)) {
        removeUpgrading(systemId);
      }
    }
  }, [systems, dataUpdatedAt, upgradingSystems, removeUpgrading]);

  const handleRefresh = () => {
    refreshCache.mutate(undefined, {
      onSuccess: () => addToast(t("pages.dashboard.cacheClearedRefreshingAllSystems"), "info"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const hasRefreshInProgress =
    refreshCache.isPending ||
    (systems?.some((s) => s.activeOperation?.type === "check") ?? false);
  const disableRefreshAll = refreshCache.isPending || hasActiveOps;
  const systemsWithUpdates = useMemo(
    () => systems?.filter((s) => isUpgradeAllEligible(s, isUpgrading(s.id))) ?? [],
    [systems, isUpgrading],
  );
  const disableUpgradeLauncher = upgradeAllBatch.isPending;
  const dashboardGroupSortById = useMemo(
    () => new Map(dashboardGroups.map((group) => [group.id, group.sortOrder])),
    [dashboardGroups],
  );
  const compareModalSystems = (a: System, b: System): number => {
    const groupOrderA =
      a.dashboardGroupId !== null && dashboardGroupSortById.has(a.dashboardGroupId)
        ? dashboardGroupSortById.get(a.dashboardGroupId)!
        : dashboardGroupConfig.ungroupedSortOrder;
    const groupOrderB =
      b.dashboardGroupId !== null && dashboardGroupSortById.has(b.dashboardGroupId)
        ? dashboardGroupSortById.get(b.dashboardGroupId)!
        : dashboardGroupConfig.ungroupedSortOrder;
    return (
      groupOrderA - groupOrderB ||
      compareDashboardOrder(a, b)
    );
  };
  const orderedSystemsWithUpdates = useMemo(
    () => [...systemsWithUpdates].sort(compareModalSystems),
    [systemsWithUpdates, dashboardGroupSortById, dashboardGroupConfig.ungroupedSortOrder],
  );
  const orderedModalCandidateSystems = orderedSystemsWithUpdates;
  const latestSystemsById = useMemo(
    () => new Map((systems ?? []).map((system) => [system.id, system])),
    [systems],
  );
  const modalSystems = showUpgradeConfirm
    ? upgradeModalSystems
        .map((snapshot) => {
          const latest = latestSystemsById.get(snapshot.id);
          return latest
            ? { ...latest, excludeFromUpgradeAll: snapshot.excludeFromUpgradeAll }
            : snapshot;
        })
        .filter((system) => isUpgradeAllEligible(system, isUpgrading(system.id)))
    : orderedSystemsWithUpdates;
  const defaultSelectedSystemIds = orderedModalCandidateSystems
    .filter((s) => s.excludeFromUpgradeAll !== 1)
    .map((s) => s.id);
  const selectedSystems = modalSystems.filter(
    (s) => selectedSystemIds.includes(s.id) && s.updateCount > 0,
  );
  const selectedUpdateCount = selectedSystems.reduce((sum, s) => sum + s.updateCount, 0);
  const orderedGroupsForModal = useMemo(() => {
    const knownGroupIds = new Set(dashboardGroups.map((group) => group.id));
    const groups: UpgradeModalGroup[] = dashboardGroups
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id - b.id)
      .map((group) => ({
        key: String(group.id),
        id: group.id,
        name: group.name,
        updatePriority:
          group.updatePriority ?? Math.min(99, Math.max(1, group.sortOrder + 1)),
        systems: modalSystems
          .filter((system) => system.dashboardGroupId === group.id)
          .sort(compareUpgradeModalSystems),
      }));
    const ungroupedSystems = modalSystems
      .filter(
        (system) =>
          system.dashboardGroupId === null ||
          !knownGroupIds.has(system.dashboardGroupId),
      )
      .sort(compareUpgradeModalSystems);
    if (dashboardGroups.length > 0) {
      groups.push({
        key: "ungrouped",
        id: null,
        name: t("pages.dashboard.ungrouped"),
        updatePriority: ungroupedUpdatePriority,
        systems: ungroupedSystems,
      });
    } else if (ungroupedSystems.length > 0) {
      groups.push({
        key: "ungrouped",
        id: null,
        name: t("pages.dashboard.systems"),
        updatePriority: ungroupedUpdatePriority,
        systems: ungroupedSystems,
      });
    }
    return groups
      .sort((a, b) =>
        compareUpgradeModalGroups(
          a,
          b,
          dashboardGroupSortById,
          dashboardGroupConfig.ungroupedSortOrder,
        )
      )
      .filter((group) => group.systems.length > 0);
  }, [
    dashboardGroups,
    dashboardGroupConfig.ungroupedSortOrder,
    dashboardGroupSortById,
    modalSystems,
    t,
    ungroupedUpdatePriority,
  ]);

  const openUpgradeConfirm = () => {
    setSelectedSystemIds(defaultSelectedSystemIds);
    setUpgradeModalSystems(orderedModalCandidateSystems);
    setFullUpgradeSelections(Object.fromEntries(
      orderedModalCandidateSystems.map((s) => [s.id, isDefaultFullUpgradeEnabled(s)])
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

  const handleCreateDashboardGroup = () => {
    const existingNames = new Set(dashboardGroups.map((group) => group.name.trim().toLowerCase()));
    let index = 1;
    while (existingNames.has(`group ${index}`)) index += 1;
    createDashboardGroup.mutate(`Group ${index}`, {
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleRenameDashboardGroup = (group: DashboardGroup) => {
    setRenameDashboardGroup(group);
  };

  const saveRenameDashboardGroup = () => {
    if (!renameDashboardGroup) return;
    const name = renameDashboardGroup.name.trim();
    if (!name) return;
    if (name === dashboardGroups.find((group) => group.id === renameDashboardGroup.id)?.name) {
      setRenameDashboardGroup(null);
      return;
    }
    updateDashboardGroup.mutate(
      { groupId: renameDashboardGroup.id, name },
      {
        onSuccess: () => setRenameDashboardGroup(null),
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const handleDeleteDashboardGroup = (group: DashboardGroup) => {
    setDeleteDashboardGroupTarget(group);
  };

  const confirmDeleteDashboardGroup = () => {
    if (!deleteDashboardGroupTarget) return;
    deleteDashboardGroup.mutate(deleteDashboardGroupTarget.id, {
      onSuccess: () => setDeleteDashboardGroupTarget(null),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleUpgradeAll = () => {
    const systemsToUpgrade = modalSystems
      .map((system) => latestSystemsById.get(system.id) ?? system)
      .filter((system) =>
        selectedSystemIds.includes(system.id) &&
        system.updateCount > 0 &&
        isUpgradeAllEligible(system, isUpgrading(system.id))
      );
    if (systemsToUpgrade.length === 0) return;

    const fullUpgradeBySystemId = fullUpgradeSelections;
    closeUpgradeConfirm();
    const items = systemsToUpgrade.map((s) => {
      const canOverrideMode = supportsDefaultUpgradeModeOverride(s);
      const defaultUpgradeModeOverride =
        !canOverrideMode
          ? undefined
          : fullUpgradeBySystemId[s.id]
                ? "aggressive" as const
                : "standard" as const;
      return {
        systemId: s.id,
        defaultUpgradeModeOverride,
      };
    });
    upgradeAllBatch.mutate(items, {
      onSuccess: () => addToast(
        t("pages.dashboard.upgradeAllQueuedForCountSystemlabel", {
          count: items.length,
          systemLabel: items.length === 1 ? t("pages.dashboard.system") : t("pages.dashboard.systems"),
        }),
        "info",
      ),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <Layout
      title={t("pages.dashboard.dashboard")}
      actions={
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={handleRefresh}
            disabled={disableRefreshAll}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {hasRefreshInProgress ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                {t("pages.dashboard.refreshing")}
              </span>
            ) : (
              t("pages.dashboard.refreshAll")
            )}
          </button>
          <button
            onClick={openUpgradeConfirm}
            disabled={disableUpgradeLauncher}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {t("pages.dashboard.upgradeAll")}
          </button>
        </div>
      }
    >
      {/* Stats */}
      {stats && (
        <div className={`grid grid-cols-2 sm:grid-cols-3 ${getStatsGridClass(stats)} gap-3 mb-6`}>
          <StatCard label={t("pages.dashboard.totalSystems")} value={stats.total} color="text-slate-700 dark:text-slate-100" />
          <StatCard label={t("pages.dashboard.upToDate2")} value={stats.upToDate} color="text-slate-700 dark:text-slate-100" />
          <StatCard label={t("pages.dashboard.needUpdates")} value={stats.needsUpdates} color="text-amber-600 dark:text-amber-500" />
          {stats.needsReboot > 0 && (
            <StatCard label={t("pages.dashboard.needsReboot")} value={stats.needsReboot} color="text-amber-600 dark:text-amber-500" />
          )}
          {stats.lifecycleWarnings > 0 && (
            <StatCard label={t("pages.dashboard.osWarnings")} value={stats.lifecycleWarnings} color="text-amber-600 dark:text-amber-500" />
          )}
          <StatCard label={t("pages.dashboard.checkIssues")} value={stats.checkIssues} color="text-amber-600 dark:text-amber-500" />
          <StatCard label={t("pages.dashboard.unreachable")} value={stats.unreachable} color="text-red-600 dark:text-red-500" />
          <StatCard label={t("pages.dashboard.totalUpdates")} value={stats.totalUpdates} color="text-slate-700 dark:text-slate-100" />
        </div>
      )}

      {/* System cards grid */}
      {systems && systems.length > 0 ? (
        <DashboardSystemGroups
          systems={systems}
          groups={dashboardGroups}
          ungroupedSortOrder={dashboardGroupConfig.ungroupedSortOrder}
          ungroupedUpdatePriority={ungroupedUpdatePriority}
          editMode={dashboardGroupEditMode}
          onToggleEditMode={() => setDashboardGroupEditMode((current) => !current)}
          onCreateGroup={handleCreateDashboardGroup}
          onRenameGroup={handleRenameDashboardGroup}
          onDeleteGroup={handleDeleteDashboardGroup}
          saveGroupOrder={(groupKeys) => reorderDashboardGroups.mutateAsync(groupKeys).then(() => undefined)}
          saveGroupUpdatePriority={(groupId, updatePriority) =>
            updateDashboardGroupPriority
              .mutateAsync({ groupId, updatePriority })
              .then(() => undefined)
          }
          saveSystemUpdatePriority={(systemId, updatePriority) =>
            updateSystemPriority
              .mutateAsync({ systemId, updatePriority })
              .then(() => undefined)
          }
          saveSystemPlacements={(items) => updateSystemDashboardGroups.mutateAsync(items).then(() => undefined)}
          busy={
            createDashboardGroup.isPending ||
            updateDashboardGroup.isPending ||
            updateDashboardGroupPriority.isPending ||
            updateSystemPriority.isPending ||
            deleteDashboardGroup.isPending ||
            reorderDashboardGroups.isPending ||
            updateSystemDashboardGroups.isPending
          }
          onError={(message) => addToast(message, "danger")}
          renderSystem={(s) => (
            <SystemCard
              system={s}
              upgrading={!isPostUpgradeRecheck(s.activeOperation) && (isUpgrading(s.id) || !!s.activeOperation?.type?.includes("upgrade"))}
              checking={isPostUpgradeRecheck(s.activeOperation) || isPostAutoremoveRecheck(s.activeOperation) || s.activeOperation?.type === "check" || s.activeOperation?.type === "package_manager_repair"}
            />
          )}
        />
      ) : (
        <div className="text-center py-16">
          <p className="text-slate-500 dark:text-slate-400 mb-4">{t("pages.dashboard.noSystemsConfiguredYet")}</p>
          <Link
            to="/systems"
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {t("pages.dashboard.addSystem")}
          </Link>
        </div>
      )}

      <Modal open={showUpgradeConfirm} onClose={closeUpgradeConfirm} title={t("pages.dashboard.upgradeAllSystems")}>
        <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
          {t("pages.dashboard.applyUpdatesUpdatelabelAcrossSystemsSystemlabel", {
            updates: selectedUpdateCount,
            updateLabel: selectedUpdateCount === 1 ? t("pages.dashboard.update") : t("pages.dashboard.updates"),
            systems: selectedSystems.length,
            systemLabel: selectedSystems.length === 1 ? t("pages.dashboard.system") : t("pages.dashboard.systems"),
          })}
        </p>
        {modalSystems.length > 0 ? (
          <div className="mb-4">
            {orderedGroupsForModal.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-4 text-sm text-slate-500 dark:text-slate-400">
                {t("pages.dashboard.noSystemsHaveUpdates")}
              </div>
            ) : (
              <div className="space-y-3">
                {orderedGroupsForModal.map((group) => (
                  <section
                    key={group.key}
                    className="rounded-lg border border-border bg-slate-50/60 p-2 dark:bg-slate-800/40"
                  >
                    <UpgradeModalGroupHeading
                      name={group.name}
                      systemCount={group.systems.length}
                      updatePriority={group.updatePriority}
                    />
                    <ul className="min-h-6 space-y-2">
                      {group.systems.map((s) => {
                        const isSelected = isUpgradePresetSelected(s, selectedSystemIds);
                        const canOverrideMode = supportsDefaultUpgradeModeOverride(s);
                        const fullUpgradeEnabled = fullUpgradeSelections[s.id] ?? false;
                        const fullUpgradeSaving =
                          updateSystemUpgradeMode.isPending &&
                          updateSystemUpgradeMode.variables?.systemId === s.id;
                        return (
                          <li
                            key={s.id}
                            className={getUpgradeSystemRowClass({ hasUpdates: true, isSelected })}
                          >
                            <div className="flex min-w-0 flex-wrap items-center gap-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSystemSelection(s.id)}
                                disabled={updateSystemUpgradeAllExclusion.isPending}
                                className="shrink-0 rounded"
                                aria-label={`${isSelected ? "Exclude" : "Include"} ${s.name} in Upgrade All`}
                              />
                              <span className={getUpgradeSystemNameClass({ hasUpdates: true, isSelected })}>
                                {s.name}
                              </span>
                              {canOverrideMode && (
                                <button
                                  type="button"
                                  onClick={() => toggleFullUpgradeSelection(s.id)}
                                  disabled={fullUpgradeSaving}
                                  aria-pressed={fullUpgradeEnabled}
                                  className={`shrink-0 rounded-md border px-2.5 py-1 text-xs whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                    fullUpgradeEnabled
                                      ? "border-blue-600 bg-blue-600 text-white"
                                      : "border-border bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
                                  }`}
                                  title={t("pages.dashboard.toggleAndSaveFullUpgradeForThisSystem")}
                                >
                                  {t("pages.dashboard.fullUpgrade")}
                                </button>
                              )}
                            </div>
                            <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-start-auto sm:justify-end">
                              <Badge variant="warning" small>
                                {t("pages.dashboard.countUpdates", { count: s.updateCount })}
                              </Badge>
                              {s.securityCount > 0 && (
                                <Badge variant="danger" small>{t("pages.dashboard.countSecurity", { count: s.securityCount })}</Badge>
                              )}
                              {s.keptBackCount > 0 && (
                                <Badge variant="muted" small>{t("pages.dashboard.countKeptBack", { count: s.keptBackCount })}</Badge>
                              )}
                              <span className="ml-auto shrink-0" title={t("pages.dashboard.systemUpgradePriorityHelp")}>
                                <Badge variant="muted" small>
                                  {t("pages.dashboard.updatePriority")}: {s.updatePriority ?? 1}
                                </Badge>
                              </span>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            {systemsWithUpdates.length > 0 && (
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                {t("pages.dashboard.checkASystemToIncludeItInFuture")}
              </p>
            )}
          </div>
        ) : (
          <div className="mb-4 rounded-lg border border-dashed border-border p-4 text-sm text-slate-500 dark:text-slate-400">
            {t("pages.dashboard.noSystemsHaveUpdates")}
          </div>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            onClick={closeUpgradeConfirm}
            className="w-full rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 sm:w-auto"
          >
            {t("pages.dashboard.cancel")}
          </button>
          <button
            onClick={handleUpgradeAll}
            disabled={isUpgradeAllSubmitDisabled(selectedSystems.length, upgradeAllBatch.isPending)}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
          >
            {t("pages.dashboard.upgradeAll")}
          </button>
        </div>
      </Modal>
      <Modal
        open={!!renameDashboardGroup}
        onClose={() => setRenameDashboardGroup(null)}
        title={t("pages.dashboard.renameGroup")}
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-200">
              {t("pages.dashboard.groupName")}
            </span>
            <input
              value={renameDashboardGroup?.name ?? ""}
              onChange={(event) =>
                setRenameDashboardGroup((current) =>
                  current ? { ...current, name: event.target.value } : current,
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") saveRenameDashboardGroup();
              }}
              autoFocus
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:bg-slate-900"
            />
          </label>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setRenameDashboardGroup(null)}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 sm:w-auto"
            >
              {t("pages.dashboard.cancel")}
            </button>
            <button
              type="button"
              onClick={saveRenameDashboardGroup}
              disabled={!renameDashboardGroup?.name.trim() || updateDashboardGroup.isPending}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
            >
              {t("pages.dashboard.save")}
            </button>
          </div>
        </div>
      </Modal>
      <Modal
        open={!!deleteDashboardGroupTarget}
        onClose={() => setDeleteDashboardGroupTarget(null)}
        title={t("pages.dashboard.deleteGroup2")}
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("pages.dashboard.deleteNameSystemsInThisGroupWillMove", {
              name: deleteDashboardGroupTarget?.name ?? "",
            })}
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setDeleteDashboardGroupTarget(null)}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 sm:w-auto"
            >
              {t("pages.dashboard.cancel")}
            </button>
            <button
              type="button"
              onClick={confirmDeleteDashboardGroup}
              disabled={deleteDashboardGroup.isPending}
              className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50 sm:w-auto"
            >
              {t("pages.dashboard.delete")}
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
