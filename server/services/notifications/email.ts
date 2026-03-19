import nodemailer from "nodemailer";
import type { NotificationPayload, NotificationResult } from "./types";
import { getEncryptor } from "../../security";
import { createFlatProvider } from "./flat-provider";
import { decorateNotificationTitle } from "./presentation";
import { resolveNotificationLinkLabel, resolveNotificationLinkUrl } from "./link-target";

// Basic email format check (RFC 5322 simplified)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_IMPORTANCE_OVERRIDES = ["auto", "normal", "important"] as const;
const VALID_TLS_MODES = ["plain", "starttls", "tls"] as const;

export type EmailTlsMode = (typeof VALID_TLS_MODES)[number];

function validateEmails(raw: string): string | null {
  const addresses = raw.split(",").map((e) => e.trim()).filter(Boolean);
  if (addresses.length === 0) return "At least one email address is required";
  for (const addr of addresses) {
    if (!EMAIL_RE.test(addr)) return `Invalid email address: ${addr}`;
  }
  return null;
}

function resolveEmailImportance(
  payloadPriority: NotificationPayload["priority"],
  override: string | undefined,
): {
  mailPriority: "high" | "normal";
  importanceHeader: "high" | "normal";
  xPriorityHeader: "1" | "3";
} {
  const effective = override && override !== "auto"
    ? override
    : (payloadPriority === "high" || payloadPriority === "urgent" ? "important" : "normal");

  if (effective === "important") {
    return {
      mailPriority: "high",
      importanceHeader: "high",
      xPriorityHeader: "1",
    };
  }

  return {
    mailPriority: "normal",
    importanceHeader: "normal",
    xPriorityHeader: "3",
  };
}

export function resolveEmailTlsMode(config: Record<string, string>): EmailTlsMode {
  if (VALID_TLS_MODES.includes(config.smtpTlsMode as EmailTlsMode)) {
    return config.smtpTlsMode as EmailTlsMode;
  }

  if (config.smtpSecure === "false") return "plain";
  if (config.smtpSecure === "true") {
    const port = parseInt(config.smtpPort || "587", 10);
    return port === 465 ? "tls" : "starttls";
  }

  return "starttls";
}

export function shouldAllowInsecureTls(config: Record<string, string>): boolean {
  return config.allowInsecureTls === "true";
}

function normalizeEmailConfig(config: Record<string, string>): Record<string, string> {
  const normalized = { ...config };

  if ("smtpSecure" in normalized) {
    normalized.smtpTlsMode = resolveEmailTlsMode(normalized);
    delete normalized.smtpSecure;
  }

  return normalized;
}

export function buildEmailTransportOptions(
  config: Record<string, string>,
  password?: string,
): Record<string, unknown> {
  const port = parseInt(config.smtpPort || "587", 10);
  const tlsMode = resolveEmailTlsMode(config);
  const allowInsecureTls = shouldAllowInsecureTls(config);

  return {
    host: config.smtpHost,
    port,
    secure: tlsMode === "tls",
    ignoreTLS: tlsMode === "plain",
    requireTLS: tlsMode === "starttls",
    auth: config.smtpUser
      ? { user: config.smtpUser, pass: password }
      : undefined,
    tls: tlsMode === "plain"
      ? undefined
      : { rejectUnauthorized: !allowInsecureTls },
    connectionTimeout: 10_000,
    socketTimeout: 10_000,
  };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildEmailHtmlBody(payload: NotificationPayload): string {
  const title = escapeHtml(decorateNotificationTitle(payload));
  const body = escapeHtml(payload.body).replaceAll("\n", "<br>");
  const actionUrl = escapeHtml(resolveNotificationLinkUrl(payload));
  const actionLabel = escapeHtml(resolveNotificationLinkLabel(payload));

  return [
    "<div style=\"font-family:Arial,sans-serif;line-height:1.5;color:#111827;\">",
    `<p style="margin:0 0 16px;"><strong>${title}</strong></p>`,
    `<p style="margin:0 0 20px;">${body}</p>`,
    `<p style="margin:0;"><a href="${actionUrl}" style="display:inline-block;padding:10px 16px;background:#111827;color:#ffffff;text-decoration:none;border-radius:8px;">${actionLabel}</a></p>`,
    "</div>",
  ].join("");
}

export const emailProvider = createFlatProvider({
  name: "email",
  allowedKeys: [
    "smtpHost",
    "smtpPort",
    "smtpTlsMode",
    "allowInsecureTls",
    "smtpSecure",
    "smtpUser",
    "smtpPassword",
    "smtpFrom",
    "emailTo",
    "emailImportanceOverride",
  ],
  sensitiveKeys: ["smtpPassword"],
  normalizeConfig: normalizeEmailConfig,

  validateConfig(config) {
    if (!config.smtpHost) return "SMTP host is required";
    if (!config.smtpFrom) return "Sender email address is required";
    if (!config.emailTo) return "Recipient email address is required";

    // Validate email formats
    if (!EMAIL_RE.test(config.smtpFrom)) return "Invalid sender email address";
    const toError = validateEmails(config.emailTo);
    if (toError) return toError;

    // Validate port range
    const port = parseInt(config.smtpPort || "587", 10);
    if (isNaN(port) || port < 1 || port > 65535) return "SMTP port must be between 1 and 65535";

    if (
      config.smtpTlsMode &&
      !VALID_TLS_MODES.includes(config.smtpTlsMode as EmailTlsMode)
    ) {
      return `smtp TLS mode must be one of: ${VALID_TLS_MODES.join(", ")}`;
    }

    if (
      config.allowInsecureTls &&
      config.allowInsecureTls !== "true" &&
      config.allowInsecureTls !== "false"
    ) {
      return "allowInsecureTls must be true or false";
    }

    const importanceOverride = config.emailImportanceOverride || "auto";
    if (!VALID_IMPORTANCE_OVERRIDES.includes(importanceOverride as (typeof VALID_IMPORTANCE_OVERRIDES)[number])) {
      return `email importance override must be one of: ${VALID_IMPORTANCE_OVERRIDES.join(", ")}`;
    }

    return null;
  },

  async send(payload: NotificationPayload, config: Record<string, string>): Promise<NotificationResult> {
    let password: string | undefined;
    if (config.smtpPassword) {
      try {
        password = getEncryptor().decrypt(config.smtpPassword);
      } catch {
        password = config.smtpPassword;
      }
    }

    const transport = nodemailer.createTransport(buildEmailTransportOptions(config, password));

    const recipients = config.emailTo
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .join(", ");
    const importance = resolveEmailImportance(payload.priority, config.emailImportanceOverride);

    await transport.sendMail({
      from: config.smtpFrom,
      to: recipients,
      subject: decorateNotificationTitle(payload),
      text: payload.body,
      html: buildEmailHtmlBody(payload),
      priority: importance.mailPriority,
      headers: {
        Importance: importance.importanceHeader,
        "X-Priority": importance.xPriorityHeader,
      },
    });

    return { success: true };
  },
});

export { resolveEmailImportance };
