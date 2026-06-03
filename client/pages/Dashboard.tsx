import { useState, useEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import { Link } from "react-router";
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
import { deriveSystemUpdateState, isPostAutoremoveRecheck, isPostUpgradeRecheck, shouldClearLocalUpgrade } from "../lib/system-status";

const UNGROUPED_KEY = "ungrouped";
type UpgradeSystemPlacement = { groupId: number | null; upgradeOrder: number };
type DropPosition = "before" | "after" | "end";
type ModalUpgradeGroup = {
  key: string;
  id: number | null;
  name: string;
  sortOrder: number;
  systems: System[];
  realGroup?: UpgradeGroup;
};

function getGroupKey(groupId: number | null | undefined): string {
  return groupId ? String(groupId) : UNGROUPED_KEY;
}

function sameUpgradeSystemPlacement(
  system: Pick<System, "upgradeGroupId" | "upgradeOrder">,
  placement: UpgradeSystemPlacement,
): boolean {
  return (
    (system.upgradeGroupId ?? null) === placement.groupId &&
    system.upgradeOrder === placement.upgradeOrder
  );
}

export function applyUpgradeSystemPlacements<T extends Pick<System, "id" | "upgradeGroupId" | "upgradeOrder">>(
  systems: T[],
  placements: Map<number, UpgradeSystemPlacement>,
): T[] {
  if (placements.size === 0) return systems;
  return systems.map((system) => {
    const placement = placements.get(system.id);
    return placement
      ? { ...system, upgradeGroupId: placement.groupId, upgradeOrder: placement.upgradeOrder }
      : system;
  });
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
  return !!system.activeOperation?.type.includes("upgrade") && !isPostUpgradeRecheck(system.activeOperation);
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
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{label}</div>
    </div>
  );
}

function SystemCard({ system, upgrading, checking }: { system: Pick<System, "id" | "name" | "hostname" | "port" | "osName" | "isReachable" | "updateCount" | "securityCount" | "keptBackCount" | "needsReboot" | "cacheAge" | "cacheTimestamp" | "isStale" | "lastCheck" | "activeOperation">; upgrading: boolean; checking: boolean }) {
  const updateState = deriveSystemUpdateState(system, { upgrading, checking });
  const maintaining = updateState === "maintaining";
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
            <Badge variant="info" small>Upgrading...</Badge>
          ) : updateState === "maintaining" ? (
            <Badge variant="info" small>Maintaining...</Badge>
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
  const [localGroupOrderKeys, setLocalGroupOrderKeys] = useState<string[] | null>(null);
  const [renameGroup, setRenameGroup] = useState<{ id: number; name: string } | null>(null);
  const [deleteGroup, setDeleteGroup] = useState<UpgradeGroup | null>(null);
  const upgradeGroupContainerRef = useRef<HTMLDivElement | null>(null);
  const upgradeModalSystemsRef = useRef<System[]>([]);
  const orderedGroupsForModalRef = useRef<ModalUpgradeGroup[]>([]);
  const pendingSystemPlacementsRef = useRef<Map<number, UpgradeSystemPlacement>>(new Map());
  const draggedSystemIdRef = useRef<number | null>(null);
  const draggedGroupKeyRef = useRef<string | null>(null);
  const dragPreviewRef = useRef<HTMLElement | null>(null);
  const dragPreviewOffsetRef = useRef({ x: 0, y: 0 });
  const dragPreviewCleanupRef = useRef<(() => void) | null>(null);
  const dragInitialModalSystemsRef = useRef<System[]>([]);
  const dragSystemPlacementsRef = useRef<Map<number, UpgradeSystemPlacement> | null>(null);
  const dragSystemLayoutKeyRef = useRef<string>("");
  const dragInitialGroupKeysRef = useRef<string[]>([]);
  const dragGroupKeysRef = useRef<string[] | null>(null);
  const dragDocumentStylesRef = useRef<{ userSelect: string; touchAction: string; overscrollBehavior: string } | null>(null);

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
  const hasRefreshInProgress =
    refreshCache.isPending ||
    (systems?.some((s) => s.activeOperation?.type === "check") ?? false);
  const disableRefreshAll = refreshCache.isPending || hasActiveOps;
  const disableUpgradeSubmit = refreshCache.isPending || hasActiveOps;
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
    const groups: ModalUpgradeGroup[] =
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
    let sortedGroups = groups.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    if (localGroupOrderKeys) {
      const orderByKey = new Map(localGroupOrderKeys.map((key, index) => [key, index]));
      sortedGroups = sortedGroups.sort((a, b) => {
        const aOrder = orderByKey.get(a.key) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = orderByKey.get(b.key) ?? Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
      });
    }
    return upgradeEditMode
      ? sortedGroups
      : sortedGroups.filter((group) => group.systems.length > 0);
  }, [upgradeGroups, upgradeGroupConfig.ungroupedSortOrder, visibleModalSystems, groupsById, upgradeEditMode, localGroupOrderKeys]);
  const upgradeSortingDisabled =
    !upgradeEditMode || updateSystemUpgradeGroups.isPending || reorderUpgradeGroups.isPending;

  useEffect(() => {
    upgradeModalSystemsRef.current = upgradeModalSystems;
  }, [upgradeModalSystems]);

  useEffect(() => {
    orderedGroupsForModalRef.current = orderedGroupsForModal;
  }, [orderedGroupsForModal]);

  useEffect(() => {
    if (!showUpgradeConfirm || !upgradeEditMode) return;

    const systemsById = new Map(orderedModalCandidateSystems.map((system) => [system.id, system]));
    for (const [systemId, placement] of pendingSystemPlacementsRef.current) {
      const refreshedSystem = systemsById.get(systemId);
      if (refreshedSystem && sameUpgradeSystemPlacement(refreshedSystem, placement)) {
        pendingSystemPlacementsRef.current.delete(systemId);
      }
    }
    setUpgradeModalSystems((current) => {
      const refreshedSystems = current
        .map((system) => systemsById.get(system.id))
        .filter((system): system is System => Boolean(system));
      const refreshedIds = new Set(refreshedSystems.map((system) => system.id));
      const newlyEligibleSystems = orderedModalCandidateSystems.filter((system) => !refreshedIds.has(system.id));
      return applyUpgradeSystemPlacements(
        [...refreshedSystems, ...newlyEligibleSystems],
        pendingSystemPlacementsRef.current,
      );
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
  }, [showUpgradeConfirm, upgradeEditMode, orderedModalCandidateSystems]);

  const persistSystemPlacements = (
    updates: Map<number, UpgradeSystemPlacement>,
    previousSystems = upgradeModalSystemsRef.current,
  ) => {
    const payload = Array.from(updates.entries()).map(([systemId, update]) => ({
      systemId,
      groupId: update.groupId,
      upgradeOrder: update.upgradeOrder,
    }));
    const previousSystemsById = new Map(previousSystems.map((system) => [system.id, system]));
    const hasChanges = payload.some((update) => {
      const system = previousSystemsById.get(update.systemId);
      return system
        ? (system.upgradeGroupId ?? null) !== update.groupId || system.upgradeOrder !== update.upgradeOrder
        : false;
    });
    if (!hasChanges) return;

    pendingSystemPlacementsRef.current = updates;
    setUpgradeModalSystems((current) => applyUpgradeSystemPlacements(current, updates));
    updateSystemUpgradeGroups.mutate(payload, {
      onError: (err) => {
        pendingSystemPlacementsRef.current = new Map();
        setUpgradeModalSystems(previousSystems);
        addToast(err.message, "danger");
      },
    });
  };

  const getDragLayoutKey = (element: HTMLElement): string | null => {
    if (element.dataset.systemId) return `system:${element.dataset.systemId}`;
    if (element.dataset.upgradeGroupKey) return `group:${element.dataset.upgradeGroupKey}`;
    return null;
  };

  const captureDragLayout = (): Map<string, DOMRect> => {
    const root = upgradeGroupContainerRef.current;
    const rects = new Map<string, DOMRect>();
    if (!root) return rects;

    for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-upgrade-group-key], [data-system-id]"))) {
      const key = getDragLayoutKey(element);
      if (key) rects.set(key, element.getBoundingClientRect());
    }
    return rects;
  };

  const animateDragLayoutFrom = (previousRects: Map<string, DOMRect>) => {
    if (previousRects.size === 0) return;

    const root = upgradeGroupContainerRef.current;
    if (!root) return;

    const animatedElements: HTMLElement[] = [];
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-upgrade-group-key], [data-system-id]"))) {
      const key = getDragLayoutKey(element);
      const previousRect = key ? previousRects.get(key) : undefined;
      if (!previousRect) continue;

      const nextRect = element.getBoundingClientRect();
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;

      element.style.transition = "none";
      element.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      element.style.willChange = "transform";
      animatedElements.push(element);
    }

    if (animatedElements.length === 0) return;
    document.body.offsetHeight;
    window.requestAnimationFrame(() => {
      for (const element of animatedElements) {
        element.style.transition = "transform 150ms ease-out";
        element.style.transform = "";
      }
      window.setTimeout(() => {
        for (const element of animatedElements) {
          element.style.transition = "";
          element.style.transform = "";
          element.style.willChange = "";
        }
      }, 180);
    });
  };

  const clearDragPreview = () => {
    dragPreviewCleanupRef.current?.();
    dragPreviewCleanupRef.current = null;
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
  };

  const lockPointerDragDocument = () => {
    if (dragDocumentStylesRef.current) return;
    dragDocumentStylesRef.current = {
      userSelect: document.body.style.userSelect,
      touchAction: document.body.style.touchAction,
      overscrollBehavior: document.body.style.overscrollBehavior,
    };
    document.body.style.userSelect = "none";
    document.body.style.touchAction = "none";
    document.body.style.overscrollBehavior = "contain";
  };

  const unlockPointerDragDocument = () => {
    const previousStyles = dragDocumentStylesRef.current;
    if (!previousStyles) return;
    document.body.style.userSelect = previousStyles.userSelect;
    document.body.style.touchAction = previousStyles.touchAction;
    document.body.style.overscrollBehavior = previousStyles.overscrollBehavior;
    dragDocumentStylesRef.current = null;
  };

  const moveDragPreview = (clientX: number, clientY: number) => {
    if (!dragPreviewRef.current || (clientX === 0 && clientY === 0)) return;
    const { x, y } = dragPreviewOffsetRef.current;
    dragPreviewRef.current.style.transform = `translate3d(${clientX - x}px, ${clientY - y}px, 0)`;
  };

  const setPointerDragPreview = (event: ReactPointerEvent<HTMLElement>, source: HTMLElement | null) => {
    clearDragPreview();
    if (!source) return;

    const rect = source.getBoundingClientRect();
    const preview = source.cloneNode(true) as HTMLElement;
    preview.removeAttribute("id");
    preview.setAttribute("aria-hidden", "true");
    preview.style.position = "fixed";
    preview.style.left = "0";
    preview.style.top = "0";
    preview.style.width = `${rect.width}px`;
    preview.style.pointerEvents = "none";
    preview.style.zIndex = "9999";
    preview.style.opacity = "0.94";
    preview.style.boxShadow = "0 18px 45px rgba(15, 23, 42, 0.35)";
    preview.style.willChange = "transform";
    document.body.appendChild(preview);
    dragPreviewRef.current = preview;
    dragPreviewOffsetRef.current = {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
    moveDragPreview(event.clientX, event.clientY);
  };

  const getSystemDropTarget = (
    clientX: number,
    clientY: number,
  ): { groupKey: string; systemId: number | null; position: DropPosition } | null => {
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof HTMLElement)) return null;

    const row = target.closest<HTMLElement>("[data-system-id]");
    if (row) {
      const list = row.closest<HTMLElement>("[data-system-list-group]");
      const groupKey = list?.dataset.systemListGroup;
      const systemId = Number(row.dataset.systemId);
      if (groupKey && Number.isInteger(systemId) && systemId > 0) {
        const rect = row.getBoundingClientRect();
        return {
          groupKey,
          systemId,
          position: clientY > rect.top + rect.height / 2 ? "after" : "before",
        };
      }
    }

    const list = target.closest<HTMLElement>("[data-system-list-group]");
    if (list?.dataset.systemListGroup) {
      return { groupKey: list.dataset.systemListGroup, systemId: null, position: "end" };
    }

    const group = target.closest<HTMLElement>("[data-upgrade-group-key]");
    if (group?.dataset.upgradeGroupKey) {
      return { groupKey: group.dataset.upgradeGroupKey, systemId: null, position: "end" };
    }

    return null;
  };

  const getSystemPlacementsForMove = (
    targetGroupKey: string,
    targetSystemId: number | null,
    position: DropPosition,
  ): Map<number, UpgradeSystemPlacement> | null => {
    const draggedSystemId = draggedSystemIdRef.current;
    if (!draggedSystemId || upgradeSortingDisabled) return null;
    if (targetSystemId === draggedSystemId) return null;

    const groups = orderedGroupsForModalRef.current;
    const groupsByKey = new Map(groups.map((group) => [group.key, group]));
    if (!groupsByKey.has(targetGroupKey)) return null;

    const systemIdsByGroup = new Map(
      groups.map((group) => [
        group.key,
        group.systems.map((system) => system.id).filter((systemId) => systemId !== draggedSystemId),
      ]),
    );
    const targetSystemIds = systemIdsByGroup.get(targetGroupKey);
    if (!targetSystemIds) return null;

    let insertIndex = targetSystemIds.length;
    if (targetSystemId !== null && position !== "end") {
      const targetIndex = targetSystemIds.indexOf(targetSystemId);
      if (targetIndex >= 0) {
        insertIndex = targetIndex + (position === "after" ? 1 : 0);
      }
    }
    targetSystemIds.splice(Math.min(insertIndex, targetSystemIds.length), 0, draggedSystemId);

    const updates = new Map<number, UpgradeSystemPlacement>();
    for (const group of groups) {
      const groupSystemIds = systemIdsByGroup.get(group.key) ?? [];
      for (const [index, systemId] of groupSystemIds.entries()) {
        updates.set(systemId, { groupId: group.id, upgradeOrder: index + 1 });
      }
    }
    return updates;
  };

  const getSystemLayoutKey = (placements: Map<number, UpgradeSystemPlacement>): string =>
    Array.from(placements.entries())
      .sort(([a], [b]) => a - b)
      .map(([systemId, placement]) => `${systemId}:${placement.groupId ?? UNGROUPED_KEY}:${placement.upgradeOrder}`)
      .join("|");

  const moveDraggedSystemPreview = (clientX: number, clientY: number) => {
    const target = getSystemDropTarget(clientX, clientY);
    if (!target) return;
    const placements = getSystemPlacementsForMove(target.groupKey, target.systemId, target.position);
    if (!placements) return;

    const layoutKey = getSystemLayoutKey(placements);
    if (layoutKey === dragSystemLayoutKeyRef.current) return;

    const previousRects = captureDragLayout();
    dragSystemLayoutKeyRef.current = layoutKey;
    dragSystemPlacementsRef.current = placements;
    flushSync(() => {
      setUpgradeModalSystems((current) => applyUpgradeSystemPlacements(current, placements));
    });
    animateDragLayoutFrom(previousRects);
  };

  const getGroupDropTarget = (clientX: number, clientY: number): { groupKey: string; position: Exclude<DropPosition, "end"> } | null => {
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof HTMLElement)) return null;
    const group = target.closest<HTMLElement>("[data-upgrade-group-key]");
    const groupKey = group?.dataset.upgradeGroupKey;
    if (!group || !groupKey) return null;
    const rect = group.getBoundingClientRect();
    return { groupKey, position: clientY > rect.top + rect.height / 2 ? "after" : "before" };
  };

  const moveDraggedGroupPreview = (clientX: number, clientY: number) => {
    const draggedGroupKey = draggedGroupKeyRef.current;
    if (!draggedGroupKey || upgradeSortingDisabled) return;

    const target = getGroupDropTarget(clientX, clientY);
    if (!target || target.groupKey === draggedGroupKey) return;

    const currentKeys = dragGroupKeysRef.current ?? orderedGroupsForModalRef.current.map((group) => group.key);
    const groupKeys = currentKeys.filter((key) => key !== draggedGroupKey);
    const targetIndex = groupKeys.indexOf(target.groupKey);
    if (targetIndex < 0) return;

    const insertIndex = target.position === "after" ? targetIndex + 1 : targetIndex;
    groupKeys.splice(insertIndex, 0, draggedGroupKey);
    if (groupKeys.join("|") === currentKeys.join("|")) return;

    const previousRects = captureDragLayout();
    dragGroupKeysRef.current = groupKeys;
    flushSync(() => {
      setLocalGroupOrderKeys(groupKeys);
    });
    animateDragLayoutFrom(previousRects);
  };

  const finishPointerDrag = () => {
    const systemPlacements = dragSystemPlacementsRef.current;
    const groupKeys = dragGroupKeysRef.current;
    const initialGroupKeys = dragInitialGroupKeysRef.current;
    const initialModalSystems = dragInitialModalSystemsRef.current;

    clearDragPreview();
    unlockPointerDragDocument();
    dragPreviewCleanupRef.current?.();
    dragPreviewCleanupRef.current = null;

    if (systemPlacements) {
      persistSystemPlacements(systemPlacements, initialModalSystems);
    }

    if (groupKeys && groupKeys.join("|") !== initialGroupKeys.join("|")) {
      const payload = groupKeys
        .map((key) => key === UNGROUPED_KEY ? UNGROUPED_KEY : Number(key))
        .filter((key): key is number | typeof UNGROUPED_KEY => key === UNGROUPED_KEY || (Number.isInteger(key) && key > 0));
      if (payload.length === orderedGroupsForModalRef.current.length) {
        reorderUpgradeGroups.mutate(payload, {
          onError: (err) => {
            setLocalGroupOrderKeys(initialGroupKeys);
            addToast(err.message, "danger");
          },
        });
      }
    }

    draggedSystemIdRef.current = null;
    draggedGroupKeyRef.current = null;
    dragSystemPlacementsRef.current = null;
    dragSystemLayoutKeyRef.current = "";
    dragGroupKeysRef.current = null;
    dragInitialGroupKeysRef.current = [];
    dragInitialModalSystemsRef.current = [];
  };

  const cancelPointerDrag = () => {
    const initialSystems = dragInitialModalSystemsRef.current;
    if (dragSystemPlacementsRef.current && initialSystems.length > 0) {
      setUpgradeModalSystems(initialSystems);
    }
    if (dragGroupKeysRef.current) {
      setLocalGroupOrderKeys(dragInitialGroupKeysRef.current.length > 0 ? dragInitialGroupKeysRef.current : null);
    }
    clearDragPreview();
    unlockPointerDragDocument();
    draggedSystemIdRef.current = null;
    draggedGroupKeyRef.current = null;
    dragSystemPlacementsRef.current = null;
    dragSystemLayoutKeyRef.current = "";
    dragGroupKeysRef.current = null;
    dragInitialGroupKeysRef.current = [];
    dragInitialModalSystemsRef.current = [];
  };

  const startPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    source: HTMLElement | null,
    onMove: (clientX: number, clientY: number) => void,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    lockPointerDragDocument();
    setPointerDragPreview(event, source);

    const handlePointerMove = (pointerEvent: PointerEvent) => {
      pointerEvent.preventDefault();
      moveDragPreview(pointerEvent.clientX, pointerEvent.clientY);
      onMove(pointerEvent.clientX, pointerEvent.clientY);
    };
    const handlePointerUp = (pointerEvent: PointerEvent) => {
      pointerEvent.preventDefault();
      cleanupPointerListeners();
      finishPointerDrag();
    };
    const handlePointerCancel = () => {
      cleanupPointerListeners();
      cancelPointerDrag();
    };
    const cleanupPointerListeners = () => {
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("pointercancel", handlePointerCancel, true);
    };

    document.addEventListener("pointermove", handlePointerMove, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("pointercancel", handlePointerCancel, true);
    dragPreviewCleanupRef.current = cleanupPointerListeners;
  };

  const handleSystemPointerDown = (event: ReactPointerEvent<HTMLElement>, systemId: number) => {
    if (upgradeSortingDisabled) return;
    draggedSystemIdRef.current = systemId;
    dragInitialModalSystemsRef.current = upgradeModalSystemsRef.current;
    dragSystemPlacementsRef.current = null;
    dragSystemLayoutKeyRef.current = "";
    startPointerDrag(event, event.currentTarget.closest("li"), moveDraggedSystemPreview);
  };

  const handleGroupPointerDown = (event: ReactPointerEvent<HTMLElement>, groupKey: string) => {
    if (upgradeSortingDisabled || orderedGroupsForModal.length <= 1) return;
    draggedGroupKeyRef.current = groupKey;
    const groupKeys = orderedGroupsForModalRef.current.map((group) => group.key);
    dragInitialGroupKeysRef.current = groupKeys;
    dragGroupKeysRef.current = groupKeys;
    startPointerDrag(event, event.currentTarget.closest("section"), moveDraggedGroupPreview);
  };

  const openUpgradeConfirm = () => {
    clearDragPreview();
    unlockPointerDragDocument();
    pendingSystemPlacementsRef.current = new Map();
    draggedSystemIdRef.current = null;
    draggedGroupKeyRef.current = null;
    dragSystemPlacementsRef.current = null;
    dragGroupKeysRef.current = null;
    setLocalGroupOrderKeys(null);
    setSelectedSystemIds(defaultSelectedSystemIds);
    setUpgradeEditMode(false);
    setUpgradeModalSystems(orderedModalCandidateSystems);
    setFullUpgradeSelections(Object.fromEntries(
      orderedModalCandidateSystems.map((s) => [s.id, isDefaultFullUpgradeEnabled(s)])
    ));
    setShowUpgradeConfirm(true);
  };

  const closeUpgradeConfirm = () => {
    clearDragPreview();
    unlockPointerDragDocument();
    pendingSystemPlacementsRef.current = new Map();
    draggedSystemIdRef.current = null;
    draggedGroupKeyRef.current = null;
    dragSystemPlacementsRef.current = null;
    dragGroupKeysRef.current = null;
    setLocalGroupOrderKeys(null);
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
            disabled={disableRefreshAll}
            className="px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 whitespace-nowrap"
          >
            {hasRefreshInProgress ? (
              <span className="flex items-center gap-1.5">
                <span className="spinner spinner-sm" />
                Refreshing...
              </span>
            ) : (
              "Refresh All"
            )}
          </button>
          <button
            onClick={openUpgradeConfirm}
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
              checking={isPostUpgradeRecheck(s.activeOperation) || isPostAutoremoveRecheck(s.activeOperation) || s.activeOperation?.type === "check" || s.activeOperation?.type === "package_manager_repair"}
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
            <div className="mb-3 flex items-center justify-between gap-2">
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
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  Add group
                </button>
              )}
            </div>
            <div ref={upgradeGroupContainerRef} className="space-y-3">
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
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={`upgrade-group-drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                          !upgradeSortingDisabled && orderedGroupsForModal.length > 1
                            ? "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                            : "cursor-default opacity-40"
                        }`}
                        title={!upgradeSortingDisabled && orderedGroupsForModal.length > 1 ? "Drag to reorder group" : undefined}
                        aria-label={!upgradeSortingDisabled && orderedGroupsForModal.length > 1 ? `Drag to reorder ${group.name}` : undefined}
                        onPointerDown={(event) => handleGroupPointerDown(event, group.key)}
                        style={{ touchAction: "none" }}
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
                      <div className="flex shrink-0 gap-2">
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
                          className={getUpgradeSystemRowClass({ hasUpdates, isSelected })}
                        >
                          <span
                            className={`upgrade-drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                              !upgradeSortingDisabled
                                ? "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                                : "cursor-default opacity-40"
                            }`}
                            title={!upgradeSortingDisabled ? "Drag to set upgrade group and order" : undefined}
                            aria-label={!upgradeSortingDisabled ? `Drag to set upgrade group and order for ${s.name}` : undefined}
                            onPointerDown={(event) => handleSystemPointerDown(event, s.id)}
                            style={{ touchAction: "none" }}
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
                            <span className={getUpgradeSystemNameClass({ hasUpdates, isSelected })}>
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
            disabled={isUpgradeAllSubmitDisabled(selectedSystems.length, disableUpgradeSubmit)}
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
