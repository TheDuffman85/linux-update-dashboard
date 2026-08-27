import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const {
  mockUseDashboardStats,
  mockUseDashboardSystems,
  mockUseRefreshCache,
  mockUseUpgradeAllBatch,
  mockUseDashboardGroups,
  mockUseCreateDashboardGroup,
  mockUseUpdateDashboardGroup,
  mockUseUpdateDashboardGroupPriority,
  mockUseUpdateSystemPriority,
  mockUseDeleteDashboardGroup,
  mockUseReorderDashboardGroups,
  mockUseUpdateSystemDashboardGroups,
  mockUseUpdateSystemUpgradeAllExclusion,
  mockUseUpdateSystemUpgradeMode,
  mockUseToast,
  mockUseUpgrade,
} = vi.hoisted(() => ({
  mockUseDashboardStats: vi.fn(),
  mockUseDashboardSystems: vi.fn(),
  mockUseRefreshCache: vi.fn(),
  mockUseUpgradeAllBatch: vi.fn(),
  mockUseDashboardGroups: vi.fn(),
  mockUseCreateDashboardGroup: vi.fn(),
  mockUseUpdateDashboardGroup: vi.fn(),
  mockUseUpdateDashboardGroupPriority: vi.fn(),
  mockUseUpdateSystemPriority: vi.fn(),
  mockUseDeleteDashboardGroup: vi.fn(),
  mockUseReorderDashboardGroups: vi.fn(),
  mockUseUpdateSystemDashboardGroups: vi.fn(),
  mockUseUpdateSystemUpgradeAllExclusion: vi.fn(),
  mockUseUpdateSystemUpgradeMode: vi.fn(),
  mockUseToast: vi.fn(),
  mockUseUpgrade: vi.fn(),
}));

vi.mock("../../client/lib/dashboard", () => ({
  useDashboardStats: mockUseDashboardStats,
  useDashboardSystems: mockUseDashboardSystems,
}));

vi.mock("../../client/lib/updates", () => ({
  useRefreshCache: mockUseRefreshCache,
  useUpgradeAllBatch: mockUseUpgradeAllBatch,
}));

vi.mock("../../client/lib/systems", () => ({
  useDashboardGroups: mockUseDashboardGroups,
  useCreateDashboardGroup: mockUseCreateDashboardGroup,
  useUpdateDashboardGroup: mockUseUpdateDashboardGroup,
  useUpdateDashboardGroupPriority: mockUseUpdateDashboardGroupPriority,
  useUpdateSystemPriority: mockUseUpdateSystemPriority,
  useDeleteDashboardGroup: mockUseDeleteDashboardGroup,
  useReorderDashboardGroups: mockUseReorderDashboardGroups,
  useUpdateSystemDashboardGroups: mockUseUpdateSystemDashboardGroups,
  useUpdateSystemUpgradeAllExclusion: mockUseUpdateSystemUpgradeAllExclusion,
  useUpdateSystemUpgradeMode: mockUseUpdateSystemUpgradeMode,
}));

vi.mock("../../client/context/ToastContext", () => ({
  useToast: mockUseToast,
}));

vi.mock("../../client/context/UpgradeContext", () => ({
  useUpgrade: mockUseUpgrade,
}));

vi.mock("../../client/components/Layout", () => ({
  Layout: ({
    title,
    actions,
    children,
  }: {
    title: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <div>{title}</div>
      <div>{actions}</div>
      <main>{children}</main>
    </div>
  ),
}));

import Dashboard, {
  canToggleUpgradePreset,
  compareUpgradeModalGroups,
  compareUpgradeModalSystems,
  getDashboardUpgradeToast,
  isPreselectedForUpgradeAll,
  isUpgradeAllSubmitDisabled,
  isUpgradePresetSelected,
  UpgradeModalGroupHeading,
} from "../../client/pages/Dashboard";
import {
  compareSystemsByName,
  DashboardSystemGroups,
} from "../../client/components/dashboard/DashboardSystemGroups";
import type { System } from "../../client/lib/systems";

function getOpeningButtonTag(html: string, text: string): string {
  const textIndex = html.indexOf(text);
  expect(textIndex).toBeGreaterThan(-1);
  const buttonIndex = html.lastIndexOf("<button", textIndex);
  expect(buttonIndex).toBeGreaterThan(-1);
  const buttonEnd = html.indexOf(">", buttonIndex);
  expect(buttonEnd).toBeGreaterThan(-1);
  return html.slice(buttonIndex, buttonEnd + 1);
}

function hasDisabledAttribute(tag: string): boolean {
  return /\sdisabled(?:=|\s|>)/.test(tag);
}

describe("Dashboard", () => {
  beforeEach(() => {
    mockUseDashboardStats.mockReturnValue({
      data: {
        total: 1,
        upToDate: 0,
        needsUpdates: 1,
        unreachable: 0,
        checkIssues: 0,
        totalUpdates: 7,
        needsReboot: 0,
        lifecycleWarnings: 0,
      },
    });
    mockUseDashboardSystems.mockReturnValue({
      data: [
        {
          id: 1,
          name: "Alpha",
          hostname: "alpha.local",
          port: 22,
          osName: "Debian",
          isReachable: 1,
          updateCount: 7,
          securityCount: 2,
          keptBackCount: 0,
          cacheAge: null,
          cacheTimestamp: null,
          isStale: false,
          lastCheck: null,
          activeOperation: null,
          excludeFromUpgradeAll: 0,
          dashboardGroupId: null,
          dashboardOrder: 1,
          pkgManager: "apt",
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: null,
          supportsFullUpgrade: true,
        },
      ],
      dataUpdatedAt: Date.now(),
    });
    mockUseRefreshCache.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpgradeAllBatch.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    });
    mockUseDashboardGroups.mockReturnValue({
      data: {
        groups: [],
        ungroupedSortOrder: 1_000_000,
        ungroupedUpdatePriority: 99,
      },
    });
    mockUseCreateDashboardGroup.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseUpdateDashboardGroup.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseUpdateDashboardGroupPriority.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseUpdateSystemPriority.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseDeleteDashboardGroup.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseReorderDashboardGroups.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseUpdateSystemDashboardGroups.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseUpdateSystemUpgradeAllExclusion.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mockUseUpdateSystemUpgradeMode.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      variables: undefined,
    });
    mockUseToast.mockReturnValue({ addToast: vi.fn() });
    mockUseUpgrade.mockReturnValue({
      upgradeAll: vi.fn(),
      isUpgrading: () => false,
      removeUpgrading: vi.fn(),
      upgradingSystems: new Map(),
      upgradingCount: 0,
    });
  });

  test("does not show the total update count on the Upgrade All dashboard button", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("Upgrade All");
    expect(html).not.toContain("Upgrade All (7)");
  });

  test("keeps the Upgrade All launcher available when no systems currently qualify", () => {
    const current = mockUseDashboardSystems();
    mockUseDashboardSystems.mockReturnValue({
      ...current,
      data: current.data.map((system: System) => ({
        ...system,
        updateCount: 0,
      })),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrade All"))).toBe(
      false,
    );
  });

  test("renders the dashboard summary cards", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("Total Systems");
    expect(html).toContain("Total Updates");
    expect(html).toContain("Need Updates");
  });

  test("shows OS warnings as amber and labels Debian LTS warnings without dates", () => {
    mockUseDashboardStats.mockReturnValue({
      data: {
        total: 1,
        upToDate: 0,
        needsUpdates: 0,
        unreachable: 0,
        checkIssues: 0,
        totalUpdates: 0,
        needsReboot: 0,
        lifecycleWarnings: 1,
      },
    });
    mockUseDashboardSystems.mockReturnValue({
      data: [
        {
          id: 1,
          name: "Alpha",
          hostname: "alpha.local",
          port: 22,
          osName: "Debian",
          isReachable: 1,
          updateCount: 0,
          securityCount: 0,
          keptBackCount: 0,
          osLifecycleStatus: "support_ended",
          osLifecycleEolDate: "2028-06-30",
          osLifecycleDaysUntilEol: 744,
          osLifecycleDaysUntilSupportEnd: -6,
          osLifecycleLabel: "Debian 12 is in LTS until 2028-06-30",
          cacheAge: null,
          cacheTimestamp: null,
          isStale: false,
          lastCheck: null,
          activeOperation: null,
          excludeFromUpgradeAll: 0,
          dashboardGroupId: null,
          dashboardOrder: 1,
          pkgManager: "apt",
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: null,
          supportsFullUpgrade: true,
        },
      ],
      dataUpdatedAt: Date.now(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("bg-amber-100");
    expect(html).toContain("LTS");
    expect(html).not.toContain("In LTS");
    expect(html).not.toContain("LTS until 2028-06-30");
    expect(html).toContain("w-3 h-3 rounded-full shrink-0 bg-green-500");
    expect(html).not.toContain("Support ended");
  });

  test("uses a short lifecycle badge without remaining days for upcoming support end", () => {
    mockUseDashboardSystems.mockReturnValue({
      data: [
        {
          id: 1,
          name: "Alpha",
          hostname: "alpha.local",
          port: 22,
          osName: "Debian",
          isReachable: 1,
          updateCount: 0,
          securityCount: 0,
          keptBackCount: 0,
          osLifecycleStatus: "support_ending",
          osLifecycleEolDate: "2030-06-30",
          osLifecycleDaysUntilEol: 1491,
          osLifecycleDaysUntilSupportEnd: 23,
          osLifecycleLabel:
            "Debian 13 security support ends in 23 days; LTS until 2030-06-30",
          cacheAge: null,
          cacheTimestamp: null,
          isStale: false,
          lastCheck: null,
          activeOperation: null,
          excludeFromUpgradeAll: 0,
          dashboardGroupId: null,
          dashboardOrder: 1,
          pkgManager: "apt",
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: null,
          supportsFullUpgrade: true,
        },
      ],
      dataUpdatedAt: Date.now(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("Security support ending soon");
    expect(html).not.toContain("23d");
  });

  test("keeps the Upgrade All launcher available when the only updated system is busy", () => {
    mockUseDashboardSystems.mockReturnValue({
      data: [
        {
          id: 1,
          name: "Alpha",
          hostname: "alpha.local",
          port: 22,
          osName: "Debian",
          isReachable: 1,
          updateCount: 7,
          securityCount: 2,
          keptBackCount: 0,
          cacheAge: null,
          cacheTimestamp: null,
          isStale: false,
          lastCheck: null,
          activeOperation: {
            type: "upgrade_all",
            startedAt: "2026-05-18 10:00:00",
          },
          excludeFromUpgradeAll: 0,
          dashboardGroupId: null,
          dashboardOrder: 1,
          pkgManager: "apt",
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: null,
          supportsFullUpgrade: true,
        },
      ],
      dataUpdatedAt: Date.now(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Refresh All<\/button>/);
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrade All"))).toBe(
      false,
    );
  });

  test("keeps Upgrade All available for idle systems while another system is busy", () => {
    const baseSystem = {
      hostname: "system.local",
      port: 22,
      osName: "Debian",
      isReachable: 1,
      updateCount: 7,
      securityCount: 0,
      keptBackCount: 0,
      cacheAge: null,
      cacheTimestamp: null,
      isStale: false,
      lastCheck: null,
      excludeFromUpgradeAll: 0,
      dashboardGroupId: null,
      pkgManager: "apt",
      detectedPkgManagers: ["apt"],
      disabledPkgManagers: [],
      pkgManagerConfigs: null,
      supportsFullUpgrade: true,
    };
    mockUseDashboardSystems.mockReturnValue({
      data: [
        {
          ...baseSystem,
          id: 1,
          name: "Busy",
          dashboardOrder: 1,
          activeOperation: {
            type: "check",
            startedAt: "2026-05-18 10:00:00",
          },
        },
        {
          ...baseSystem,
          id: 2,
          name: "Idle",
          dashboardOrder: 2,
          activeOperation: null,
        },
      ],
      dataUpdatedAt: Date.now(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrade All"))).toBe(
      false,
    );
  });

  test("does not show the dashboard upgrade action as upgrading during refresh", () => {
    mockUseRefreshCache.mockReturnValue({ mutate: vi.fn(), isPending: true });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("Refreshing...");
    expect(
      hasDisabledAttribute(getOpeningButtonTag(html, "Refreshing...")),
    ).toBe(true);
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrade All"))).toBe(
      false,
    );
    expect(html).not.toContain("Upgrading...");
  });

  test("does not show the dashboard upgrade action as upgrading during active system checks", () => {
    mockUseDashboardSystems.mockReturnValue({
      data: [
        {
          id: 1,
          name: "Alpha",
          hostname: "alpha.local",
          port: 22,
          osName: "Debian",
          isReachable: 1,
          updateCount: 7,
          securityCount: 2,
          keptBackCount: 0,
          cacheAge: null,
          cacheTimestamp: null,
          isStale: false,
          lastCheck: null,
          activeOperation: {
            type: "check",
            startedAt: "2026-05-18 10:00:00",
          },
          excludeFromUpgradeAll: 0,
          dashboardGroupId: null,
          dashboardOrder: 1,
          pkgManager: "apt",
          detectedPkgManagers: ["apt"],
          disabledPkgManagers: [],
          pkgManagerConfigs: null,
          supportsFullUpgrade: true,
        },
      ],
      dataUpdatedAt: Date.now(),
    });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("Refreshing...");
    expect(
      hasDisabledAttribute(getOpeningButtonTag(html, "Refreshing...")),
    ).toBe(true);
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrade All"))).toBe(
      false,
    );
    expect(html).not.toContain("Upgrading...");
  });

  test("disables the modal Upgrade All submit without a selection or during submission", () => {
    expect(isUpgradeAllSubmitDisabled(1, true)).toBe(true);
    expect(isUpgradeAllSubmitDisabled(1, false)).toBe(false);
    expect(isUpgradeAllSubmitDisabled(0, false)).toBe(true);
  });

  test("treats recovered upgrade warnings as informational dashboard toasts", () => {
    expect(getDashboardUpgradeToast("Alpha", "warning")).toEqual({
      message: "Alpha: Upgrade state resynced after backend restart",
      type: "info",
    });
  });

  test("only allows Upgrade All presets for systems with current updates", () => {
    const systemWithoutUpdates = { id: 1, updateCount: 0 };
    const systemWithUpdates = { id: 2, updateCount: 1 };

    expect(isUpgradePresetSelected(systemWithoutUpdates, [1])).toBe(true);
    expect(canToggleUpgradePreset(systemWithoutUpdates)).toBe(false);
    expect(canToggleUpgradePreset(systemWithUpdates)).toBe(true);
  });

  test("derives the Upgrade All initial selection from the saved preselection", () => {
    expect(isPreselectedForUpgradeAll({ excludeFromUpgradeAll: 0 })).toBe(true);
    expect(isPreselectedForUpgradeAll({ excludeFromUpgradeAll: 1 })).toBe(false);
  });

  test("shows the group upgrade priority in the Upgrade All modal heading", () => {
    const html = renderToStaticMarkup(
      <UpgradeModalGroupHeading
        name="Production"
        systemCount={3}
        updatePriority={4}
      />,
    );

    expect(html).toContain("Production");
    expect(html).toContain("Priority: 4");
    expect(html).toContain('class="ml-auto mr-3"');
    expect(html).toContain("bg-slate-100");
    expect(html).toContain(
      'title="Lower numbers upgrade first. Groups with the same priority upgrade in parallel."',
    );
  });

  test("orders Upgrade All groups by priority and then dashboard position", () => {
    const dashboardOrder = new Map([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
    const groups = [
      { id: 1, name: "First on dashboard", updatePriority: 3 },
      { id: 2, name: "Second on dashboard", updatePriority: 1 },
      { id: 3, name: "Third on dashboard", updatePriority: 1 },
      { id: null, name: "Ungrouped", updatePriority: 2 },
    ];

    expect(
      groups
        .sort((a, b) => compareUpgradeModalGroups(a, b, dashboardOrder, 3))
        .map((group) => group.name),
    ).toEqual([
      "Second on dashboard",
      "Third on dashboard",
      "Ungrouped",
      "First on dashboard",
    ]);
  });

  test("orders systems by priority within an Upgrade All group", () => {
    const systems = [
      {
        id: 1,
        name: "First on dashboard",
        dashboardOrder: 1,
        updatePriority: 3,
      },
      {
        id: 2,
        name: "Second on dashboard",
        dashboardOrder: 2,
        updatePriority: 1,
      },
      {
        id: 3,
        name: "Third on dashboard",
        dashboardOrder: 3,
        updatePriority: 1,
      },
    ] as System[];

    expect(
      systems.sort(compareUpgradeModalSystems).map((system) => system.name),
    ).toEqual([
      "Second on dashboard",
      "Third on dashboard",
      "First on dashboard",
    ]);
  });

  test("renders dashboard groups in saved order and keeps Ungrouped last", () => {
    const systems = [
      {
        id: 1,
        name: "Alpha",
        dashboardGroupId: 2,
        dashboardOrder: 2,
        sortOrder: 1,
      },
      {
        id: 2,
        name: "Bravo",
        dashboardGroupId: null,
        dashboardOrder: 1,
        sortOrder: 2,
      },
      {
        id: 3,
        name: "Charlie",
        dashboardGroupId: 2,
        dashboardOrder: 1,
        sortOrder: 3,
      },
    ] as System[];
    const html = renderToStaticMarkup(
      <DashboardSystemGroups
        systems={systems}
        groups={[
          {
            id: 2,
            name: "Production",
            sortOrder: 0,
            updatePriority: 4,
            createdAt: "",
            updatedAt: "",
          },
          {
            id: 1,
            name: "Empty",
            sortOrder: 1,
            updatePriority: 8,
            createdAt: "",
            updatedAt: "",
          },
        ]}
        ungroupedSortOrder={2}
        ungroupedUpdatePriority={7}
        editMode={false}
        onToggleEditMode={vi.fn()}
        onCreateGroup={vi.fn()}
        onRenameGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        saveGroupOrder={vi.fn().mockResolvedValue(undefined)}
        saveGroupUpdatePriority={vi.fn().mockResolvedValue(undefined)}
        saveSystemPlacements={vi.fn().mockResolvedValue(undefined)}
        onError={vi.fn()}
        renderSystem={(system) => <span>{system.name}</span>}
      />,
    );

    expect(html.indexOf("Production")).toBeLessThan(html.indexOf("Bravo"));
    expect(html).toContain("Charlie");
    expect(html).toContain("Alpha");
    expect(html).toContain("Ungrouped");
    expect(html).not.toContain("Empty");
    expect(html.indexOf("Charlie")).toBeLessThan(html.indexOf("Alpha"));
    expect(html).not.toContain("Priority: 4");
    expect(html).not.toContain("Priority: 7");
    expect(html).not.toContain("Priority: 8");
    expect(html).not.toContain("data-dashboard-upgrade-priority");
  });

  test("renders Ungrouped in its saved middle position", () => {
    const systems = [
      {
        id: 1,
        name: "Alpha",
        dashboardGroupId: 2,
        dashboardOrder: 1,
        sortOrder: 1,
      },
      {
        id: 2,
        name: "Bravo",
        dashboardGroupId: null,
        dashboardOrder: 1,
        sortOrder: 2,
      },
      {
        id: 3,
        name: "Charlie",
        dashboardGroupId: 3,
        dashboardOrder: 1,
        sortOrder: 3,
      },
    ] as System[];
    const html = renderToStaticMarkup(
      <DashboardSystemGroups
        systems={systems}
        groups={[
          {
            id: 2,
            name: "Production",
            sortOrder: 0,
            createdAt: "",
            updatedAt: "",
          },
          { id: 3, name: "Edge", sortOrder: 2, createdAt: "", updatedAt: "" },
        ]}
        ungroupedSortOrder={1}
        editMode={false}
        onToggleEditMode={vi.fn()}
        onCreateGroup={vi.fn()}
        onRenameGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        saveGroupOrder={vi.fn().mockResolvedValue(undefined)}
        saveSystemPlacements={vi.fn().mockResolvedValue(undefined)}
        onError={vi.fn()}
        renderSystem={(system) => <span>{system.name}</span>}
      />,
    );

    expect(html.indexOf("Production")).toBeLessThan(html.indexOf("Ungrouped"));
    expect(html.indexOf("Ungrouped")).toBeLessThan(html.indexOf("Edge"));
  });

  test("does not use the Systems page order to break dashboard order ties", () => {
    const html = renderToStaticMarkup(
      <DashboardSystemGroups
        systems={
          [
            {
              id: 1,
              name: "Zulu",
              dashboardGroupId: 1,
              dashboardOrder: 1,
              sortOrder: 0,
            },
            {
              id: 2,
              name: "Alpha",
              dashboardGroupId: 1,
              dashboardOrder: 1,
              sortOrder: 1,
            },
          ] as System[]
        }
        groups={[
          {
            id: 1,
            name: "Primary",
            sortOrder: 0,
            createdAt: "",
            updatedAt: "",
          },
        ]}
        ungroupedSortOrder={1}
        editMode={false}
        onToggleEditMode={vi.fn()}
        onCreateGroup={vi.fn()}
        onRenameGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        saveGroupOrder={vi.fn().mockResolvedValue(undefined)}
        saveSystemPlacements={vi.fn().mockResolvedValue(undefined)}
        onError={vi.fn()}
        renderSystem={(system) => <span>{system.name}</span>}
      />,
    );

    expect(html.indexOf("Alpha")).toBeLessThan(html.indexOf("Zulu"));
  });

  test("shows state badges for each group including a single visible group", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) =>
          key === "ludash.dashboard.group-badges" ? "true" : null,
        ),
        setItem: vi.fn(),
      },
    });
    try {
      const makeSystem = (
        id: number,
        name: string,
        overrides: Partial<System> = {},
      ) =>
        ({
          id,
          name,
          dashboardGroupId: 1,
          dashboardOrder: id,
          sortOrder: id,
          updateCount: 0,
          isReachable: 1,
          needsReboot: 0,
          lastCheck: null,
          osLifecycleStatus: "supported",
          ...overrides,
        }) as System;
      const systems = [
        makeSystem(1, "Up to date"),
        makeSystem(2, "Needs updates", { updateCount: 3 }),
        makeSystem(3, "Needs reboot", { needsReboot: 1 }),
        makeSystem(4, "OS warning", { osLifecycleStatus: "support_ended" }),
        makeSystem(5, "Check issue", {
          lastCheck: {
            status: "failed",
            error: "failed",
            startedAt: "",
            completedAt: "",
          },
        }),
        makeSystem(6, "Unreachable", { isReachable: -1 }),
        makeSystem(7, "Second group", { dashboardGroupId: 2 }),
      ];
      const renderGroups = (
        groups: Array<{ id: number; name: string; sortOrder: number }>,
        systemsToRender = systems,
      ) =>
        renderToStaticMarkup(
          <DashboardSystemGroups
            systems={systemsToRender}
            groups={groups.map((group) => ({
              ...group,
              createdAt: "",
              updatedAt: "",
            }))}
            ungroupedSortOrder={groups.length}
            editMode={false}
            onToggleEditMode={vi.fn()}
            onCreateGroup={vi.fn()}
            onRenameGroup={vi.fn()}
            onDeleteGroup={vi.fn()}
            saveGroupOrder={vi.fn().mockResolvedValue(undefined)}
            saveSystemPlacements={vi.fn().mockResolvedValue(undefined)}
            onError={vi.fn()}
            renderSystem={(system) => <span>{system.name}</span>}
          />,
        );

      const multipleGroupHtml = renderGroups([
        { id: 1, name: "Primary", sortOrder: 0 },
        { id: 2, name: "Secondary", sortOrder: 1 },
      ]);
      expect(multipleGroupHtml).toContain('aria-label="Group status"');
      expect(multipleGroupHtml).toContain("Up to date");
      expect(multipleGroupHtml).toContain("Need Updates");
      expect(multipleGroupHtml).toContain("Needs Reboot");
      expect(multipleGroupHtml).toContain("OS Warnings");
      expect(multipleGroupHtml).toContain("Check Issues");
      expect(multipleGroupHtml).toContain("Unreachable");

      const singleGroupHtml = renderGroups(
        [{ id: 1, name: "Primary", sortOrder: 0 }],
        systems.slice(0, 6),
      );
      expect(singleGroupHtml).toContain('aria-label="Group status"');
      expect(singleGroupHtml).toContain("Need Updates");

      const ungroupedOnlyHtml = renderGroups(
        [],
        systems.slice(0, 6).map((system) => ({
          ...system,
          dashboardGroupId: null,
        })),
      );
      expect(ungroupedOnlyHtml).toContain("Ungrouped");
      expect(ungroupedOnlyHtml).toContain('aria-label="Group status"');
      expect(ungroupedOnlyHtml).toContain("Need Updates");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("uses Edit mode and exposes system ordering and badge controls while editing", () => {
    const systems = [
      {
        id: 1,
        name: "Alpha",
        dashboardGroupId: 1,
        dashboardOrder: 1,
        updatePriority: 6,
        sortOrder: 1,
        updateCount: 1,
        excludeFromUpgradeAll: 0,
        isReachable: 1,
        needsReboot: 0,
        lastCheck: null,
        osLifecycleStatus: "supported",
      },
    ] as System[];
    const commonProps = {
      systems,
      groups: [
        {
          id: 1,
          name: "Primary",
          sortOrder: 0,
          updatePriority: 3,
          createdAt: "",
          updatedAt: "",
        },
      ],
      ungroupedSortOrder: 1,
      ungroupedUpdatePriority: 4,
      onToggleEditMode: vi.fn(),
      onCreateGroup: vi.fn(),
      onRenameGroup: vi.fn(),
      onDeleteGroup: vi.fn(),
      saveGroupOrder: vi.fn().mockResolvedValue(undefined),
      saveGroupUpdatePriority: vi.fn().mockResolvedValue(undefined),
      saveSystemUpdatePriority: vi.fn().mockResolvedValue(undefined),
      saveSystemUpgradeAllExclusion: vi.fn().mockResolvedValue(undefined),
      saveSystemPlacements: vi.fn().mockResolvedValue(undefined),
      onError: vi.fn(),
      renderSystem: (system: System) => <span>{system.name}</span>,
    };

    const viewHtml = renderToStaticMarkup(
      <DashboardSystemGroups {...commonProps} editMode={false} />,
    );
    expect(viewHtml).toContain("Edit mode");
    expect(viewHtml).toContain("data-dashboard-edit-toolbar");
    expect(viewHtml).toContain('aria-pressed="false"');
    expect(viewHtml).not.toContain(">Done</button>");
    expect(viewHtml).not.toContain("Edit groups");
    expect(viewHtml).not.toContain("Group badges");
    expect(viewHtml).not.toContain("Sort systems by name");
    expect(viewHtml).not.toContain("Priority: 3");
    expect(viewHtml).not.toContain("data-dashboard-system-upgrade-priority");
    expect(viewHtml).not.toContain("data-dashboard-system-upgrade-all-preselection");
    expect(viewHtml).toContain('aria-controls="dashboard-group-content-1"');
    expect(viewHtml).not.toContain("data-dashboard-group-order-actions");

    const editHtml = renderToStaticMarkup(
      <DashboardSystemGroups {...commonProps} editMode />,
    );
    expect(editHtml).toContain("Group badges");
    expect(editHtml).toContain('aria-checked="false"');
    expect(editHtml).not.toContain('aria-label="Group status"');
    expect(editHtml).toContain(">Done</button>");
    expect(editHtml).toContain('title="Drag to reorder system"');
    expect(editHtml).toContain('title="Drag to reorder group"');
    expect(editHtml).toContain(
      'data-dashboard-group-drag-header="true" draggable="true"',
    );
    expect(editHtml).toContain("data-dashboard-group-actions");
    expect(editHtml).toContain("data-dashboard-group-order-actions");
    expect(editHtml).not.toContain('aria-controls="dashboard-group-content-1"');
    expect(editHtml).toContain("data-dashboard-system-drag-handle");
    expect(editHtml).toContain("data-dashboard-system-actions");
    expect(editHtml).not.toContain(">Drag to reorder system</span>");
    expect(editHtml).toMatch(/data-dashboard-system-id="1" draggable="true"/);
    expect(editHtml).toContain('aria-label="Move group Primary up"');
    expect(editHtml).toContain('aria-label="Move group Primary down"');
    expect(editHtml).toContain('aria-label="Move system Alpha up"');
    expect(editHtml).toContain('aria-label="Move system Alpha down"');
    expect(editHtml).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Move group Primary up"/,
    );
    expect(editHtml).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Move system Alpha up"/,
    );
    expect(editHtml).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Move system Alpha down"/,
    );
    expect(editHtml).toContain('aria-label="Sort systems by name"');
    expect(editHtml).toContain('aria-label="Upgrade priority for Primary"');
    expect(editHtml).toContain(
      'aria-label="Decrease upgrade priority for Primary"',
    );
    expect(editHtml).toContain(
      'aria-label="Increase upgrade priority for Primary"',
    );
    expect(editHtml).toContain('data-dashboard-system-upgrade-priority="true"');
    expect(editHtml).toContain('data-dashboard-system-upgrade-all-preselection="true"');
    expect(editHtml).toContain('aria-label="Preselect Alpha for Upgrade All"');
    expect(editHtml).toContain("Upgrade All");
    expect(editHtml).toContain("When off, this system starts unchecked but remains available for manual selection.");
    expect(editHtml).toContain('aria-label="Upgrade priority for Alpha"');
    expect(editHtml).toContain(
      'aria-label="Decrease upgrade priority for Alpha"',
    );
    expect(editHtml).toContain(
      'aria-label="Increase upgrade priority for Alpha"',
    );
    expect(editHtml).toContain(
      'title="Lower numbers upgrade first within this group. Systems with the same priority upgrade in parallel."',
    );
    expect(editHtml).toContain(
      'title="Lower numbers upgrade first. Groups with the same priority upgrade in parallel."',
    );
    expect(editHtml).toContain("flex-col sm:flex-row sm:justify-between");
    expect(editHtml).toContain(
      "flex w-full items-center justify-end gap-1 sm:w-auto sm:shrink-0",
    );
    expect(editHtml).toMatch(
      /<input type="number" min="0" max="99" step="1"[^>]*value="3"/,
    );
    expect(editHtml).toMatch(
      /<input type="number" min="0" max="99" step="1"[^>]*value="6"/,
    );
    expect(editHtml.indexOf('aria-label="Sort systems by name"')).toBeLessThan(
      editHtml.indexOf('aria-label="Delete group"'),
    );
    expect(editHtml.indexOf('aria-label="Delete group"')).toBeLessThan(
      editHtml.indexOf('aria-label="Upgrade priority for Primary"'),
    );
    expect(editHtml).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Edit group name"/,
    );
    expect(editHtml).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Delete group"/,
    );
  });

  test("renders systems excluded from Upgrade All as not preselected", () => {
    const html = renderToStaticMarkup(
      <DashboardSystemGroups
        systems={[{
          id: 1,
          name: "Manual only",
          dashboardGroupId: null,
          dashboardOrder: 1,
          updatePriority: 1,
          sortOrder: 1,
          excludeFromUpgradeAll: 1,
        } as System]}
        groups={[]}
        ungroupedSortOrder={0}
        ungroupedUpdatePriority={1}
        editMode
        onToggleEditMode={vi.fn()}
        onCreateGroup={vi.fn()}
        onRenameGroup={vi.fn()}
        onDeleteGroup={vi.fn()}
        saveGroupOrder={vi.fn().mockResolvedValue(undefined)}
        saveGroupUpdatePriority={vi.fn().mockResolvedValue(undefined)}
        saveSystemUpdatePriority={vi.fn().mockResolvedValue(undefined)}
        saveSystemUpgradeAllExclusion={vi.fn().mockResolvedValue(undefined)}
        saveSystemPlacements={vi.fn().mockResolvedValue(undefined)}
        onError={vi.fn()}
        renderSystem={(system) => <span>{system.name}</span>}
      />,
    );

    expect(html).toMatch(/role="switch" aria-checked="false" aria-label="Preselect Manual only for Upgrade All"/);
  });

  test("sorts system names case-insensitively and with natural number ordering", () => {
    const systems = [
      { id: 1, name: "System 10" },
      { id: 2, name: "beta" },
      { id: 3, name: "System 2" },
      { id: 4, name: "Alpha" },
    ] as System[];

    expect(
      [...systems].sort(compareSystemsByName).map((system) => system.name),
    ).toEqual(["Alpha", "beta", "System 2", "System 10"]);
  });

  test("restores the disabled group badge preference", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn((key: string) =>
          key === "ludash.dashboard.group-badges" ? "false" : null,
        ),
        setItem: vi.fn(),
      },
    });

    try {
      const html = renderToStaticMarkup(
        <DashboardSystemGroups
          systems={[
            {
              id: 1,
              name: "Alpha",
              dashboardGroupId: 1,
              dashboardOrder: 1,
              sortOrder: 1,
              updateCount: 1,
              isReachable: 1,
              needsReboot: 0,
              lastCheck: null,
              osLifecycleStatus: "supported",
            } as System,
          ]}
          groups={[
            {
              id: 1,
              name: "Primary",
              sortOrder: 0,
              createdAt: "",
              updatedAt: "",
            },
          ]}
          ungroupedSortOrder={1}
          editMode
          onToggleEditMode={vi.fn()}
          onCreateGroup={vi.fn()}
          onRenameGroup={vi.fn()}
          onDeleteGroup={vi.fn()}
          saveGroupOrder={vi.fn().mockResolvedValue(undefined)}
          saveSystemPlacements={vi.fn().mockResolvedValue(undefined)}
          onError={vi.fn()}
          renderSystem={(system) => <span>{system.name}</span>}
        />,
      );

      expect(html).toContain("Group badges");
      expect(html).toContain('aria-checked="false"');
      expect(html).not.toContain('aria-label="Group status"');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
