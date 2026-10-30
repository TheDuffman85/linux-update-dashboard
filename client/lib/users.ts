import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { UserRole } from "../context/AuthContext";

export interface ManagedUser {
  id: number;
  username: string;
  role: UserRole;
  /** OIDC users get their role from the identity provider and can only be deleted. */
  source: "local" | "oidc";
  disabled: boolean;
  passwordChangeRequired: boolean;
  totpEnabled: boolean;
  passkeyCount: number;
  createdAt: string;
  current: boolean;
}

type UserResponse = { status: string; user: ManagedUser };

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ["users"],
    queryFn: () =>
      apiFetch<{ users: ManagedUser[] }>("/users").then((r) => r.users),
    enabled,
  });
}

function useUserMutation<T>(mutationFn: (params: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
    },
  });
}

export function useCreateUser() {
  return useUserMutation(
    (params: {
      username: string;
      password: string;
      role: UserRole;
      requirePasswordChange: boolean;
    }) =>
      apiFetch<UserResponse>("/users", {
        method: "POST",
        body: JSON.stringify(params),
      }),
  );
}

export function useUpdateUser() {
  return useUserMutation(
    ({ id, ...changes }: { id: number; role?: UserRole; disabled?: boolean }) =>
      apiFetch<UserResponse>(`/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      }),
  );
}

export function useResetUserPassword() {
  return useUserMutation(
    ({
      id,
      ...params
    }: {
      id: number;
      password: string;
      requirePasswordChange: boolean;
    }) =>
      apiFetch<UserResponse>(`/users/${id}/password`, {
        method: "POST",
        body: JSON.stringify(params),
      }),
  );
}

export function useResetUserMfa() {
  return useUserMutation((id: number) =>
    apiFetch<UserResponse>(`/users/${id}/reset-mfa`, { method: "POST" }),
  );
}

export function useDeleteUser() {
  return useUserMutation((id: number) =>
    apiFetch(`/users/${id}`, { method: "DELETE" }),
  );
}
