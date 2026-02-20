import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface System {
  id: number;
  name: string;
  hostname: string;
  port: number;
  authType: string;
  username: string;
  pkgManager: string | null;
  osName: string | null;
  osVersion: string | null;
  kernel: string | null;
  hostnameRemote: string | null;
  uptime: string | null;
  arch: string | null;
  cpuCores: string | null;
  memory: string | null;
  disk: string | null;
  isReachable: number;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  updateCount: number;
  cacheAge: string | null;
  isStale?: boolean;
}

export interface CachedUpdate {
  id: number;
  systemId: number;
  pkgManager: string;
  packageName: string;
  currentVersion: string | null;
  newVersion: string;
  architecture: string | null;
  repository: string | null;
  isSecurity: number;
  cachedAt: string;
}

export interface HistoryEntry {
  id: number;
  systemId: number;
  action: string;
  pkgManager: string;
  packageCount: number | null;
  packages: string | null;
  packagesList: string[];
  status: string;
  output: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export function useSystems() {
  return useQuery({
    queryKey: ["systems"],
    queryFn: () =>
      apiFetch<{ systems: System[] }>("/systems").then((r) => r.systems),
  });
}

export function useSystem(id: number) {
  return useQuery({
    queryKey: ["system", id],
    queryFn: () =>
      apiFetch<{ system: System; updates: CachedUpdate[]; history: HistoryEntry[] }>(
        `/systems/${id}`
      ),
  });
}

export function useCreateSystem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      hostname: string;
      port: number;
      authType: string;
      username: string;
      password?: string;
      privateKey?: string;
      keyPassphrase?: string;
    }) => apiFetch<{ id: number }>("/systems", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["systems"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUpdateSystem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: {
      id: number;
      name: string;
      hostname: string;
      port: number;
      authType: string;
      username: string;
      password?: string;
      privateKey?: string;
      keyPassphrase?: string;
    }) => apiFetch(`/systems/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["systems"] });
      qc.invalidateQueries({ queryKey: ["system", vars.id] });
    },
  });
}

export function useDeleteSystem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/systems/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["systems"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean; message: string }>(
        `/systems/${id}/test-connection`,
        { method: "POST" }
      ),
  });
}
