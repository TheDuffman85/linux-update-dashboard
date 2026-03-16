import { getEncryptor, looksLikeEncryptedValue } from "../../security";
import type {
  NotificationConfig,
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
} from "./types";

function maybeDecryptable(value: string): boolean {
  if (!looksLikeEncryptedValue(value)) return false;
  try {
    getEncryptor().decrypt(value);
    return true;
  } catch {
    return false;
  }
}

export function readFlatConfig(
  config: NotificationConfig,
  allowedKeys: readonly string[],
): Record<string, string> {
  const allowed = new Set(allowedKeys);
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(config)) {
    if (!allowed.has(key) || typeof value !== "string") continue;
    result[key] = value;
  }

  return result;
}

interface FlatProviderOptions {
  name: string;
  allowedKeys: readonly string[];
  sensitiveKeys?: readonly string[];
  normalizeConfig?(config: Record<string, string>): Record<string, string>;
  validateConfig(config: Record<string, string>): string | null;
  send(payload: NotificationPayload, config: Record<string, string>): Promise<NotificationResult>;
}

export function createFlatProvider(options: FlatProviderOptions): NotificationProvider {
  const allowedKeys = [...options.allowedKeys];
  const sensitiveKeys = new Set(options.sensitiveKeys ?? []);
  const sanitize = (config: NotificationConfig): Record<string, string> => {
    const raw = readFlatConfig(config, allowedKeys);
    return options.normalizeConfig ? options.normalizeConfig(raw) : raw;
  };

  return {
    name: options.name,

    sanitizeConfig(config) {
      return sanitize(config);
    },

    maskConfig(config) {
      const sanitized = sanitize(config);
      for (const key of sensitiveKeys) {
        if (sanitized[key]) sanitized[key] = "(stored)";
      }
      return sanitized;
    },

    mergeConfig(storedConfig, incomingConfig) {
      const stored = sanitize(storedConfig);
      const incoming = sanitize(incomingConfig);
      const merged = { ...stored, ...incoming };

      for (const key of sensitiveKeys) {
        if (incoming[key] === "(stored)") {
          merged[key] = stored[key] || "";
        }
      }

      return merged;
    },

    prepareConfigForStorage(config) {
      const sanitized = sanitize(config);
      const encryptor = getEncryptor();

      for (const key of sensitiveKeys) {
        const value = sanitized[key];
        if (!value || value === "(stored)" || maybeDecryptable(value)) continue;
        sanitized[key] = encryptor.encrypt(value);
      }

      return sanitized;
    },

    validateConfig(config) {
      for (const key of Object.keys(config)) {
        if (!allowedKeys.includes(key)) {
          return `Unsupported ${options.name} config key: ${key}`;
        }
      }
      return options.validateConfig(sanitize(config));
    },

    async send(payload, config) {
      return options.send(payload, sanitize(config));
    },
  };
}
