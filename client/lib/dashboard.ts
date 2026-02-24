import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { System } from "./systems";

export interface DashboardStats {
  total: number;
  upToDate: number;
  needsUpdates: number;
  unreachable: number;
  totalUpdates: number;
  needsReboot: number;
}

export function useDashboardStats(hasActiveOps?: boolean) {
  return useQuery({
    queryKey: ["dashboard", "stats"],
    queryFn: () =>
      apiFetch<{ stats: DashboardStats }>("/dashboard/stats").then(
        (r) => r.stats
      ),
    refetchInterval: hasActiveOps ? 3000 : 30_000,
  });
}

export function useDashboardSystems(hasClientActiveOps?: boolean) {
  return useQuery({
    queryKey: ["dashboard", "systems"],
    queryFn: () =>
      apiFetch<{ systems: System[] }>("/dashboard/systems").then(
        (r) => r.systems
      ),
    refetchInterval: (query) => {
      const hasServerActiveOps = query.state.data?.some((s) => s.activeOperation);
      return (hasServerActiveOps || hasClientActiveOps) ? 3000 : 30_000;
    },
  });
}
