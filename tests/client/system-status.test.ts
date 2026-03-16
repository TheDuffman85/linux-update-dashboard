import { describe, expect, test } from "bun:test";
import { deriveSystemUpdateState, getUpdatesPanelState } from "../../client/lib/system-status";
import type { ActiveOperation, LastCheckSummary } from "../../client/lib/systems";

function makeLastCheck(status: LastCheckSummary["status"], error: string | null = null): LastCheckSummary {
  return {
    status,
    error,
    startedAt: "2026-01-01 10:00:00",
    completedAt: "2026-01-01 10:01:00",
  };
}

function makeSystem(overrides?: {
  isReachable?: number;
  updateCount?: number;
  lastCheck?: LastCheckSummary | null;
  activeOperation?: ActiveOperation | null;
}) {
  return {
    isReachable: overrides?.isReachable ?? 1,
    updateCount: overrides?.updateCount ?? 0,
    lastCheck: overrides?.lastCheck ?? null,
    activeOperation: overrides?.activeOperation ?? null,
  };
}

describe("deriveSystemUpdateState", () => {
  test("returns failed when the latest check failed", () => {
    expect(
      deriveSystemUpdateState(
        makeSystem({ lastCheck: makeLastCheck("failed", "[apt] sudo failed") }),
      ),
    ).toBe("check_failed");
  });

  test("returns warning when the latest check completed with warnings", () => {
    expect(
      deriveSystemUpdateState(
        makeSystem({ updateCount: 2, lastCheck: makeLastCheck("warning", "[flatpak] failed") }),
      ),
    ).toBe("check_warning");
  });

  test("returns updates available when updates exist without check issues", () => {
    expect(
      deriveSystemUpdateState(makeSystem({ updateCount: 3, lastCheck: makeLastCheck("success") })),
    ).toBe("updates_available");
  });

  test("returns up to date when the system is reachable with no updates and no check issues", () => {
    expect(
      deriveSystemUpdateState(makeSystem({ lastCheck: makeLastCheck("success") })),
    ).toBe("up_to_date");
  });

  test("returns unreachable before check issues", () => {
    expect(
      deriveSystemUpdateState(
        makeSystem({ isReachable: -1, lastCheck: makeLastCheck("failed", "boom") }),
      ),
    ).toBe("unreachable");
  });

  test("returns checking and upgrading before other states", () => {
    expect(
      deriveSystemUpdateState(
        makeSystem({ lastCheck: makeLastCheck("failed") }),
        { checking: true },
      ),
    ).toBe("checking");

    expect(
      deriveSystemUpdateState(
        makeSystem({ lastCheck: makeLastCheck("failed") }),
        { upgrading: true },
      ),
    ).toBe("upgrading");
  });
});

describe("getUpdatesPanelState", () => {
  test("returns a failed panel instead of the no-updates empty state", () => {
    expect(
      getUpdatesPanelState({ lastCheck: makeLastCheck("failed", "[apt] sudo failed") }, 0),
    ).toEqual({
      kind: "check_failed",
      title: "Update check failed",
      message: "The latest update check did not complete, so the package list may be unavailable.",
      error: "[apt] sudo failed",
    });
  });

  test("returns a warning panel while preserving found updates", () => {
    expect(
      getUpdatesPanelState({ lastCheck: makeLastCheck("warning", "[flatpak] failed") }, 2),
    ).toEqual({
      kind: "check_warning",
      title: "Update check completed with warnings",
      message: "Showing the updates that were found before one or more package manager checks failed.",
      error: "[flatpak] failed",
    });
  });

  test("returns the clean empty state only for successful non-warning checks", () => {
    expect(
      getUpdatesPanelState({ lastCheck: makeLastCheck("success") }, 0),
    ).toEqual({ kind: "up_to_date" });
  });
});
