import type { NotificationProvider } from "./types";
import { emailProvider } from "./email";
import { gotifyProvider } from "./gotify";
import { ntfyProvider } from "./ntfy";
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
  ntfy: ntfyProvider,
  webhook: webhookProvider,
};

export function getProvider(name: string): NotificationProvider | undefined {
  return providers[name];
}

export function getProviderNames(): string[] {
  return Object.keys(providers);
}
