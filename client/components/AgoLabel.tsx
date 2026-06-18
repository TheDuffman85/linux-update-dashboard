import { formatExactDateTime, formatTimeAgo } from "../lib/time";
import { useI18n } from "../lib/i18n";

export function AgoLabel({
  timestamp,
  className = "",
}: {
  timestamp: string;
  stale?: boolean;
  className?: string;
}) {
  const { language, t } = useI18n();

  return (
    <span
      className={`text-[11px] whitespace-nowrap text-slate-500 dark:text-slate-500 ${className}`.trim()}
      title={formatExactDateTime(timestamp, language)}
    >
      {formatTimeAgo(timestamp, t, language)}
    </span>
  );
}
