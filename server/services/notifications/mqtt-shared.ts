import { getEncryptor, looksLikeEncryptedValue } from "../../security";
import type { NotificationConfig } from "./types";

export const STORED_SENTINEL = "(stored)";
const ALLOWED_PROTOCOLS = new Set(["mqtt:", "mqtts:", "ws:", "wss:"]);
const ALLOWED_KEYS = new Set([
  "brokerUrl",
  "username",
  "password",
  "clientId",
  "keepaliveSeconds",
  "connectTimeoutMs",
  "qos",
  "publishEvents",
  "topic",
  "retainEvents",
  "homeAssistantEnabled",
  "discoveryPrefix",
  "baseTopic",
  "publishAppEntity",
  "commandsEnabled",
  "payloadInstall",
]);

export interface MqttConfig extends Record<string, unknown> {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
  keepaliveSeconds: number;
  connectTimeoutMs: number;
  qos: 0 | 1;
  publishEvents: boolean;
  topic: string;
  retainEvents: boolean;
  homeAssistantEnabled: boolean;
  discoveryPrefix: string;
  baseTopic: string;
  publishAppEntity: boolean;
  commandsEnabled: boolean;
  payloadInstall: string;
}

export interface MqttPublishMessage {
  topic: string;
  payload: string;
  retain?: boolean;
  qos?: 0 | 1;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeTopicSegment(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed || fallback;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function maybeEncrypt(value: string): string {
  if (!value || value === STORED_SENTINEL || maybeDecryptable(value)) return value;
  return getEncryptor().encrypt(value);
}

export function defaultMqttConfig(): MqttConfig {
  return {
    brokerUrl: "",
    username: "",
    password: "",
    clientId: "",
    keepaliveSeconds: 60,
    connectTimeoutMs: 10_000,
    qos: 1,
    publishEvents: true,
    topic: "",
    retainEvents: false,
    homeAssistantEnabled: false,
    discoveryPrefix: "homeassistant",
    baseTopic: "ludash",
    publishAppEntity: true,
    commandsEnabled: false,
    payloadInstall: "install",
  };
}

export function sanitizeMqttConfig(config: NotificationConfig): MqttConfig {
  const raw = asObject(config);
  const defaults = defaultMqttConfig();

  return {
    brokerUrl: normalizeString(raw.brokerUrl),
    username: normalizeString(raw.username),
    password: typeof raw.password === "string" ? raw.password : defaults.password,
    clientId: normalizeString(raw.clientId),
    keepaliveSeconds: clampInteger(raw.keepaliveSeconds, defaults.keepaliveSeconds, 1, 3600),
    connectTimeoutMs: clampInteger(raw.connectTimeoutMs, defaults.connectTimeoutMs, 1000, 120_000),
    qos: raw.qos === 0 ? 0 : 1,
    publishEvents: raw.publishEvents !== false,
    topic: normalizeString(raw.topic),
    retainEvents: raw.retainEvents === true,
    homeAssistantEnabled: raw.homeAssistantEnabled === true,
    discoveryPrefix: normalizeTopicSegment(raw.discoveryPrefix, defaults.discoveryPrefix),
    baseTopic: normalizeTopicSegment(raw.baseTopic, defaults.baseTopic),
    publishAppEntity: raw.publishAppEntity !== false,
    commandsEnabled: raw.commandsEnabled === true,
    payloadInstall: normalizeString(raw.payloadInstall) || defaults.payloadInstall,
  };
}

export function maskMqttConfig(config: NotificationConfig): MqttConfig {
  const sanitized = sanitizeMqttConfig(config);
  if (sanitized.password) sanitized.password = STORED_SENTINEL;
  return sanitized;
}

export function mergeMqttConfig(storedConfig: NotificationConfig, incomingConfig: NotificationConfig): MqttConfig {
  const stored = sanitizeMqttConfig(storedConfig);
  const incoming = sanitizeMqttConfig(incomingConfig);
  const rawIncoming = asObject(incomingConfig);

  const merged: MqttConfig = {
    ...stored,
    ...incoming,
    publishEvents: rawIncoming.publishEvents === undefined ? stored.publishEvents : incoming.publishEvents,
    retainEvents: rawIncoming.retainEvents === undefined ? stored.retainEvents : incoming.retainEvents,
    homeAssistantEnabled: rawIncoming.homeAssistantEnabled === undefined ? stored.homeAssistantEnabled : incoming.homeAssistantEnabled,
    publishAppEntity: rawIncoming.publishAppEntity === undefined ? stored.publishAppEntity : incoming.publishAppEntity,
    commandsEnabled: rawIncoming.commandsEnabled === undefined ? stored.commandsEnabled : incoming.commandsEnabled,
  };

  if (incoming.password === STORED_SENTINEL) {
    merged.password = stored.password || "";
  }

  return merged;
}

export function prepareMqttConfigForStorage(config: NotificationConfig): MqttConfig {
  const sanitized = sanitizeMqttConfig(config);
  if (sanitized.password) {
    sanitized.password = maybeEncrypt(sanitized.password);
  }
  return sanitized;
}

function validateTopicValue(topic: string, label: string): string | null {
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

export function validateMqttConfig(config: NotificationConfig): string | null {
  for (const key of Object.keys(asObject(config))) {
    if (!ALLOWED_KEYS.has(key)) {
      return `Unsupported mqtt config key: ${key}`;
    }
  }

  const sanitized = sanitizeMqttConfig(config);
  if (!sanitized.brokerUrl) return "MQTT broker URL is required";

  let parsed: URL;
  try {
    parsed = new URL(sanitized.brokerUrl);
  } catch {
    return "Invalid MQTT broker URL";
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return "MQTT broker URL must use mqtt://, mqtts://, ws://, or wss://";
  }

  if (!parsed.hostname) return "MQTT broker URL must include a hostname";
  if (sanitized.publishEvents) {
    const topicError = validateTopicValue(sanitized.topic, "MQTT topic");
    if (topicError) return topicError;
  }

  const discoveryError = validateTopicValue(sanitized.discoveryPrefix, "Home Assistant discovery prefix");
  if (discoveryError) return discoveryError;
  const baseTopicError = validateTopicValue(sanitized.baseTopic, "MQTT base topic");
  if (baseTopicError) return baseTopicError;

  if (!sanitized.payloadInstall.trim()) {
    return "MQTT install payload is required";
  }
  if (sanitized.commandsEnabled && !sanitized.homeAssistantEnabled) {
    return "MQTT install commands require Home Assistant support to be enabled";
  }
  if (sanitized.qos !== 0 && sanitized.qos !== 1) {
    return "MQTT QoS must be 0 or 1";
  }

  return null;
}

export function buildMqttConnectionOptions(config: MqttConfig): {
  username?: string;
  password?: string;
  clientId?: string;
  keepalive: number;
  connectTimeout: number;
  reconnectPeriod: number;
  clean: boolean;
} {
  let password = config.password || undefined;
  if (password && looksLikeEncryptedValue(password)) {
    try {
      password = getEncryptor().decrypt(password);
    } catch {
      // Leave legacy/plain value untouched if decryption fails.
    }
  }

  return {
    username: config.username || undefined,
    password,
    clientId: config.clientId || undefined,
    keepalive: config.keepaliveSeconds,
    connectTimeout: config.connectTimeoutMs,
    reconnectPeriod: 5000,
    clean: true,
  };
}

export function buildHomeAssistantDiscoveryTopic(
  config: MqttConfig,
  channelId: number,
  entityKey: string,
): string {
  return `${config.discoveryPrefix}/update/ludash_${channelId}_${entityKey}/config`;
}

export function buildEntityBaseTopic(
  config: MqttConfig,
  channelId: number,
  entityKey: string,
): string {
  return `${config.baseTopic}/channels/${channelId}/${entityKey}`;
}
