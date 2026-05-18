import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch, pollJob } from "./client";

export type DefaultUpgradeModeOverride = "standard" | "aggressive";
export const LOST_UPGRADE_JOB_RECOVERY_OUTPUT =
  "The backend restarted before the job result could be read. Dashboard state was resynced from the server.";

async function invalidateSystemOperationQueries(qc: QueryClient, systemId: number): Promise<void> {
  await qc.invalidateQueries({ queryKey: ["system", systemId] });
  await qc.invalidateQueries({ queryKey: ["systems"] });
  await qc.invalidateQueries({ queryKey: ["dashboard"] });
}

export async function recoverLostUpgradeJob<T extends { status: string; output: string }>(
  qc: QueryClient,
  systemId: number,
  result: Partial<T> = {},
): Promise<T> {
  await invalidateSystemOperationQueries(qc, systemId);
  return {
    ...result,
    status: "warning",
    output: LOST_UPGRADE_JOB_RECOVERY_OUTPUT,
  } as T;
}

export function useCheckUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (systemId: number) => {
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/check`,
        { method: "POST" }
      );
      return pollJob<{ updateCount: number; status?: string }>(jobId);
    },
    onSettled: async (_data, _error, systemId) => {
      if (systemId !== undefined) {
        await invalidateSystemOperationQueries(qc, systemId);
      }
    },
  });
}

export function useCheckAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ status: string }>("/systems/check-all", { method: "POST" }),
    onSuccess: () => {
      // Will be stale until checks complete, poll will pick up changes
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["systems"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      }, 5000);
    },
  });
}

export function useCancelOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (systemId: number) =>
      apiFetch<{ status: string }>(`/systems/${systemId}/cancel`, {
        method: "POST",
      }),
    onSettled: async (_data, _error, systemId) => {
      if (systemId !== undefined) {
        await invalidateSystemOperationQueries(qc, systemId);
      }
    },
  });
}

export function useUpgradeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: number | {
      systemId: number;
      defaultUpgradeModeOverride?: DefaultUpgradeModeOverride;
    }) => {
      const systemId = typeof vars === "number" ? vars : vars.systemId;
      const defaultUpgradeModeOverride =
        typeof vars === "number" ? undefined : vars.defaultUpgradeModeOverride;
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/upgrade`,
        {
          method: "POST",
          body: defaultUpgradeModeOverride
            ? JSON.stringify({ defaultUpgradeModeOverride })
            : undefined,
        }
      );
      return pollJob<{ status: string; output: string }>(jobId, 3000, 300, {
        recoverMissingJob: () => recoverLostUpgradeJob(qc, systemId),
      });
    },
    onSettled: async (_data, _error, vars) => {
      const systemId = typeof vars === "number" ? vars : vars?.systemId;
      if (systemId !== undefined) {
        await invalidateSystemOperationQueries(qc, systemId);
      }
    },
  });
}

export function useFullUpgradeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (systemId: number) => {
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/full-upgrade`,
        { method: "POST" }
      );
      return pollJob<{ status: string; output: string }>(jobId, 3000, 300, {
        recoverMissingJob: () => recoverLostUpgradeJob(qc, systemId),
      });
    },
    onSettled: async (_data, _error, systemId) => {
      if (systemId !== undefined) {
        await invalidateSystemOperationQueries(qc, systemId);
      }
    },
  });
}

export function useUpgradePackage() {
  const upgradePackages = useUpgradePackages();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      systemId,
      packageName,
    }: {
      systemId: number;
      packageName: string;
    }) => {
      const result = await upgradePackages.mutateAsync({
        systemId,
        packageNames: [packageName],
      });
      return {
        ...result,
        package: packageName,
      };
    },
    onSettled: async (_data, _error, vars) => {
      if (vars) {
        await invalidateSystemOperationQueries(qc, vars.systemId);
      }
    },
  });
}

export function useUpgradePackages() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      systemId,
      packageNames,
    }: {
      systemId: number;
      packageNames: string[];
    }) => {
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/upgrade-packages`,
        {
          method: "POST",
          body: JSON.stringify({ packageNames }),
        }
      );
      return pollJob<{ status: string; packageCount: number; packages: string[]; output: string }>(jobId, 3000, 300, {
        recoverMissingJob: () =>
          recoverLostUpgradeJob<{
            status: string;
            packageCount: number;
            packages: string[];
            output: string;
          }>(qc, systemId, {
            packageCount: packageNames.length,
            packages: packageNames,
          }),
      });
    },
    onSettled: async (_data, _error, vars) => {
      if (vars) {
        await invalidateSystemOperationQueries(qc, vars.systemId);
      }
    },
  });
}

export function useHideUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      systemId,
      pkgManager,
      packageName,
      newVersion,
    }: {
      systemId: number;
      pkgManager: string;
      packageName: string;
      newVersion: string;
    }) =>
      apiFetch(`/systems/${systemId}/hidden-updates`, {
        method: "POST",
        body: JSON.stringify({ pkgManager, packageName, newVersion }),
      }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUnhideUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      systemId,
      hiddenUpdateId,
    }: {
      systemId: number;
      hiddenUpdateId: number;
    }) =>
      apiFetch(`/systems/${systemId}/hidden-updates/${hiddenUpdateId}`, {
        method: "DELETE",
      }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useRefreshCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ status: string }>("/cache/refresh", { method: "POST" }),
    onSuccess: async () => {
      // Invalidate immediately — the server has already set activeOperation
      // on each system, so the refetch will show "Checking..." state on cards.
      // The dashboard's 3-second polling (triggered by activeOperation) then
      // picks up results as each check completes.
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}
