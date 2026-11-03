import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { ApiTokenPermission } from "../../shared/api-token-permissions";

export interface ApiToken {
  id: number;
  name: string | null;
  /** Write permissions the token holds; empty for a token that can only read. */
  permissions: ApiTokenPermission[];
  /** "oidc" tokens are limited by the SSO role of a linked account. */
  roleSource?: "local" | "oidc";
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function useApiTokens(enabled = true) {
  return useQuery({
    queryKey: ["api-tokens"],
    queryFn: () =>
      apiFetch<{ tokens: ApiToken[] }>("/tokens").then((r) => r.tokens),
    enabled,
  });
}

export function useCreateApiToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: {
      name?: string;
      expiresInDays?: number;
      permissions?: ApiTokenPermission[];
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
