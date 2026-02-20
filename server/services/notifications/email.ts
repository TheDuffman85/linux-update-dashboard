import nodemailer from "nodemailer";
import type { NotificationProvider, NotificationPayload, NotificationResult } from "./types";
import { getEncryptor } from "../../security";

// Basic email format check (RFC 5322 simplified)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmails(raw: string): string | null {
  const addresses = raw.split(",").map((e) => e.trim()).filter(Boolean);
  if (addresses.length === 0) return "At least one email address is required";
  for (const addr of addresses) {
    if (!EMAIL_RE.test(addr)) return `Invalid email address: ${addr}`;
  }
  return null;
}

export const emailProvider: NotificationProvider = {
  name: "email",

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

    const port = parseInt(config.smtpPort || "587", 10);
    const secure = config.smtpSecure !== "false";

    const transport = nodemailer.createTransport({
      host: config.smtpHost,
      port,
      secure: secure && port === 465,
      auth: config.smtpUser
        ? { user: config.smtpUser, pass: password }
        : undefined,
      tls: secure ? { rejectUnauthorized: true } : undefined,
      connectionTimeout: 10_000,
      socketTimeout: 10_000,
    });

    const recipients = config.emailTo
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .join(", ");

    await transport.sendMail({
      from: config.smtpFrom,
      to: recipients,
      subject: payload.title,
      text: payload.body,
    });

    return { success: true };
  },
};
