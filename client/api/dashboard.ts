import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { System } from "./systems";

export interface DashboardStats {
  total: number;
  upToDate: number;
  needsUpdates: number;
  unreachable: number;
  totalUpdates: number;
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ["dashboard", "stats"],
    queryFn: () =>
      apiFetch<{ stats: DashboardStats }>("/dashboard/stats").then(
        (r) => r.stats
      ),
    refetchInterval: 30_000,
  });
}

export function useDashboardSystems() {
  return useQuery({
    queryKey: ["dashboard", "systems"],
    queryFn: () =>
      apiFetch<{ systems: System[] }>("/dashboard/systems").then(
        (r) => r.systems
      ),
    refetchInterval: 30_000,
  });
}
