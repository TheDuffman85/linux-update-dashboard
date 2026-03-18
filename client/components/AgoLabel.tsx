import { formatExactDateTime, formatTimeAgo } from "../lib/time";

export function AgoLabel({
  timestamp,
  className = "",
}: {
  timestamp: string;
  stale?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`text-[11px] whitespace-nowrap text-slate-500 dark:text-slate-500 ${className}`.trim()}
      title={formatExactDateTime(timestamp)}
    >
      {formatTimeAgo(timestamp)}
    </span>
  );
}
