import type { NotificationProvider, NotificationPayload, NotificationResult } from "./types";
import { getEncryptor } from "../../security";

const BLOCKED_HOSTS = [
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "[::1]",
  "metadata.google.internal",
];

const BLOCKED_IP_PREFIXES = [
  "10.",
  "172.16.", "172.17.", "172.18.", "172.19.",
  "172.20.", "172.21.", "172.22.", "172.23.",
  "172.24.", "172.25.", "172.26.", "172.27.",
  "172.28.", "172.29.", "172.30.", "172.31.",
  "192.168.",
  "169.254.",
  "fd",
  "fe80:",
];

function validateUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Invalid URL format";
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "URL must use http or https";
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTS.includes(hostname)) {
    return "URL must not point to localhost or internal addresses";
  }

  for (const prefix of BLOCKED_IP_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return "URL must not point to private/internal IP addresses";
    }
  }

  return null;
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
    // Re-validate URL at send time as defense-in-depth
    const urlError = validateUrl(config.ntfyUrl);
    if (urlError) return { success: false, error: urlError };

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
