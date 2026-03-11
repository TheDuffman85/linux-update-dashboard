import type { NotificationProvider } from "./types";
import { emailProvider } from "./email";
import { gotifyProvider } from "./gotify";
import { mqttProvider } from "./mqtt";
import { ntfyProvider } from "./ntfy";
import { telegramProvider } from "./telegram";
import { webhookProvider } from "./webhook";

export type {
  AppUpdateEvent,
  CheckResult,
  NotificationConfig,
  NotificationEventData,
  NotificationEventType,
  NotificationPayload,
  NotificationPriority,
  NotificationProvider,
  NotificationResult,
} from "./types";

const providers: Record<string, NotificationProvider> = {
  email: emailProvider,
  gotify: gotifyProvider,
  mqtt: mqttProvider,
  ntfy: ntfyProvider,
  telegram: telegramProvider,
  webhook: webhookProvider,
};

export function getProvider(name: string): NotificationProvider | undefined {
  return providers[name];
}

export function getProviderNames(): string[] {
  return Object.keys(providers);
}
