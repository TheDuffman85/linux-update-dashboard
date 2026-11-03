/**
 * Permissions of an API token, shared by the server (enforcement) and the
 * client (token form). Every token can read; these grant the write actions.
 */

export const API_TOKEN_PERMISSIONS = [
  "updates:check",
  "updates:apply",
  "systems:organize",
  "systems:remove",
  "systems:add",
  "systems:edit",
] as const;

export type ApiTokenPermission = (typeof API_TOKEN_PERMISSIONS)[number];

export function isApiTokenPermission(value: unknown): value is ApiTokenPermission {
  return (API_TOKEN_PERMISSIONS as readonly unknown[]).includes(value);
}

/** Known permissions from a stored list, in canonical order. Malformed values grant nothing. */
export function parseApiTokenPermissions(stored: string): ApiTokenPermission[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return API_TOKEN_PERMISSIONS.filter((permission) => parsed.includes(permission));
}
