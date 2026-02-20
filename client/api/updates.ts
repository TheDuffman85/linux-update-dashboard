import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export function useCheckUpdates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (systemId: number) =>
      apiFetch<{ status: string; updateCount: number }>(
        `/systems/${systemId}/check`,
        { method: "POST" }
      ),
    onSuccess: (_data, systemId) => {
      qc.invalidateQueries({ queryKey: ["system", systemId] });
      qc.invalidateQueries({ queryKey: ["systems"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
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
    mutationFn: (systemId: number) =>
      apiFetch<{ status: string; output: string }>(
        `/systems/${systemId}/upgrade`,
        { method: "POST" }
      ),
    onSuccess: (_data, systemId) => {
      qc.invalidateQueries({ queryKey: ["system", systemId] });
      qc.invalidateQueries({ queryKey: ["systems"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

export function useUpgradePackage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      systemId,
      packageName,
    }: {
      systemId: number;
      packageName: string;
    }) =>
      apiFetch<{ status: string }>(`/systems/${systemId}/upgrade/${packageName}`, {
        method: "POST",
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["system", vars.systemId] });
      qc.invalidateQueries({ queryKey: ["systems"] });
    },
  });
}

export function useRefreshCache() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ status: string }>("/cache/refresh", { method: "POST" }),
    onSuccess: () => {
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["systems"] });
        qc.invalidateQueries({ queryKey: ["dashboard"] });
      }, 5000);
    },
  });
}
