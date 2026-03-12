import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface ActiveOperation {
  type: "check" | "upgrade_all" | "full_upgrade_all" | "upgrade_package" | "reboot";
  startedAt: string;
  packageName?: string;
}

export interface System {
  id: number;
  sortOrder: number;
  name: string;
  hostname: string;
  port: number;
  credentialId: number | null;
  proxyJumpSystemId: number | null;
  authType: string;
  username: string;
  hostKeyVerificationEnabled: number;
  approvedHostKey: string | null;
  trustedHostKeyAlgorithm: string | null;
  trustedHostKeyFingerprintSha256: string | null;
  hostKeyTrustedAt: string | null;
  hostKeyStatus: "verified" | "verification_disabled" | "needs_approval";
  proxyJumpChain: Array<{ id: number; name: string }>;
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
  ignoreKeptBackPackages: number;
  excludeFromUpgradeAll: number;
  hidden: number;
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
      return hasActiveOps ? 3000 : 30_000;
    },
  });
}

export function useVisibleSystems() {
  return useQuery({
    queryKey: ["systems", "visible"],
    queryFn: () =>
      apiFetch<{ systems: System[] }>("/systems?scope=visible").then((r) => r.systems),
    refetchInterval: (query) => {
      const hasActiveOps = query.state.data?.some((s) => s.activeOperation);
      return hasActiveOps ? 3000 : 30_000;
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
      return op ? 3000 : 30_000;
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
      credentialId: number;
      proxyJumpSystemId?: number | null;
      hostKeyVerificationEnabled?: boolean;
      validatedConfigToken?: string;
      sudoPassword?: string;
      disabledPkgManagers?: string[];
      ignoreKeptBackPackages?: boolean;
      excludeFromUpgradeAll?: boolean;
      hidden?: boolean;
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
      credentialId: number;
      proxyJumpSystemId?: number | null;
      hostKeyVerificationEnabled?: boolean;
      validatedConfigToken?: string;
      sudoPassword?: string;
      disabledPkgManagers?: string[];
      ignoreKeptBackPackages?: boolean;
      excludeFromUpgradeAll?: boolean;
      hidden?: boolean;
    }) => apiFetch(`/systems/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      await qc.invalidateQueries({ queryKey: ["system", vars.id] });
    },
  });
}

export function useReorderSystems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (systemIds: number[]) =>
      apiFetch("/systems/reorder", {
        method: "PUT",
        body: JSON.stringify({ systemIds }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
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

export function useRebootSystem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean; message: string }>(`/systems/${id}/reboot`, { method: "POST" }),
    onSuccess: async (_data, id) => {
      await qc.invalidateQueries({ queryKey: ["system", id] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: (data: {
      hostname: string;
      port: number;
      credentialId: number;
      proxyJumpSystemId?: number | null;
      hostKeyVerificationEnabled?: boolean;
      trustChallengeToken?: string;
      approvedHostKeys?: Array<{
        systemId?: number;
        role: "jump" | "target";
        host: string;
        port: number;
        algorithm: string;
        fingerprintSha256: string;
        rawKey: string;
      }>;
      systemId?: number;
      sourceSystemId?: number;
    }) =>
      apiFetch<{
        success: boolean;
        message: string;
        debugRef?: string;
        detectedManagers?: string[];
        validatedConfigToken?: string;
        trustChallengeToken?: string;
        hostKeyChallenges?: Array<{
          systemId?: number;
          role: "jump" | "target";
          host: string;
          port: number;
          algorithm: string;
          fingerprintSha256: string;
          rawKey: string;
        }>;
      }>(
        "/systems/test-connection",
        { method: "POST", body: JSON.stringify(data) }
      ),
  });
}

export function useRevokeHostKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ status: string }>(`/systems/${id}/revoke-host-key`, {
        method: "POST",
      }),
    onSuccess: async (_data, id) => {
      await qc.invalidateQueries({ queryKey: ["system", id] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
    },
  });
}
