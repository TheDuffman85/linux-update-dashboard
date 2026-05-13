export interface ActiveOperation {
  type: "check" | "upgrade_all" | "full_upgrade_all" | "upgrade_package" | "reboot";
  startedAt: string;
  phase?: "reconnecting" | "rechecking";
  packageName?: string;
  packageNames?: string[];
  remotePid?: number;
  remoteLogFile?: string;
  remoteExitFile?: string;
  cancelRequested?: boolean;
}

interface ActiveOperationRecord {
  operation: ActiveOperation;
  abortController: AbortController;
}

const activeOperations = new Map<number, ActiveOperationRecord>();

export class OperationCancelledError extends Error {
  constructor(message = "Operation cancelled") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export function isOperationCancelledError(error: unknown): error is OperationCancelledError {
  return error instanceof OperationCancelledError;
}

function isSameOperation(left: ActiveOperation, right: ActiveOperation): boolean {
  return left.type === right.type && left.startedAt === right.startedAt;
}

export function setActiveOperation(systemId: number, operation: ActiveOperation): void {
  const existing = activeOperations.get(systemId);
  if (existing && isSameOperation(existing.operation, operation)) {
    existing.operation = {
      ...operation,
      cancelRequested: existing.operation.cancelRequested || operation.cancelRequested,
    };
    return;
  }
  activeOperations.set(systemId, {
    operation,
    abortController: new AbortController(),
  });
}

export function clearActiveOperation(systemId: number): void {
  activeOperations.delete(systemId);
}

export function getActiveOperation(systemId: number): ActiveOperation | null {
  return activeOperations.get(systemId)?.operation ?? null;
}

export function getAllActiveOperations(): ReadonlyMap<number, ActiveOperation> {
  return new Map(
    Array.from(activeOperations.entries()).map(([systemId, record]) => [
      systemId,
      record.operation,
    ])
  );
}

export function getActiveOperationSignal(systemId: number): AbortSignal | null {
  return activeOperations.get(systemId)?.abortController.signal ?? null;
}

export function throwIfActiveOperationCancelled(systemId: number): void {
  const signal = getActiveOperationSignal(systemId);
  if (signal?.aborted) {
    throw new OperationCancelledError();
  }
}

export function cancelActiveOperation(systemId: number): boolean {
  const record = activeOperations.get(systemId);
  if (!record) return false;
  record.operation = { ...record.operation, cancelRequested: true };
  record.abortController.abort();
  return true;
}
