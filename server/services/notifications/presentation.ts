import type { NotificationPayload } from "./types";

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
