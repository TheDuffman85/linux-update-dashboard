export function parseTimestamp(timestamp: string): Date {
  return new Date(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`);
}

export function formatTimeAgo(timestamp: string): string {
  const date = parseTimestamp(timestamp);
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatExactDateTime(timestamp: string): string {
  return parseTimestamp(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function getDurationBetween(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  nowMs = Date.now()
): number | null {
  if (!startedAt) return null;

  const startedMs = parseTimestamp(startedAt).getTime();
  const endedMs = completedAt ? parseTimestamp(completedAt).getTime() : nowMs;
  if (Number.isNaN(startedMs) || Number.isNaN(endedMs)) return null;

  return Math.max(0, endedMs - startedMs);
}

export function formatDurationMs(durationMs: number): string {
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;

  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(" ");
}

export function formatDurationBetween(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  nowMs = Date.now()
): string | null {
  const durationMs = getDurationBetween(startedAt, completedAt, nowMs);
  return durationMs === null ? null : formatDurationMs(durationMs);
}
