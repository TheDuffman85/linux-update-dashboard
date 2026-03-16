import type { NotificationConfig } from "./notifications";
import {
  validateEmail,
  validateEmailList,
  validateHttpUrl,
  validateInteger,
  validateRequiredText,
} from "./form-validation";

const TELEGRAM_BOT_TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{20,}$/;
const STORED_SENTINEL = "(stored)";
const VALID_NTFY_PRIORITIES = new Set(["auto", "min", "low", "default", "high", "urgent"]);

function validateMqttTopicValue(topic: string, label: string): string | null {
  if (!topic.trim()) return `${label} is required`;
  if (topic.includes("#") || topic.includes("+")) {
    return `${label} must not contain MQTT wildcards`;
  }
  if (topic.startsWith("/") || topic.endsWith("/")) {
    return `${label} must not start or end with a slash`;
  }
  if (topic.includes("//")) {
    return `${label} must not contain empty topic levels`;
  }
  return null;
}

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
  options?: {
    name?: string;
  },
): string | null {
  if (options?.name !== undefined) {
    const nameError = validateRequiredText(options.name, "Name", 100);
    if (nameError) return nameError;
  }

  if (type === "email") {
    const smtpHostError = validateRequiredText(
      typeof config.smtpHost === "string" ? config.smtpHost : "",
      "SMTP host",
    );
    if (smtpHostError) return smtpHostError;

    const smtpFrom = typeof config.smtpFrom === "string" ? config.smtpFrom : "";
    const smtpFromRequiredError = validateRequiredText(smtpFrom, "Sender email address");
    if (smtpFromRequiredError) return smtpFromRequiredError;
    const smtpFromError = validateEmail(smtpFrom, "sender email address");
    if (smtpFromError) return smtpFromError;

    const emailTo = typeof config.emailTo === "string" ? config.emailTo : "";
    const emailToError = validateEmailList(emailTo, "Recipient email address");
    if (emailToError) return emailToError;

    const smtpPort = Number.parseInt(String(config.smtpPort ?? "587"), 10);
    const smtpPortError = validateInteger(smtpPort, "SMTP port", 1, 65535);
    if (smtpPortError) return smtpPortError;

    return null;
  }

  if (type === "gotify") {
    const gotifyUrl = typeof config.gotifyUrl === "string" ? config.gotifyUrl : "";
    const gotifyUrlRequiredError = validateRequiredText(gotifyUrl, "Gotify URL");
    if (gotifyUrlRequiredError) return gotifyUrlRequiredError;
    const gotifyUrlError = validateHttpUrl(
      gotifyUrl,
      "Gotify URL",
    );
    if (gotifyUrlError) return gotifyUrlError;

    const gotifyTokenError = validateRequiredText(
      typeof config.gotifyToken === "string" ? config.gotifyToken : "",
      "Gotify app token",
    );
    if (gotifyTokenError) return gotifyTokenError;

    const priorityOverride = String(config.gotifyPriorityOverride ?? "auto");
    if (priorityOverride !== "auto") {
      const parsed = Number.parseInt(priorityOverride, 10);
      const legacyNamedPriority = ["min", "low", "default", "high", "urgent"].includes(priorityOverride);
      if ((!Number.isInteger(parsed) || parsed < 0 || parsed > 10) && !legacyNamedPriority) {
        return "gotify priority override must be \"auto\" or an integer from 0 to 10";
      }
    }

    return null;
  }

  if (type === "ntfy") {
    const ntfyUrl = typeof config.ntfyUrl === "string" ? config.ntfyUrl : "";
    const ntfyUrlRequiredError = validateRequiredText(ntfyUrl, "ntfy URL");
    if (ntfyUrlRequiredError) return ntfyUrlRequiredError;
    const ntfyUrlError = validateHttpUrl(
      ntfyUrl,
      "ntfy URL",
    );
    if (ntfyUrlError) return ntfyUrlError;

    const ntfyTopic = typeof config.ntfyTopic === "string" ? config.ntfyTopic : "";
    const ntfyTopicError = validateRequiredText(ntfyTopic, "ntfy topic");
    if (ntfyTopicError) return ntfyTopicError;
    if (!/^[a-zA-Z0-9_-]+$/.test(ntfyTopic)) {
      return "ntfy topic must only contain letters, numbers, hyphens, and underscores";
    }

    const priorityOverride = String(config.ntfyPriorityOverride ?? "auto");
    if (!VALID_NTFY_PRIORITIES.has(priorityOverride)) {
      return `ntfy priority override must be one of: ${Array.from(VALID_NTFY_PRIORITIES).join(", ")}`;
    }

    return null;
  }

  if (type === "mqtt") {
    const brokerUrl = typeof config.brokerUrl === "string" ? config.brokerUrl : "";
    const brokerUrlError = validateRequiredText(brokerUrl, "MQTT broker URL");
    if (brokerUrlError) return brokerUrlError;
    try {
      const parsed = new URL(brokerUrl);
      if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(parsed.protocol)) {
        return "MQTT broker URL must use mqtt://, mqtts://, ws://, or wss://";
      }
      if (!parsed.hostname) {
        return "MQTT broker URL must include a hostname";
      }
    } catch {
      return "Invalid MQTT broker URL";
    }

    const keepaliveSeconds = Number(config.keepaliveSeconds);
    const keepaliveError = validateInteger(keepaliveSeconds, "Keepalive", 1, 3600);
    if (keepaliveError) return keepaliveError;

    const connectTimeoutMs = Number(config.connectTimeoutMs);
    const timeoutError = validateInteger(connectTimeoutMs, "Connect timeout", 1000, 120000);
    if (timeoutError) return timeoutError;

    const publishEvents = config.publishEvents === true;
    const topic = typeof config.topic === "string" ? config.topic.trim() : "";

    if (publishEvents) {
      const topicError = validateMqttTopicValue(topic, "MQTT topic");
      if (topicError) return topicError;
    }

    const discoveryPrefixError = validateMqttTopicValue(
      typeof config.discoveryPrefix === "string" ? config.discoveryPrefix : "",
      "Home Assistant discovery prefix",
    );
    if (discoveryPrefixError) return discoveryPrefixError;

    const baseTopicError = validateMqttTopicValue(
      typeof config.baseTopic === "string" ? config.baseTopic : "",
      "MQTT base topic",
    );
    if (baseTopicError) return baseTopicError;

    const payloadInstallError = validateRequiredText(
      typeof config.payloadInstall === "string" ? config.payloadInstall : "",
      "MQTT install payload",
    );
    if (payloadInstallError) return payloadInstallError;

    return null;
  }

  if (type === "telegram") {
    const token = typeof config.telegramBotToken === "string" ? config.telegramBotToken : "";
    if (token && token !== STORED_SENTINEL && !TELEGRAM_BOT_TOKEN_RE.test(token)) {
      return "Telegram bot token format is invalid";
    }

    return null;
  }

  if (type === "webhook") {
    const url = typeof config.url === "string" ? config.url : "";
    const urlRequiredError = validateRequiredText(url, "Webhook URL");
    if (urlRequiredError) return urlRequiredError;
    const urlError = validateHttpUrl(url, "Webhook URL");
    if (urlError) return urlError;
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        return "Webhook URL must not embed credentials";
      }
    } catch {
      return "Webhook URL must be a valid URL";
    }

    const timeoutError = validateInteger(Number(config.timeoutMs), "Timeout", 1000, 30000);
    if (timeoutError) return timeoutError;

    const retryAttemptsError = validateInteger(Number(config.retryAttempts), "Retry attempts", 0, 5);
    if (retryAttemptsError) return retryAttemptsError;

    const retryDelayError = validateInteger(Number(config.retryDelayMs), "Retry delay", 0, 300000);
    if (retryDelayError) return retryDelayError;

    const auth = config.auth as Record<string, unknown> | undefined;
    if (auth?.mode === "bearer" && !String(auth.token ?? "").trim()) {
      return "Bearer authentication requires a token";
    }
    if (auth?.mode === "basic" && (!String(auth.username ?? "").trim() || !String(auth.password ?? "").trim())) {
      return "Basic authentication requires username and password";
    }

    return null;
  }

  return null;
}
