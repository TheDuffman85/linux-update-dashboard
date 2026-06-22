import { formatExactDateTime, formatTimeAgo } from "../lib/time";
import { useI18n } from "../lib/i18n";
import { resolveTimeFormatPreference, useDateTime } from "../lib/date-time";

export function AgoLabel({
  timestamp,
  className = "",
}: {
  timestamp: string;
  stale?: boolean;
  className?: string;
}) {
  const { language, t } = useI18n();
  const { browserTimeFormat, timeFormat, timeZone } = useDateTime();
  const resolvedTimeFormat = resolveTimeFormatPreference(
    timeFormat,
    browserTimeFormat,
  );
  const dateTimeOptions = {
    ...(timeZone ? { timeZone } : {}),
    hour12: resolvedTimeFormat === "12h",
  };

  return (
    <span
      className={`text-[11px] whitespace-nowrap text-slate-500 dark:text-slate-500 ${className}`.trim()}
      title={formatExactDateTime(timestamp, language, dateTimeOptions)}
    >
      {formatTimeAgo(timestamp, t, language, dateTimeOptions)}
    </span>
  );
}
