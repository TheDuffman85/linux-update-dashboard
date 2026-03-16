const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9._:-]*[a-zA-Z0-9])?$/;

export function validateRequiredText(
  value: string,
  label: string,
  maxLength?: number,
): string | null {
  if (!value.trim()) {
    return `${label} is required`;
  }

  if (maxLength !== undefined && value.trim().length > maxLength) {
    return `${label} must be ${maxLength} characters or less`;
  }

  return null;
}

export function validatePassword(value: string): string | null {
  if (value.length < 8) return "Password must be at least 8 characters";
  if (!/[a-z]/.test(value)) return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(value)) return "Password must contain an uppercase letter";
  if (!/\d/.test(value)) return "Password must contain a digit";
  return null;
}

export function validateEmail(value: string, label: string): string | null {
  if (!EMAIL_RE.test(value.trim())) {
    return `Invalid ${label.toLowerCase()}`;
  }

  return null;
}

export function validateEmailList(value: string, label: string): string | null {
  const addresses = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (addresses.length === 0) {
    return `${label} is required`;
  }

  for (const address of addresses) {
    if (!EMAIL_RE.test(address)) {
      return `Invalid email address: ${address}`;
    }
  }

  return null;
}

export function validateInteger(
  value: number,
  label: string,
  min: number,
  max: number,
): string | null {
  if (!Number.isInteger(value) || value < min || value > max) {
    return `${label} must be between ${min} and ${max}`;
  }

  return null;
}

export function validateHttpUrl(value: string, label: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `${label} must use http or https`;
    }
  } catch {
    return `${label} must be a valid URL`;
  }

  return null;
}

export function validateHostname(value: string): string | null {
  if (!value || value.length > 255 || !VALID_HOSTNAME.test(value)) {
    return "Hostname is required and must be a valid hostname or IP";
  }

  return null;
}
