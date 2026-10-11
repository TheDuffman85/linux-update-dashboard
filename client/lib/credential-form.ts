import type { CredentialDetail, CredentialKind } from "./credentials";
import { validateRequiredText } from "./form-validation";

export const SSH_CREDENTIAL_KINDS: CredentialKind[] = [
  "usernamePassword",
  "sshKey",
  "certificate",
];

export const ALL_CREDENTIAL_KINDS: CredentialKind[] = [
  ...SSH_CREDENTIAL_KINDS,
  "secret",
];

export const CREDENTIAL_KIND_LABEL_KEYS: Record<CredentialKind, string> = {
  usernamePassword: "pages.credentials.type.usernamePassword",
  sshKey: "pages.credentials.type.sshKey",
  certificate: "pages.credentials.type.certificate",
  secret: "pages.credentials.type.secret",
};

export const MAX_SECRET_VALUE_LENGTH = 4096;

export interface CredentialFormValues {
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  certificatePem: string;
  privateKeyPem: string;
  privateKeyPassword: string;
  secretValue?: string;
}

export function validateCredentialForm(
  name: string,
  kind: CredentialKind,
  values: CredentialFormValues,
  initial?: Pick<CredentialDetail, "payload">,
): string | null {
  const nameError = validateRequiredText(name, "Name", 100);
  if (nameError) return nameError;

  if (kind === "secret") {
    const value = values.secretValue ?? "";
    if (!value && initial?.payload.value !== "(stored)") {
      return "Secret value is required";
    }
    if (value.length > MAX_SECRET_VALUE_LENGTH) {
      return `Secret value must be at most ${MAX_SECRET_VALUE_LENGTH} characters`;
    }
    if (/[\r\n\0]/.test(value)) {
      return "Secret value must be a single line";
    }
    return null;
  }

  const usernameError = validateRequiredText(values.username, "Username");
  if (usernameError) return usernameError;

  if (kind === "usernamePassword") {
    if (!values.password && initial?.payload.password !== "(stored)") {
      return "Password is required";
    }
    return null;
  }

  if (kind === "sshKey") {
    if (!values.privateKey && initial?.payload.privateKey !== "(stored)") {
      return "Private key is required";
    }
    return null;
  }

  if (!values.certificatePem && initial?.payload.certificatePem !== "(stored)") {
    return "OpenSSH certificate is required";
  }
  if (!values.privateKeyPem && initial?.payload.privateKeyPem !== "(stored)") {
    return "Private key is required";
  }

  return null;
}

export function buildCredentialPayload(
  kind: CredentialKind,
  values: CredentialFormValues,
  initial?: Pick<CredentialDetail, "payload">
): Record<string, string> {
  if (kind === "secret") {
    return {
      value:
        values.secretValue ||
        (initial?.payload.value === "(stored)" ? "(stored)" : ""),
    };
  }

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
