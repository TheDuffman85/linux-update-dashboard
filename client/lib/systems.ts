import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, pollJob } from "./client";
import type { PackageManagerConfigs } from "./package-manager-configs";
import type { HostKeyStatus } from "./host-key-status";

export interface ActiveOperation {
  type: "check" | "autoremove" | "upgrade_all" | "full_upgrade_all" | "upgrade_package" | "reboot" | "package_manager_repair";
  startedAt: string;
  phase?: "queued" | "reconnecting" | "rechecking";
  packageName?: string;
  packageNames?: string[];
  cancelRequested?: boolean;
}

export interface LastCheckSummary {
  status: "success" | "warning" | "failed";
  error: string | null;
  startedAt: string;
  completedAt: string | null;
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
  hostKeyStatus: HostKeyStatus;
  proxyJumpChain: Array<{ id: number; name: string }>;
  pkgManager: string | null;
  detectedPkgManagers: string[] | null;
  disabledPkgManagers: string[] | null;
  pkgManagerConfigs: PackageManagerConfigs | null;
  autoHideKeptBackUpdates: number;
  osName: string | null;
  osVersion: string | null;
  kernel: string | null;
  hostnameRemote: string | null;
  uptime: string | null;
  uptimeSeconds: number | null;
  arch: string | null;
  cpuCores: string | null;
  memory: string | null;
  disk: string | null;
  bootId: string | null;
  rebootDismissedBootId: string | null;
  rebootDismissedUptimeSeconds: number | null;
  rebootDismissedAt: string | null;
  excludeFromUpgradeAll: number;
  upgradeGroupId: number | null;
  upgradeOrder: number;
  hidden: number;
  needsReboot: number;
  isReachable: number;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  updateCount: number;
  securityCount: number;
  keptBackCount: number;
  lastCheck: LastCheckSummary | null;
  cacheAge: string | null;
  cacheTimestamp?: string | null;
  isStale?: boolean;
  activeOperation?: ActiveOperation | null;
  supportsFullUpgrade?: boolean;
  autoremoveSupport?: {
    supportedManagers: string[];
    skippedManagers: string[];
  };
  packageIssueCount?: number;
  scriptOverrides: Record<string, string>;
}

export interface UpgradeGroup {
  id: number;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpgradeGroupConfig {
  groups: UpgradeGroup[];
  ungroupedSortOrder: number;
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
  isKeptBack: number;
  cachedAt: string;
}

export interface InstalledPackage {
  id: number;
  systemId: number;
  pkgManager: string;
  packageName: string;
  currentVersion: string;
  architecture: string | null;
  repository: string | null;
  cachedAt: string;
}

export interface HiddenUpdate {
  id: number;
  systemId: number;
  pkgManager: string;
  packageName: string;
  currentVersion: string | null;
  newVersion: string | null;
  architecture: string | null;
  repository: string | null;
  isSecurity: number;
  isKeptBack: number;
  active: number;
  lastMatchedAt: string;
  inactiveSince: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PackageManagerIssue {
  id: number;
  systemId: number;
  pkgManager: string;
  issueKey: string;
  title: string;
  message: string;
  repairCommand: string | null;
  active: number;
  dismissedBootId: string | null;
  dismissedUptimeSeconds: number | null;
  dismissedAt: string | null;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ActivityStepStatus = "success" | "warning" | "failed" | "started" | "cancelled";

export interface ActivityStep {
  label: string | null;
  pkgManager: string;
  command: string;
  output: string | null;
  error: string | null;
  status: ActivityStepStatus;
  startedAt?: string | null;
  completedAt?: string | null;
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
  steps: ActivityStep[] | null;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PotentialCommandEntry {
  id: string;
  category: "detection" | "system_info" | "check" | "list_installed_packages" | "repair_issue" | "autoremove" | "upgrade_all" | "full_upgrade_all" | "upgrade_selected" | "reboot";
  label: string;
  purpose: string;
  pkgManager: string | null;
  command: string;
  sourceCommand?: string;
  sudoersSafety?: "exact" | "package_placeholder" | "unsafe";
  requiresWildcard?: boolean;
  requiresPasswordLauncher?: boolean;
  warnings?: string[];
}

export interface CommandReferenceWarning {
  id: string;
  category: PotentialCommandEntry["category"];
  label: string;
  pkgManager: string | null;
  message: string;
  command?: string;
}

export interface CommandReference {
  exact: PotentialCommandEntry[];
  sudoers: PotentialCommandEntry[];
  warnings: CommandReferenceWarning[];
}

export interface SudoersPreviewWarning extends CommandReferenceWarning {}

export interface SudoersPreview {
  username: string;
  filePath: string;
  required: boolean;
  resolution: "resolved" | "fallback";
  resolutionError: string | null;
  content: string;
  warnings: SudoersPreviewWarning[];
}

export interface SystemDetailResponse {
  system: System;
  updates: CachedUpdate[];
  installedPackages: InstalledPackage[];
  hiddenUpdates: HiddenUpdate[];
  packageIssues: PackageManagerIssue[];
  history: HistoryEntry[];
  commandReference: CommandReference;
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

export function useSystem(id: number, options?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: ["system", id],
    enabled: options?.enabled ?? true,
    queryFn: () =>
      apiFetch<SystemDetailResponse>(
        `/systems/${id}`
      ),
    refetchInterval: (query) => {
      const op = query.state.data?.system?.activeOperation;
      return op ? 3000 : 30_000;
    },
  });
  return query;
}

export function useSudoersPreview(id: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["system", id, "sudoers-preview"],
    enabled: options?.enabled ?? true,
    queryFn: () => apiFetch<SudoersPreview>(`/systems/${id}/sudoers-preview`),
  });
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
      detectedPkgManagers?: string[];
      pkgManagerConfigs?: PackageManagerConfigs | null;
      autoHideKeptBackUpdates?: boolean;
      excludeFromUpgradeAll?: boolean;
      hidden?: boolean;
      scriptOverrides?: Record<string, string | null | undefined>;
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
      detectedPkgManagers?: string[];
      pkgManagerConfigs?: PackageManagerConfigs | null;
      autoHideKeptBackUpdates?: boolean;
      excludeFromUpgradeAll?: boolean;
      hidden?: boolean;
      scriptOverrides?: Record<string, string | null | undefined>;
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

export function useReorderSystemUpgradeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (systemIds: number[]) =>
      apiFetch("/systems/upgrade-order", {
        method: "PUT",
        body: JSON.stringify({ systemIds }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUpgradeGroups() {
  return useQuery({
    queryKey: ["upgrade-groups"],
    queryFn: () =>
      apiFetch<UpgradeGroupConfig>("/systems/upgrade-groups"),
  });
}

function invalidateUpgradeGroupQueries(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["upgrade-groups"] });
  void qc.invalidateQueries({ queryKey: ["systems"] });
  void qc.invalidateQueries({ queryKey: ["system"] });
  void qc.invalidateQueries({ queryKey: ["dashboard"] });
}

export function useCreateUpgradeGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ id: number }>("/systems/upgrade-groups", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => invalidateUpgradeGroupQueries(qc),
  });
}

export function useUpdateUpgradeGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, name }: { groupId: number; name: string }) =>
      apiFetch(`/systems/upgrade-groups/${groupId}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => invalidateUpgradeGroupQueries(qc),
  });
}

export function useDeleteUpgradeGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupId: number) =>
      apiFetch(`/systems/upgrade-groups/${groupId}`, { method: "DELETE" }),
    onSuccess: () => invalidateUpgradeGroupQueries(qc),
  });
}

export function useReorderUpgradeGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (groupKeys: Array<number | "ungrouped">) =>
      apiFetch("/systems/upgrade-groups/reorder", {
        method: "PUT",
        body: JSON.stringify({ groupKeys }),
      }),
    onSuccess: () => invalidateUpgradeGroupQueries(qc),
  });
}

export function useUpdateSystemUpgradeGroups() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: Array<{ systemId: number; groupId: number | null; upgradeOrder: number }>) =>
      apiFetch("/systems/upgrade-groups/systems", {
        method: "PUT",
        body: JSON.stringify({ items }),
      }),
    onSuccess: () => invalidateUpgradeGroupQueries(qc),
  });
}

export function useUpdateSystemUpgradeMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      systemId,
      fullUpgrade,
    }: {
      systemId: number;
      fullUpgrade: boolean;
    }) =>
      apiFetch(`/systems/${systemId}/upgrade-mode`, {
        method: "PUT",
        body: JSON.stringify({ fullUpgrade }),
      }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      await qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
    },
  });
}

export function useUpdateSystemUpgradeAllExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      systemId,
      excluded,
    }: {
      systemId: number;
      excluded: boolean;
    }) =>
      apiFetch(`/systems/${systemId}/upgrade-all-exclusion`, {
        method: "PUT",
        body: JSON.stringify({ excluded }),
      }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
      await qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
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
      apiFetch<{ success: boolean; message: string; blocked?: boolean }>(`/systems/${id}/reboot`, { method: "POST" }),
    onSuccess: async (_data, id) => {
      await qc.invalidateQueries({ queryKey: ["system", id] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
    },
  });
}

export function useDismissNeedsReboot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ status: string }>(`/systems/${id}/dismiss-needs-reboot`, { method: "POST" }),
    onSuccess: async (_data, id) => {
      await qc.invalidateQueries({ queryKey: ["system", id] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useSolvePackageIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ systemId, issueId }: { systemId: number; issueId: number }) => {
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/package-issues/${issueId}/solve`,
        { method: "POST" },
      );
      return pollJob<{ status: string; output: string }>(jobId, 3000);
    },
    onSettled: async (_data, _error, vars) => {
      if (!vars) return;
      await qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useDismissPackageIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ systemId, issueId }: { systemId: number; issueId: number }) =>
      apiFetch<{ status: string }>(
        `/systems/${systemId}/package-issues/${issueId}/dismiss`,
        { method: "POST" },
      ),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
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
