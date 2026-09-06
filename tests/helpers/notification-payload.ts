import type { NotificationPayload } from "../../server/services/notifications/types";

export function makeNotificationPayload(
  input: Omit<NotificationPayload, "event"> &
    Partial<Pick<NotificationPayload, "event">>,
): NotificationPayload {
  return {
    ...input,
    event: input.event ?? {
      title: input.title,
      body: input.body,
      priority: input.priority ?? "default",
      tags: input.tags ?? [],
      sentAt: "2026-09-06T00:00:00.000Z",
      eventTypes: [],
      totals: {
        systemsWithUpdates: 0,
        totalUpdates: 0,
        totalSecurity: 0,
        totalKeptBack: 0,
        unreachableSystems: 0,
      },
      updates: [],
      unreachable: [],
      appUpdate: null,
    },
  };
}
