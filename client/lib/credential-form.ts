import type { CredentialDetail, CredentialKind } from "./credentials";

export const SSH_CREDENTIAL_KINDS: CredentialKind[] = [
  "usernamePassword",
  "sshKey",
  "certificate",
];

export const CREDENTIAL_KIND_LABELS: Record<CredentialKind, string> = {
  usernamePassword: "User / Password",
  sshKey: "SSH Key",
  certificate: "Certificate",
};

export interface CredentialFormValues {
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  certificatePem: string;
  privateKeyPem: string;
  privateKeyPassword: string;
}

export function buildCredentialPayload(
  kind: CredentialKind,
  values: CredentialFormValues,
  initial?: Pick<CredentialDetail, "payload">
): Record<string, string> {
  if (kind === "usernamePassword") {
    return {
      username: values.username,
      password:
        values.password ||
        (initial?.payload.password === "(stored)" ? "(stored)" : ""),
    };
  }

  if (kind === "sshKey") {
    return {
      username: values.username,
      privateKey:
        values.privateKey ||
        (initial?.payload.privateKey === "(stored)" ? "(stored)" : ""),
      passphrase:
        values.passphrase ||
        (initial?.payload.passphrase === "(stored)" ? "(stored)" : ""),
    };
  }

  return {
    username: values.username,
    certificatePem:
      values.certificatePem ||
      (initial?.payload.certificatePem === "(stored)" ? "(stored)" : ""),
    privateKeyPem:
      values.privateKeyPem ||
      (initial?.payload.privateKeyPem === "(stored)" ? "(stored)" : ""),
    privateKeyPassword:
      values.privateKeyPassword ||
      (initial?.payload.privateKeyPassword === "(stored)" ? "(stored)" : ""),
  };
}
