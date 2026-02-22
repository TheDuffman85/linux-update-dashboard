import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  enabled: boolean;
  notifyOn: string[];
  systemIds: number[] | null;
  config: Record<string, string>;
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
      config: Record<string, string>;
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
      config?: Record<string, string>;
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
    mutationFn: (data: { type: string; config: Record<string, string>; name?: string }) =>
      apiFetch<{ success: boolean; error?: string }>(
        `/notifications/test`,
        { method: "POST", body: JSON.stringify(data) }
      ),
  });
}
