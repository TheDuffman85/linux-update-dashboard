import { describe, expect, test } from "vitest";
import {
  deriveSystemUpdateState,
  getSystemStatusDotClass,
  getUpdatesPanelState,
  hasHostKeyVerificationError,
  isHostKeyVerificationErrorMessage,
  omitHostKeyVerificationErrorFromUpdatesPanelState,
  shouldClearLocalUpgrade,
} from "../../client/lib/system-status";
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
  osLifecycleStatus?: "supported" | "support_ending" | "support_ended" | "approaching_eol" | "eol" | "unknown";
  lastCheck?: LastCheckSummary | null;
  activeOperation?: ActiveOperation | null;
}) {
  return {
    isReachable: overrides?.isReachable ?? 1,
    updateCount: overrides?.updateCount ?? 0,
    osLifecycleStatus: overrides?.osLifecycleStatus,
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

  test("returns lifecycle warning instead of up to date for EOL systems", () => {
    expect(
      deriveSystemUpdateState(makeSystem({
        lastCheck: makeLastCheck("success"),
        osLifecycleStatus: "eol",
      })),
    ).toBe("lifecycle_warning");
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

  test("returns checking during a post-upgrade recheck phase", () => {
    expect(
      deriveSystemUpdateState(
        makeSystem({
          lastCheck: makeLastCheck("success"),
          activeOperation: {
            type: "upgrade_package",
            startedAt: "2026-01-01 10:02:00",
            phase: "rechecking",
            packageName: "jq",
            packageNames: ["jq"],
          },
        }),
        { upgrading: true },
      ),
    ).toBe("checking");
  });

  test("returns maintaining while autoremove runs and checking while it rechecks", () => {
    const operation: ActiveOperation = {
      type: "autoremove",
      startedAt: "2026-01-01 10:02:00",
    };
    expect(deriveSystemUpdateState(makeSystem({ activeOperation: operation }))).toBe("maintaining");
    expect(deriveSystemUpdateState(makeSystem({
      activeOperation: { ...operation, phase: "rechecking" },
    }))).toBe("checking");
  });
});

describe("getSystemStatusDotClass", () => {
  test("keeps non-EOL lifecycle warnings green", () => {
    expect(getSystemStatusDotClass("lifecycle_warning", { osLifecycleStatus: "support_ending" })).toBe("bg-green-500");
    expect(getSystemStatusDotClass("lifecycle_warning", { osLifecycleStatus: "support_ended" })).toBe("bg-green-500");
    expect(getSystemStatusDotClass("lifecycle_warning", { osLifecycleStatus: "approaching_eol" })).toBe("bg-green-500");
  });

  test("marks final EOL lifecycle warnings red", () => {
    expect(getSystemStatusDotClass("lifecycle_warning", { osLifecycleStatus: "eol" })).toBe("bg-red-500");
  });

  test("keeps lifecycle warnings amber without lifecycle context", () => {
    expect(getSystemStatusDotClass("lifecycle_warning")).toBe("bg-amber-500");
  });

  test("keeps operational failures red", () => {
    expect(getSystemStatusDotClass("check_failed")).toBe("bg-red-500");
    expect(getSystemStatusDotClass("unreachable")).toBe("bg-red-500");
  });
});

describe("shouldClearLocalUpgrade", () => {
  test("clears local upgrade state when the server has no active operation", () => {
    expect(shouldClearLocalUpgrade(null)).toBe(true);
  });

  test("clears local upgrade state during post-upgrade recheck", () => {
    expect(
      shouldClearLocalUpgrade({
        type: "upgrade_all",
        startedAt: "2026-01-01 10:02:00",
        phase: "rechecking",
      }),
    ).toBe(true);
  });

  test("keeps local upgrade state while the server upgrade is still active", () => {
    expect(
      shouldClearLocalUpgrade({
        type: "full_upgrade_all",
        startedAt: "2026-01-01 10:02:00",
      }),
    ).toBe(false);
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

describe("host-key update notice handling", () => {
  test("recognizes host-key verification errors including the misspelled variant", () => {
    expect(isHostKeyVerificationErrorMessage("HostKeyVerificationError")).toBe(true);
    expect(isHostKeyVerificationErrorMessage("HostKeyVarificationError")).toBe(true);
    expect(isHostKeyVerificationErrorMessage("SSH host key approval required")).toBe(true);
    expect(isHostKeyVerificationErrorMessage("sudo password required")).toBe(false);
  });

  test("detects host-key failures from the latest check summary", () => {
    expect(
      hasHostKeyVerificationError(makeLastCheck("failed", "SSH host key verification failed")),
    ).toBe(true);
    expect(hasHostKeyVerificationError(makeLastCheck("failed", "network unreachable"))).toBe(false);
  });

  test("removes host-key errors from the inline updates panel", () => {
    expect(
      omitHostKeyVerificationErrorFromUpdatesPanelState({
        kind: "check_failed",
        title: "Update check failed",
        message: "The latest update check did not complete, so the package list may be unavailable.",
        error: "HostKeyVerificationError: SSH host key approval required",
      }),
    ).toBeNull();

    expect(
      omitHostKeyVerificationErrorFromUpdatesPanelState({
        kind: "check_warning",
        title: "Update check completed with warnings",
        message: "One or more package manager checks failed, so this result may be incomplete.",
        error: "[apt] mirror failed\n\nHostKeyVerificationError: SSH host key approval required",
      }),
    ).toEqual({
      kind: "check_warning",
      title: "Update check completed with warnings",
      message: "One or more package manager checks failed, so this result may be incomplete.",
      error: "[apt] mirror failed",
    });
  });
});
