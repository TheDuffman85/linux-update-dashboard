import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { apiTokens } from "../../db/schema";
import { getEncryptor } from "../../security";
import type {
  NotificationConfig,
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
} from "./types";

const STORED_SENTINEL = "(stored)";
const SENSITIVE_KEYS = new Set(["telegramBotToken", "commandApiTokenEncrypted"]);
const MANAGED_KEYS = new Set([
  "botUsername",
  "chatId",
  "chatDisplayName",
  "chatBoundAt",
  "chatBindingStatus",
  "commandApiTokenEncrypted",
  "commandApiTokenId",
]);
const DERIVED_KEYS = new Set([
  "commandTokenStatus",
  "commandTokenName",
  "commandTokenCreatedAt",
  "commandTokenLastUsedAt",
  "commandTokenExpiresAt",
]);
const ALL_KEYS = new Set([
  "telegramBotToken",
  "botUsername",
  "chatId",
  "chatDisplayName",
  "chatBoundAt",
  "chatBindingStatus",
  "commandsEnabled",
  "commandApiTokenEncrypted",
  "commandApiTokenId",
  ...DERIVED_KEYS,
]);
const VALID_BINDING_STATUSES = new Set(["unbound", "pending", "bound"]);

function looksEncrypted(value: string): boolean {
  return /^[A-Za-z0-9+/=]+$/.test(value) && value.length >= 44;
}

export interface TelegramConfig {
  telegramBotToken?: string;
  botUsername?: string;
  chatId?: string;
  chatDisplayName?: string;
  chatBoundAt?: string;
  chatBindingStatus?: "unbound" | "pending" | "bound";
  commandsEnabled?: boolean;
  commandApiTokenEncrypted?: string;
  commandApiTokenId?: number;
  commandTokenStatus?: "not-required" | "pending" | "missing" | "expired" | "active";
  commandTokenName?: string;
  commandTokenCreatedAt?: string;
  commandTokenLastUsedAt?: string;
  commandTokenExpiresAt?: string;
}

function maybeDecrypt(value: string): string {
  if (!looksEncrypted(value)) return value;
  try {
    return getEncryptor().decrypt(value);
  } catch {
    return value;
  }
}

function maybeDecryptable(value: string): boolean {
  if (!looksEncrypted(value)) return false;
  try {
    getEncryptor().decrypt(value);
    return true;
  } catch {
    return false;
  }
}

function sanitizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeManagedString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function readTelegramConfig(config: NotificationConfig): TelegramConfig {
  const sanitized: TelegramConfig = {};

  for (const [key, value] of Object.entries(config)) {
    if (!ALL_KEYS.has(key)) continue;
    if (DERIVED_KEYS.has(key)) continue;

    if (key === "commandsEnabled") {
      if (typeof value === "boolean") sanitized.commandsEnabled = value;
      continue;
    }

    if (key === "commandApiTokenId") {
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        sanitized.commandApiTokenId = value;
      }
      continue;
    }

    if (key === "chatBindingStatus") {
      if (typeof value === "string" && VALID_BINDING_STATUSES.has(value)) {
        sanitized.chatBindingStatus = value as TelegramConfig["chatBindingStatus"];
      }
      continue;
    }

    if (MANAGED_KEYS.has(key)) {
      const managedValue = sanitizeManagedString(value);
      if (managedValue) {
        sanitized[key as keyof TelegramConfig] = managedValue as never;
      }
      continue;
    }

    const raw = sanitizeString(value);
    if (raw) {
      sanitized[key as keyof TelegramConfig] = raw as never;
    }
  }

  if (sanitized.commandsEnabled === undefined) {
    sanitized.commandsEnabled = false;
  }
  if (!sanitized.chatBindingStatus) {
    sanitized.chatBindingStatus = sanitized.chatId ? "bound" : "unbound";
  }

  return sanitized;
}

function asNotificationConfig(config: TelegramConfig): NotificationConfig {
  return { ...config };
}

export function getTelegramCommandTokenState(config: NotificationConfig | TelegramConfig): TelegramConfig {
  const telegram = readTelegramConfig(config as NotificationConfig);

  if (!telegram.commandsEnabled) {
    return {
      commandTokenStatus: "not-required",
    };
  }

  if (!telegram.chatId || !telegram.telegramBotToken) {
    return {
      commandTokenStatus: "pending",
    };
  }

  if (!telegram.commandApiTokenId || !telegram.commandApiTokenEncrypted) {
    return {
      commandTokenStatus: "missing",
    };
  }

  const row = getDb()
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.id, telegram.commandApiTokenId))
    .get();

  if (!row) {
    return {
      commandTokenStatus: "missing",
    };
  }

  const isExpired = row.expiresAt
    ? new Date(`${row.expiresAt}Z`).getTime() <= Date.now()
    : false;

  return {
    commandTokenStatus: isExpired ? "expired" : "active",
    commandTokenName: row.name || undefined,
    commandTokenCreatedAt: row.createdAt,
    commandTokenLastUsedAt: row.lastUsedAt || undefined,
    commandTokenExpiresAt: row.expiresAt || undefined,
  };
}

export function maskTelegramConfig(config: TelegramConfig): TelegramConfig {
  const masked: TelegramConfig = {
    ...config,
    ...getTelegramCommandTokenState(config),
  };
  for (const key of SENSITIVE_KEYS) {
    const typedKey = key as keyof TelegramConfig;
    if (masked[typedKey]) {
      masked[typedKey] = STORED_SENTINEL as never;
    }
  }
  return masked;
}

export function prepareTelegramConfigForStorage(config: TelegramConfig): TelegramConfig {
  const prepared = { ...config };
  const encryptor = getEncryptor();

  for (const key of SENSITIVE_KEYS) {
    const typedKey = key as keyof TelegramConfig;
    const value = prepared[typedKey];
    if (typeof value !== "string" || !value || value === STORED_SENTINEL || maybeDecryptable(value)) {
      continue;
    }
    prepared[typedKey] = encryptor.encrypt(value) as never;
  }

  if (!prepared.chatBindingStatus) {
    prepared.chatBindingStatus = prepared.chatId ? "bound" : "unbound";
  }
  if (prepared.commandsEnabled === undefined) {
    prepared.commandsEnabled = false;
  }

  return prepared;
}

export function mergeTelegramConfig(
  storedConfig: NotificationConfig,
  incomingConfig: NotificationConfig,
): TelegramConfig {
  const stored = readTelegramConfig(storedConfig);
  const incoming = readTelegramConfig(incomingConfig);
  const merged: TelegramConfig = {
    ...stored,
  };

  if ("commandsEnabled" in incomingConfig && typeof incoming.commandsEnabled === "boolean") {
    merged.commandsEnabled = incoming.commandsEnabled;
  }

  if ("telegramBotToken" in incomingConfig) {
    merged.telegramBotToken =
      incoming.telegramBotToken === STORED_SENTINEL
        ? stored.telegramBotToken || ""
        : incoming.telegramBotToken;
  }

  return merged;
}

export function resolveTelegramBotToken(config: NotificationConfig): string | null {
  const telegram = readTelegramConfig(config);
  if (!telegram.telegramBotToken) return null;
  return maybeDecrypt(telegram.telegramBotToken);
}

export function resolveTelegramCommandToken(config: NotificationConfig): string | null {
  const telegram = readTelegramConfig(config);
  if (!telegram.commandApiTokenEncrypted) return null;
  return maybeDecrypt(telegram.commandApiTokenEncrypted);
}

export function isTelegramBound(config: NotificationConfig): boolean {
  const telegram = readTelegramConfig(config);
  return !!(telegram.telegramBotToken && telegram.chatId);
}

function validateTokenFormat(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token);
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<NotificationResult> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      success: false,
      error: `telegram returned ${res.status}: ${body}`,
      statusCode: res.status,
      summary: `telegram returned ${res.status}`,
    };
  }

  return {
    success: true,
    statusCode: res.status,
    summary: "telegram message sent",
  };
}

export const telegramProvider: NotificationProvider = {
  name: "telegram",

  sanitizeConfig(config) {
    return asNotificationConfig(readTelegramConfig(config));
  },

  maskConfig(config) {
    return asNotificationConfig(maskTelegramConfig(readTelegramConfig(config)));
  },

  mergeConfig(storedConfig, incomingConfig) {
    return asNotificationConfig(mergeTelegramConfig(storedConfig, incomingConfig));
  },

  prepareConfigForStorage(config) {
    return asNotificationConfig(prepareTelegramConfigForStorage(readTelegramConfig(config)));
  },

  validateConfig(config) {
    const telegram = readTelegramConfig(config);

    for (const key of Object.keys(config)) {
      if (!ALL_KEYS.has(key)) {
        return `Unsupported telegram config key: ${key}`;
      }
    }

    if (telegram.telegramBotToken && !validateTokenFormat(resolveTelegramBotToken(telegram as NotificationConfig) || "")) {
      return "Telegram bot token format is invalid";
    }

    if (telegram.chatBindingStatus && !VALID_BINDING_STATUSES.has(telegram.chatBindingStatus)) {
      return "telegram chat binding status is invalid";
    }

    if (telegram.commandApiTokenId !== undefined && (!Number.isInteger(telegram.commandApiTokenId) || telegram.commandApiTokenId <= 0)) {
      return "telegram command token id must be a positive integer";
    }

    if (telegram.chatId && !telegram.telegramBotToken) {
      return "Telegram chat binding requires a bot token";
    }

    if (telegram.commandsEnabled && telegram.commandApiTokenId !== undefined && !telegram.commandApiTokenEncrypted) {
      return "Telegram command token metadata is incomplete";
    }

    return null;
  },

  async send(payload, config) {
    const telegram = readTelegramConfig(config);
    const botToken = telegram.telegramBotToken ? maybeDecrypt(telegram.telegramBotToken) : "";
    if (!botToken) {
      return { success: false, error: "Telegram bot token is not configured" };
    }
    if (!telegram.chatId) {
      return { success: false, error: "Telegram chat is not bound yet" };
    }

    const message = `${payload.title}\n\n${payload.body}`;
    return sendTelegramMessage(botToken, telegram.chatId, message);
  },
};
