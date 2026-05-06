import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export type ScheduleType = "refresh" | "update";
export type ScheduleRunStatus = "success" | "warning" | "failed";

export interface RefreshScheduleConfig {
  cron: string;
  cacheDurationHours: number;
}

export interface UpdateScheduleConfig {
  cron: string;
}

export type ScheduleConfig = RefreshScheduleConfig | UpdateScheduleConfig;

export interface Schedule {
  id: number;
  name: string;
  type: ScheduleType;
  enabled: boolean;
  systemIds: number[] | null;
  config: ScheduleConfig;
  lastStartedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: ScheduleRunStatus | string | null;
  lastRunMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isRefreshConfig(config: ScheduleConfig): config is RefreshScheduleConfig {
  return "cron" in config && "cacheDurationHours" in config;
}

export function isUpdateConfig(config: ScheduleConfig): config is UpdateScheduleConfig {
  return "cron" in config && !("cacheDurationHours" in config);
}

export function useSchedules() {
  return useQuery({
    queryKey: ["schedules"],
    queryFn: () =>
      apiFetch<{ schedules: Schedule[] }>("/schedules").then((r) => r.schedules),
  });
}

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      type: ScheduleType;
      enabled?: boolean;
      systemIds?: number[] | null;
      config: ScheduleConfig;
    }) =>
      apiFetch<{ id: number }>("/schedules", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useUpdateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: number;
      name?: string;
      type?: ScheduleType;
      enabled?: boolean;
      systemIds?: number[] | null;
      config?: ScheduleConfig;
    }) =>
      apiFetch(`/schedules/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useReorderSchedules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scheduleIds: number[]) =>
      apiFetch("/schedules/reorder", {
        method: "PUT",
        body: JSON.stringify({ scheduleIds }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/schedules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedules"] });
    },
  });
}
