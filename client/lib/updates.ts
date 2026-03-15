import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, pollJob } from "./client";

export function useCheckUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (systemId: number) => {
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/check`,
        { method: "POST" }
      );
      return pollJob<{ updateCount: number }>(jobId);
    },
    onSuccess: async (_data, systemId) => {
      await qc.invalidateQueries({ queryKey: ["system", systemId] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
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

export function useUpgradeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (systemId: number) => {
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/upgrade`,
        { method: "POST" }
      );
      return pollJob<{ status: string; output: string }>(jobId, 3000);
    },
    onSuccess: async (_data, systemId) => {
      await qc.invalidateQueries({ queryKey: ["system", systemId] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
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
      return pollJob<{ status: string; output: string }>(jobId, 3000);
    },
    onSuccess: async (_data, systemId) => {
      await qc.invalidateQueries({ queryKey: ["system", systemId] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
      await qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUpgradePackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      systemId,
      packageName,
    }: {
      systemId: number;
      packageName: string;
    }) => {
      const { jobId } = await apiFetch<{ status: string; jobId: string }>(
        `/systems/${systemId}/upgrade/${packageName}`,
        { method: "POST" }
      );
      return pollJob<{ status: string; package: string; output: string }>(jobId, 3000);
    },
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
      await qc.invalidateQueries({ queryKey: ["systems"] });
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
