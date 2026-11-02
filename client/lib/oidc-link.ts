import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { UserRole } from "../context/AuthContext";

export interface OidcLinkStatus {
  /** OIDC is configured and this account has local credentials to link it to. */
  available: boolean;
  /** Links can only be changed from a password or passkey session. */
  canManage: boolean;
  username: string;
  totpEnabled: boolean;
  passwordLoginDisabled: boolean;
  /** API tokens limited by the SSO role; they become local tokens when unlinking. */
  ssoTokenCount: number;
  link: {
    issuer: string;
    username: string | null;
    role: UserRole;
    method: "verified" | "username";
    linkedAt: string;
    /** "changed": this identity can no longer sign in. "unavailable": SSO is off until the provider responds. */
    provider: "current" | "changed" | "unavailable";
  } | null;
  /** An identity the provider confirmed, waiting for the account holder to confirm the link. */
  pending: {
    issuer: string;
    username: string;
    role: UserRole;
    merge: { username: string; apiTokenCount: number } | null;
  } | null;
}

export interface AccountHolderProof {
  password: string;
  totpCode?: string;
}

export function useOidcLinkStatus() {
  return useQuery({
    queryKey: ["oidc-link"],
    queryFn: () => apiFetch<OidcLinkStatus>("/auth/oidc/link"),
  });
}

export function useStartOidcLink() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ redirectUrl: string }>("/auth/oidc/link/start", { method: "POST" }),
  });
}

function useOidcLinkChange(mutationFn: (proof: AccountHolderProof) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["oidc-link"] });
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
  });
}

export function useConfirmOidcLink() {
  return useOidcLinkChange((proof) =>
    apiFetch("/auth/oidc/link/confirm", { method: "POST", body: JSON.stringify(proof) }),
  );
}

export function useUnlinkOidc() {
  return useOidcLinkChange((proof) =>
    apiFetch("/auth/oidc/link", { method: "DELETE", body: JSON.stringify(proof) }),
  );
}
