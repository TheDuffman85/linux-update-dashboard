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
  isUpgradeAllSubmitDisabled,
  isUpgradePresetSelected,
} from "../../client/pages/Dashboard";

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

  test("shows OS warnings as yellow and labels Debian LTS warnings without dates", () => {
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

    expect(html).toContain("text-yellow-500 dark:text-yellow-400");
    expect(html).toContain("OS Warnings");
    expect(html).toContain("LTS");
    expect(html).not.toContain("In LTS");
    expect(html).not.toContain("LTS until 2028-06-30");
    expect(html).toContain("w-3 h-3 rounded-full shrink-0 bg-green-500");
    expect(html).not.toContain("Support ended");
  });

  test("uses a short lifecycle badge without remaining days for upcoming support end", () => {
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
          osLifecycleStatus: "support_ending",
          osLifecycleEolDate: "2030-06-30",
          osLifecycleDaysUntilEol: 1491,
          osLifecycleDaysUntilSupportEnd: 23,
          osLifecycleLabel: "Debian 13 security support ends in 23 days; LTS until 2030-06-30",
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

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("Security support ending soon");
    expect(html).not.toContain("23d");
  });

  test("shows active upgrades without disabling the dashboard upgrade modal launcher", () => {
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
    expect(html).toContain("Upgrading...");
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrading..."))).toBe(false);
    expect(html).not.toContain(">Upgrade All</button>");
  });

  test("does not show the dashboard upgrade action as upgrading during refresh", () => {
    mockUseRefreshCache.mockReturnValue({ mutate: vi.fn(), isPending: true });

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(html).toContain("Refreshing...");
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Refreshing..."))).toBe(true);
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrade All"))).toBe(false);
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

    expect(html).toContain("Refreshing...");
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Refreshing..."))).toBe(true);
    expect(hasDisabledAttribute(getOpeningButtonTag(html, "Upgrade All"))).toBe(false);
    expect(html).not.toContain("Upgrading...");
  });

  test("disables the modal Upgrade All submit while dashboard work is running", () => {
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
