import type { System } from "./systems";

/**
 * Dashboard status filters, usable in the system search as `is:<filter>`
 * (or `-is:<filter>` to exclude). The predicates mirror the counts returned
 * by `/api/dashboard/stats`, so clicking a stat card shows exactly the
 * systems it counts.
 */
export type DashboardStatusFilter =
  | "uptodate"
  | "updates"
  | "reboot"
  | "os-warning"
  | "issues"
  | "unreachable";

type FilterableSystem = Pick<System, "updateCount" | "isReachable" | "needsReboot" | "osLifecycleStatus" | "lastCheck">;

const FILTER_ALIASES: Record<string, DashboardStatusFilter> = {
  uptodate: "uptodate",
  "up-to-date": "uptodate",
  updates: "updates",
  outdated: "updates",
  reboot: "reboot",
  "os-warning": "os-warning",
  lifecycle: "os-warning",
  issues: "issues",
  "check-issues": "issues",
  unreachable: "unreachable",
  offline: "unreachable",
};

const FILTER_TOKEN = /^(-?)is:([a-z-]+)$/i;

function hasCheckIssue(system: FilterableSystem): boolean {
  return system.lastCheck?.status === "failed" || system.lastCheck?.status === "warning";
}

function hasLifecycleWarning(system: FilterableSystem): boolean {
  return (
    system.osLifecycleStatus === "eol" ||
    system.osLifecycleStatus === "approaching_eol" ||
    system.osLifecycleStatus === "support_ending" ||
    system.osLifecycleStatus === "support_ended"
  );
}

const FILTER_PREDICATES: Record<DashboardStatusFilter, (system: FilterableSystem) => boolean> = {
  uptodate: (s) => s.updateCount === 0 && s.isReachable === 1 && !hasCheckIssue(s) && !hasLifecycleWarning(s),
  updates: (s) => s.updateCount > 0 && !hasCheckIssue(s),
  reboot: (s) => s.needsReboot === 1,
  "os-warning": hasLifecycleWarning,
  issues: hasCheckIssue,
  unreachable: (s) => s.isReachable === -1,
};

export interface ParsedDashboardSearch {
  filters: Array<{ filter: DashboardStatusFilter; negated: boolean }>;
  text: string;
}

/** Splits `is:` filter tokens from the free-text part of a search. Unknown `is:` values stay text. */
export function parseDashboardSearch(search: string): ParsedDashboardSearch {
  const filters: ParsedDashboardSearch["filters"] = [];
  const text: string[] = [];
  for (const token of search.trim().split(/\s+/)) {
    if (!token) continue;
    const match = FILTER_TOKEN.exec(token);
    const filter = match ? FILTER_ALIASES[match[2].toLowerCase()] : undefined;
    if (match && filter) filters.push({ filter, negated: match[1] === "-" });
    else text.push(token);
  }
  return { filters, text: text.join(" ") };
}

export function filterSystemsByStatus<T extends FilterableSystem>(
  systems: T[],
  filters: ParsedDashboardSearch["filters"],
): T[] {
  if (filters.length === 0) return systems;
  return systems.filter((system) =>
    filters.every(({ filter, negated }) => FILTER_PREDICATES[filter](system) !== negated),
  );
}

export function isDashboardStatusFilterActive(search: string, filter: DashboardStatusFilter): boolean {
  const { filters } = parseDashboardSearch(search);
  return filters.length === 1 && filters[0].filter === filter && !filters[0].negated;
}

/**
 * Stat card click: show only systems matching `filter` (replacing any other
 * status filters), or remove it when it is already the active one. Passing
 * `null` clears all status filters. Free-text search terms are kept.
 */
export function toggleDashboardStatusFilter(search: string, filter: DashboardStatusFilter | null): string {
  const { text } = parseDashboardSearch(search);
  if (filter === null || isDashboardStatusFilterActive(search, filter)) return text;
  return [`is:${filter}`, text].filter(Boolean).join(" ");
}
