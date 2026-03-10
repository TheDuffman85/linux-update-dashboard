import http from "node:http";
import https from "node:https";
import { getEncryptor, looksLikeEncryptedValue } from "../../security";
import { sanitizeOutput } from "../../utils/sanitize";
import type {
  NotificationConfig,
  NotificationEventData,
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
} from "./types";
import { renderTemplate, validateTemplate } from "./webhook-template";

const STORED_SENTINEL = "(stored)";
const FORBIDDEN_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "authorization",
  "cookie",
]);
const BLOCKED_HOSTS = new Set(["metadata.google.internal", "169.254.169.254"]);
const ALLOWED_METHODS = new Set(["POST", "PUT", "PATCH"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const LEGACY_DISCORD_TEMPLATE = JSON.stringify(
  {
    embeds: [
      {
        title: "{{event.title}}",
        description: "{{event.body}}",
        timestamp: "{{event.sentAt}}",
      },
    ],
  },
  null,
  2,
);
const BROKEN_JSONSAFE_DISCORD_TEMPLATE = JSON.stringify(
  {
    embeds: [
      {
        title: "{{event.titleJson}}",
        description: "{{event.bodyJson}}",
        timestamp: "{{event.sentAtJson}}",
      },
    ],
  },
  null,
  2,
);
const PREVIOUS_DISCORD_TEMPLATE = `{
  "embeds": [
    {
      "title": {{event.titleJson}},
      "description": {{event.bodyJson}},
      "timestamp": {{event.sentAtJson}}
    }
  ]
}`;
const DISCORD_TEMPLATE = `{
  "embeds": [
    {
      "title": {{event.decoratedTitleJson}},
      "description": {{event.bodyJson}},
      "timestamp": {{event.sentAtJson}}
    }
  ]
}`;

type WebhookMethod = "POST" | "PUT" | "PATCH";

interface WebhookField {
  name: string;
  value: string;
  sensitive: boolean;
}

interface WebhookBodyTextConfig {
  mode: "text" | "json";
  template: string;
}

interface WebhookBodyFormConfig {
  mode: "form";
  fields: WebhookField[];
}

type WebhookBodyConfig = WebhookBodyTextConfig | WebhookBodyFormConfig;

type WebhookAuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "basic"; username: string; password: string };

export interface WebhookConfig extends Record<string, unknown> {
  preset: "custom" | "discord";
  method: WebhookMethod;
  url: string;
  query: Array<{ name: string; value: string }>;
  headers: WebhookField[];
  auth: WebhookAuthConfig;
  body: WebhookBodyConfig;
  timeoutMs: number;
  retryAttempts: number;
  retryDelayMs: number;
  allowInsecureTls: boolean;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function maybeDecryptable(value: string): boolean {
  if (!looksLikeEncryptedValue(value)) return false;
  try {
    getEncryptor().decrypt(value);
    return true;
  } catch {
    return false;
  }
}

function maybeDecrypt(value: string): string {
  if (!looksLikeEncryptedValue(value)) return value;
  try {
    return getEncryptor().decrypt(value);
  } catch {
    return value;
  }
}

function maybeEncrypt(value: string): string {
  if (!value || value === STORED_SENTINEL || maybeDecryptable(value)) return value;
  return getEncryptor().encrypt(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeField(value: unknown): WebhookField | null {
  const raw = asObject(value);
  const name = typeof raw.name === "string" ? raw.name : "";
  const fieldValue = typeof raw.value === "string" ? raw.value : "";
  if (!name.trim()) return null;
  return {
    name,
    value: fieldValue,
    sensitive: raw.sensitive === true,
  };
}

function normalizeQueryField(value: unknown): { name: string; value: string } | null {
  const raw = asObject(value);
  const name = typeof raw.name === "string" ? raw.name : "";
  const fieldValue = typeof raw.value === "string" ? raw.value : "";
  if (!name.trim()) return null;
  return {
    name,
    value: fieldValue,
  };
}

function normalizeAuth(value: unknown): WebhookAuthConfig {
  const raw = asObject(value);
  const mode = typeof raw.mode === "string" ? raw.mode : "none";
  if (mode === "bearer") {
    return {
      mode,
      token: typeof raw.token === "string" ? raw.token : "",
    };
  }
  if (mode === "basic") {
    return {
      mode,
      username: typeof raw.username === "string" ? raw.username : "",
      password: typeof raw.password === "string" ? raw.password : "",
    };
  }
  return { mode: "none" };
}

function normalizeBody(value: unknown): WebhookBodyConfig {
  const raw = asObject(value);
  const mode = raw.mode;
  if (mode === "form") {
    return {
      mode,
      fields: Array.isArray(raw.fields)
        ? raw.fields.map(normalizeField).filter((field): field is WebhookField => !!field)
        : [],
    };
  }

  if (mode === "json") {
    return {
      mode,
      template: typeof raw.template === "string" ? raw.template : "",
    };
  }

  return {
    mode: "text",
    template: typeof raw.template === "string" ? raw.template : "",
  };
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(max, Math.trunc(value)))
    : fallback;
}

function defaultWebhookConfig(): WebhookConfig {
  return {
    preset: "custom",
    method: "POST",
    url: "",
    query: [],
    headers: [],
    auth: { mode: "none" },
    body: {
      mode: "text",
      template: "",
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    retryAttempts: DEFAULT_RETRY_ATTEMPTS,
    retryDelayMs: DEFAULT_RETRY_DELAY_MS,
    allowInsecureTls: false,
  };
}

function sanitizeWebhookConfig(config: NotificationConfig): WebhookConfig {
  const raw = asObject(config);
  const defaults = defaultWebhookConfig();
  const sanitized: WebhookConfig = {
    preset: raw.preset === "discord" ? "discord" : defaults.preset,
    method: typeof raw.method === "string" && ALLOWED_METHODS.has(raw.method)
      ? raw.method as WebhookMethod
      : defaults.method,
    url: typeof raw.url === "string" ? raw.url : defaults.url,
    query: Array.isArray(raw.query)
      ? raw.query.map(normalizeQueryField).filter((field): field is { name: string; value: string } => !!field)
      : defaults.query,
    headers: Array.isArray(raw.headers)
      ? raw.headers.map(normalizeField).filter((field): field is WebhookField => !!field)
      : defaults.headers,
    auth: normalizeAuth(raw.auth),
    body: normalizeBody(raw.body),
    timeoutMs: clampNumber(raw.timeoutMs, defaults.timeoutMs, 30_000),
    retryAttempts: clampNumber(raw.retryAttempts, defaults.retryAttempts, 5),
    retryDelayMs: clampNumber(raw.retryDelayMs, defaults.retryDelayMs, 300_000),
    allowInsecureTls: raw.allowInsecureTls === true,
  };

  if (
    sanitized.preset === "discord" &&
    sanitized.body.mode === "json" &&
    (
      sanitized.body.template === LEGACY_DISCORD_TEMPLATE ||
      sanitized.body.template === BROKEN_JSONSAFE_DISCORD_TEMPLATE ||
      sanitized.body.template === PREVIOUS_DISCORD_TEMPLATE
    )
  ) {
    sanitized.body.template = DISCORD_TEMPLATE;
  }

  return sanitized;
}

function maskWebhookConfig(config: NotificationConfig): WebhookConfig {
  const masked = deepClone(sanitizeWebhookConfig(config));

  for (const header of masked.headers) {
    if (header.sensitive && header.value) {
      header.value = STORED_SENTINEL;
    }
  }

  if (masked.auth.mode === "bearer" && masked.auth.token) {
    masked.auth.token = STORED_SENTINEL;
  }
  if (masked.auth.mode === "basic" && masked.auth.password) {
    masked.auth.password = STORED_SENTINEL;
  }
  if (masked.body.mode === "form") {
    for (const field of masked.body.fields) {
      if (field.sensitive && field.value) {
        field.value = STORED_SENTINEL;
      }
    }
  }
  return masked;
}

function mergeSensitiveFields(stored: WebhookField[], incoming: WebhookField[]): WebhookField[] {
  return incoming.map((field, index) => {
    const previous = stored[index];
    if (!field.sensitive || field.value !== STORED_SENTINEL || !previous || !previous.sensitive) {
      return field;
    }
    return {
      ...field,
      value: previous.value,
    };
  });
}

function mergeWebhookConfig(storedConfig: NotificationConfig, incomingConfig: NotificationConfig): WebhookConfig {
  const stored = sanitizeWebhookConfig(storedConfig);
  const incoming = sanitizeWebhookConfig({ ...stored, ...incomingConfig });

  incoming.headers = mergeSensitiveFields(stored.headers, incoming.headers);

  if (incoming.auth.mode === "bearer" && incoming.auth.token === STORED_SENTINEL && stored.auth.mode === "bearer") {
    incoming.auth.token = stored.auth.token;
  }
  if (incoming.auth.mode === "basic" && incoming.auth.password === STORED_SENTINEL && stored.auth.mode === "basic") {
    incoming.auth.password = stored.auth.password;
  }
  if (incoming.body.mode === "form" && stored.body.mode === "form") {
    incoming.body.fields = mergeSensitiveFields(stored.body.fields, incoming.body.fields);
  }
  return incoming;
}

function prepareWebhookConfigForStorage(config: NotificationConfig): WebhookConfig {
  const prepared = deepClone(sanitizeWebhookConfig(config));

  for (const header of prepared.headers) {
    if (header.sensitive) {
      header.value = maybeEncrypt(header.value);
    }
  }

  if (prepared.auth.mode === "bearer") {
    prepared.auth.token = maybeEncrypt(prepared.auth.token);
  }
  if (prepared.auth.mode === "basic") {
    prepared.auth.password = maybeEncrypt(prepared.auth.password);
  }
  if (prepared.body.mode === "form") {
    for (const field of prepared.body.fields) {
      if (field.sensitive) {
        field.value = maybeEncrypt(field.value);
      }
    }
  }
  return prepared;
}

function validateUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Webhook URL must be a valid URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Webhook URL must use http or https";
  }
  if (parsed.username || parsed.password) {
    return "Webhook URL must not embed credentials";
  }
  if (BLOCKED_HOSTS.has(parsed.hostname.toLowerCase())) {
    return "Webhook URL points to a blocked metadata endpoint";
  }

  return null;
}

function validateHeaderName(name: string): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(name)) {
    return `Invalid header name: ${name}`;
  }
  if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
    return `Header ${name} is reserved`;
  }
  return null;
}

function validateTemplateField(label: string, template: string): string | null {
  if (!template) return null;
  const error = validateTemplate(template);
  return error ? `${label}: ${error}` : null;
}

function validateWebhookConfig(config: NotificationConfig): string | null {
  const raw = asObject(config);
  if (typeof raw.method !== "string" || !ALLOWED_METHODS.has(raw.method)) {
    return "Webhook method must be POST, PUT, or PATCH";
  }

  const webhook = sanitizeWebhookConfig(config);
  const urlError = validateUrl(webhook.url);
  if (urlError) return urlError;

  const urlTemplateError = validateTemplateField("URL template", webhook.url);
  if (urlTemplateError) return urlTemplateError;

  for (const entry of webhook.query) {
    const queryTemplateError = validateTemplateField(`Query parameter ${entry.name}`, entry.value);
    if (queryTemplateError) return queryTemplateError;
  }

  for (const header of webhook.headers) {
    const nameError = validateHeaderName(header.name);
    if (nameError) return nameError;
    const headerTemplateError = validateTemplateField(`Header ${header.name}`, header.value);
    if (headerTemplateError) return headerTemplateError;
  }

  if (webhook.auth.mode === "bearer" && !webhook.auth.token) {
    return "Bearer authentication requires a token";
  }
  if (webhook.auth.mode === "basic" && (!webhook.auth.username || !webhook.auth.password)) {
    return "Basic authentication requires username and password";
  }

  if (webhook.body.mode !== "form") {
    const bodyTemplateError = validateTemplateField("Body template", webhook.body.template);
    if (bodyTemplateError) return bodyTemplateError;
  } else {
    for (const field of webhook.body.fields) {
      const fieldTemplateError = validateTemplateField(`Form field ${field.name}`, field.value);
      if (fieldTemplateError) return fieldTemplateError;
    }
  }

  return null;
}

function decryptWebhookConfig(config: NotificationConfig): WebhookConfig {
  const decrypted = deepClone(sanitizeWebhookConfig(config));

  for (const header of decrypted.headers) {
    if (header.sensitive) {
      header.value = maybeDecrypt(header.value);
    }
  }

  if (decrypted.auth.mode === "bearer") {
    decrypted.auth.token = maybeDecrypt(decrypted.auth.token);
  }
  if (decrypted.auth.mode === "basic") {
    decrypted.auth.password = maybeDecrypt(decrypted.auth.password);
  }
  if (decrypted.body.mode === "form") {
    for (const field of decrypted.body.fields) {
      if (field.sensitive) {
        field.value = maybeDecrypt(field.value);
      }
    }
  }
  return decrypted;
}

function renderFieldValue(value: string, event: NotificationEventData): string {
  return value ? renderTemplate(value, event) : "";
}

function buildBody(config: WebhookConfig, event: NotificationEventData): { contentType: string; body: string } {
  if (config.body.mode === "json") {
    const body = renderFieldValue(config.body.template, event);
    JSON.parse(body);
    return {
      contentType: "application/json",
      body,
    };
  }

  if (config.body.mode === "form") {
    const params = new URLSearchParams();
    for (const field of config.body.fields) {
      params.append(field.name, renderFieldValue(field.value, event));
    }
    return {
      contentType: "application/x-www-form-urlencoded",
      body: params.toString(),
    };
  }

  return {
    contentType: "text/plain; charset=utf-8",
    body: renderFieldValue(config.body.template, event),
  };
}

function applyAuth(headers: Record<string, string>, auth: WebhookAuthConfig): void {
  if (auth.mode === "bearer") {
    headers.Authorization = `Bearer ${auth.token}`;
    return;
  }
  if (auth.mode === "basic") {
    const token = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
}

function sendHttpRequest(config: WebhookConfig, url: URL, headers: Record<string, string>, body: string): Promise<NotificationResult> {
  const requestLib = url.protocol === "https:" ? https : http;
  const options: https.RequestOptions = {
    method: config.method,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    headers,
    rejectUnauthorized: url.protocol === "https:" ? !config.allowInsecureTls : undefined,
  };

  return new Promise((resolve) => {
    const req = requestLib.request(options, (res) => {
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (responseBody.length < 2048) {
          responseBody += chunk;
        }
      });
      res.on("end", () => {
        const statusCode = res.statusCode || 0;
        const summary = responseBody ? sanitizeOutput(responseBody.trim()) : `HTTP ${statusCode}`;
        if (statusCode >= 200 && statusCode < 300) {
          resolve({
            success: true,
            statusCode,
            summary,
          });
          return;
        }

        resolve({
          success: false,
          statusCode,
          error: `Webhook returned ${statusCode}`,
          summary,
        });
      });
    });

    req.setTimeout(config.timeoutMs, () => {
      req.destroy(new Error("Webhook request timed out"));
    });
    req.on("error", (error) => {
      resolve({
        success: false,
        error: sanitizeOutput(String(error.message || error)),
      });
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

export const webhookProvider: NotificationProvider = {
  name: "webhook",

  sanitizeConfig(config) {
    return sanitizeWebhookConfig(config);
  },

  maskConfig(config) {
    return maskWebhookConfig(config);
  },

  mergeConfig(storedConfig, incomingConfig) {
    return mergeWebhookConfig(storedConfig, incomingConfig);
  },

  prepareConfigForStorage(config) {
    return prepareWebhookConfigForStorage(config);
  },

  validateConfig(config) {
    return validateWebhookConfig(config);
  },

  async send(payload: NotificationPayload, config: NotificationConfig): Promise<NotificationResult> {
    try {
      const webhook = decryptWebhookConfig(config);

      let renderedUrl: URL;
      renderedUrl = new URL(renderFieldValue(webhook.url, payload.event));
      for (const queryEntry of webhook.query) {
        renderedUrl.searchParams.append(queryEntry.name, renderFieldValue(queryEntry.value, payload.event));
      }

      const { contentType, body } = buildBody(webhook, payload.event);
      const headers: Record<string, string> = {
        "Content-Type": contentType,
      };

      for (const header of webhook.headers) {
        headers[header.name] = renderFieldValue(header.value, payload.event);
      }

      applyAuth(headers, webhook.auth);

      return sendHttpRequest(webhook, renderedUrl, headers, body);
    } catch (error) {
      return {
        success: false,
        error: sanitizeOutput(error instanceof Error ? error.message : String(error)),
      };
    }
  },
};
