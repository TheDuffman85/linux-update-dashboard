import type { NotificationProvider, NotificationPayload, NotificationResult } from "./types";
import { getEncryptor } from "../../security";

const ALLOWED_CONFIG_KEYS = new Set([
  "gotifyUrl",
  "gotifyToken",
  "gotifyPriorityOverride",
]);

function validateUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return "URL must use http or https";
    }
    return null;
  } catch {
    return "Invalid URL format";
  }
}

function resolvePriority(
  payloadPriority: NotificationPayload["priority"],
  override: string | undefined,
): number {
  if (override && override !== "auto") {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 10) {
      return parsed;
    }

    // Backward compatibility for configs created before numeric priorities.
    switch (override) {
      case "min":
        return 1;
      case "low":
        return 3;
      case "high":
        return 8;
      case "urgent":
        return 10;
      case "default":
      default:
        return 5;
    }
  }

  switch (payloadPriority || "default") {
    case "min":
      return 1;
    case "low":
      return 3;
    case "high":
      return 8;
    case "urgent":
      return 10;
    case "default":
    default:
      return 5;
  }
}

export const gotifyProvider: NotificationProvider = {
  name: "gotify",

  validateConfig(config) {
    for (const key of Object.keys(config)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        return `Unsupported gotify config key: ${key}`;
      }
    }

    if (!config.gotifyUrl) return "Gotify URL is required";
    if (!config.gotifyToken) return "Gotify app token is required";

    const urlError = validateUrl(config.gotifyUrl);
    if (urlError) return urlError;

    const priorityOverride = config.gotifyPriorityOverride || "auto";
    if (priorityOverride !== "auto") {
      const parsed = Number.parseInt(priorityOverride, 10);
      const legacyNamedPriority = ["min", "low", "default", "high", "urgent"].includes(priorityOverride);
      if ((!Number.isInteger(parsed) || parsed < 0 || parsed > 10) && !legacyNamedPriority) {
        return "gotify priority override must be \"auto\" or an integer from 0 to 10";
      }
    }

    return null;
  },

  async send(payload: NotificationPayload, config: Record<string, string>): Promise<NotificationResult> {
    let token = config.gotifyToken;
    try {
      token = getEncryptor().decrypt(config.gotifyToken);
    } catch {
      // Use raw token for legacy/plaintext config values.
    }

    const baseUrl = config.gotifyUrl.replace(/\/+$/, "");
    const url = new URL(`${baseUrl}/message`);
    url.searchParams.set("token", token);

    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: payload.title,
        message: payload.body,
        priority: resolvePriority(payload.priority, config.gotifyPriorityOverride),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `gotify returned ${res.status}: ${text}` };
    }

    return { success: true };
  },
};
