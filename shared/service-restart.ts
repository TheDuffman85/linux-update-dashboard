/**
 * Services that keep running replaced binaries or libraries after an upgrade.
 * Shared by the server (detection, restart validation) and the client (display,
 * skip-list editing).
 */

export type ServiceRestartScanStatus =
  /** Every process was scanned (root or allowed sudo). */
  | "ok"
  /** No root or sudo: only the SSH user's own processes could be scanned. */
  | "partial"
  /** sudo refused the scan, usually because the sudoers rule is missing. */
  | "denied"
  /** The host lacks what the scan needs, such as /bin/grep, or it did not run. */
  | "unsupported";

export type ServiceRestartInitSystem = "systemd" | "openrc" | "other";

export interface ServiceRestartProcess {
  pid: number;
  comm: string;
}

export interface ServiceRestartService {
  /** systemd unit (`nginx.service`) or OpenRC service name (`nginx`). */
  unit: string;
  processes: ServiceRestartProcess[];
  /** A sample of the replaced files the service still maps. */
  files: string[];
}

export interface ServiceRestartInfo {
  status: ServiceRestartScanStatus;
  init: ServiceRestartInitSystem;
  services: ServiceRestartService[];
  /** PID 1 maps replaced files; only `systemctl daemon-reexec` or a reboot fixes it. */
  managerNeedsReexec: boolean;
  /** Processes in user sessions; they are left to the users that own them. */
  sessionProcessCount: number;
  /** Processes outside a service, such as VMs or manually started daemons. */
  otherProcesses: ServiceRestartProcess[];
  /**
   * Set once services were restarted from this scan. Restarted services are
   * removed, but the rest is unconfirmed until the next scan replaces it.
   */
  stale?: boolean;
}

/**
 * Services that are listed but not restarted by default, because a restart
 * drops sessions, network, containers, guests, or cluster membership.
 * Patterns match the unit name with or without its `.service` suffix.
 */
export const DEFAULT_SERVICE_RESTART_SKIP_PATTERNS: readonly string[] = [
  "dbus",
  "dbus-broker",
  "systemd-logind",
  "getty@*",
  "serial-getty@*",
  "user@*",
  "display-manager",
  "gdm*",
  "sddm",
  "lightdm",
  "networking",
  "NetworkManager",
  "systemd-networkd",
  "wpa_supplicant",
  "docker",
  "containerd",
  "podman",
  "libvirtd",
  "lxc*",
  "pve-cluster",
  "pve-guests",
  "pve-ha-*",
  "corosync",
  "unattended-upgrades",
];

export const MAX_SERVICE_RESTART_SKIP_PATTERNS = 100;
/** Services one restart request may name. */
export const MAX_SERVICES_PER_RESTART = 50;
const SKIP_PATTERN = /^[A-Za-z0-9@._:*?-]{1,128}$/;

/**
 * Names that are safe to pass to systemctl or rc-service without quoting, so
 * they also match an exact sudoers rule. systemd's `\x2d` escapes are excluded.
 */
export const SERVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,254}$/;

export function isValidServiceName(value: unknown): value is string {
  return typeof value === "string" && SERVICE_NAME_PATTERN.test(value);
}

export function isValidServiceSkipPattern(value: unknown): value is string {
  return typeof value === "string" && SKIP_PATTERN.test(value);
}

/** Trims, drops blanks and duplicates. Returns an error message for invalid input. */
export function normalizeServiceSkipPatterns(
  value: unknown,
): { patterns: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "patterns must be an array of strings" };
  const patterns: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { error: "patterns must be an array of strings" };
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!SKIP_PATTERN.test(trimmed)) {
      return { error: `Invalid pattern: ${trimmed.slice(0, 64)}. Use letters, digits, @ . _ : - and the wildcards * and ?.` };
    }
    if (!patterns.includes(trimmed)) patterns.push(trimmed);
  }
  if (patterns.length > MAX_SERVICE_RESTART_SKIP_PATTERNS) {
    return { error: `At most ${MAX_SERVICE_RESTART_SKIP_PATTERNS} patterns are allowed` };
  }
  return { patterns };
}

/**
 * Case-insensitive glob match with `*` and `?`. It backtracks only to the last
 * `*`, so it runs in O(pattern × value) time whatever the pattern; a regex
 * built from the glob could backtrack exponentially on patterns like `a*a*a*b`.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  let pi = 0;
  let vi = 0;
  let starPi = -1;
  let starVi = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === v[vi])) {
      pi += 1;
      vi += 1;
    } else if (pi < p.length && p[pi] === "*") {
      starPi = pi;
      starVi = vi;
      pi += 1;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      starVi += 1;
      vi = starVi;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi += 1;
  return pi === p.length;
}

/** The effective skip list: the system's own list, or the defaults when it has none. */
export function resolveServiceSkipPatterns(patterns: readonly string[] | null | undefined): readonly string[] {
  return patterns ?? DEFAULT_SERVICE_RESTART_SKIP_PATTERNS;
}

export function isServiceSkipped(unit: string, patterns: readonly string[]): boolean {
  const bare = unit.endsWith(".service") ? unit.slice(0, -".service".length) : unit;
  return patterns.some((pattern) => matchesGlob(pattern, unit) || matchesGlob(pattern, bare));
}

/** Reads a stored scan; returns null for missing or malformed data. */
export function parseServiceRestartInfo(value: string | null | undefined): ServiceRestartInfo | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as ServiceRestartInfo;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.services) ? parsed : null;
  } catch {
    return null;
  }
}

/** Flagged services that are not on the skip list. */
export function listRestartableServices(
  info: ServiceRestartInfo | null | undefined,
  patterns: readonly string[],
): ServiceRestartService[] {
  return (info?.services ?? []).filter((service) => !isServiceSkipped(service.unit, patterns));
}
