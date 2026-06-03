import type { ActiveOperation, LastCheckSummary } from "./systems";

export type SystemUpdateState =
  | "upgrading"
  | "maintaining"
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

const HOST_KEY_VERIFICATION_ERROR_RE =
  /HostKeyV(?:erification|arification)Error|SSH host key approval required|SSH host key verification failed/i;

export function isPostUpgradeRecheck(activeOperation: ActiveOperation | null | undefined): boolean {
  return activeOperation?.phase === "rechecking" && activeOperation.type.includes("upgrade");
}

export function isPostAutoremoveRecheck(activeOperation: ActiveOperation | null | undefined): boolean {
  return activeOperation?.phase === "rechecking" && activeOperation.type === "autoremove";
}

export function shouldClearLocalUpgrade(activeOperation: ActiveOperation | null | undefined): boolean {
  return !activeOperation || isPostUpgradeRecheck(activeOperation);
}

export function isHostKeyVerificationErrorMessage(message: string | null | undefined): boolean {
  return HOST_KEY_VERIFICATION_ERROR_RE.test(message ?? "");
}

export function hasHostKeyVerificationError(lastCheck: LastCheckSummary | null | undefined): boolean {
  return isHostKeyVerificationErrorMessage(lastCheck?.error);
}

export function omitHostKeyVerificationErrorFromUpdatesPanelState(
  state: UpdatesPanelState | null,
): UpdatesPanelState | null {
  if (!state || (state.kind !== "check_failed" && state.kind !== "check_warning")) return state;
  if (!isHostKeyVerificationErrorMessage(state.error)) return state;

  const remainingErrors = (state.error ?? "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => !isHostKeyVerificationErrorMessage(block));

  if (remainingErrors.length === 0) return null;
  return { ...state, error: remainingErrors.join("\n\n") };
}

export function deriveSystemUpdateState(
  system: SystemStatusInput,
  options?: DeriveOptions,
): SystemUpdateState {
  const activeType = system.activeOperation?.type;
  if (options?.checking || activeType === "check" || isPostUpgradeRecheck(system.activeOperation) || isPostAutoremoveRecheck(system.activeOperation)) return "checking";
  if (options?.upgrading || activeType?.includes("upgrade")) return "upgrading";
  if (activeType === "autoremove") return "maintaining";
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
