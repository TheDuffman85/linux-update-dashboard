import type { NotificationProvider } from "./types";
import { emailProvider } from "./email";
import { ntfyProvider } from "./ntfy";

export type { NotificationProvider, NotificationPayload, NotificationResult } from "./types";

const providers: Record<string, NotificationProvider> = {
  email: emailProvider,
  ntfy: ntfyProvider,
};

export function getProvider(name: string): NotificationProvider | undefined {
  return providers[name];
}

export function getProviderNames(): string[] {
  return Object.keys(providers);
}
