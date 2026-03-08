import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export type CredentialKind =
  | "usernamePassword"
  | "sshKey"
  | "emailSmtp"
  | "ntfyToken"
  | "certificate";

export interface CredentialReference {
  type: "system" | "notification";
  id: number;
  name: string;
}

export interface CredentialSummary {
  id: number;
  name: string;
  kind: CredentialKind;
  summary: string;
  referenceCount: number;
  references: CredentialReference[];
}

export interface CredentialDetail extends CredentialSummary {
  payload: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export function useCredentials(filters?: {
  kind?: CredentialKind;
}) {
  const params = new URLSearchParams();
  if (filters?.kind) params.set("kind", filters.kind);
  const query = params.toString();

  return useQuery({
    queryKey: ["credentials", filters?.kind ?? null],
    queryFn: () =>
      apiFetch<{ credentials: CredentialSummary[] }>(
        `/credentials${query ? `?${query}` : ""}`
      ).then((r) => r.credentials),
  });
}

export function useCredential(id: number | null) {
  return useQuery({
    queryKey: ["credential", id],
    enabled: id !== null,
    queryFn: () =>
      apiFetch<{ credential: CredentialDetail }>(`/credentials/${id}`).then(
        (r) => r.credential
      ),
  });
}

export function useCreateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      kind: CredentialKind;
      payload: Record<string, string>;
    }) =>
      apiFetch<{ id: number }>("/credentials", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["credentials"] });
    },
  });
}

export function useUpdateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: number;
      name: string;
      payload: Record<string, string>;
    }) =>
      apiFetch(`/credentials/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: async (_data, vars) => {
      await qc.invalidateQueries({ queryKey: ["credentials"] });
      await qc.invalidateQueries({ queryKey: ["credential", vars.id] });
    },
  });
}

export function useDeleteCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/credentials/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["credentials"] });
    },
  });
}
