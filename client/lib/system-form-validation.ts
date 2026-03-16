import { validateHostname, validateInteger, validateRequiredText } from "./form-validation";

export function validateSystemForm(data: {
  name: string;
  hostname: string;
  port: number;
  credentialId: number;
  proxyJumpSystemId?: number | null;
}): string | null {
  const nameError = validateRequiredText(data.name, "Display name", 255);
  if (nameError) return nameError;

  const hostnameError = validateHostname(data.hostname);
  if (hostnameError) return hostnameError;

  const portError = validateInteger(data.port, "SSH port", 1, 65535);
  if (portError) return portError;

  if (!Number.isInteger(data.credentialId) || data.credentialId <= 0) {
    return "SSH credential is required";
  }

  if (
    data.proxyJumpSystemId !== undefined &&
    data.proxyJumpSystemId !== null &&
    (!Number.isInteger(data.proxyJumpSystemId) || data.proxyJumpSystemId <= 0)
  ) {
    return "Proxy Jump system must be a positive integer";
  }

  return null;
}
