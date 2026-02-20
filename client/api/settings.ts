import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: () =>
      apiFetch<{ settings: Record<string, string> }>("/settings").then(
        (r) => r.settings
      ),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, string>) =>
      apiFetch("/settings", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
