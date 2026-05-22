import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ReactNode } from "react";

const {
  mockUseDashboardStats,
  mockUseDashboardSystems,
  mockUseRefreshCache,
  mockUseUpgradeAllBatch,
  mockUseUpgradeGroups,
  mockUseCreateUpgradeGroup,
  mockUseUpdateUpgradeGroup,
  mockUseDeleteUpgradeGroup,
  mockUseReorderUpgradeGroups,
  mockUseUpdateSystemUpgradeGroups,
  mockUseReorderSystemUpgradeOrder,
  mockUseUpdateSystemUpgradeAllExclusion,
  mockUseUpdateSystemUpgradeMode,
  mockUseToast,
  mockUseUpgrade,
} = vi.hoisted(() => ({
  mockUseDashboardStats: vi.fn(),
  mockUseDashboardSystems: vi.fn(),
  mockUseRefreshCache: vi.fn(),
  mockUseUpgradeAllBatch: vi.fn(),
  mockUseUpgradeGroups: vi.fn(),
  mockUseCreateUpgradeGroup: vi.fn(),
  mockUseUpdateUpgradeGroup: vi.fn(),
  mockUseDeleteUpgradeGroup: vi.fn(),
  mockUseReorderUpgradeGroups: vi.fn(),
  mockUseUpdateSystemUpgradeGroups: vi.fn(),
  mockUseReorderSystemUpgradeOrder: vi.fn(),
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
  useUpgradeGroups: mockUseUpgradeGroups,
  useCreateUpgradeGroup: mockUseCreateUpgradeGroup,
  useUpdateUpgradeGroup: mockUseUpdateUpgradeGroup,
  useDeleteUpgradeGroup: mockUseDeleteUpgradeGroup,
  useReorderUpgradeGroups: mockUseReorderUpgradeGroups,
  useUpdateSystemUpgradeGroups: mockUseUpdateSystemUpgradeGroups,
  useReorderSystemUpgradeOrder: mockUseReorderSystemUpgradeOrder,
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
  Layout: ({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <div>{title}</div>
      <div>{actions}</div>
      <main>{children}</main>
    </div>
  ),
}));

import Dashboard, {
  applyUpgradeSystemPlacements,
  canToggleUpgradePreset,
  getDashboardUpgradeToast,
  isUpgradePresetSelected,
} from "../../client/pages/Dashboard";

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
          upgradeOrder: 1,
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
    mockUseUpgradeAllBatch.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpgradeGroups.mockReturnValue({ data: { groups: [], ungroupedSortOrder: 1_000_000 } });
    mockUseCreateUpgradeGroup.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpdateUpgradeGroup.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseDeleteUpgradeGroup.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseReorderUpgradeGroups.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpdateSystemUpgradeGroups.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseReorderSystemUpgradeOrder.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpdateSystemUpgradeAllExclusion.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseUpdateSystemUpgradeMode.mockReturnValue({ mutate: vi.fn(), isPending: false, variables: undefined });
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

  test("disables dashboard refresh and upgrade actions while the server reports an active upgrade", () => {
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
          upgradeOrder: 1,
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
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Upgrading\.\.\..*<\/button>/s);
    expect(html).not.toContain(">Upgrade All</button>");
  });

  test("treats recovered upgrade warnings as informational dashboard toasts", () => {
    expect(getDashboardUpgradeToast("Alpha", "warning")).toEqual({
      message: "Alpha: Upgrade state resynced after backend restart",
      type: "info",
    });
  });

  test("allows edit mode to toggle Upgrade All presets for systems without updates", () => {
    const systemWithoutUpdates = { id: 1, updateCount: 0 };

    expect(isUpgradePresetSelected(systemWithoutUpdates, [1])).toBe(true);
    expect(canToggleUpgradePreset(systemWithoutUpdates, false)).toBe(false);
    expect(canToggleUpgradePreset(systemWithoutUpdates, true)).toBe(true);
  });

  test("applies pending upgrade group placements over stale system rows", () => {
    const systems = [
      { id: 1, upgradeGroupId: null, upgradeOrder: 1, name: "Alpha" },
      { id: 2, upgradeGroupId: 3, upgradeOrder: 1, name: "Bravo" },
    ];
    const placements = new Map([
      [1, { groupId: 3, upgradeOrder: 2 }],
    ]);

    expect(applyUpgradeSystemPlacements(systems, placements)).toEqual([
      { id: 1, upgradeGroupId: 3, upgradeOrder: 2, name: "Alpha" },
      { id: 2, upgradeGroupId: 3, upgradeOrder: 1, name: "Bravo" },
    ]);
  });
});
