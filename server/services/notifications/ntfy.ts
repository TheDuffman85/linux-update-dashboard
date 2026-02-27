import type { NotificationProvider, NotificationPayload, NotificationResult } from "./types";
import { getEncryptor } from "../../security";
import { isSafeOutboundUrl } from "../../request-security";

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

export const ntfyProvider: NotificationProvider = {
  name: "ntfy",

  validateConfig(config) {
    if (!config.ntfyUrl) return "ntfy URL is required";
    if (!config.ntfyTopic) return "ntfy topic is required";

    const urlError = validateUrl(config.ntfyUrl);
    if (urlError) return urlError;

    // Validate topic contains only safe characters
    if (!/^[a-zA-Z0-9_-]+$/.test(config.ntfyTopic)) {
      return "ntfy topic must only contain letters, numbers, hyphens, and underscores";
    }

    return null;
  },

  async send(payload: NotificationPayload, config: Record<string, string>): Promise<NotificationResult> {
    // Re-validate URL at send time as defense-in-depth, including DNS/IP checks.
    const outbound = await isSafeOutboundUrl(config.ntfyUrl);
    if (!outbound.safe) return { success: false, error: outbound.reason };

    const baseUrl = config.ntfyUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/${encodeURIComponent(config.ntfyTopic)}`;

    const headers: Record<string, string> = {
      "Title": payload.title,
      "Priority": payload.priority || "default",
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
};
