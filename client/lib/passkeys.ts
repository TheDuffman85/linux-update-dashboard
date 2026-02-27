import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";

export interface Passkey {
  id: number;
  credentialId: string;
  name: string | null;
  createdAt: string;
}

export function usePasskeys() {
  return useQuery({
    queryKey: ["passkeys"],
    queryFn: () =>
      apiFetch<{ passkeys: Passkey[] }>("/passkeys").then((r) => r.passkeys),
  });
}

export function useDeletePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/passkeys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["passkeys"] });
    },
  });
}

export function useRenamePasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiFetch(`/passkeys/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["passkeys"] });
    },
  });
}

export function useRegisterPasskey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name?: string) => {
      // Step 1: Get registration options from server
      const options = await apiFetch<Record<string, unknown>>(
        "/auth/webauthn/register/options",
        { method: "POST", body: JSON.stringify({}) }
      );

      // Step 2: Transform options for navigator.credentials.create()
      const user = options.user as Record<string, unknown>;
      const publicKeyOptions = {
        ...options,
        challenge: base64urlToBuffer(options.challenge as string),
        user: {
          ...user,
          id: base64urlToBuffer(user.id as string),
        },
        excludeCredentials: (
          options.excludeCredentials as
            | Array<{ id: string; type: string; transports?: string[] }>
            | undefined
        )?.map((c) => ({
          ...c,
          id: base64urlToBuffer(c.id),
        })),
      } as PublicKeyCredentialCreationOptions;

      // Step 3: Create credential via browser WebAuthn API
      const credential = (await navigator.credentials.create({
        publicKey: publicKeyOptions,
      })) as PublicKeyCredential;

      if (!credential) throw new Error("No credential returned");

      // Step 4: Send attestation response to server for verification
      const response =
        credential.response as AuthenticatorAttestationResponse;
      const body = {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          attestationObject: bufferToBase64url(response.attestationObject),
          clientDataJSON: bufferToBase64url(response.clientDataJSON),
          transports:
            "getTransports" in response
              ? (response as AuthenticatorAttestationResponse).getTransports()
              : [],
        },
      };

      return apiFetch("/auth/webauthn/register/verify", {
        method: "POST",
        body: JSON.stringify({ ...body, name }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["passkeys"] });
    },
  });
}

// --- base64url utilities ---

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
