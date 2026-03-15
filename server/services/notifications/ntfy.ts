import type { NotificationPayload, NotificationResult } from "./types";
import { getEncryptor } from "../../security";
import { createFlatProvider } from "./flat-provider";

const VALID_PRIORITY_OVERRIDES = ["auto", "min", "low", "default", "high", "urgent"] as const;
const ALLOWED_CONFIG_KEYS = new Set([
  "ntfyUrl",
  "ntfyTopic",
  "ntfyToken",
  "ntfyPriorityOverride",
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
): string {
  if (override && override !== "auto") {
    return override;
  }

  return payloadPriority || "default";
}

function sanitizeHeaderValue(value: string): string {
  return value
    .replaceAll("⏸️ ", "")
    .replaceAll("⚠️ ", "")
    .replace(/[^\t\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const ntfyProvider = createFlatProvider({
  name: "ntfy",
  allowedKeys: [
    "ntfyUrl",
    "ntfyTopic",
    "ntfyToken",
    "ntfyPriorityOverride",
  ],
  sensitiveKeys: ["ntfyToken"],

  validateConfig(config) {
    for (const key of Object.keys(config)) {
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        return `Unsupported ntfy config key: ${key}`;
      }
    }

    if (!config.ntfyUrl) return "ntfy URL is required";
    if (!config.ntfyTopic) return "ntfy topic is required";

    const urlError = validateUrl(config.ntfyUrl);
    if (urlError) return urlError;

    // Validate topic contains only safe characters
    if (!/^[a-zA-Z0-9_-]+$/.test(config.ntfyTopic)) {
      return "ntfy topic must only contain letters, numbers, hyphens, and underscores";
    }

    const priorityOverride = config.ntfyPriorityOverride || "auto";
    if (!VALID_PRIORITY_OVERRIDES.includes(priorityOverride as (typeof VALID_PRIORITY_OVERRIDES)[number])) {
      return `ntfy priority override must be one of: ${VALID_PRIORITY_OVERRIDES.join(", ")}`;
    }

    return null;
  },

  async send(payload: NotificationPayload, config: Record<string, string>): Promise<NotificationResult> {

    const baseUrl = config.ntfyUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/${encodeURIComponent(config.ntfyTopic)}`;

    const headers: Record<string, string> = {
      "Title": sanitizeHeaderValue(payload.title),
      "Priority": resolvePriority(payload.priority, config.ntfyPriorityOverride),
    };

    if (payload.tags?.length) {
      headers["Tags"] = payload.tags.join(",");
    }

    if (config.ntfyToken) {
      try {
        const token = getEncryptor().decrypt(config.ntfyToken);
        headers["Authorization"] = `Bearer ${token}`;
      } catch {
        headers["Authorization"] = `Bearer ${config.ntfyToken}`;
      }
    }

    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers,
      body: payload.body,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `ntfy returned ${res.status}: ${text}` };
    }

    return { success: true };
  },
});
