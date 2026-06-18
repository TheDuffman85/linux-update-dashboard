import { getKnownPublicOrigin } from "../../request-security";
import { getServerTranslator } from "../i18n";
import type { NotificationPayload } from "./types";

export function resolveNotificationLinkUrl(payload: NotificationPayload): string {
  return payload.event?.appUpdate?.releaseUrl
    || payload.event?.appUpdate?.repoUrl
    || new URL("/", getKnownPublicOrigin()).toString();
}

export function resolveNotificationLinkLabel(payload: NotificationPayload): string {
  const t = getServerTranslator();
  if (payload.event?.appUpdate?.releaseUrl) return t("server.notifications.link.openRelease");
  if (payload.event?.appUpdate?.repoUrl) return t("server.notifications.link.openRepo");
  return t("server.notifications.link.openLud");
}
