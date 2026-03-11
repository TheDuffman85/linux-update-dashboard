import * as mqttRuntime from "./mqtt-runtime";
import * as telegramBot from "./telegram-bot";
import { registerNotificationRuntimeHandlers } from "./notification-runtime-events";

export async function start(): Promise<void> {
  registerNotificationRuntimeHandlers({
    syncSystemState,
    syncAppUpdateState,
  });

  await Promise.all([
    mqttRuntime.start(),
    telegramBot.start(),
  ]);
}

export async function stop(): Promise<void> {
  registerNotificationRuntimeHandlers({});
  await Promise.all([
    mqttRuntime.stop(),
    Promise.resolve().then(() => telegramBot.stop()),
  ]);
}

export async function reconcileNotificationChange(
  previousRow: Parameters<typeof telegramBot.reconcileNotificationChange>[0],
  currentRow: Parameters<typeof telegramBot.reconcileNotificationChange>[1],
  actorUserId?: number,
): Promise<void> {
  await telegramBot.reconcileNotificationChange(previousRow, currentRow, actorUserId);
  await mqttRuntime.reconcileNotificationChange(
    previousRow && "type" in previousRow ? previousRow : null,
    currentRow && "type" in currentRow ? currentRow : null,
  );
}

export async function syncSystemState(systemId?: number): Promise<void> {
  await mqttRuntime.syncSystemState(systemId);
}

export async function syncAppUpdateState(): Promise<void> {
  await mqttRuntime.syncAppUpdateState();
}

export async function createBindingLink(notificationId: number, actorUserId: number) {
  return telegramBot.createBindingLink(notificationId, actorUserId);
}

export async function unlinkNotification(notificationId: number): Promise<void> {
  await telegramBot.unlinkNotification(notificationId);
}

export async function reissueCommandToken(notificationId: number, actorUserId: number): Promise<void> {
  await telegramBot.reissueCommandToken(notificationId, actorUserId);
}
