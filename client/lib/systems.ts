import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface ActiveOperation {
  type: "check" | "upgrade_all" | "full_upgrade_all" | "upgrade_package";
  startedAt: string;
  packageName?: string;
}

export interface System {
  id: number;
  name: string;
  hostname: string;
  port: number;
  authType: string;
  username: string;
  pkgManager: string | null;
  detectedPkgManagers: string[] | null;
  disabledPkgManagers: string[] | null;
  osName: string | null;
  osVersion: string | null;
  kernel: string | null;
  hostnameRemote: string | null;
  uptime: string | null;
  arch: string | null;
  cpuCores: string | null;
  memory: string | null;
  disk: string | null;
  needsReboot: number;
  isReachable: number;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  updateCount: number;
  cacheAge: string | null;
  isStale?: boolean;
  activeOperation?: ActiveOperation | null;
  supportsFullUpgrade?: boolean;
}

export interface CachedUpdate {
  id: number;
  systemId: number;
  pkgManager: string;
  packageName: string;
  currentVersion: string | null;
  newVersion: string | null;
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
  command: string | null;
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
    refetchInterval: (query) => {
      const hasActiveOps = query.state.data?.some((s) => s.activeOperation);
      return hasActiveOps ? 3000 : false;
    },
  });
}

export function useSystem(id: number) {
  const query = useQuery({
    queryKey: ["system", id],
    queryFn: () =>
      apiFetch<{ system: System; updates: CachedUpdate[]; history: HistoryEntry[] }>(
        `/systems/${id}`
      ),
    refetchInterval: (query) => {
      const op = query.state.data?.system?.activeOperation;
      return op ? 3000 : false;
    },
  });
  return query;
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
      sudoPassword?: string;
      disabledPkgManagers?: string[];
      sourceSystemId?: number;
    }) => apiFetch<{ id: number }>("/systems", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
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
      sudoPassword?: string;
      disabledPkgManagers?: string[];
    }) => apiFetch(`/systems/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["system", vars.id] });
    },
  });
}

export function useDeleteSystem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/systems/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (data: {
      hostname: string;
      port: number;
      username: string;
      authType: string;
      password?: string;
      privateKey?: string;
      keyPassphrase?: string;
      systemId?: number;
    }) =>
      apiFetch<{ success: boolean; message: string; detectedManagers?: string[] }>(
        "/systems/test-connection",
        { method: "POST", body: JSON.stringify(data) }
      ),
  });
}
