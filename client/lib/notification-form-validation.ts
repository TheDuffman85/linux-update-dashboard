import type { NotificationConfig } from "./notifications";

export function canSendNotificationFormTest(
  type: string,
  config: NotificationConfig,
): boolean {
  if (type !== "mqtt") return true;
  return config.publishEvents === true;
}

export function validateNotificationFormAction(
  type: string,
  config: NotificationConfig,
): string | null {
  if (type !== "mqtt") return null;

  const publishEvents = config.publishEvents === true;
  const topic = typeof config.topic === "string" ? config.topic.trim() : "";

  if (publishEvents && !topic) {
    return "MQTT topic is required";
  }

  return null;
}
