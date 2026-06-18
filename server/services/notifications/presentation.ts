import type { CheckResult, NotificationPayload } from "./types";
import type { Translator } from "../i18n";

const TAG_ICONS: Record<string, string> = {
  warning: "⚠️",
  package: "📦",
  skull: "💀",
  arrow_up: "⬆️",
  white_check_mark: "✅",
};

export function decorateNotificationTitle(
  payload: Pick<NotificationPayload, "title" | "tags">,
): string {
  for (const tag of payload.tags ?? []) {
    const icon = TAG_ICONS[tag];
    if (icon) {
      return `${icon} ${payload.title}`;
    }
  }

  return payload.title;
}

export function formatUpdateCounts(
  updateCount: number,
  securityCount: number,
  keptBackCount: number,
  t?: Translator,
): string {
  let text = t
    ? t(
        updateCount === 1
          ? "server.notifications.updateCount.one"
          : "server.notifications.updateCount.many",
        { count: updateCount },
      )
    : `${updateCount} update${updateCount !== 1 ? "s" : ""}`;
  const details: string[] = [];
  if (securityCount > 0) {
    details.push(t
      ? t("server.notifications.updateCount.security", { count: securityCount })
      : `${securityCount} security`);
  }
  if (keptBackCount > 0) {
    details.push(t
      ? t("server.notifications.updateCount.keptBack", { count: keptBackCount })
      : `${keptBackCount} kept back`);
  }
  if (details.length > 0) {
    text += ` (${details.join(", ")})`;
  }
  return text;
}

export function formatUpdateLine(
  result: Pick<CheckResult, "systemName" | "updateCount" | "securityCount" | "keptBackCount">,
  t?: Translator,
): string {
  return `${result.systemName}: ${formatUpdateCounts(result.updateCount, result.securityCount, result.keptBackCount, t)}`;
}
