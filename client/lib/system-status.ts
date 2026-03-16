import type { ActiveOperation, LastCheckSummary } from "./systems";

export type SystemUpdateState =
  | "upgrading"
  | "checking"
  | "unreachable"
  | "check_failed"
  | "check_warning"
  | "updates_available"
  | "up_to_date"
  | "unchecked";

type SystemStatusInput = {
  isReachable: number;
  updateCount: number;
  lastCheck: LastCheckSummary | null;
  activeOperation?: ActiveOperation | null;
};

type DeriveOptions = {
  upgrading?: boolean;
  checking?: boolean;
};

export type UpdatesPanelState =
  | { kind: "check_failed"; title: string; message: string; error: string | null }
  | { kind: "check_warning"; title: string; message: string; error: string | null }
  | { kind: "updates_available" }
  | { kind: "up_to_date" };

export function deriveSystemUpdateState(
  system: SystemStatusInput,
  options?: DeriveOptions,
): SystemUpdateState {
  const activeType = system.activeOperation?.type;
  if (options?.upgrading || activeType?.includes("upgrade")) return "upgrading";
  if (options?.checking || activeType === "check") return "checking";
  if (system.isReachable === -1) return "unreachable";
  if (system.lastCheck?.status === "failed") return "check_failed";
  if (system.lastCheck?.status === "warning") return "check_warning";
  if (system.updateCount > 0) return "updates_available";
  if (system.isReachable === 1) return "up_to_date";
  return "unchecked";
}

export function getUpdatesPanelState(
  system: Pick<SystemStatusInput, "lastCheck">,
  updatesCount: number,
): UpdatesPanelState {
  if (system.lastCheck?.status === "failed") {
    return {
      kind: "check_failed",
      title: "Update check failed",
      message: "The latest update check did not complete, so the package list may be unavailable.",
      error: system.lastCheck.error,
    };
  }

  if (system.lastCheck?.status === "warning") {
    return {
      kind: "check_warning",
      title: "Update check completed with warnings",
      message: updatesCount > 0
        ? "Showing the updates that were found before one or more package manager checks failed."
        : "One or more package manager checks failed, so this result may be incomplete.",
      error: system.lastCheck.error,
    };
  }

  return updatesCount > 0 ? { kind: "updates_available" } : { kind: "up_to_date" };
}
