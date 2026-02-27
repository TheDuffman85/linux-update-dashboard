import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface ApiToken {
  id: number;
  name: string | null;
  readOnly: number;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function useApiTokens() {
  return useQuery({
    queryKey: ["api-tokens"],
    queryFn: () =>
      apiFetch<{ tokens: ApiToken[] }>("/tokens").then((r) => r.tokens),
  });
}

export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      name?: string;
      expiresInDays?: number;
      readOnly?: boolean;
    }) =>
      apiFetch<{ token: string; id: number }>("/tokens", {
        method: "POST",
        body: JSON.stringify(params),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}

export function useRenameApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiFetch(`/tokens/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}

export function useDeleteApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}
