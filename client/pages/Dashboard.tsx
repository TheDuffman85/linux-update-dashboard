import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import Sortable from "sortablejs";
import type { SortableEvent } from "sortablejs";
import { Layout } from "../components/Layout";
import { AgoLabel } from "../components/AgoLabel";
import { Badge } from "../components/Badge";
import { Modal } from "../components/Modal";
import { useDashboardStats, useDashboardSystems } from "../lib/dashboard";
import { useRefreshCache, useUpgradeAllBatch } from "../lib/updates";
import {
  useCreateUpgradeGroup,
  useDeleteUpgradeGroup,
  useReorderUpgradeGroups,
  useUpdateSystemUpgradeGroups,
  useUpdateSystemUpgradeAllExclusion,
  useUpdateSystemUpgradeMode,
  useUpdateUpgradeGroup,
  useUpgradeGroups,
} from "../lib/systems";
import type { System, UpgradeGroup } from "../lib/systems";
import { useToast } from "../context/ToastContext";
import { useUpgrade } from "../context/UpgradeContext";
import { deriveSystemUpdateState, isPostUpgradeRecheck, shouldClearLocalUpgrade } from "../lib/system-status";

const UNGROUPED_KEY = "ungrouped";

function getGroupKey(groupId: number | null | undefined): string {
  return groupId ? String(groupId) : UNGROUPED_KEY;
}

function compareUpgradeOrder(a: System, b: System): number {
  const orderDiff = (a.upgradeOrder ?? 1) - (b.upgradeOrder ?? 1);
  if (orderDiff !== 0) return orderDiff;
  return a.name.localeCompare(b.name) || a.id - b.id;
}

function compareSystemsInGroup(a: System, b: System): number {
  const orderDiff = (a.upgradeOrder ?? 1) - (b.upgradeOrder ?? 1);
  if (orderDiff !== 0) return orderDiff;
  return a.name.localeCompare(b.name) || a.id - b.id;
}

function hasActiveUpgradeOperation(system: System): boolean {
  return system.activeOperation?.type.includes("upgrade") ?? false;
}

function isUpgradeAllEligible(system: System, locallyUpgrading: boolean): boolean {
  return system.updateCount > 0 && !locallyUpgrading && !hasActiveUpgradeOperation(system);
}

export function isUpgradePresetSelected(
  system: Pick<System, "id">,
  selectedSystemIds: number[],
): boolean {
  return selectedSystemIds.includes(system.id);
}

export function canToggleUpgradePreset(
  system: Pick<System, "updateCount">,
  upgradeEditMode: boolean,
): boolean {
  return upgradeEditMode || system.updateCount > 0;
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
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function SystemCard({ system, upgrading, checking }: { system: Pick<System, "id" | "name" | "hostname" | "port" | "osName" | "isReachable" | "updateCount" | "securityCount" | "keptBackCount" | "needsReboot" | "cacheAge" | "cacheTimestamp" | "isStale" | "lastCheck" | "activeOperation">; upgrading: boolean; checking: boolean }) {
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
  const { isUpgrading, removeUpgrading, upgradingSystems, upgradingCount } = useUpgrade();
  const { data: systems, dataUpdatedAt } = useDashboardSystems(upgradingCount > 0);
  const hasActiveOps = systems?.some((s) => s.activeOperation) ?? false;
  const { data: stats } = useDashboardStats(hasActiveOps);
  const { data: upgradeGroupConfig = { groups: [], ungroupedSortOrder: 1_000_000 } } = useUpgradeGroups();
  const upgradeGroups = upgradeGroupConfig.groups;
  const refreshCache = useRefreshCache();
  const upgradeAllBatch = useUpgradeAllBatch();
  const createUpgradeGroup = useCreateUpgradeGroup();
  const updateUpgradeGroup = useUpdateUpgradeGroup();
  const deleteUpgradeGroup = useDeleteUpgradeGroup();
  const reorderUpgradeGroups = useReorderUpgradeGroups();
  const updateSystemUpgradeGroups = useUpdateSystemUpgradeGroups();
  const updateSystemUpgradeAllExclusion = useUpdateSystemUpgradeAllExclusion();
  const updateSystemUpgradeMode = useUpdateSystemUpgradeMode();
  const { addToast } = useToast();
  const [showUpgradeConfirm, setShowUpgradeConfirm] = useState(false);
  const [upgradeEditMode, setUpgradeEditMode] = useState(false);
  const [selectedSystemIds, setSelectedSystemIds] = useState<number[]>([]);
  const [fullUpgradeSelections, setFullUpgradeSelections] = useState<Record<number, boolean>>({});
  const [upgradeModalSystems, setUpgradeModalSystems] = useState<System[]>([]);
  const [renameGroup, setRenameGroup] = useState<{ id: number; name: string } | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<UpgradeGroup | null>(null);
  const upgradeModalSystemsRef = useRef<System[]>([]);
  const groupListRef = useRef<HTMLDivElement | null>(null);
  const groupSortableRef = useRef<Sortable | null>(null);
  const systemListRefs = useRef(new Map<string, HTMLUListElement>());
  const systemSortablesRef = useRef<Sortable[]>([]);

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
      onSuccess: () => addToast("Cache cleared. Refreshing all systems...", "info"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const hasUpgradeInProgress =
    upgradingCount > 0 ||
    (systems?.some((s) => isUpgrading(s.id) || hasActiveUpgradeOperation(s)) ?? false);
  const systemsWithUpdates = useMemo(
    () => systems?.filter((s) => isUpgradeAllEligible(s, isUpgrading(s.id))) ?? [],
    [systems, isUpgrading]
  );
  const orderedSystemsWithUpdates = useMemo(
    () => [...systemsWithUpdates].sort(compareUpgradeOrder),
    [systemsWithUpdates]
  );
  const orderedModalCandidateSystems = useMemo(
    () =>
      [...(systems ?? [])]
        .filter((s) => !isUpgrading(s.id) && !hasActiveUpgradeOperation(s))
        .sort((a, b) => {
          const groupDiff = (a.upgradeGroupId ?? 1_000_000) - (b.upgradeGroupId ?? 1_000_000);
          if (groupDiff !== 0) return groupDiff;
          return compareSystemsInGroup(a, b);
        }),
    [systems, isUpgrading]
  );
  const modalSystems = showUpgradeConfirm ? upgradeModalSystems : orderedSystemsWithUpdates;
  const visibleModalSystems = upgradeEditMode
    ? modalSystems
    : modalSystems.filter((system) => system.updateCount > 0);
  const excludedSystems = orderedSystemsWithUpdates.filter((s) => s.excludeFromUpgradeAll === 1);
  const defaultSelectedSystemIds = orderedModalCandidateSystems
    .filter((s) => s.excludeFromUpgradeAll !== 1)
    .map((s) => s.id);
  const selectedSystems = modalSystems.filter((s) => selectedSystemIds.includes(s.id) && s.updateCount > 0);
  const selectedUpdateCount = selectedSystems.reduce((sum, s) => sum + s.updateCount, 0);
  const groupsById = useMemo(
    () => new Map(upgradeGroups.map((group) => [group.id, group])),
    [upgradeGroups]
  );
  const orderedGroupsForModal = useMemo(() => {
    const groups: Array<{ key: string; id: number | null; name: string; sortOrder: number; systems: System[]; realGroup?: UpgradeGroup }> =
      upgradeGroups
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id - b.id)
        .map((group) => ({
          key: String(group.id),
          id: group.id,
          name: group.name,
          sortOrder: group.sortOrder,
          systems: visibleModalSystems
            .filter((system) => system.upgradeGroupId === group.id)
            .sort(compareSystemsInGroup),
          realGroup: group,
        }));
    const ungroupedSystems = visibleModalSystems
      .filter((system) => !system.upgradeGroupId || !groupsById.has(system.upgradeGroupId))
      .sort(compareSystemsInGroup);
    if (upgradeGroups.length > 0) {
      groups.push({
        key: UNGROUPED_KEY,
        id: null,
        name: "Ungrouped",
        sortOrder: upgradeGroupConfig.ungroupedSortOrder,
        systems: ungroupedSystems,
      });
    } else if (ungroupedSystems.length > 0) {
      groups.push({
        key: UNGROUPED_KEY,
        id: null,
        name: "Systems",
        sortOrder: 0,
        systems: ungroupedSystems,
      });
    }
    const sortedGroups = groups.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return upgradeEditMode
      ? sortedGroups
      : sortedGroups.filter((group) => group.systems.length > 0);
  }, [upgradeGroups, upgradeGroupConfig.ungroupedSortOrder, visibleModalSystems, groupsById, upgradeEditMode]);
  const sortableLayoutKey = useMemo(
    () =>
      orderedGroupsForModal
        .map((group) => `${group.key}:${group.systems.map((system) => system.id).join(",")}`)
        .join("|"),
    [orderedGroupsForModal]
  );

  useEffect(() => {
    upgradeModalSystemsRef.current = upgradeModalSystems;
  }, [upgradeModalSystems]);

  useEffect(() => {
    if (!showUpgradeConfirm || !upgradeEditMode) return;

    const systemsById = new Map(orderedModalCandidateSystems.map((system) => [system.id, system]));
    setUpgradeModalSystems((current) => {
      const refreshedSystems = current
        .map((system) => systemsById.get(system.id))
        .filter((system): system is System => Boolean(system));
      const refreshedIds = new Set(refreshedSystems.map((system) => system.id));
      const newlyEligibleSystems = orderedModalCandidateSystems.filter((system) => !refreshedIds.has(system.id));
      return [...refreshedSystems, ...newlyEligibleSystems];
    });
    setSelectedSystemIds((current) =>
      current.filter((systemId) => {
        const system = systemsById.get(systemId);
        return !!system;
      })
    );
    setFullUpgradeSelections((current) => {
      const next: Record<number, boolean> = {};
      for (const system of orderedModalCandidateSystems) {
        next[system.id] = current[system.id] ?? isDefaultFullUpgradeEnabled(system);
      }
      return next;
    });
  }, [showUpgradeConfirm, orderedModalCandidateSystems]);

  const restoreSortableDomMove = (evt: SortableEvent) => {
    if (evt.oldIndex === undefined) return;

    const refIndex =
      evt.from === evt.to &&
      evt.newIndex !== undefined &&
      evt.newIndex < evt.oldIndex
        ? evt.oldIndex + 1
        : evt.oldIndex;
    evt.from.insertBefore(evt.item, evt.from.children[refIndex] ?? null);
  };

  const persistSystemGroupingFromDom = (evt: SortableEvent) => {
    const root = groupListRef.current;
    if (!root) {
      restoreSortableDomMove(evt);
      return;
    }
    const updates = new Map<number, { groupId: number | null; upgradeOrder: number }>();
    for (const list of Array.from(root.querySelectorAll<HTMLUListElement>("[data-system-list-group]"))) {
      const rawGroupId = list.dataset.systemListGroup;
      const groupId = rawGroupId && rawGroupId !== UNGROUPED_KEY ? Number(rawGroupId) : null;
      Array.from(list.querySelectorAll<HTMLElement>("[data-system-id]")).forEach((node, index) => {
        const systemId = Number(node.dataset.systemId);
        if (Number.isInteger(systemId) && systemId > 0) {
          updates.set(systemId, { groupId, upgradeOrder: index + 1 });
        }
      });
    }
    if (updates.size === 0) {
      restoreSortableDomMove(evt);
      return;
    }
    const payload = Array.from(updates.entries()).map(([systemId, update]) => ({
      systemId,
      groupId: update.groupId,
      upgradeOrder: update.upgradeOrder,
    }));
    const previousSystems = upgradeModalSystemsRef.current;
    restoreSortableDomMove(evt);
    setUpgradeModalSystems((current) =>
      current.map((system) => {
        const update = updates.get(system.id);
        return update
          ? { ...system, upgradeGroupId: update.groupId, upgradeOrder: update.upgradeOrder }
          : system;
      })
    );
    window.setTimeout(() => {
      updateSystemUpgradeGroups.mutate(payload, {
        onError: (err) => {
          setUpgradeModalSystems(previousSystems);
          addToast(err.message, "danger");
        },
      });
    }, 0);
  };

  useEffect(() => {
    systemSortablesRef.current.forEach((sortable) => sortable.destroy());
    systemSortablesRef.current = [];
    groupSortableRef.current?.destroy();
    groupSortableRef.current = null;

    if (!showUpgradeConfirm) return;

    const root = groupListRef.current;
    if (root && orderedGroupsForModal.length > 1) {
      groupSortableRef.current = new Sortable(root, {
        animation: 150,
        handle: ".upgrade-group-drag-handle",
        draggable: "[data-upgrade-group-key]",
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        onEnd: (evt) => {
          const groupKeys = Array.from(root.querySelectorAll<HTMLElement>("[data-upgrade-group-key]"))
            .map((node) => node.dataset.upgradeGroupKey)
            .map((key) => key === UNGROUPED_KEY ? UNGROUPED_KEY : Number(key))
            .filter((key): key is number | typeof UNGROUPED_KEY => key === UNGROUPED_KEY || (Number.isInteger(key) && key > 0));
          restoreSortableDomMove(evt);
          if (groupKeys.length === orderedGroupsForModal.length) {
            window.setTimeout(() => {
              reorderUpgradeGroups.mutate(groupKeys, {
                onError: (err) => addToast(err.message, "danger"),
              });
            }, 0);
          }
        },
      });
    }

    for (const [groupKey, list] of systemListRefs.current.entries()) {
      if (!list) continue;
      const sortable = new Sortable(list, {
        animation: 150,
        group: "upgrade-systems",
        handle: ".upgrade-drag-handle",
        ghostClass: "sortable-ghost",
        chosenClass: "sortable-chosen",
        onEnd: persistSystemGroupingFromDom,
      });
      systemSortablesRef.current.push(sortable);
      if (!groupKey) sortable.option("disabled", true);
    }

    return () => {
      systemSortablesRef.current.forEach((sortable) => sortable.destroy());
      systemSortablesRef.current = [];
      groupSortableRef.current?.destroy();
      groupSortableRef.current = null;
    };
  }, [showUpgradeConfirm, upgradeEditMode, sortableLayoutKey, orderedGroupsForModal.length, reorderUpgradeGroups, addToast]);

  useEffect(() => {
    const disabled = !upgradeEditMode || updateSystemUpgradeGroups.isPending || reorderUpgradeGroups.isPending;
    systemSortablesRef.current.forEach((sortable) => sortable.option("disabled", disabled));
    groupSortableRef.current?.option("disabled", disabled);
  }, [upgradeEditMode, updateSystemUpgradeGroups.isPending, reorderUpgradeGroups.isPending]);

  const openUpgradeConfirm = () => {
    setSelectedSystemIds(defaultSelectedSystemIds);
    setUpgradeEditMode(false);
    setUpgradeModalSystems(orderedModalCandidateSystems);
    setFullUpgradeSelections(Object.fromEntries(
      orderedModalCandidateSystems.map((s) => [s.id, isDefaultFullUpgradeEnabled(s)])
    ));
    setShowUpgradeConfirm(true);
  };

  const closeUpgradeConfirm = () => {
    setShowUpgradeConfirm(false);
    setUpgradeEditMode(false);
    setSelectedSystemIds([]);
    setUpgradeModalSystems([]);
    setRenameGroup(null);
    setDeleteGroup(null);
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

  const handleCreateGroup = () => {
    const existingNames = new Set(upgradeGroups.map((group) => group.name.trim().toLowerCase()));
    let index = 1;
    while (existingNames.has(`group ${index}`)) index += 1;
    const name = `Group ${index}`;
    createUpgradeGroup.mutate(name, {
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const openRenameGroup = (group: UpgradeGroup) => {
    setRenameGroup({ id: group.id, name: group.name });
  };

  const saveRenameGroup = () => {
    if (!renameGroup) return;
    const name = renameGroup.name.trim();
    const currentGroup = upgradeGroups.find((group) => group.id === renameGroup.id);
    if (!name || !currentGroup) return;
    if (name === currentGroup.name) {
      setRenameGroup(null);
      return;
    }
    updateUpgradeGroup.mutate(
      { groupId: renameGroup.id, name },
      {
        onSuccess: () => setRenameGroup(null),
        onError: (err) => addToast(err.message, "danger"),
      }
    );
  };

  const handleDeleteGroup = (group: UpgradeGroup) => {
    setDeleteGroup(group);
  };

  const confirmDeleteGroup = () => {
    if (!deleteGroup) return;
    deleteUpgradeGroup.mutate(deleteGroup.id, {
      onSuccess: () => setDeleteGroup(null),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleUpgradeAll = () => {
    const latestSystemsById = new Map((systems ?? []).map((system) => [system.id, system]));
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
      onSuccess: () => addToast(`Upgrade All queued for ${items.length} system${items.length !== 1 ? "s" : ""}`, "info"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  return (
    <Layout
      title="Dashboard"
      contentWidth="wide"
      actions={
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={handleRefresh}
            disabled={refreshCache.isPending || hasUpgradeInProgress}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {refreshCache.isPending ? <span className="spinner spinner-sm" /> : "Refresh All"}
          </button>
          <button
            onClick={openUpgradeConfirm}
            disabled={hasUpgradeInProgress}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {hasUpgradeInProgress ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                Upgrading...
              </span>
            ) : (
              "Upgrade All"
            )}
          </button>
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
        {modalSystems.length > 0 ? (
          <div className="mb-4">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                role="switch"
                aria-checked={upgradeEditMode}
                onClick={() => setUpgradeEditMode((current) => !current)}
                className="inline-flex w-fit items-center gap-2 rounded-md px-1 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
              >
                <span
                  className={`relative h-5 w-9 rounded-full transition-colors ${
                    upgradeEditMode ? "bg-blue-500" : "bg-slate-300 dark:bg-slate-600"
                  }`}
                  aria-hidden="true"
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      upgradeEditMode ? "translate-x-4" : ""
                    }`}
                  />
                </span>
                Edit mode
              </button>
              {upgradeEditMode && (
                <button
                  type="button"
                  onClick={handleCreateGroup}
                  disabled={createUpgradeGroup.isPending}
                  className="w-full rounded-md border border-border px-3 py-1.5 text-xs text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-700 sm:w-auto"
                >
                  Add group
                </button>
              )}
            </div>
            <div ref={groupListRef} className="space-y-3">
              {orderedGroupsForModal.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-4 text-sm text-slate-500 dark:text-slate-400">
                  No systems have updates right now. Enable edit mode to organize all systems.
                </div>
              )}
              {orderedGroupsForModal.map((group) => (
                <section
                  key={group.key}
                  data-group-id={group.id ?? undefined}
                  data-upgrade-group-key={group.key}
                  data-real-group={group.id ? "true" : "false"}
                  className="rounded-lg border border-border bg-slate-50/60 p-2 dark:bg-slate-800/40"
                >
                  <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`upgrade-group-drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                          upgradeEditMode && orderedGroupsForModal.length > 1
                            ? "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                            : "cursor-default opacity-40"
                        }`}
                        title={upgradeEditMode && orderedGroupsForModal.length > 1 ? "Drag to reorder group" : undefined}
                        aria-label={upgradeEditMode && orderedGroupsForModal.length > 1 ? `Drag to reorder ${group.name}` : undefined}
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                        </svg>
                      </span>
                      <h3 className="min-w-0 truncate text-sm font-semibold text-slate-700 dark:text-slate-100">
                        {group.name}
                      </h3>
                      <Badge variant="muted" small>{group.systems.length}</Badge>
                    </div>
                    {upgradeEditMode && group.realGroup && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => openRenameGroup(group.realGroup!)}
                          className="rounded p-1.5 transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                          title="Edit group name"
                        >
                          <span className="sr-only">Edit group name</span>
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteGroup(group.realGroup!)}
                          className="rounded p-1.5 text-red-500 transition-colors hover:bg-red-50 dark:hover:bg-red-900/20"
                          title="Delete group"
                        >
                          <span className="sr-only">Delete group</span>
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                  <ul
                    ref={(node) => {
                      if (node) {
                        systemListRefs.current.set(group.key, node);
                      } else {
                        systemListRefs.current.delete(group.key);
                      }
                    }}
                    data-system-list-group={group.id ?? UNGROUPED_KEY}
                    className="min-h-6 space-y-2"
                  >
                    {group.systems.map((s) => {
                      const hasUpdates = s.updateCount > 0;
                      const isSelected = isUpgradePresetSelected(s, selectedSystemIds);
                      const canTogglePreset = canToggleUpgradePreset(s, upgradeEditMode);
                      const canOverrideMode = supportsDefaultUpgradeModeOverride(s);
                      const fullUpgradeEnabled = fullUpgradeSelections[s.id] ?? false;
                      const fullUpgradeSaving =
                        updateSystemUpgradeMode.isPending &&
                        updateSystemUpgradeMode.variables?.systemId === s.id;

                      return (
                        <li
                          key={s.id}
                          data-system-id={s.id}
                          className={`grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-lg border p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] ${
                            isSelected
                              ? "bg-white dark:bg-slate-800/80"
                              : "bg-slate-50 dark:bg-slate-700/50"
                          } ${hasUpdates ? "border-border" : "border-dashed border-slate-300 opacity-70 dark:border-slate-600"}`}
                        >
                          <span
                            className={`upgrade-drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                              upgradeEditMode && !updateSystemUpgradeGroups.isPending
                                ? "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                                : "cursor-default opacity-40"
                            }`}
                            title={upgradeEditMode ? "Drag to set upgrade group and order" : undefined}
                            aria-label={upgradeEditMode ? `Drag to set upgrade group and order for ${s.name}` : undefined}
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                            </svg>
                          </span>
                          <div className="flex min-w-0 flex-wrap items-center gap-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => canTogglePreset && toggleSystemSelection(s.id)}
                              disabled={!canTogglePreset || updateSystemUpgradeAllExclusion.isPending}
                              className="shrink-0 rounded"
                              aria-label={`${isSelected ? "Exclude" : "Include"} ${s.name} in Upgrade All`}
                            />
                            <span className="block min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
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
                                title="Toggle and save full upgrade for this system"
                              >
                                Full upgrade
                              </button>
                            )}
                          </div>
                          <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-start-auto sm:justify-end">
                            {hasUpdates ? (
                              <Badge variant="warning" small>{s.updateCount} updates</Badge>
                            ) : (
                              <Badge variant="muted" small>no updates</Badge>
                            )}
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
                </section>
              ))}
            </div>
            {upgradeEditMode && modalSystems.length > 1 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
                Drag groups and systems to set the saved upgrade order. Systems in the same group start together; the next group waits for the previous group to finish.
              </p>
            )}
            {systemsWithUpdates.length > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
                Check a system to include it in future Upgrade All runs; uncheck it to exclude it.
              </p>
            )}
          </div>
        ) : (
          <div className="mb-4 rounded-lg border border-dashed border-border p-4 text-sm text-slate-500 dark:text-slate-400">
            No systems are available to group yet.
          </div>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            onClick={closeUpgradeConfirm}
            className="w-full px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors sm:w-auto"
          >
            Cancel
          </button>
          <button
            onClick={handleUpgradeAll}
            disabled={selectedSystems.length === 0 || hasUpgradeInProgress}
            className="w-full px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 sm:w-auto"
          >
            Upgrade All
          </button>
        </div>
      </Modal>
      <Modal
        open={!!renameGroup}
        onClose={() => setRenameGroup(null)}
        title="Rename Group"
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-200">
              Group name
            </span>
            <input
              value={renameGroup?.name ?? ""}
              onChange={(event) =>
                setRenameGroup((current) =>
                  current ? { ...current, name: event.target.value } : current
                )
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") saveRenameGroup();
              }}
              autoFocus
              className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:bg-slate-900"
            />
          </label>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setRenameGroup(null)}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 sm:w-auto"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveRenameGroup}
              disabled={!renameGroup?.name.trim() || updateUpgradeGroup.isPending}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>
      <Modal
        open={!!deleteGroup}
        onClose={() => setDeleteGroup(null)}
        title="Delete Group"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Delete {deleteGroup?.name}? Systems in this group will move to Ungrouped.
          </p>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setDeleteGroup(null)}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-700 sm:w-auto"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDeleteGroup}
              disabled={deleteUpgradeGroup.isPending}
              className="w-full rounded-lg bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:opacity-50 sm:w-auto"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </Layout>
  );
}
