import { describe, expect, test } from "vitest";
import {
  filterSystemsByStatus,
  isDashboardStatusFilterActive,
  parseDashboardSearch,
  toggleDashboardStatusFilter,
} from "../../client/lib/dashboard-search";

type TestSystem = Parameters<typeof filterSystemsByStatus>[0][number] & { id: number };

const system = (id: number, overrides: Partial<TestSystem> = {}): TestSystem => ({
  id,
  updateCount: 0,
  isReachable: 1,
  needsReboot: 0,
  osLifecycleStatus: "supported",
  lastCheck: null,
  ...overrides,
});

const ids = (systems: TestSystem[]) => systems.map((s) => s.id);

describe("dashboard status search", () => {
  test("separates known filter tokens from free text", () => {
    expect(parseDashboardSearch("  web  IS:Updates -is:reboot is:bogus prod ")).toEqual({
      filters: [
        { filter: "updates", negated: false },
        { filter: "reboot", negated: true },
      ],
      text: "web is:bogus prod",
    });
    expect(parseDashboardSearch("is:offline is:outdated").filters.map((f) => f.filter))
      .toEqual(["unreachable", "updates"]);
  });

  test("filters with the same rules as the dashboard stats", () => {
    const systems = [
      system(1),
      system(2, { updateCount: 3 }),
      system(3, { updateCount: 3, lastCheck: { status: "failed", error: "x", startedAt: "", completedAt: null } }),
      system(4, { isReachable: -1 }),
      system(5, { needsReboot: 1 }),
      system(6, { osLifecycleStatus: "eol" }),
      system(7, { isReachable: 0 }),
    ];
    const run = (search: string) => ids(filterSystemsByStatus(systems, parseDashboardSearch(search).filters));

    expect(run("is:uptodate")).toEqual([1, 5]);
    expect(run("is:updates")).toEqual([2]);
    expect(run("is:issues")).toEqual([3]);
    expect(run("is:unreachable")).toEqual([4]);
    expect(run("is:reboot")).toEqual([5]);
    expect(run("is:os-warning")).toEqual([6]);
    expect(run("is:updates is:issues")).toEqual([]);
    expect(run("-is:uptodate -is:unreachable")).toEqual([2, 3, 6, 7]);
    expect(run("")).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("toggles a single card filter while keeping free text", () => {
    expect(toggleDashboardStatusFilter("", "updates")).toBe("is:updates");
    expect(toggleDashboardStatusFilter("web", "updates")).toBe("is:updates web");
    expect(toggleDashboardStatusFilter("is:updates web", "updates")).toBe("web");
    expect(toggleDashboardStatusFilter("is:reboot web", "updates")).toBe("is:updates web");
    expect(toggleDashboardStatusFilter("is:outdated", "updates")).toBe("");
    expect(toggleDashboardStatusFilter("-is:updates web", "updates")).toBe("is:updates web");
    expect(toggleDashboardStatusFilter("is:reboot is:issues web", null)).toBe("web");
  });

  test("marks a card active only when it is the sole positive filter", () => {
    expect(isDashboardStatusFilterActive("is:updates web", "updates")).toBe(true);
    expect(isDashboardStatusFilterActive("-is:updates", "updates")).toBe(false);
    expect(isDashboardStatusFilterActive("is:updates is:reboot", "updates")).toBe(false);
  });
});
