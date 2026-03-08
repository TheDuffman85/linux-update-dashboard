import type { NotificationProvider } from "./types";
import { emailProvider } from "./email";
import { gotifyProvider } from "./gotify";
import { ntfyProvider } from "./ntfy";

export type { NotificationProvider, NotificationPayload, NotificationResult } from "./types";

const providers: Record<string, NotificationProvider> = {
  email: emailProvider,
  gotify: gotifyProvider,
  ntfy: ntfyProvider,
};

export function getProvider(name: string): NotificationProvider | undefined {
  return providers[name];
}

export function getProviderNames(): string[] {
  return Object.keys(providers);
}
