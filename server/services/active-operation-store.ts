export interface ActiveOperation {
  type: "check" | "upgrade_all" | "full_upgrade_all" | "upgrade_package" | "reboot";
  startedAt: string;
  packageName?: string;
  packageNames?: string[];
  remotePid?: number;
  remoteLogFile?: string;
  remoteExitFile?: string;
}

const activeOperations = new Map<number, ActiveOperation>();

export function setActiveOperation(systemId: number, operation: ActiveOperation): void {
  activeOperations.set(systemId, operation);
}

export function clearActiveOperation(systemId: number): void {
  activeOperations.delete(systemId);
}

export function getActiveOperation(systemId: number): ActiveOperation | null {
  return activeOperations.get(systemId) ?? null;
}

export function getAllActiveOperations(): ReadonlyMap<number, ActiveOperation> {
  return activeOperations;
}
