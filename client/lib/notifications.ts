import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export type NotificationConfig = Record<string, unknown>;

export interface WebhookField {
  name: string;
  value: string;
  sensitive: boolean;
}

export type WebhookAuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "basic"; username: string; password: string };

export type WebhookBodyConfig =
  | { mode: "text" | "json"; template: string }
  | { mode: "form"; fields: WebhookField[] };

export interface WebhookConfig extends NotificationConfig {
  preset: "custom" | "discord";
  method: "POST" | "PUT" | "PATCH";
  url: string;
  query: Array<{ name: string; value: string }>;
  headers: WebhookField[];
  auth: WebhookAuthConfig;
  body: WebhookBodyConfig;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  allowInsecureTls: boolean;
}

export interface TelegramConfig extends NotificationConfig {
  telegramBotToken?: string;
  botUsername?: string;
  chatId?: string;
  chatDisplayName?: string;
  chatBoundAt?: string;
  chatBindingStatus?: "unbound" | "pending" | "bound";
  commandsEnabled?: boolean;
  commandApiTokenEncrypted?: string;
  commandApiTokenId?: number;
  commandTokenStatus?: "not-required" | "pending" | "missing" | "expired" | "active";
  commandTokenName?: string;
  commandTokenCreatedAt?: string;
  commandTokenLastUsedAt?: string;
  commandTokenExpiresAt?: string;
}

export interface MqttConfig extends NotificationConfig {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
  keepaliveSeconds: number;
  connectTimeoutMs: number;
  qos: 0 | 1;
  publishEvents: boolean;
  topic: string;
  retainEvents: boolean;
  homeAssistantEnabled: boolean;
  discoveryPrefix: string;
  baseTopic: string;
  publishAppEntity: boolean;
  commandsEnabled: boolean;
  payloadInstall: string;
}

export interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  notifyOn: string[];
  systemIds: number[] | null;
  config: NotificationConfig;
  schedule: string | null;
  lastSentAt: string | null;
  lastAppVersionNotified?: string | null;
  lastDeliveryStatus?: string | null;
  lastDeliveryAt?: string | null;
  lastDeliveryCode?: number | null;
  lastDeliveryMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () =>
      apiFetch<{ notifications: NotificationChannel[] }>("/notifications").then(
        (r) => r.notifications
      ),
  });
}

export function useCreateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      type: string;
      enabled?: boolean;
      notifyOn?: string[];
      systemIds?: number[] | null;
      config: NotificationConfig;
      schedule?: string | null;
    }) =>
      apiFetch<{ id: number }>("/notifications", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useUpdateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: number;
      name?: string;
      type?: string;
      enabled?: boolean;
      notifyOn?: string[];
      systemIds?: number[] | null;
      config?: NotificationConfig;
      schedule?: string | null;
    }) =>
      apiFetch(`/notifications/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useReorderNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (notificationIds: number[]) =>
      apiFetch("/notifications/reorder", {
        method: "PUT",
        body: JSON.stringify({ notificationIds }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useDeleteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/notifications/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useTestNotification() {
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean; error?: string }>(
        `/notifications/${id}/test`,
        { method: "POST" }
      ),
  });
}

export function useTestNotificationConfig() {
  return useMutation({
    mutationFn: (data: {
      type: string;
      config: NotificationConfig;
      name?: string;
      existingId?: number;
    }) =>
      apiFetch<{ success: boolean; error?: string }>(
        `/notifications/test`,
        { method: "POST", body: JSON.stringify(data) }
      ),
  });
}

export function useCreateTelegramLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ url: string; expiresAt: string }>(`/notifications/${id}/telegram/link`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useUnlinkTelegramChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ status: string }>(`/notifications/${id}/telegram/unlink`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useReissueTelegramCommandToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ status: string }>(`/notifications/${id}/telegram/reissue-command-token`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}
