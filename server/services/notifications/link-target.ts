import { getKnownPublicOrigin } from "../../request-security";
import type { NotificationPayload } from "./types";

export function resolveNotificationLinkUrl(payload: NotificationPayload): string {
  return payload.event?.appUpdate?.releaseUrl
    || payload.event?.appUpdate?.repoUrl
    || new URL("/", getKnownPublicOrigin()).toString();
}

export function resolveNotificationLinkLabel(payload: NotificationPayload): string {
  if (payload.event?.appUpdate?.releaseUrl) return "Open release";
  if (payload.event?.appUpdate?.repoUrl) return "Open repo";
  return "Open LUD";
}
