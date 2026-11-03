import type { ApiTokenPermission } from "../../shared/api-token-permissions";

interface TokenWriteRule {
  method: string;
  path: string;
  /** Holding any of these allows the route. Empty when `blocked` closes it to every token. */
  anyOf: readonly ApiTokenPermission[];
  blocked?: string;
}

function allow(method: string, path: string, ...anyOf: ApiTokenPermission[]): TokenWriteRule {
  return { method, path, anyOf };
}

function block(method: string, path: string, reason: string): TokenWriteRule {
  return { method, path, anyOf: [], blocked: reason };
}

/**
 * Every state-changing route an API token can reach outside the management
 * areas. Routes that are not listed are denied, so a new route stays closed to
 * tokens until it is added here. tests/server/api-token-permissions.test.ts
 * keeps this table in sync with the routes of the app.
 *
 * Literal paths come before parameterized ones, because the first match wins.
 */
export const TOKEN_WRITE_RULES: readonly TokenWriteRule[] = [
  allow("POST", "/api/cache/refresh", "updates:check"),
  allow("POST", "/api/systems/check-all", "updates:check"),
  allow("POST", "/api/systems/:id/check", "updates:check"),
  allow("POST", "/api/systems/:id/cancel", "updates:check"),

  allow("POST", "/api/systems/upgrade-all", "updates:apply"),
  allow("POST", "/api/systems/:id/upgrade", "updates:apply"),
  allow("POST", "/api/systems/:id/full-upgrade", "updates:apply"),
  allow("POST", "/api/systems/:id/autoremove", "updates:apply"),
  allow("POST", "/api/systems/:id/upgrade-packages", "updates:apply"),
  allow("POST", "/api/systems/:id/upgrade/:packageName", "updates:apply"),
  allow("POST", "/api/systems/:id/package-issues/:issueId/solve", "updates:apply"),
  allow("POST", "/api/systems/:id/reboot", "updates:apply"),
  allow("POST", "/api/systems/:id/post-upgrade-script/run", "updates:apply"),

  allow("POST", "/api/systems/dashboard-groups", "systems:organize"),
  allow("PUT", "/api/systems/dashboard-groups/reorder", "systems:organize"),
  allow("PUT", "/api/systems/dashboard-groups/systems", "systems:organize"),
  allow("PUT", "/api/systems/dashboard-groups/update-priority", "systems:organize"),
  allow("PUT", "/api/systems/dashboard-groups/:id", "systems:organize"),
  allow("DELETE", "/api/systems/dashboard-groups/:id", "systems:organize"),
  allow("PUT", "/api/systems/reorder", "systems:organize"),
  allow("PUT", "/api/systems/:id/upgrade-mode", "systems:organize"),
  allow("PUT", "/api/systems/:id/update-priority", "systems:organize"),
  allow("PUT", "/api/systems/:id/upgrade-all-exclusion", "systems:organize"),
  allow("POST", "/api/systems/:id/hidden-updates", "systems:organize"),
  allow("DELETE", "/api/systems/:id/hidden-updates/:hiddenUpdateId", "systems:organize"),
  allow("POST", "/api/systems/:id/package-issues/:issueId/dismiss", "systems:organize"),
  allow("POST", "/api/systems/:id/dismiss-needs-reboot", "systems:organize"),
  allow("POST", "/api/systems/:id/dismiss-post-upgrade-pending", "systems:organize"),
  allow("POST", "/api/systems/:id/dismiss-root-user-banner", "systems:organize"),
  allow("POST", "/api/systems/:id/dismiss-os-lifecycle-warning", "systems:organize"),
  // Clearing a key only stops connections until it is trusted again. Read/write
  // tokens could always do this, so it stays with them instead of moving to edit.
  allow("POST", "/api/systems/:id/revoke-host-key", "systems:organize", "systems:edit"),

  allow("POST", "/api/systems", "systems:add"),
  allow("POST", "/api/systems/test-connection", "systems:add", "systems:edit"),
  allow("PUT", "/api/systems/:id", "systems:edit"),
  allow("DELETE", "/api/systems/:id", "systems:remove"),

  block("PUT", "/api/systems/:id/script-overrides", "API tokens cannot modify script overrides"),
  block("PUT", "/api/systems/:id/repository-sources", "API tokens cannot modify repository sources"),
];

function pathMatches(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  return (
    patternParts.length === pathParts.length &&
    patternParts.every(
      (part, index) => part === pathParts[index] || (part.startsWith(":") && pathParts[index] !== ""),
    )
  );
}

export function findTokenWriteRule(method: string, path: string): TokenWriteRule | undefined {
  return TOKEN_WRITE_RULES.find((rule) => rule.method === method && pathMatches(rule.path, path));
}

/** Why a token may not call a state-changing route, or null when it may. */
export function getTokenWriteDenial(
  method: string,
  path: string,
  permissions: readonly ApiTokenPermission[],
): string | null {
  const rule = findTokenWriteRule(method, path);
  if (!rule) return "API tokens cannot use this endpoint";
  if (rule.blocked) return rule.blocked;
  if (rule.anyOf.some((permission) => permissions.includes(permission))) return null;
  return `This token needs the ${rule.anyOf.join(" or ")} permission`;
}
