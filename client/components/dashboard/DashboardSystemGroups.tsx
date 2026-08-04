import {
  useEffect,
  useMemo,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import type { DashboardGroup, System } from "../../lib/systems";
import { useI18n } from "../../lib/i18n";
import { Badge } from "../Badge";

const COLLAPSED_GROUPS_STORAGE_KEY = "ludash.dashboard.collapsed-groups";
const GROUP_BADGES_STORAGE_KEY = "ludash.dashboard.group-badges";
const UNGROUPED_KEY = "ungrouped";

type DragItem = { kind: "system"; id: number } | { kind: "group"; id: string };

type SystemPlacement = {
  systemId: number;
  groupId: number | null;
  dashboardOrder: number;
};

type DashboardSection = {
  key: string;
  groupId: number | null;
  name: string;
  sortOrder: number;
  updatePriority: number;
  group?: DashboardGroup;
  systems: System[];
};

type GroupStatusBadge = {
  key: string;
  label: string;
  count: number;
  variant: "success" | "warning" | "danger";
};

function readCollapsedGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value = JSON.parse(
      window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function readGroupBadgesEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(GROUP_BADGES_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function compareSystems(a: System, b: System): number {
  const orderA = a.dashboardOrder ?? 0;
  const orderB = b.dashboardOrder ?? 0;
  return orderA - orderB || a.name.localeCompare(b.name) || a.id - b.id;
}

const systemNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareSystemsByName(a: System, b: System): number {
  return systemNameCollator.compare(a.name, b.name) || a.id - b.id;
}

function hasCheckIssue(system: System): boolean {
  return system.lastCheck?.status === "failed" || system.lastCheck?.status === "warning";
}

function hasLifecycleWarning(system: System): boolean {
  return (
    system.osLifecycleStatus === "eol" ||
    system.osLifecycleStatus === "approaching_eol" ||
    system.osLifecycleStatus === "support_ending" ||
    system.osLifecycleStatus === "support_ended"
  );
}

function getGroupStatusBadges(systems: System[], t: (key: string) => string): GroupStatusBadge[] {
  const checkIssues = systems.filter(hasCheckIssue).length;
  const badges: GroupStatusBadge[] = [
    {
      key: "up-to-date",
      label: t("pages.dashboard.upToDate"),
      count: systems.filter(
        (system) =>
          system.updateCount === 0 &&
          system.isReachable === 1 &&
          !hasCheckIssue(system) &&
          !hasLifecycleWarning(system),
      ).length,
      variant: "success",
    },
    {
      key: "updates",
      label: t("pages.dashboard.needUpdates"),
      count: systems.filter(
        (system) => system.updateCount > 0 && !hasCheckIssue(system),
      ).length,
      variant: "warning",
    },
    {
      key: "reboot",
      label: t("pages.dashboard.needsReboot"),
      count: systems.filter((system) => system.needsReboot === 1).length,
      variant: "warning",
    },
    {
      key: "lifecycle",
      label: t("pages.dashboard.osWarnings"),
      count: systems.filter(hasLifecycleWarning).length,
      variant: "warning",
    },
    {
      key: "check-issues",
      label: t("pages.dashboard.checkIssues"),
      count: checkIssues,
      variant: "warning",
    },
    {
      key: "unreachable",
      label: t("pages.dashboard.unreachable"),
      count: systems.filter((system) => system.isReachable === -1).length,
      variant: "danger",
    },
  ];
  return badges.filter((badge) => badge.count > 0);
}

function groupKey(groupId: number | null): string {
  return groupId === null ? UNGROUPED_KEY : String(groupId);
}

function cloneSystems(systems: System[]): System[] {
  return systems.map((system) => ({ ...system }));
}

function applySystemOrder(
  systems: System[],
  orderedSections: Array<{ groupId: number | null; systems: System[] }>,
): System[] {
  const placements = new Map<number, SystemPlacement>();
  orderedSections.forEach((section) => {
    section.systems.forEach((system, index) => {
      placements.set(system.id, {
        systemId: system.id,
        groupId: section.groupId,
        dashboardOrder: index + 1,
      });
    });
  });
  return systems.map((system) => {
    const placement = placements.get(system.id);
    return placement
      ? {
          ...system,
          dashboardGroupId: placement.groupId,
          dashboardOrder: placement.dashboardOrder,
        }
      : system;
  });
}

export function DashboardSystemGroups({
  systems,
  groups,
  ungroupedSortOrder,
  ungroupedUpdatePriority = Math.min(
    99,
    Math.max(1, ungroupedSortOrder + 1),
  ),
  editMode,
  onToggleEditMode,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  saveGroupOrder,
  saveGroupUpdatePriority,
  saveSystemUpdatePriority,
  saveSystemPlacements,
  busy = false,
  onError,
  renderSystem,
}: {
  systems: System[];
  groups: DashboardGroup[];
  ungroupedSortOrder: number;
  ungroupedUpdatePriority: number;
  editMode: boolean;
  onToggleEditMode: () => void;
  onCreateGroup: () => void;
  onRenameGroup: (group: DashboardGroup) => void;
  onDeleteGroup: (group: DashboardGroup) => void;
  saveGroupOrder: (groupKeys: Array<number | "ungrouped">) => Promise<void>;
  saveGroupUpdatePriority: (
    groupId: number | null,
    updatePriority: number,
  ) => Promise<void>;
  saveSystemUpdatePriority: (
    systemId: number,
    updatePriority: number,
  ) => Promise<void>;
  saveSystemPlacements: (items: SystemPlacement[]) => Promise<void>;
  busy?: boolean;
  onError: (message: string) => void;
  renderSystem: (system: System) => ReactNode;
}) {
  const { t } = useI18n();
  const [localGroups, setLocalGroups] = useState<DashboardGroup[]>(groups);
  const [localUngroupedSortOrder, setLocalUngroupedSortOrder] =
    useState(ungroupedSortOrder);
  const [localUngroupedUpdatePriority, setLocalUngroupedUpdatePriority] =
    useState(ungroupedUpdatePriority);
  const [localSystems, setLocalSystems] = useState<System[]>(systems);
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(readCollapsedGroups);
  const [groupBadgesEnabled, setGroupBadgesEnabled] =
    useState(readGroupBadgesEnabled);
  const [dragItem, setDragItem] = useState<DragItem | null>(null);

  useEffect(() => setLocalGroups(groups), [groups]);
  useEffect(() => setLocalUngroupedSortOrder(ungroupedSortOrder), [ungroupedSortOrder]);
  useEffect(
    () => setLocalUngroupedUpdatePriority(ungroupedUpdatePriority),
    [ungroupedUpdatePriority],
  );
  useEffect(() => setLocalSystems(systems), [systems]);

  const sections = useMemo(() => {
    const knownGroupIds = new Set(localGroups.map((group) => group.id));
    const result: DashboardSection[] = localGroups.map((group) => ({
      key: String(group.id),
      groupId: group.id as number | null,
      name: group.name,
      sortOrder: group.sortOrder,
      updatePriority:
        group.updatePriority ?? Math.min(99, Math.max(1, group.sortOrder + 1)),
      group,
      systems: localSystems
        .filter((system) => system.dashboardGroupId === group.id)
        .sort(compareSystems),
    }));
    const ungroupedSystems = localSystems
      .filter(
        (system) =>
          system.dashboardGroupId === null ||
          !knownGroupIds.has(system.dashboardGroupId),
      )
      .sort(compareSystems);
    if (localGroups.length > 0 || editMode || groupBadgesEnabled) {
      result.push({
        key: UNGROUPED_KEY,
        groupId: null,
        name: t("pages.dashboard.ungrouped"),
        sortOrder: localUngroupedSortOrder,
        updatePriority: localUngroupedUpdatePriority,
        group: undefined,
        systems: ungroupedSystems,
      });
    }
    return result.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [
    editMode,
    groupBadgesEnabled,
    localGroups,
    localSystems,
    localUngroupedSortOrder,
    localUngroupedUpdatePriority,
    t,
  ]);
  const displayedSections = editMode
    ? sections
    : sections.filter((section) => section.systems.length > 0);
  const persistCollapsedGroups = (next: Set<string>) => {
    setCollapsedGroups(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        COLLAPSED_GROUPS_STORAGE_KEY,
        JSON.stringify([...next]),
      );
    }
  };

  const toggleCollapsed = (key: string) => {
    if (editMode) return;
    const next = new Set(collapsedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persistCollapsedGroups(next);
  };

  const toggleGroupBadges = () => {
    const next = !groupBadgesEnabled;
    setGroupBadgesEnabled(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(GROUP_BADGES_STORAGE_KEY, String(next));
      } catch {
        // The preference still applies for this session when storage is unavailable.
      }
    }
  };

  const beginDrag = (event: DragEvent, item: DragItem) => {
    if (!editMode || busy) return;
    setDragItem(item);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", `${item.kind}:${item.id}`);
  };

  const finishDrag = () => setDragItem(null);

  const reorderGroups = async (targetGroupKey: string) => {
    if (
      busy ||
      !dragItem ||
      dragItem.kind !== "group" ||
      dragItem.id === targetGroupKey
    )
      return;
    const previous = sections;
    const next = [...previous];
    const sourceIndex = next.findIndex((section) => section.key === dragItem.id);
    const targetIndex = next.findIndex((section) => section.key === targetGroupKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    const nextGroupKeys = next.map((section) => section.key);
    setLocalGroups(
      next.flatMap((section, sortOrder) =>
        section.group ? [{ ...section.group, sortOrder }] : [],
      ),
    );
    const nextUngroupedSortOrder = next.findIndex((section) => section.groupId === null);
    setLocalUngroupedSortOrder(nextUngroupedSortOrder);
    try {
      await saveGroupOrder(
        nextGroupKeys.map((key) => (key === UNGROUPED_KEY ? UNGROUPED_KEY : Number(key))),
      );
    } catch (error) {
      setLocalGroups(groups);
      setLocalUngroupedSortOrder(ungroupedSortOrder);
      onError(
        error instanceof Error
          ? error.message
          : t("pages.dashboard.failedToSaveGroupOrder"),
      );
    }
  };

  const moveSystem = async (
    targetGroupId: number | null,
    targetSystemId: number | null,
    event: DragEvent,
  ) => {
    if (busy || !dragItem || dragItem.kind !== "system") return;
    const sourceSystem = localSystems.find(
      (system) => system.id === dragItem.id,
    );
    if (!sourceSystem || sourceSystem.id === targetSystemId) return;

    const sectionByKey = new Map(
      sections.map((section) => [
        groupKey(section.groupId),
        [...section.systems],
      ]),
    );
    const sourceKey = groupKey(
      sourceSystem.dashboardGroupId !== null &&
        localGroups.some((group) => group.id === sourceSystem.dashboardGroupId)
        ? sourceSystem.dashboardGroupId
        : null,
    );
    const sourceSystems = sectionByKey.get(sourceKey);
    const targetKey = groupKey(targetGroupId);
    const targetSystems = sectionByKey.get(targetKey);
    if (!sourceSystems || !targetSystems) return;

    const sourceIndex = sourceSystems.findIndex(
      (system) => system.id === sourceSystem.id,
    );
    if (sourceIndex >= 0) sourceSystems.splice(sourceIndex, 1);
    const existingTargetIndex = targetSystems.findIndex(
      (system) => system.id === sourceSystem.id,
    );
    if (existingTargetIndex >= 0) targetSystems.splice(existingTargetIndex, 1);

    let insertIndex = targetSystems.length;
    if (targetSystemId !== null) {
      const targetIndex = targetSystems.findIndex(
        (system) => system.id === targetSystemId,
      );
      if (targetIndex >= 0) {
        const targetElement = event.currentTarget as HTMLElement;
        const rect = targetElement.getBoundingClientRect();
        insertIndex =
          event.clientY > rect.top + rect.height / 2
            ? targetIndex + 1
            : targetIndex;
      }
    }
    targetSystems.splice(
      Math.min(insertIndex, targetSystems.length),
      0,
      sourceSystem,
    );

    const orderedSections = sections.map((section) => ({
      groupId: section.groupId,
      systems: sectionByKey.get(groupKey(section.groupId)) ?? [],
    }));
    const previous = cloneSystems(localSystems);
    const next = applySystemOrder(localSystems, orderedSections);
    const items = orderedSections.flatMap((section) =>
      section.systems.map((system, index) => ({
        systemId: system.id,
        groupId: section.groupId,
        dashboardOrder: index + 1,
      })),
    );
    setLocalSystems(next);
    try {
      await saveSystemPlacements(items);
    } catch (error) {
      setLocalSystems(previous);
      onError(
        error instanceof Error
          ? error.message
          : t("pages.dashboard.failedToSaveSystemGroups"),
      );
    }
  };

  const sortSystemsByName = async (section: DashboardSection) => {
    if (busy || section.systems.length < 2) return;
    const sortedSystems = [...section.systems].sort(compareSystemsByName);
    const items = sortedSystems.map((system, index) => ({
      systemId: system.id,
      groupId: section.groupId,
      dashboardOrder: index + 1,
    }));
    const previous = cloneSystems(localSystems);
    setLocalSystems(
      applySystemOrder(localSystems, [
        { groupId: section.groupId, systems: sortedSystems },
      ]),
    );
    try {
      await saveSystemPlacements(items);
    } catch (error) {
      setLocalSystems(previous);
      onError(
        error instanceof Error
          ? error.message
          : t("pages.dashboard.failedToSaveSystemGroups"),
      );
    }
  };

  const setLocalUpdatePriority = (
    groupId: number | null,
    updatePriority: number,
  ) => {
    if (groupId === null) {
      setLocalUngroupedUpdatePriority(updatePriority);
      return;
    }
    setLocalGroups((current) =>
      current.map((group) =>
        group.id === groupId ? { ...group, updatePriority } : group,
      ),
    );
  };

  const persistUpdatePriority = async (
    section: DashboardSection,
    updatePriority: number,
  ) => {
    if (
      busy ||
      !Number.isSafeInteger(updatePriority) ||
      updatePriority < 1 ||
      updatePriority > 99
    ) return;
    const previousPriority = section.groupId === null
      ? ungroupedUpdatePriority
      : groups.find((group) => group.id === section.groupId)?.updatePriority;
    if (previousPriority === undefined || previousPriority === updatePriority) return;
    setLocalUpdatePriority(section.groupId, updatePriority);
    try {
      await saveGroupUpdatePriority(section.groupId, updatePriority);
    } catch (error) {
      setLocalUpdatePriority(section.groupId, previousPriority);
      onError(
        error instanceof Error
          ? error.message
          : t("pages.dashboard.failedToSaveUpdatePriority"),
      );
    }
  };

  const setLocalSystemUpdatePriority = (
    systemId: number,
    updatePriority: number,
  ) => {
    setLocalSystems((current) =>
      current.map((system) =>
        system.id === systemId ? { ...system, updatePriority } : system,
      ),
    );
  };

  const persistSystemUpdatePriority = async (
    system: System,
    updatePriority: number,
  ) => {
    if (
      busy ||
      !Number.isSafeInteger(updatePriority) ||
      updatePriority < 1 ||
      updatePriority > 99
    ) return;
    const previousPriority =
      systems.find((candidate) => candidate.id === system.id)?.updatePriority ?? 1;
    if (previousPriority === updatePriority) return;
    setLocalSystemUpdatePriority(system.id, updatePriority);
    try {
      await saveSystemUpdatePriority(system.id, updatePriority);
    } catch (error) {
      setLocalSystemUpdatePriority(system.id, previousPriority);
      onError(
        error instanceof Error
          ? error.message
          : t("pages.dashboard.failedToSaveUpdatePriority"),
      );
    }
  };

  const renderUpdatePriorityControl = (section: DashboardSection) => (
    <div
      className="inline-flex h-7 items-center overflow-hidden rounded-md border border-border bg-white dark:bg-slate-900"
      title={t("pages.dashboard.upgradePriorityHelp")}
      aria-label={t("pages.dashboard.updatePriorityForName", {
        name: section.name,
      })}
    >
      <span className="px-1.5 text-[10px] font-medium text-slate-500 dark:text-slate-400">
        {t("pages.dashboard.updatePriority")}
      </span>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void persistUpdatePriority(section, section.updatePriority - 1)}
        disabled={busy || section.updatePriority <= 1}
        className="h-full border-l border-border px-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label={t("pages.dashboard.decreaseUpdatePriorityForName", {
          name: section.name,
        })}
      >
        -
      </button>
      <input
        type="number"
        min="1"
        max="99"
        step="1"
        value={section.updatePriority}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isSafeInteger(next) && next >= 1 && next <= 99) {
            setLocalUpdatePriority(section.groupId, next);
          }
        }}
        onBlur={() => void persistUpdatePriority(section, section.updatePriority)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        disabled={busy}
        className="h-full w-8 border-l border-border bg-transparent px-0.5 text-center text-[11px] font-semibold text-slate-700 outline-none focus:bg-blue-50 dark:text-slate-100 dark:focus:bg-blue-950/30 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        aria-label={t("pages.dashboard.updatePriorityForName", {
          name: section.name,
        })}
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void persistUpdatePriority(section, section.updatePriority + 1)}
        disabled={busy || section.updatePriority >= 99}
        className="h-full border-l border-border px-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
        aria-label={t("pages.dashboard.increaseUpdatePriorityForName", {
          name: section.name,
        })}
      >
        +
      </button>
    </div>
  );

  const renderSystemUpdatePriorityControl = (system: System) => {
    const updatePriority = system.updatePriority ?? 1;
    return (
      <div
        data-dashboard-system-upgrade-priority
        draggable={false}
        className="ml-auto inline-flex h-7 shrink-0 items-center overflow-hidden rounded-md border border-border bg-white dark:bg-slate-900"
        title={t("pages.dashboard.systemUpgradePriorityHelp")}
        aria-label={t("pages.dashboard.updatePriorityForName", {
          name: system.name,
        })}
      >
        <span className="px-1.5 text-[10px] font-medium text-slate-500 dark:text-slate-400">
          {t("pages.dashboard.updatePriority")}
        </span>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void persistSystemUpdatePriority(system, updatePriority - 1)}
          disabled={busy || updatePriority <= 1}
          className="h-full border-l border-border px-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label={t("pages.dashboard.decreaseUpdatePriorityForName", {
            name: system.name,
          })}
        >
          -
        </button>
        <input
          type="number"
          min="1"
          max="99"
          step="1"
          value={updatePriority}
          onChange={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isSafeInteger(next) && next >= 1 && next <= 99) {
              setLocalSystemUpdatePriority(system.id, next);
            }
          }}
          onBlur={() => void persistSystemUpdatePriority(system, updatePriority)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          disabled={busy}
          className="h-full w-8 border-l border-border bg-transparent px-0.5 text-center text-[11px] font-semibold text-slate-700 outline-none focus:bg-blue-50 dark:text-slate-100 dark:focus:bg-blue-950/30 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          aria-label={t("pages.dashboard.updatePriorityForName", {
            name: system.name,
          })}
        />
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void persistSystemUpdatePriority(system, updatePriority + 1)}
          disabled={busy || updatePriority >= 99}
          className="h-full border-l border-border px-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
          aria-label={t("pages.dashboard.increaseUpdatePriorityForName", {
            name: system.name,
          })}
        >
          +
        </button>
      </div>
    );
  };

  const handleDrop = (
    event: DragEvent,
    targetGroupId: number | null,
    targetGroupKey: string,
    targetSystemId: number | null = null,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (busy || !dragItem) return;
    if (dragItem.kind === "group") {
      void reorderGroups(targetGroupKey);
    } else if (dragItem.kind === "system") {
      void moveSystem(targetGroupId, targetSystemId, event);
    }
    finishDrag();
  };

  const renderSection = (section: DashboardSection) => {
    const isCollapsed = !editMode && collapsedGroups.has(section.key);
    const statusBadges = getGroupStatusBadges(section.systems, t);
    return (
      <section
        key={section.key}
        data-dashboard-group-key={section.key}
        className="rounded-xl border border-border bg-slate-50/50 p-3 dark:bg-slate-800/40"
        onDragOver={(event) => editMode && !busy && event.preventDefault()}
        onDrop={(event) =>
          editMode && !busy && handleDrop(event, section.groupId, section.key)
        }
      >
        <div
          className={`mb-3 flex items-start gap-2 ${
            editMode
              ? "flex-col sm:flex-row sm:justify-between"
              : "justify-between"
          }`}
        >
          <div
            className={`flex min-w-0 flex-wrap items-center gap-2 ${
              editMode ? "w-full sm:w-auto" : ""
            }`}
          >
            {editMode && (
              <span
                draggable
                onDragStart={(event) =>
                  beginDrag(event, { kind: "group", id: section.key })
                }
                onDragEnd={finishDrag}
                className="cursor-grab rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                title={t("pages.dashboard.dragToReorderGroup")}
                aria-label={t("pages.dashboard.dragToReorderGroup")}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01"
                  />
                </svg>
              </span>
            )}
            <button
              type="button"
              onClick={() => toggleCollapsed(section.key)}
              disabled={editMode}
              aria-expanded={!isCollapsed}
              aria-controls={`dashboard-group-content-${section.key}`}
              className="flex min-w-0 items-center gap-2 text-left"
            >
              <svg
                className={`h-4 w-4 shrink-0 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="m6 9 6 6 6-6"
                />
              </svg>
              <h2 className="truncate text-sm font-semibold text-slate-700 dark:text-slate-100">
                {section.name}
              </h2>
              <Badge variant="muted" small>
                {section.systems.length}
              </Badge>
            </button>
            {groupBadgesEnabled && statusBadges.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1" aria-label={t("pages.dashboard.groupStatus")}>
                {statusBadges.map((badge) => (
                  <Badge key={badge.key} variant={badge.variant} small>
                    <span>{badge.label}</span>
                    <span className="ml-1 font-semibold">{badge.count}</span>
                  </Badge>
                ))}
              </div>
            )}
          </div>
          {editMode && (
            <div className="flex w-full items-center justify-end gap-1 sm:w-auto sm:shrink-0">
              <button
                type="button"
                onClick={() => void sortSystemsByName(section)}
                disabled={busy || section.systems.length < 2}
                className="rounded px-1.5 py-1 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700"
                title={t("pages.dashboard.sortSystemsByName")}
                aria-label={t("pages.dashboard.sortSystemsByName")}
              >
                <span className="text-[10px] font-bold leading-4" aria-hidden="true">
                  A–Z
                </span>
              </button>
              <button
                type="button"
                onClick={() => section.group && onRenameGroup(section.group)}
                disabled={busy || !section.group}
                className="rounded p-1.5 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-700"
                title={t("pages.dashboard.editGroupName")}
                aria-label={t("pages.dashboard.editGroupName")}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.4-9.4a2 2 0 1 0 2.8 2.8L11.8 15H9v-2.8l8.6-8.6Z"
                  />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => section.group && onDeleteGroup(section.group)}
                disabled={busy || !section.group}
                className="rounded p-1.5 text-red-500 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-900/20"
                title={t("pages.dashboard.deleteGroup")}
                aria-label={t("pages.dashboard.deleteGroup")}
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7 18.1 19.1A2 2 0 0 1 16.1 21H7.9a2 2 0 0 1-2-1.9L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"
                  />
                </svg>
              </button>
              {renderUpdatePriorityControl(section)}
            </div>
          )}
        </div>
        {!isCollapsed && (
          <div
            id={`dashboard-group-content-${section.key}`}
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {section.systems.map((system) => (
              <div
                key={system.id}
                data-dashboard-system-id={system.id}
                draggable={editMode && !busy}
                onDragStart={(event) => {
                  if (
                    (event.target as HTMLElement).closest(
                      "[data-dashboard-system-upgrade-priority]",
                    )
                  ) {
                    event.preventDefault();
                    return;
                  }
                  if (!editMode || busy) {
                    event.preventDefault();
                    return;
                  }
                  beginDrag(event, { kind: "system", id: system.id });
                }}
                onDragEnd={finishDrag}
                onDragOver={(event) =>
                  editMode && !busy && event.preventDefault()
                }
                onDrop={(event) =>
                  editMode &&
                  !busy &&
                  handleDrop(event, section.groupId, section.key, system.id)
                }
                className={
                  editMode
                    ? "cursor-grab rounded-xl bg-slate-100 p-1.5 ring-1 ring-dashed ring-slate-400 dark:bg-slate-900/40 dark:ring-slate-500"
                    : undefined
                }
                title={editMode ? t("pages.dashboard.dragToReorderSystem") : undefined}
              >
                {editMode && (
                  <div className="flex flex-wrap items-center justify-between gap-1.5 pb-1.5">
                    <div
                      data-dashboard-system-drag-handle
                      className="flex min-w-0 flex-1 items-center justify-center gap-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300"
                      title={t("pages.dashboard.dragToReorderSystem")}
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01"
                        />
                      </svg>
                      <span>{t("pages.dashboard.dragToReorderSystem")}</span>
                    </div>
                    {renderSystemUpdatePriorityControl(system)}
                  </div>
                )}
                {renderSystem(system)}
              </div>
            ))}
          </div>
        )}
      </section>
    );
  };

  const flatMode =
    localGroups.length === 0 && !editMode && !groupBadgesEnabled;

  return (
    <div>
      <div
        data-dashboard-edit-toolbar
        className={`mb-3 flex flex-wrap items-center gap-2 transition-colors ${
          editMode
            ? "justify-between rounded-xl border border-blue-200 bg-blue-50/70 p-2.5 shadow-sm dark:border-blue-800/70 dark:bg-blue-950/25"
            : "justify-end"
        }`}
      >
        {editMode && (
          <div className="flex min-w-0 items-center gap-2.5 px-1">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300"
              aria-hidden="true"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 4H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4m-1.5-7.5a2.12 2.12 0 0 1 3 3L12 18l-4 1 1-4 9.5-9.5Z"
                />
              </svg>
            </span>
            <span className="truncate text-sm font-semibold text-blue-950 dark:text-blue-100">
              {t("pages.dashboard.editMode")}
            </span>
          </div>
        )}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {editMode && (
            <button
              type="button"
              role="switch"
              aria-checked={groupBadgesEnabled}
              onClick={toggleGroupBadges}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-blue-200 bg-white/80 px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-white dark:border-blue-800 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:bg-slate-900"
            >
              <span
                className={`relative h-4 w-7 rounded-full transition-colors ${groupBadgesEnabled ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-600"}`}
                aria-hidden="true"
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${groupBadgesEnabled ? "translate-x-3" : ""}`}
                />
              </span>
              {t("pages.dashboard.groupBadges")}
            </button>
          )}
          {editMode && (
            <button
              type="button"
              onClick={onCreateGroup}
              disabled={busy}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-blue-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <svg
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m-7-7h14" />
              </svg>
              {t("pages.dashboard.addGroup")}
            </button>
          )}
          <button
            type="button"
            aria-pressed={editMode}
            onClick={onToggleEditMode}
            disabled={busy}
            className={`inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              editMode
                ? "h-9 bg-blue-600 px-3 text-xs text-white shadow-sm hover:bg-blue-700"
                : "h-8 px-2 text-[11px] text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
            }`}
          >
            <svg
              className={editMode ? "h-4 w-4" : "h-3.5 w-3.5"}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d={editMode ? "m5 12 4 4L19 6" : "M11 4H7a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4m-1.5-7.5a2.12 2.12 0 0 1 3 3L12 18l-4 1 1-4 9.5-9.5Z"}
              />
            </svg>
            {editMode ? t("pages.dashboard.done") : t("pages.dashboard.editMode")}
          </button>
        </div>
      </div>
      {flatMode ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[...localSystems].sort(compareSystems).map((system) => (
            <div key={system.id} onDragStart={(event) => event.preventDefault()}>
              {renderSystem(system)}
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">{displayedSections.map(renderSection)}</div>
      )}
    </div>
  );
}
