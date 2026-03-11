type RuntimeHandlers = {
  syncSystemState?: (systemId?: number) => Promise<void> | void;
  syncAppUpdateState?: () => Promise<void> | void;
};

let handlers: RuntimeHandlers = {};

export function registerNotificationRuntimeHandlers(next: RuntimeHandlers): void {
  handlers = next;
}

export async function requestNotificationRuntimeSystemSync(systemId?: number): Promise<void> {
  await handlers.syncSystemState?.(systemId);
}

export async function requestNotificationRuntimeAppUpdateSync(): Promise<void> {
  await handlers.syncAppUpdateState?.();
}
