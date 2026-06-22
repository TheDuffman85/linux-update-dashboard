import { useEffect, useRef, useState } from "react";
import Sortable from "sortablejs";
import { Cron } from "croner";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  useNotifications,
  useCreateNotification,
  useCreateTelegramLink,
  useReissueTelegramCommandToken,
  useUpdateNotification,
  useDeleteNotification,
  useResetNotificationUpdateDedupe,
  useReorderNotifications,
  useTestNotification,
  useTestNotificationConfig,
  useUnlinkTelegramChat,
  readEmailAllowInsecureTls,
  readEmailTlsMode,
  type EmailTlsMode,
  type NotificationChannel,
  type NotificationConfig,
  type MqttConfig,
  type TelegramConfig,
  type WebhookConfig,
  type WebhookField,
} from "../lib/notifications";
import {
  canSendNotificationFormTest,
  validateNotificationFormAction,
} from "../lib/notification-form-validation";
import { useVisibleSystems } from "../lib/systems";
import {
  isNotificationScheduleConfig,
  useCreateSchedule,
  useSchedules,
} from "../lib/schedules";
import { getMinScheduleIntervalMinutes } from "../lib/schedule-interval";
import { useToast } from "../context/ToastContext";
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/date-time";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const checkboxClass =
  "w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500";
const mutedTextClass = "text-xs text-slate-500 dark:text-slate-400";
const MASKED_VALUE = "(stored)";
const TELEGRAM_BINDING_STATUS_LABELS: Record<string, string> = {
  unbound: "pages.notifications.telegram.status.notLinked",
  pending: "pages.notifications.telegram.status.linkPending",
  bound: "pages.notifications.telegram.status.linked",
};
const TELEGRAM_COMMAND_TOKEN_STATUS_LABELS: Record<string, string> = {
  "not-required": "pages.notifications.telegram.tokenStatus.notRequired",
  pending: "pages.notifications.telegram.tokenStatus.waitingForLinkedChat",
  missing: "pages.notifications.telegram.tokenStatus.missingOrRevoked",
  expired: "pages.notifications.telegram.tokenStatus.expired",
  active: "pages.notifications.telegram.tokenStatus.active",
};
const DISCORD_TEMPLATE = `{
  "embeds": [
    {
      "title": {{event.decoratedTitleJson}},
      "description": {{event.bodyJson}},
      "timestamp": {{event.sentAtJson}}
    }
  ]
}`;

const TYPE_LABELS: Record<string, string> = {
  email: "pages.notifications.type.email",
  gotify: "pages.notifications.type.gotify",
  mqtt: "pages.notifications.type.mqtt",
  ntfy: "pages.notifications.type.ntfy",
  telegram: "pages.notifications.type.telegram",
  webhook: "pages.notifications.type.webhook",
};

const PUSH_PRIORITY_OPTIONS = [
  { value: "auto", labelKey: "pages.notifications.priority.auto" },
  { value: "min", labelKey: "pages.notifications.priority.min" },
  { value: "low", labelKey: "pages.notifications.priority.low" },
  { value: "default", labelKey: "pages.notifications.priority.default" },
  { value: "high", labelKey: "pages.notifications.priority.high" },
  { value: "urgent", labelKey: "pages.notifications.priority.urgent" },
];

const GOTIFY_PRIORITY_OPTIONS = [
  { value: "auto", labelKey: "pages.notifications.priority.auto" },
  { value: "0", labelKey: "pages.notifications.priority.gotifySilent" },
  { value: "1", labelKey: "pages.notifications.priority.gotifyLow" },
  { value: "3", labelKey: "pages.notifications.priority.gotifyDefaultLow" },
  { value: "5", labelKey: "pages.notifications.priority.gotifyNormal" },
  { value: "8", labelKey: "pages.notifications.priority.gotifyHigh" },
  { value: "10", labelKey: "pages.notifications.priority.gotifyMax" },
];

const EMAIL_IMPORTANCE_OPTIONS = [
  { value: "auto", labelKey: "pages.notifications.priority.auto" },
  { value: "normal", labelKey: "pages.notifications.importance.normal" },
  { value: "important", labelKey: "pages.notifications.importance.important" },
];

const EMAIL_TLS_MODE_OPTIONS: Array<{ value: EmailTlsMode; labelKey: string }> = [
  { value: "plain", labelKey: "pages.notifications.smtpSecurity.plain" },
  { value: "starttls", labelKey: "pages.notifications.smtpSecurity.starttls" },
  { value: "tls", labelKey: "pages.notifications.smtpSecurity.tls" },
];

const EVENT_LABELS: Record<string, string> = {
  updates: "pages.notifications.event.updates",
  unreachable: "pages.notifications.event.unreachable",
  appUpdates: "pages.notifications.event.appUpdates",
};

const DEFAULT_NOTIFY_ON = ["updates", "appUpdates"];
const MIN_SCHEDULE_INTERVAL_MINUTES = getMinScheduleIntervalMinutes();
const MIN_SCHEDULE_INTERVAL_MS = MIN_SCHEDULE_INTERVAL_MINUTES * 60 * 1000;
const SCHEDULE_PRESETS: { labelKey: string; value: string }[] = [
  { labelKey: "common.cron.every5Minutes", value: "*/5 * * * *" },
  { labelKey: "common.cron.every15Minutes", value: "*/15 * * * *" },
  { labelKey: "common.cron.every30Minutes", value: "*/30 * * * *" },
  { labelKey: "common.cron.everyHour", value: "0 * * * *" },
  { labelKey: "common.cron.every3Hours", value: "0 */3 * * *" },
  { labelKey: "common.cron.every6Hours", value: "0 */6 * * *" },
  { labelKey: "common.cron.dailyAt0000", value: "0 0 * * *" },
  { labelKey: "common.cron.dailyAt0300", value: "0 3 * * *" },
  { labelKey: "common.cron.weeklySunday0300", value: "0 3 * * 0" },
  { labelKey: "common.cron.weeklyMonday0900", value: "0 9 * * 1" },
  { labelKey: "common.cron.monthlyOnThe1st", value: "0 3 1 * *" },
  { labelKey: "common.custom", value: "custom" },
];

type Translate = ReturnType<typeof useI18n>["t"];

function moveNotification<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function readString(config: NotificationConfig, key: string, fallback = ""): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function readBoolean(config: NotificationConfig, key: string, fallback = false): boolean {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

function readOptionalString(config: NotificationConfig, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value ? value : undefined;
}

function readOptionalInteger(config: NotificationConfig, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readInteger(config: NotificationConfig, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function coerceTelegramConfig(config: NotificationConfig): TelegramConfig {
  return {
    telegramBotToken: readString(config, "telegramBotToken"),
    botUsername: readString(config, "botUsername"),
    chatId: readString(config, "chatId"),
    chatDisplayName: readString(config, "chatDisplayName"),
    chatBoundAt: readString(config, "chatBoundAt"),
    chatBindingStatus: (() => {
      const value = readString(config, "chatBindingStatus", "unbound");
      return value === "pending" || value === "bound" ? value : "unbound";
    })(),
    commandsEnabled: readBoolean(config, "commandsEnabled"),
    commandApiTokenEncrypted: readString(config, "commandApiTokenEncrypted"),
    commandApiTokenId: readOptionalInteger(config, "commandApiTokenId"),
    commandTokenStatus: (() => {
      const value = readString(config, "commandTokenStatus");
      return value === "not-required" || value === "pending" || value === "missing" || value === "expired" || value === "active"
        ? value
        : undefined;
    })(),
    commandTokenName: readOptionalString(config, "commandTokenName"),
    commandTokenCreatedAt: readOptionalString(config, "commandTokenCreatedAt"),
    commandTokenLastUsedAt: readOptionalString(config, "commandTokenLastUsedAt"),
    commandTokenExpiresAt: readOptionalString(config, "commandTokenExpiresAt"),
  };
}

function normalizeGotifyPriorityOverride(value: string | undefined): string {
  switch (value) {
    case "min":
      return "1";
    case "low":
      return "3";
    case "default":
      return "5";
    case "high":
      return "8";
    case "urgent":
      return "10";
    default:
      return value || "auto";
  }
}

function describeNotificationSchedule(channel: NotificationChannel, t: Translate): string {
  const scheduleNames =
    channel.scheduleNames?.length
      ? channel.scheduleNames
      : channel.scheduleName
        ? [channel.scheduleName]
        : [];
  if (scheduleNames.length === 1) return scheduleNames[0];
  if (scheduleNames.length === 2) return scheduleNames.join(", ");
  if (scheduleNames.length > 2) {
    return t("pages.notifications.countSchedules", { count: scheduleNames.length });
  }
  if (channel.schedule) return describeCron(channel.schedule, t);
  return t("pages.notifications.immediate");
}

function describeCron(cron: string, t: Translate): string {
  const preset = SCHEDULE_PRESETS.find((item) => item.value === cron);
  return preset ? t(preset.labelKey) : cron;
}

function buildDuplicateNotification(channel: NotificationChannel, t: Translate): NotificationChannel {
  const config = { ...channel.config };
  if (channel.type === "telegram") {
    delete config.chatId;
    delete config.chatDisplayName;
    delete config.chatBoundAt;
    delete config.commandApiTokenEncrypted;
    delete config.commandApiTokenId;
    delete config.commandTokenStatus;
    delete config.commandTokenName;
    delete config.commandTokenCreatedAt;
    delete config.commandTokenLastUsedAt;
    delete config.commandTokenExpiresAt;
    config.chatBindingStatus = "unbound";
  }

  return {
    ...channel,
    id: 0,
    name: t("pages.notifications.nameCopy", { name: channel.name }),
    config,
    scheduleId: channel.scheduleId,
    scheduleIds: [...channel.scheduleIds],
    scheduleName: channel.scheduleName,
    scheduleNames: [...channel.scheduleNames],
    schedules: channel.schedules.map((schedule) => ({ ...schedule })),
    lastSentAt: null,
    lastDeliveryStatus: null,
    lastDeliveryAt: null,
    lastDeliveryCode: null,
    lastDeliveryMessage: null,
  };
}

function getCronMinimumIntervalMs(cronExpression: string): number | null {
  try {
    const cron = new Cron(cronExpression);
    let previous = cron.nextRun(new Date("2026-01-01T00:00:00Z"));
    if (!previous) return null;

    let minimum: number | null = null;
    for (let index = 0; index < 20; index += 1) {
      const next = cron.nextRun(previous);
      if (!next) break;
      const interval = next.getTime() - previous.getTime();
      if (interval > 0) {
        minimum = minimum === null ? interval : Math.min(minimum, interval);
      }
      previous = next;
    }
    return minimum;
  } catch {
    return null;
  }
}

function isBelowMinimumScheduleInterval(cronExpression: string): boolean {
  const minimumInterval = getCronMinimumIntervalMs(cronExpression);
  return minimumInterval !== null && minimumInterval < MIN_SCHEDULE_INTERVAL_MS;
}

function ScheduleMinimumWarning({ cron }: { cron: string }) {
  const { t } = useI18n();
  if (!isBelowMinimumScheduleInterval(cron)) return null;

  return (
    <span className="text-xs text-amber-600 dark:text-amber-400">
      {t("pages.notifications.belowMinutesMinMinimum", { minutes: MIN_SCHEDULE_INTERVAL_MINUTES })}
    </span>
  );
}

function NewNotificationScheduleForm({
  onSubmit,
  onCancel,
  loading,
}: {
  onSubmit: (data: { name: string; cron: string }) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(() => t("pages.notifications.notificationSchedule"));
  const [cronPreset, setCronPreset] = useState(SCHEDULE_PRESETS[3].value);
  const [customCron, setCustomCron] = useState("");
  const [error, setError] = useState("");
  const activeCron = cronPreset === "custom" ? customCron.trim() : cronPreset;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const cron = cronPreset === "custom" ? customCron.trim() : cronPreset;
    if (!name.trim()) {
      setError(t("pages.notifications.nameIsRequired"));
      return;
    }
    if (!cron) {
      setError(t("pages.notifications.cronExpressionIsRequired"));
      return;
    }
    onSubmit({ name: name.trim(), cron });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300 text-sm">
          {error}
        </div>
      )}
      <div>
        <label className={labelClass}>{t("pages.notifications.name")}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          maxLength={100}
          autoFocus
        />
      </div>
      <div>
        <label className={labelClass}>{t("pages.notifications.schedule")}</label>
        <select
          value={cronPreset}
          onChange={(e) => setCronPreset(e.target.value)}
          className={inputClass}
        >
          {SCHEDULE_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {t(preset.labelKey)}
            </option>
          ))}
        </select>
        {cronPreset === "custom" && (
          <input
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            className={`${inputClass} mt-3 font-mono`}
            placeholder="0 9 * * 1"
          />
        )}
        {activeCron && (
          <p className="mt-2">
            <ScheduleMinimumWarning cron={activeCron} />
          </p>
        )}
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          {t("pages.notifications.cancel")}
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : t("pages.notifications.save")}
        </button>
      </div>
    </form>
  );
}

function defaultWebhookConfig(): WebhookConfig {
  return {
    preset: "custom",
    method: "POST",
    url: "",
    query: [],
    headers: [],
    auth: { mode: "none" },
    body: { mode: "text", template: "" },
    timeoutMs: 10000,
    retryAttempts: 2,
    retryDelayMs: 30000,
    allowInsecureTls: false,
  };
}

function defaultMqttConfig(): MqttConfig {
  return {
    brokerUrl: "",
    username: "",
    password: "",
    clientId: "",
    keepaliveSeconds: 60,
    connectTimeoutMs: 10000,
    qos: 1,
    publishEvents: true,
    topic: "",
    retainEvents: false,
    homeAssistantEnabled: false,
    deviceName: "Linux Update Dashboard",
    discoveryPrefix: "homeassistant",
    baseTopic: "ludash",
    publishAppEntity: true,
    commandsEnabled: false,
    payloadInstall: "install",
  };
}

function parseWebhookField(value: unknown): WebhookField | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  return {
    name: raw.name,
    value: typeof raw.value === "string" ? raw.value : "",
    sensitive: raw.sensitive === true,
  };
}

function coerceWebhookConfig(config: NotificationConfig): WebhookConfig {
  const defaults = defaultWebhookConfig();
  const auth =
    config.auth && typeof config.auth === "object" && !Array.isArray(config.auth)
      ? config.auth as Record<string, unknown>
      : {};
  const body =
    config.body && typeof config.body === "object" && !Array.isArray(config.body)
      ? config.body as Record<string, unknown>
      : {};

  return {
    preset: config.preset === "discord" ? "discord" : defaults.preset,
    method:
      config.method === "PUT" || config.method === "PATCH" || config.method === "POST"
        ? config.method
        : defaults.method,
    url: typeof config.url === "string" ? config.url : defaults.url,
    query: Array.isArray(config.query)
      ? config.query
          .map((entry) => parseWebhookField({ ...(entry as Record<string, unknown>), sensitive: false }))
          .filter((entry): entry is WebhookField => !!entry)
          .map(({ name, value }) => ({ name, value }))
      : defaults.query,
    headers: Array.isArray(config.headers)
      ? config.headers.map(parseWebhookField).filter((entry): entry is WebhookField => !!entry)
      : defaults.headers,
    auth:
      auth.mode === "bearer"
        ? { mode: "bearer", token: typeof auth.token === "string" ? auth.token : "" }
        : auth.mode === "basic"
          ? {
              mode: "basic",
              username: typeof auth.username === "string" ? auth.username : "",
              password: typeof auth.password === "string" ? auth.password : "",
            }
          : defaults.auth,
    body:
      body.mode === "json"
        ? {
            mode: "json",
            template: typeof body.template === "string" ? body.template : "",
          }
        : body.mode === "form"
          ? {
              mode: "form",
              fields: Array.isArray(body.fields)
                ? body.fields.map(parseWebhookField).filter((entry): entry is WebhookField => !!entry)
                : [],
            }
          : {
              mode: "text",
              template: typeof body.template === "string" ? body.template : "",
            },
    timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : defaults.timeoutMs,
    retryAttempts: typeof config.retryAttempts === "number" ? config.retryAttempts : defaults.retryAttempts,
    retryDelayMs: typeof config.retryDelayMs === "number" ? config.retryDelayMs : defaults.retryDelayMs,
    allowInsecureTls: config.allowInsecureTls === true,
  };
}

function coerceMqttConfig(config: NotificationConfig): MqttConfig {
  const defaults = defaultMqttConfig();
  return {
    brokerUrl: readString(config, "brokerUrl"),
    username: readString(config, "username"),
    password: readString(config, "password"),
    clientId: readString(config, "clientId"),
    keepaliveSeconds: readInteger(config, "keepaliveSeconds", defaults.keepaliveSeconds),
    connectTimeoutMs: readInteger(config, "connectTimeoutMs", defaults.connectTimeoutMs),
    qos: config.qos === 0 ? 0 : 1,
    publishEvents: readBoolean(config, "publishEvents", defaults.publishEvents),
    topic: readString(config, "topic"),
    retainEvents: readBoolean(config, "retainEvents", defaults.retainEvents),
    homeAssistantEnabled: readBoolean(config, "homeAssistantEnabled", defaults.homeAssistantEnabled),
    deviceName: readString(config, "deviceName", defaults.deviceName),
    discoveryPrefix: readString(config, "discoveryPrefix", defaults.discoveryPrefix),
    baseTopic: readString(config, "baseTopic", defaults.baseTopic),
    publishAppEntity: readBoolean(config, "publishAppEntity", defaults.publishAppEntity),
    commandsEnabled: readBoolean(config, "commandsEnabled", defaults.commandsEnabled),
    payloadInstall: readString(config, "payloadInstall", defaults.payloadInstall),
  };
}

function preserveSensitiveValue(currentValue: string, initialValue?: string, sensitive?: boolean): string {
  if (!sensitive) return currentValue;
  if (currentValue) return currentValue;
  return initialValue === MASKED_VALUE ? MASKED_VALUE : "";
}

function finalizeWebhookFields(currentFields: WebhookField[], initialFields: WebhookField[]): WebhookField[] {
  return currentFields
    .filter((field) => field.name.trim())
    .map((field, index) => ({
      ...field,
      value: preserveSensitiveValue(field.value, initialFields[index]?.value, field.sensitive),
    }));
}

function finalizeWebhookConfig(current: WebhookConfig, initial?: WebhookConfig): WebhookConfig {
  const initialHeaders = initial?.headers ?? [];
  const initialFormFields = initial?.body.mode === "form" ? initial.body.fields : [];

  return {
    ...current,
    query: current.query.filter((field) => field.name.trim()),
    headers: finalizeWebhookFields(current.headers, initialHeaders),
    auth:
      current.auth.mode === "bearer"
        ? {
            mode: "bearer",
            token: preserveSensitiveValue(
              current.auth.token,
              initial?.auth.mode === "bearer" ? initial.auth.token : undefined,
              true,
            ),
          }
        : current.auth.mode === "basic"
          ? {
              mode: "basic",
              username: current.auth.username,
              password: preserveSensitiveValue(
                current.auth.password,
                initial?.auth.mode === "basic" ? initial.auth.password : undefined,
                true,
              ),
            }
          : { mode: "none" },
    body:
      current.body.mode === "form"
        ? {
            mode: "form",
            fields: finalizeWebhookFields(current.body.fields, initialFormFields),
          }
        : {
            mode: current.body.mode,
            template: current.body.template,
          },
  };
}

function formatTimestamp(
  value: string | null | undefined,
  formatDateTime: (value: Date | string | number) => string,
): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDateTime(parsed);
}

function describeDelivery(
  channel: NotificationChannel,
  formatDateTime: (value: Date | string | number) => string,
): string | null {
  if (!channel.lastDeliveryStatus) return null;
  const when = formatTimestamp(channel.lastDeliveryAt, formatDateTime);
  const code = channel.lastDeliveryCode ? ` (${channel.lastDeliveryCode})` : "";
  const message = channel.lastDeliveryMessage ? ` - ${channel.lastDeliveryMessage}` : "";
  return `${channel.lastDeliveryStatus}${code}${when ? ` at ${when}` : ""}${message}`;
}

function isLoopbackOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (host.startsWith("169.254.")) return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  return false;
}

function getWebhookDestinationWarning(urlValue: string): string | null {
  if (!urlValue.trim()) return null;
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase();
    if (host === "metadata.google.internal" || host === "169.254.169.254") {
      return "pages.notifications.webhook.warning.metadataBlocked";
    }
    if (isLoopbackOrPrivateHost(host)) {
      return "pages.notifications.webhook.warning.privateHost";
    }
  } catch {
    return null;
  }
  return null;
}

function RowEditor({
  items,
  onChange,
  label,
  allowSensitive = false,
}: {
  items: WebhookField[];
  onChange: (items: WebhookField[]) => void;
  label: string;
  allowSensitive?: boolean;
}) {
  const { t } = useI18n();
  const updateItem = (index: number, patch: Partial<WebhookField>) => {
    onChange(items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className={labelClass}>{label}</span>
        <button
          type="button"
          onClick={() => onChange([...items, { name: "", value: "", sensitive: false }])}
          className="px-2 py-1 text-xs rounded border border-border hover:bg-slate-50 dark:hover:bg-slate-700"
        >
          {t("pages.notifications.webhook.addRow")}
        </button>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <p className={mutedTextClass}>{t("pages.notifications.webhook.noEntriesConfigured")}</p>
        ) : (
          items.map((item, index) => (
            <div key={index} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
              <input
                type="text"
                value={item.name}
                onChange={(e) => updateItem(index, { name: e.target.value })}
                className={inputClass}
                placeholder={t("common.name")}
              />
              <input
                type={allowSensitive && item.sensitive ? "password" : "text"}
                value={item.value === MASKED_VALUE ? "" : item.value}
                onChange={(e) => updateItem(index, { value: e.target.value })}
                className={inputClass}
                placeholder={item.value === MASKED_VALUE ? t("common.unchanged") : t("pages.notifications.webhook.value")}
              />
              {allowSensitive ? (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={item.sensitive}
                    onChange={(e) => updateItem(index, {
                      sensitive: e.target.checked,
                      value: !e.target.checked && item.value === MASKED_VALUE ? "" : item.value,
                    })}
                    className={checkboxClass}
                  />
                  {t("pages.notifications.webhook.secret")}
                </label>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => removeItem(index)}
                className="px-2 py-2 text-xs rounded border border-border hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500"
              >
                {t("pages.notifications.webhook.remove")}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function NotificationForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: NotificationChannel;
  onSubmit: (data: {
    name: string;
    type: string;
    enabled: boolean;
    notifyOn: string[];
    systemIds: number[] | null;
    config: NotificationConfig;
    schedule: string | null;
    scheduleId: number | null;
    scheduleIds: number[];
    sourceNotificationId?: number;
  }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const { data: systemsList } = useVisibleSystems();
  const { data: schedules } = useSchedules();
  const createSchedule = useCreateSchedule();
  const testConfig = useTestNotificationConfig();
  const createTelegramLink = useCreateTelegramLink();
  const reissueTelegramCommandToken = useReissueTelegramCommandToken();
  const unlinkTelegramChat = useUnlinkTelegramChat();
  const { addToast } = useToast();
  const initialWebhook = initial ? coerceWebhookConfig(initial.config) : defaultWebhookConfig();
  const initialMqtt = initial ? coerceMqttConfig(initial.config) : defaultMqttConfig();
  const initialTelegram: TelegramConfig = initial
    ? coerceTelegramConfig(initial.config)
    : { chatBindingStatus: "unbound", commandsEnabled: false };

  const [name, setName] = useState(initial?.name || "");
  const [type, setType] = useState(initial?.type || "email");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [notifyOn, setNotifyOn] = useState<string[]>(
    initial?.notifyOn || DEFAULT_NOTIFY_ON
  );
  const [allSystems, setAllSystems] = useState(initial?.systemIds === null);
  const [selectedSystemIds, setSelectedSystemIds] = useState<number[]>(
    initial?.systemIds || []
  );

  const [smtpHost, setSmtpHost] = useState(readString(initial?.config || {}, "smtpHost"));
  const [smtpPort, setSmtpPort] = useState(readString(initial?.config || {}, "smtpPort", "587"));
  const [smtpTlsMode, setSmtpTlsMode] = useState<EmailTlsMode>(readEmailTlsMode(initial?.config || {}));
  const [smtpAllowInsecureTls, setSmtpAllowInsecureTls] = useState(readEmailAllowInsecureTls(initial?.config || {}));
  const [smtpUser, setSmtpUser] = useState(readString(initial?.config || {}, "smtpUser"));
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpFrom, setSmtpFrom] = useState(readString(initial?.config || {}, "smtpFrom"));
  const [emailTo, setEmailTo] = useState(readString(initial?.config || {}, "emailTo"));
  const [emailImportanceOverride, setEmailImportanceOverride] = useState(
    readString(initial?.config || {}, "emailImportanceOverride", "auto")
  );

  const [gotifyUrl, setGotifyUrl] = useState(readString(initial?.config || {}, "gotifyUrl"));
  const [gotifyToken, setGotifyToken] = useState("");
  const [gotifyPriorityOverride, setGotifyPriorityOverride] = useState(
    normalizeGotifyPriorityOverride(readString(initial?.config || {}, "gotifyPriorityOverride"))
  );

  const [ntfyUrl, setNtfyUrl] = useState(readString(initial?.config || {}, "ntfyUrl", "https://ntfy.sh"));
  const [ntfyTopic, setNtfyTopic] = useState(readString(initial?.config || {}, "ntfyTopic"));
  const [ntfyToken, setNtfyToken] = useState("");
  const [ntfyPriorityOverride, setNtfyPriorityOverride] = useState(
    readString(initial?.config || {}, "ntfyPriorityOverride", "auto")
  );
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramCommandsEnabled, setTelegramCommandsEnabled] = useState(
    readBoolean(initial?.config || {}, "commandsEnabled", false)
  );
  const [telegramLinkUrl, setTelegramLinkUrl] = useState<string | null>(null);
  const [telegramLinkExpiresAt, setTelegramLinkExpiresAt] = useState<string | null>(null);
  const persistedTelegramCommandsEnabled = initialTelegram.commandsEnabled === true;
  const showTelegramCommandToken = type === "telegram" && telegramCommandsEnabled;
  const telegramCommandStatusLabel =
    !telegramCommandsEnabled
      ? null
      : persistedTelegramCommandsEnabled
        ? t(TELEGRAM_COMMAND_TOKEN_STATUS_LABELS[initialTelegram.commandTokenStatus || "not-required"] || "pages.notifications.unknown")
        : !initial?.id
          ? t("pages.notifications.telegram.tokenStatus.saveNotificationFirst")
          : !initialTelegram.chatId
            ? t("pages.notifications.telegram.tokenStatus.waitingForLinkedChat")
            : t("pages.notifications.telegram.tokenStatus.willBeIssuedAfterSave");

  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig>(initialWebhook);
  const [mqttConfig, setMqttConfig] = useState<MqttConfig>(initialMqtt);

  const notificationSchedules = (schedules ?? []).filter(
    (schedule) => schedule.type === "notification_digest" && isNotificationScheduleConfig(schedule.config),
  );
  const initialScheduleIds =
    initial?.scheduleIds?.length
      ? initial.scheduleIds
      : initial?.scheduleId
        ? [initial.scheduleId]
        : [];
  const [deliveryMode, setDeliveryMode] = useState<"immediate" | "scheduled">(
    initialScheduleIds.length > 0 ? "scheduled" : "immediate",
  );
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<number[]>(
    initialScheduleIds,
  );
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [localScheduleOptions, setLocalScheduleOptions] = useState<Array<{ id: number; name: string; cron: string }>>([]);
  const scheduleOptions = [
    ...notificationSchedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      cron: isNotificationScheduleConfig(schedule.config) ? schedule.config.cron : "",
    })),
    ...localScheduleOptions.filter(
      (localSchedule) => !notificationSchedules.some((schedule) => schedule.id === localSchedule.id),
    ),
  ];

  const toggleSchedule = (id: number) => {
    setSelectedScheduleIds((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id],
    );
  };

  const toggleNotifyOn = (event: string) => {
    setNotifyOn((prev) =>
      prev.includes(event)
        ? prev.filter((entry) => entry !== event)
        : [...prev, event]
    );
  };

  const toggleSystem = (id: number) => {
    setSelectedSystemIds((prev) =>
      prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id]
    );
  };

  useEffect(() => {
    if (allSystems) return;

    const visibleSystemIds = new Set(
      (systemsList || []).map((system) => system.id),
    );
    setSelectedSystemIds((prev) => {
      const next = prev.filter((id) => visibleSystemIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [allSystems, systemsList]);

  const applyDiscordPreset = () => {
    setWebhookConfig((prev) => ({
      ...prev,
      preset: "discord",
      method: "POST",
      body: {
        mode: "json",
        template: DISCORD_TEMPLATE,
      },
    }));
  };

  const resetCustomPreset = () => {
    setWebhookConfig((prev) => ({
      ...defaultWebhookConfig(),
      url: prev.url,
    }));
  };

  const buildConfig = (): NotificationConfig => {
    if (type === "email") {
      return {
        smtpHost,
        smtpPort,
        smtpTlsMode,
        allowInsecureTls: smtpAllowInsecureTls ? "true" : "false",
        smtpUser,
        smtpPassword:
          smtpPassword || (readString(initial?.config || {}, "smtpPassword") === MASKED_VALUE ? MASKED_VALUE : ""),
        smtpFrom,
        emailTo,
        emailImportanceOverride,
      };
    }

    if (type === "gotify") {
      return {
        gotifyUrl,
        gotifyToken:
          gotifyToken || (readString(initial?.config || {}, "gotifyToken") === MASKED_VALUE ? MASKED_VALUE : ""),
        gotifyPriorityOverride,
      };
    }

    if (type === "ntfy") {
      return {
        ntfyUrl,
        ntfyTopic,
        ntfyToken:
          ntfyToken || (readString(initial?.config || {}, "ntfyToken") === MASKED_VALUE ? MASKED_VALUE : ""),
        ntfyPriorityOverride,
      };
    }

    if (type === "mqtt") {
      return {
        ...mqttConfig,
        password:
          mqttConfig.password ||
          (readString(initial?.config || {}, "password") === MASKED_VALUE ? MASKED_VALUE : ""),
      };
    }

    if (type === "telegram") {
      return {
        telegramBotToken:
          telegramBotToken || (initialTelegram.telegramBotToken === MASKED_VALUE ? MASKED_VALUE : ""),
        commandsEnabled: telegramCommandsEnabled,
      };
    }

    return finalizeWebhookConfig(webhookConfig, initial ? coerceWebhookConfig(initial.config) : undefined);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const config = buildConfig();
    const formError = validateNotificationFormAction(type, config, { name });
    if (formError) {
      addToast(formError, "danger");
      return;
    }

    if (deliveryMode === "scheduled" && selectedScheduleIds.length === 0) {
      addToast(t("pages.notifications.selectAtLeastOneSchedule"), "danger");
      return;
    }

    const nextScheduleIds = deliveryMode === "scheduled" ? selectedScheduleIds : [];
    onSubmit({
      name,
      type,
      enabled,
      notifyOn,
      systemIds: allSystems ? null : selectedSystemIds,
      config,
      schedule: null,
      scheduleId: nextScheduleIds[0] ?? null,
      scheduleIds: nextScheduleIds,
    });
  };

  const handleInlineTest = () => {
    const config = buildConfig();
    const formError = validateNotificationFormAction(type, config, { name });
    if (formError) {
      addToast(formError, "danger");
      return;
    }

    testConfig.mutate(
      {
        type,
        config,
        name: name || undefined,
        existingId: initial?.id,
      },
      {
        onSuccess: (data) => {
          if (data.success) {
            addToast(t("pages.notifications.testNotificationSent"), "success");
          } else {
            addToast(t("pages.notifications.testFailedError", { error: data.error }), "danger");
          }
        },
        onError: (err) => addToast(err.message, "danger"),
      }
    );
  };

  const handleTelegramLink = () => {
    if (!initial?.id) return;
    createTelegramLink.mutate(initial.id, {
      onSuccess: (data) => {
        setTelegramLinkUrl(data.url);
        setTelegramLinkExpiresAt(data.expiresAt);
        addToast(t("pages.notifications.telegramLinkCreated"), "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleTelegramUnlink = () => {
    if (!initial?.id) return;
    unlinkTelegramChat.mutate(initial.id, {
      onSuccess: () => {
        setTelegramLinkUrl(null);
        setTelegramLinkExpiresAt(null);
        addToast(t("pages.notifications.telegramChatUnlinked"), "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleTelegramReissueCommandToken = () => {
    if (!initial?.id) return;
    reissueTelegramCommandToken.mutate(initial.id, {
      onSuccess: () => addToast(t("pages.notifications.telegramCommandTokenReissued"), "success"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleCreateSchedule = (data: { name: string; cron: string }) => {
    createSchedule.mutate(
      {
        name: data.name,
        type: "notification_digest",
        enabled: true,
        systemIds: null,
        config: {
          cron: data.cron,
          notificationIds: [],
        },
      },
      {
        onSuccess: (result) => {
          setLocalScheduleOptions((prev) => [
            ...prev,
            { id: result.id, name: data.name, cron: data.cron },
          ]);
          setSelectedScheduleIds((prev) => Array.from(new Set([...prev, result.id])));
          setDeliveryMode("scheduled");
          setShowScheduleForm(false);
          addToast(t("pages.notifications.scheduleCreated"), "success");
        },
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const destinationWarning = type === "webhook" ? getWebhookDestinationWarning(webhookConfig.url) : null;
  const canSendTest = canSendNotificationFormTest(type, buildConfig());

  return (
    <>
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>{t("pages.notifications.name")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder={t("pages.notifications.eGOpsTeamEmail")}
            required
          />
        </div>
        <div>
          <label className={labelClass}>{t("pages.notifications.type")}</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={inputClass}
            disabled={!!initial}
          >
            <option value="email">{t(TYPE_LABELS.email)} (SMTP)</option>
            <option value="gotify">{t(TYPE_LABELS.gotify)}</option>
            <option value="mqtt">{t(TYPE_LABELS.mqtt)}</option>
            <option value="ntfy">{t(TYPE_LABELS.ntfy)}</option>
            <option value="telegram">{t(TYPE_LABELS.telegram)}</option>
            <option value="webhook">{t(TYPE_LABELS.webhook)}</option>
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className={checkboxClass}
        />
        <span className="text-sm font-medium">{t("pages.notifications.enabled")}</span>
      </label>

      <div>
        <span className={labelClass}>{t("pages.notifications.events")}</span>
        <div className="flex flex-wrap gap-4">
          {Object.entries(EVENT_LABELS).map(([event, label]) => (
            <label key={event} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={notifyOn.includes(event)}
                onChange={() => toggleNotifyOn(event)}
                className={checkboxClass}
              />
              <span className="text-sm">{t(label)}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <span className={labelClass}>{t("pages.notifications.systems")}</span>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={allSystems}
            onChange={(e) => setAllSystems(e.target.checked)}
            className={checkboxClass}
          />
          <span className="text-sm font-medium">{t("pages.notifications.allSystems")}</span>
        </label>
        {!allSystems && (
          <div className="max-h-40 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
            {(systemsList || []).length === 0 ? (
              <p className="text-xs text-slate-400 p-1">{t("pages.notifications.noSystemsConfigured")}</p>
            ) : (
              (systemsList || []).map((system) => (
                <label
                  key={system.id}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-700/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedSystemIds.includes(system.id)}
                    onChange={() => toggleSystem(system.id)}
                    className={checkboxClass}
                  />
                  <span className="text-sm">{system.name}</span>
                  <span className="text-xs text-slate-400">{system.hostname}</span>
                </label>
              ))
            )}
          </div>
        )}
      </div>

      <div>
        <span className={labelClass}>{t("pages.notifications.delivery")}</span>
        <div className="flex gap-4 mb-2">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="deliveryMode"
              checked={deliveryMode === "immediate"}
              onChange={() => setDeliveryMode("immediate")}
              className="w-4 h-4 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm">{t("pages.notifications.immediate")}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="deliveryMode"
              checked={deliveryMode === "scheduled"}
              onChange={() => setDeliveryMode("scheduled")}
              className="w-4 h-4 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm">{t("pages.notifications.schedule")}</span>
          </label>
        </div>
        {deliveryMode === "scheduled" && (
        <div className="space-y-2">
          <div className="flex flex-col gap-2">
            <div className="max-h-40 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
              {scheduleOptions.length === 0 ? (
                <p className="text-xs text-slate-400 p-1">{t("pages.notifications.noSchedulesConfigured")}</p>
              ) : (
                scheduleOptions.map((schedule) => (
                  <label
                    key={schedule.id}
                    title={schedule.cron}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-700/50"
                  >
                    <input
                      type="checkbox"
                      checked={selectedScheduleIds.includes(schedule.id)}
                      onChange={() => toggleSchedule(schedule.id)}
                      className={checkboxClass}
                    />
                    <span className="text-sm">{schedule.name}</span>
                    <span className="text-xs text-slate-400">{describeCron(schedule.cron, t)}</span>
                    <ScheduleMinimumWarning cron={schedule.cron} />
                  </label>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowScheduleForm(true)}
              className="self-start px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
            >
              {t("pages.notifications.newSchedule")}
            </button>
          </div>
          <p className={mutedTextClass}>
            {t("pages.notifications.eventsAreBatchedAndSentWhenAnySelected")}
          </p>
        </div>
        )}
      </div>

      <div className="border-t border-border pt-4 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {TYPE_LABELS[type] ? t(TYPE_LABELS[type]) : type}
        </h3>

        {type === "email" && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>{t("pages.notifications.smtpHost")}</label>
                <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.smtpPort")}</label>
                <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.smtpSecurity")}</label>
                <select
                  value={smtpTlsMode}
                  onChange={(e) => setSmtpTlsMode(e.target.value as EmailTlsMode)}
                  className={inputClass}
                >
                  {EMAIL_TLS_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>{t("pages.notifications.smtpUser")}</label>
                <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} className={inputClass} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>{t("pages.notifications.smtpPassword")}</label>
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  className={inputClass}
                  placeholder={readString(initial?.config || {}, "smtpPassword") === MASKED_VALUE ? t("common.unchanged") : ""}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.fromAddress")}</label>
                <input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.toAddresses")}</label>
                <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.importance")}</label>
                <select
                  value={emailImportanceOverride}
                  onChange={(e) => setEmailImportanceOverride(e.target.value)}
                  className={inputClass}
                >
                  {EMAIL_IMPORTANCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                  ))}
                </select>
              </div>
            </div>
            <p className={mutedTextClass}>
              {t("pages.notifications.smtpSecurityHelp")}
            </p>
            {smtpTlsMode !== "plain" && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={smtpAllowInsecureTls}
                    onChange={(e) => setSmtpAllowInsecureTls(e.target.checked)}
                    className={checkboxClass}
                  />
                  <span className="text-sm font-medium">{t("pages.notifications.allowInsecureTlsAdvanced")}</span>
                </label>
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t("pages.notifications.smtpAllowInsecureTlsHelp")}
                </p>
              </div>
            )}
          </>
        )}

        {type === "gotify" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>{t("pages.notifications.serverUrl")}</label>
              <input value={gotifyUrl} onChange={(e) => setGotifyUrl(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>{t("pages.notifications.priority")}</label>
              <select
                value={gotifyPriorityOverride}
                onChange={(e) => setGotifyPriorityOverride(e.target.value)}
                className={inputClass}
              >
                {GOTIFY_PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>{t("pages.notifications.appToken")}</label>
              <input
                type="password"
                value={gotifyToken}
                onChange={(e) => setGotifyToken(e.target.value)}
                className={inputClass}
                placeholder={readString(initial?.config || {}, "gotifyToken") === MASKED_VALUE ? t("common.unchanged") : ""}
              />
            </div>
          </div>
        )}

        {type === "ntfy" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>{t("pages.notifications.serverUrl")}</label>
              <input value={ntfyUrl} onChange={(e) => setNtfyUrl(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>{t("pages.notifications.topic")}</label>
              <input value={ntfyTopic} onChange={(e) => setNtfyTopic(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>{t("pages.notifications.accessToken")}</label>
              <input
                type="password"
                value={ntfyToken}
                onChange={(e) => setNtfyToken(e.target.value)}
                className={inputClass}
                placeholder={readString(initial?.config || {}, "ntfyToken") === MASKED_VALUE ? t("common.unchanged") : ""}
              />
            </div>
            <div>
              <label className={labelClass}>{t("pages.notifications.priority")}</label>
              <select
                value={ntfyPriorityOverride}
                onChange={(e) => setNtfyPriorityOverride(e.target.value)}
                className={inputClass}
              >
                {PUSH_PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {type === "mqtt" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className={labelClass}>{t("pages.notifications.brokerUrl")}</label>
                <input
                  value={mqttConfig.brokerUrl}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, brokerUrl: e.target.value }))}
                  className={inputClass}
                  placeholder="mqtt://broker.example.com:1883"
                />
              </div>
              <div>
                <label className={labelClass}>{t("common.username")}</label>
                <input
                  value={mqttConfig.username || ""}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, username: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>{t("common.password")}</label>
                <input
                  type="password"
                  value={mqttConfig.password === MASKED_VALUE ? "" : (mqttConfig.password || "")}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, password: e.target.value }))}
                  className={inputClass}
                  placeholder={readString(initial?.config || {}, "password") === MASKED_VALUE ? t("common.unchanged") : ""}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.clientId")}</label>
                <input
                  value={mqttConfig.clientId || ""}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, clientId: e.target.value }))}
                  className={inputClass}
                  placeholder={t("pages.notifications.optional")}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.qos")}</label>
                <select
                  value={String(mqttConfig.qos)}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, qos: e.target.value === "0" ? 0 : 1 }))}
                  className={inputClass}
                >
                  <option value="0">0</option>
                  <option value="1">1</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.keepaliveSeconds")}</label>
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={mqttConfig.keepaliveSeconds}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, keepaliveSeconds: Number(e.target.value) }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.connectTimeoutMs")}</label>
                <input
                  type="number"
                  min={1000}
                  max={120000}
                  value={mqttConfig.connectTimeoutMs}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, connectTimeoutMs: Number(e.target.value) }))}
                  className={inputClass}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="text-sm font-medium">{t("pages.notifications.genericMqttEvents")}</div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={mqttConfig.publishEvents}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, publishEvents: e.target.checked }))}
                  className={checkboxClass}
                />
                <span className="text-sm">{t("pages.notifications.publishNotificationEventsToTopic")}</span>
              </label>
              {mqttConfig.publishEvents && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <label className={labelClass}>{t("pages.notifications.eventTopic")}</label>
                    <input
                      value={mqttConfig.topic}
                      onChange={(e) => setMqttConfig((prev) => ({ ...prev, topic: e.target.value }))}
                      className={inputClass}
                      placeholder="ludash/events"
                    />
                  </div>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={mqttConfig.retainEvents}
                      onChange={(e) => setMqttConfig((prev) => ({ ...prev, retainEvents: e.target.checked }))}
                      className={checkboxClass}
                    />
                    <span className="text-sm">{t("pages.notifications.retainEventPayloads")}</span>
                  </label>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="text-sm font-medium">{t("pages.notifications.homeAssistantMqttUpdate")}</div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={mqttConfig.homeAssistantEnabled}
                  onChange={(e) => setMqttConfig((prev) => ({ ...prev, homeAssistantEnabled: e.target.checked }))}
                  className={checkboxClass}
                />
                <span className="text-sm">{t("pages.notifications.enableHomeAssistantDiscoveryAndRetainedStateSync")}</span>
              </label>
              {mqttConfig.homeAssistantEnabled && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="sm:col-span-2">
                      <label className={labelClass}>{t("pages.notifications.deviceName")}</label>
                      <input
                        value={mqttConfig.deviceName}
                        onChange={(e) => setMqttConfig((prev) => ({ ...prev, deviceName: e.target.value }))}
                        className={inputClass}
                        placeholder="Linux Update Dashboard"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t("pages.notifications.discoveryPrefix")}</label>
                      <input
                        value={mqttConfig.discoveryPrefix}
                        onChange={(e) => setMqttConfig((prev) => ({ ...prev, discoveryPrefix: e.target.value }))}
                        className={inputClass}
                        placeholder="homeassistant"
                      />
                    </div>
                    <div>
                      <label className={labelClass}>{t("pages.notifications.baseTopic")}</label>
                      <input
                        value={mqttConfig.baseTopic}
                        onChange={(e) => setMqttConfig((prev) => ({ ...prev, baseTopic: e.target.value }))}
                        className={inputClass}
                        placeholder="ludash"
                      />
                    </div>
                  </div>

                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={mqttConfig.publishAppEntity}
                      onChange={(e) => setMqttConfig((prev) => ({ ...prev, publishAppEntity: e.target.checked }))}
                      className={checkboxClass}
                    />
                    <span className="text-sm">{t("pages.notifications.publishAppUpdateEntity")}</span>
                  </label>

                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={mqttConfig.commandsEnabled}
                      onChange={(e) => setMqttConfig((prev) => ({ ...prev, commandsEnabled: e.target.checked }))}
                      className={checkboxClass}
                    />
                    <span className="text-sm">{t("pages.notifications.enableHomeAssistantInstallCommands")}</span>
                  </label>

                  {mqttConfig.commandsEnabled && (
                    <div>
                      <label className={labelClass}>{t("pages.notifications.installPayload")}</label>
                      <input
                        value={mqttConfig.payloadInstall}
                        onChange={(e) => setMqttConfig((prev) => ({ ...prev, payloadInstall: e.target.value }))}
                        className={inputClass}
                        placeholder="install"
                      />
                    </div>
                  )}

                  <div className="rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-1">
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t("pages.notifications.appUpdateEntityVisibilityOnly")}
                    </p>
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {t("pages.notifications.homeAssistantDiscoveryImmediate")}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {type === "telegram" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className={labelClass}>{t("pages.notifications.telegram.botToken")}</label>
                <input
                  type="password"
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                  className={inputClass}
                  placeholder={initialTelegram.telegramBotToken === MASKED_VALUE ? t("common.unchanged") : "123456789:AA..."}
                />
                <p className={mutedTextClass}>
                  {t("pages.notifications.telegram.botTokenHelp")}
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">{t("pages.notifications.telegram.chatBinding")}</div>
                  <div className={mutedTextClass}>
                    {t(TELEGRAM_BINDING_STATUS_LABELS[initialTelegram.chatBindingStatus || "unbound"] || "pages.notifications.telegram.status.notLinked")}
                    {initialTelegram.chatDisplayName ? ` · ${initialTelegram.chatDisplayName}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleTelegramLink}
                    disabled={!initial?.id || createTelegramLink.isPending}
                    className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
                  >
                    {createTelegramLink.isPending ? <span className="spinner spinner-sm" /> : t("pages.notifications.telegram.createLink")}
                  </button>
                  <button
                    type="button"
                    onClick={handleTelegramUnlink}
                    disabled={!initial?.id || !initialTelegram.chatId || unlinkTelegramChat.isPending}
                    className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
                  >
                    {unlinkTelegramChat.isPending ? <span className="spinner spinner-sm" /> : t("pages.notifications.telegram.unlink")}
                  </button>
                </div>
              </div>
              {!initial?.id && (
                <p className={mutedTextClass}>
                  {t("pages.notifications.telegram.saveFirstToCreateLink")}
                </p>
              )}
              {telegramLinkUrl && (
                <div className="rounded-lg border border-blue-200 dark:border-blue-800/60 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-2">
                  <p className="text-sm">
                    {t("pages.notifications.telegram.openLinkToBind")}
                  </p>
                  <a
                    href={telegramLinkUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm break-all text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {telegramLinkUrl}
                  </a>
                  {telegramLinkExpiresAt && (
                    <p className={mutedTextClass}>
                      {t("pages.notifications.telegram.expires", { value: formatTimestamp(telegramLinkExpiresAt, formatDateTime) })}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={telegramCommandsEnabled}
                  onChange={(e) => setTelegramCommandsEnabled(e.target.checked)}
                  className={checkboxClass}
                />
                <span className="text-sm font-medium">{t("pages.notifications.telegram.enableBotCommands")}</span>
              </label>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t("pages.notifications.telegram.botCommandsHelp")}
              </p>
            </div>

            {showTelegramCommandToken && (
              <div className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">{t("pages.notifications.telegram.commandToken")}</div>
                    <div className={mutedTextClass}>
                      {telegramCommandStatusLabel}
                      {persistedTelegramCommandsEnabled && initialTelegram.commandTokenName ? ` · ${initialTelegram.commandTokenName}` : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleTelegramReissueCommandToken}
                    disabled={
                      !initial?.id ||
                      !persistedTelegramCommandsEnabled ||
                      !initialTelegram.chatId ||
                      reissueTelegramCommandToken.isPending
                    }
                    className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
                  >
                    {reissueTelegramCommandToken.isPending ? <span className="spinner spinner-sm" /> : t("pages.notifications.telegram.reissueToken")}
                  </button>
                </div>
                {persistedTelegramCommandsEnabled && initialTelegram.commandApiTokenId ? (
                  <p className={mutedTextClass}>{t("pages.notifications.telegram.tokenId", { id: initialTelegram.commandApiTokenId })}</p>
                ) : null}
                {persistedTelegramCommandsEnabled && initialTelegram.commandTokenCreatedAt ? (
                  <p className={mutedTextClass}>{t("pages.notifications.telegram.created", { value: formatTimestamp(initialTelegram.commandTokenCreatedAt, formatDateTime) })}</p>
                ) : null}
                {persistedTelegramCommandsEnabled && initialTelegram.commandTokenLastUsedAt ? (
                  <p className={mutedTextClass}>{t("pages.notifications.telegram.lastUsed", { value: formatTimestamp(initialTelegram.commandTokenLastUsedAt, formatDateTime) })}</p>
                ) : null}
                {persistedTelegramCommandsEnabled && initialTelegram.commandTokenExpiresAt ? (
                  <p className={mutedTextClass}>{t("pages.notifications.telegram.expires", { value: formatTimestamp(initialTelegram.commandTokenExpiresAt, formatDateTime) })}</p>
                ) : null}
                {!persistedTelegramCommandsEnabled && (
                  <p className={mutedTextClass}>
                    {t("pages.notifications.telegram.saveToActivateCommands")}
                  </p>
                )}
                {persistedTelegramCommandsEnabled && !initialTelegram.chatId && (
                  <p className={mutedTextClass}>
                    {t("pages.notifications.telegram.linkChatFirst")}
                  </p>
                )}
                {persistedTelegramCommandsEnabled && initialTelegram.chatId && (initialTelegram.commandTokenStatus === "missing" || initialTelegram.commandTokenStatus === "expired") && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    {t("pages.notifications.telegram.commandsCannotAuthenticate")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {type === "webhook" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.preset")}</label>
                <select
                  value={webhookConfig.preset}
                  onChange={(e) => {
                    const value = e.target.value as WebhookConfig["preset"];
                    if (value === "discord") {
                      applyDiscordPreset();
                    } else {
                      resetCustomPreset();
                    }
                  }}
                  className={inputClass}
                >
                  <option value="custom">{t("common.custom")}</option>
                  <option value="discord">Discord</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.method")}</label>
                <select
                  value={webhookConfig.method}
                  onChange={(e) => setWebhookConfig((prev) => ({
                    ...prev,
                    method: e.target.value as WebhookConfig["method"],
                  }))}
                  className={inputClass}
                >
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>
            </div>

            <div>
              <label className={labelClass}>{t("pages.notifications.url")}</label>
              <input
                type="url"
                value={webhookConfig.url}
                onChange={(e) => setWebhookConfig((prev) => ({ ...prev, url: e.target.value }))}
                className={inputClass}
                placeholder="https://example.com/webhook"
              />
              {destinationWarning && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{t(destinationWarning)}</p>
              )}
            </div>

            <RowEditor
              label={t("pages.notifications.webhook.queryParameters")}
              items={webhookConfig.query.map((entry) => ({ ...entry, sensitive: false }))}
              onChange={(items) => setWebhookConfig((prev) => ({
                ...prev,
                query: items.map(({ name, value }) => ({ name, value })),
              }))}
            />
            <p className={mutedTextClass}>
              {t("pages.notifications.webhook.queryParametersHelp")}
            </p>

            <RowEditor
              label={t("pages.notifications.webhook.headers")}
              items={webhookConfig.headers}
              onChange={(items) => setWebhookConfig((prev) => ({ ...prev, headers: items }))}
              allowSensitive
            />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.auth")}</label>
                <select
                  value={webhookConfig.auth.mode}
                  onChange={(e) => {
                    const mode = e.target.value;
                    setWebhookConfig((prev) => ({
                      ...prev,
                      auth:
                        mode === "bearer"
                          ? { mode: "bearer", token: "" }
                          : mode === "basic"
                            ? { mode: "basic", username: "", password: "" }
                            : { mode: "none" },
                    }));
                  }}
                  className={inputClass}
                >
                  <option value="none">{t("pages.notifications.none")}</option>
                  <option value="bearer">{t("pages.notifications.webhook.bearerToken")}</option>
                  <option value="basic">{t("pages.notifications.webhook.basicAuth")}</option>
                </select>
              </div>
              {webhookConfig.auth.mode === "bearer" && (
                <div className="sm:col-span-2">
                  <label className={labelClass}>{t("pages.notifications.webhook.bearerToken")}</label>
                  <input
                    type="password"
                    value={webhookConfig.auth.token === MASKED_VALUE ? "" : webhookConfig.auth.token}
                    onChange={(e) => setWebhookConfig((prev) => ({
                      ...prev,
                      auth: { mode: "bearer", token: e.target.value },
                    }))}
                    className={inputClass}
                    placeholder={initialWebhook.auth.mode === "bearer" && initialWebhook.auth.token === MASKED_VALUE ? t("common.unchanged") : ""}
                  />
                </div>
              )}
              {webhookConfig.auth.mode === "basic" && (
                <>
                  <div>
                    <label className={labelClass}>{t("common.username")}</label>
                    <input
                      value={webhookConfig.auth.username}
                      onChange={(e) => setWebhookConfig((prev) => ({
                        ...prev,
                        auth: { mode: "basic", username: e.target.value, password: prev.auth.mode === "basic" ? prev.auth.password : "" },
                      }))}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>{t("common.password")}</label>
                    <input
                      type="password"
                      value={webhookConfig.auth.password === MASKED_VALUE ? "" : webhookConfig.auth.password}
                      onChange={(e) => setWebhookConfig((prev) => ({
                        ...prev,
                        auth: { mode: "basic", username: prev.auth.mode === "basic" ? prev.auth.username : "", password: e.target.value },
                      }))}
                      className={inputClass}
                      placeholder={initialWebhook.auth.mode === "basic" && initialWebhook.auth.password === MASKED_VALUE ? t("common.unchanged") : ""}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.bodyMode")}</label>
                <select
                  value={webhookConfig.body.mode}
                  onChange={(e) => {
                    const mode = e.target.value;
                    setWebhookConfig((prev) => ({
                      ...prev,
                      body:
                        mode === "form"
                          ? { mode: "form", fields: prev.body.mode === "form" ? prev.body.fields : [] }
                          : {
                              mode: mode as "text" | "json",
                              template: prev.body.mode === "form" ? "" : prev.body.template,
                            },
                    }));
                  }}
                  className={inputClass}
                >
                  <option value="text">{t("pages.notifications.webhook.bodyMode.text")}</option>
                  <option value="json">{t("pages.notifications.webhook.bodyMode.json")}</option>
                  <option value="form">{t("pages.notifications.webhook.bodyMode.form")}</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.timeoutMs")}</label>
                <input
                  type="number"
                  min={1000}
                  max={30000}
                  value={webhookConfig.timeoutMs}
                  onChange={(e) => setWebhookConfig((prev) => ({ ...prev, timeoutMs: Number(e.target.value) }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.retryAttempts")}</label>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={webhookConfig.retryAttempts}
                  onChange={(e) => setWebhookConfig((prev) => ({ ...prev, retryAttempts: Number(e.target.value) }))}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.retryDelayMs")}</label>
                <input
                  type="number"
                  min={0}
                  max={300000}
                  value={webhookConfig.retryDelayMs}
                  onChange={(e) => setWebhookConfig((prev) => ({ ...prev, retryDelayMs: Number(e.target.value) }))}
                  className={inputClass}
                />
              </div>
            </div>

            {webhookConfig.body.mode === "form" ? (
              <RowEditor
                label={t("pages.notifications.webhook.formFields")}
                items={webhookConfig.body.fields}
                onChange={(items) => setWebhookConfig((prev) => ({
                  ...prev,
                  body: { mode: "form", fields: items },
                }))}
                allowSensitive
              />
            ) : (
              <div>
                <label className={labelClass}>{t("pages.notifications.webhook.bodyTemplate")}</label>
                <textarea
                  value={webhookConfig.body.template}
                  onChange={(e) => setWebhookConfig((prev) => ({
                    ...prev,
                    body: prev.body.mode === "form"
                      ? prev.body
                      : { ...prev.body, template: e.target.value },
                  }))}
                  className={`${inputClass} min-h-32`}
                  placeholder={
                    webhookConfig.body.mode === "json"
                      ? "{\n  \"title\": \"{{event.title}}\"\n}"
                      : "{{event.body}}"
                  }
                />
                <p className={mutedTextClass}>
                  {t("pages.notifications.webhook.templatesSupport")} <code>{"{{event.title}}"}</code>.
                </p>
              </div>
            )}

            <div className="rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={webhookConfig.allowInsecureTls}
                  onChange={(e) => setWebhookConfig((prev) => ({
                    ...prev,
                    allowInsecureTls: e.target.checked,
                  }))}
                  className={checkboxClass}
                />
                <span className="text-sm font-medium">{t("pages.notifications.allowInsecureTlsAdvanced")}</span>
              </label>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t("pages.notifications.webhook.allowInsecureTlsHelp")}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={handleInlineTest}
          disabled={testConfig.isPending || !canSendTest}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mr-auto"
          title={t("pages.notifications.sendTestNotification")}
        >
          {testConfig.isPending ? <span className="spinner spinner-sm" /> : t("pages.notifications.sendTest")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          {t("pages.notifications.cancel")}
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : t("pages.notifications.save")}
        </button>
      </div>
    </form>
    <Modal
      open={showScheduleForm}
      onClose={() => setShowScheduleForm(false)}
      title={t("pages.notifications.newSchedule")}
      dismissible={!createSchedule.isPending}
    >
      <NewNotificationScheduleForm
        onSubmit={handleCreateSchedule}
        onCancel={() => setShowScheduleForm(false)}
        loading={createSchedule.isPending}
      />
    </Modal>
    </>
  );
}

export default function Notifications() {
  const { data: channels, isLoading } = useNotifications();
  const { data: systemsList } = useVisibleSystems();
  const createNotification = useCreateNotification();
  const updateNotification = useUpdateNotification();
  const deleteNotification = useDeleteNotification();
  const resetNotificationUpdateDedupe = useResetNotificationUpdateDedupe();
  const reorderNotifications = useReorderNotifications();
  const testNotification = useTestNotification();
  const { addToast } = useToast();
  const { t } = useI18n();
  const { formatDateTime } = useDateTime();
  const [showForm, setShowForm] = useState(false);
  const [duplicateChannel, setDuplicateChannel] = useState<NotificationChannel | null>(null);
  const [editChannel, setEditChannel] = useState<NotificationChannel | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [resetDedupeId, setResetDedupeId] = useState<number | null>(null);
  const [orderedChannels, setOrderedChannels] = useState<NotificationChannel[]>([]);
  const orderedChannelsRef = useRef<NotificationChannel[]>([]);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);

  useEffect(() => {
    setOrderedChannels(channels ?? []);
  }, [channels]);

  useEffect(() => {
    if (!editChannel) return;
    const refreshed = channels?.find((channel) => channel.id === editChannel.id) || null;
    if (!refreshed) {
      setEditChannel(null);
      return;
    }
    if (refreshed !== editChannel) {
      setEditChannel(refreshed);
    }
  }, [channels, editChannel]);

  useEffect(() => {
    orderedChannelsRef.current = orderedChannels;
  }, [orderedChannels]);

  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody || orderedChannels.length <= 1) {
      sortableRef.current?.destroy();
      sortableRef.current = null;
      return;
    }

    sortableRef.current?.destroy();
    sortableRef.current = new Sortable(tbody, {
      animation: 150,
      handle: ".drag-handle",
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (
          evt.oldIndex === undefined ||
          evt.newIndex === undefined ||
          evt.oldIndex === evt.newIndex
        ) {
          return;
        }

        const previousChannels = orderedChannelsRef.current;
        const nextChannels = moveNotification(previousChannels, evt.oldIndex, evt.newIndex);

        setOrderedChannels(nextChannels);
        reorderNotifications.mutate(nextChannels.map((channel) => channel.id), {
          onError: (err) => {
            setOrderedChannels(previousChannels);
            addToast(err.message, "danger");
          },
        });
      },
    });

    return () => {
      sortableRef.current?.destroy();
      sortableRef.current = null;
    };
  }, [orderedChannels.length, reorderNotifications, addToast]);

  useEffect(() => {
    sortableRef.current?.option("disabled", reorderNotifications.isPending);
  }, [reorderNotifications.isPending]);

  const handleCreate = (data: {
    name: string;
    type: string;
    enabled: boolean;
    notifyOn: string[];
    systemIds: number[] | null;
    config: NotificationConfig;
    schedule: string | null;
    scheduleId: number | null;
    scheduleIds: number[];
    sourceNotificationId?: number;
  }) => {
    createNotification.mutate(data, {
      onSuccess: () => {
        setShowForm(false);
        setDuplicateChannel(null);
        addToast(t("pages.notifications.notificationChannelCreated"), "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleUpdate = (data: {
    name: string;
    type: string;
    enabled: boolean;
    notifyOn: string[];
    systemIds: number[] | null;
    config: NotificationConfig;
    schedule: string | null;
    scheduleId: number | null;
    scheduleIds: number[];
  }) => {
    if (!editChannel) return;
    updateNotification.mutate(
      { id: editChannel.id, ...data },
      {
        onSuccess: () => {
          setEditChannel(null);
          addToast(t("pages.notifications.notificationChannelUpdated"), "success");
        },
        onError: (err) => addToast(err.message, "danger"),
      }
    );
  };

  const handleDelete = () => {
    if (deleteId === null) return;
    deleteNotification.mutate(deleteId, {
      onSuccess: () => {
        setDeleteId(null);
        addToast(t("pages.notifications.notificationChannelDeleted"), "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleResetUpdateDedupe = () => {
    if (resetDedupeId === null) return;
    resetNotificationUpdateDedupe.mutate(resetDedupeId, {
      onSuccess: () => {
        setResetDedupeId(null);
        addToast(t("pages.notifications.updateDedupeResetForNotificationChannel"), "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleTest = (id: number) => {
    testNotification.mutate(id, {
      onSuccess: (data) => {
        if (data.success) {
          addToast(t("pages.notifications.testNotificationSent"), "success");
        } else {
          addToast(t("pages.notifications.testFailedError", { error: data.error }), "danger");
        }
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleToggleEnabled = (channel: NotificationChannel) => {
    updateNotification.mutate(
      { id: channel.id, enabled: !channel.enabled },
      {
        onError: (err) => addToast(err.message, "danger"),
      }
    );
  };

  const getSystemScopeLabel = (systemIds: number[] | null): string => {
    if (systemIds === null) return t("pages.notifications.all");
    if (systemIds.length === 0) return t("pages.notifications.none");
    if (!systemsList) {
      return t("pages.notifications.countSystemlabel", {
        count: systemIds.length,
        systemLabel: systemIds.length === 1 ? t("pages.notifications.system") : t("pages.notifications.systems2"),
      });
    }
    const names = systemIds
      .map((id) => systemsList.find((system) => system.id === id)?.name)
      .filter(Boolean);
    if (names.length === 0) {
      return t("pages.notifications.countSystemlabel", {
        count: systemIds.length,
        systemLabel: systemIds.length === 1 ? t("pages.notifications.system") : t("pages.notifications.systems2"),
      });
    }
    if (names.length <= 2) return names.join(", ");
    return t("pages.notifications.countSystems", { count: names.length });
  };

  const getEventLabel = (channel: NotificationChannel): string =>
    channel.notifyOn.map((event) => t(EVENT_LABELS[event] || event)).join(", ");

  const canResetUpdateDedupe = (channel: NotificationChannel): boolean =>
    channel.notifyOn.includes("updates");

  return (
    <Layout
      title={t("pages.notifications.notifications")}
      actions={
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          {t("pages.notifications.addNotification")}
        </button>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      ) : channels && channels.length > 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-border overflow-x-auto overflow-y-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-3">{t("pages.notifications.name")}</th>
                <th className="px-4 py-3">{t("pages.notifications.type")}</th>
                <th className="px-4 py-3 hidden sm:table-cell">{t("pages.notifications.events")}</th>
                <th className="px-4 py-3 hidden md:table-cell">{t("pages.notifications.systems")}</th>
                <th className="px-4 py-3 hidden lg:table-cell">{t("pages.notifications.delivery")}</th>
                <th className="px-4 py-3">{t("pages.notifications.enabled")}</th>
                <th className="px-4 py-3 text-right">{t("pages.notifications.actions")}</th>
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {orderedChannels.map((channel) => (
                <tr
                  key={channel.id}
                  className="border-b border-border last:border-0 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={`drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                          reorderNotifications.isPending || orderedChannels.length < 2
                            ? "cursor-not-allowed opacity-40"
                            : "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                        }`}
                        title={t("pages.notifications.dragToReorder")}
                        aria-label={t("pages.notifications.dragToReorderName", { name: channel.name })}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                        </svg>
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{channel.name}</div>
                        {describeDelivery(channel, formatDateTime) && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {t("pages.notifications.lastDeliveryDelivery", {
                              delivery: describeDelivery(channel, formatDateTime) ?? "",
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {TYPE_LABELS[channel.type] ? t(TYPE_LABELS[channel.type]) : channel.type}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-slate-500 dark:text-slate-400">
                    <span className="block max-w-md truncate" title={getEventLabel(channel)}>
                      {getEventLabel(channel)}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-slate-500 dark:text-slate-400">
                    <span className="block max-w-md truncate" title={getSystemScopeLabel(channel.systemIds)}>
                      {getSystemScopeLabel(channel.systemIds)}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-slate-500 dark:text-slate-400">
                    <span className="block max-w-md truncate" title={describeNotificationSchedule(channel, t)}>
                      {describeNotificationSchedule(channel, t)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggleEnabled(channel)}
                      className={`relative w-9 h-5 rounded-full transition-colors ${
                        channel.enabled ? "bg-blue-500" : "bg-slate-300 dark:bg-slate-600"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          channel.enabled ? "translate-x-4" : ""
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleTest(channel.id)}
                        disabled={testNotification.isPending}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title={t("pages.notifications.sendTestNotification")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setResetDedupeId(channel.id)}
                        disabled={!canResetUpdateDedupe(channel) || resetNotificationUpdateDedupe.isPending}
                        className={`p-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                          canResetUpdateDedupe(channel)
                            ? "hover:bg-slate-100 dark:hover:bg-slate-700"
                            : "text-slate-400 dark:text-slate-500"
                        }`}
                        title={
                          canResetUpdateDedupe(channel)
                            ? t("pages.notifications.resetUpdateDedupe")
                            : t("pages.notifications.updateDedupeResetIsOnlyAvailableForChannels")
                        }
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.8}
                            d="M3 12a9 9 0 0115.3-6.364M18.3 5.636H14.5V1.8M21 12a9 9 0 01-15.3 6.364M5.7 18.364h3.8V22.2"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          setDuplicateChannel(channel);
                          setShowForm(true);
                        }}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title={t("pages.notifications.copyNotification")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setEditChannel(channel)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title={t("pages.notifications.editNotification")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteId(channel.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title={t("pages.notifications.deleteNotification")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center py-16">
          <p className="text-slate-500 dark:text-slate-400 mb-4">
            {t("pages.notifications.noNotificationChannelsConfiguredYet")}
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {t("pages.notifications.addYourFirstNotification")}
          </button>
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setDuplicateChannel(null);
        }}
        title={duplicateChannel ? t("pages.notifications.duplicateNotification") : t("pages.notifications.addNotification")}
        dismissible={!createNotification.isPending}
      >
        <NotificationForm
          key={duplicateChannel?.id ?? "new"}
          initial={duplicateChannel ? buildDuplicateNotification(duplicateChannel, t) : undefined}
          onSubmit={(data) => handleCreate({
            ...data,
            sourceNotificationId: duplicateChannel?.id,
          })}
          onCancel={() => {
            setShowForm(false);
            setDuplicateChannel(null);
          }}
          loading={createNotification.isPending}
        />
      </Modal>

      <Modal
        open={editChannel !== null}
        onClose={() => setEditChannel(null)}
        title={t("pages.notifications.editNotification2")}
        dismissible={!updateNotification.isPending}
      >
        {editChannel && (
          <NotificationForm
            initial={editChannel}
            onSubmit={handleUpdate}
            onCancel={() => setEditChannel(null)}
            loading={updateNotification.isPending}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title={t("pages.notifications.deleteNotification2")}
        message={t("pages.notifications.areYouSureYouWantToDeleteThis")}
        confirmLabel={t("pages.notifications.delete")}
        danger
        loading={deleteNotification.isPending}
      />

      <ConfirmDialog
        open={resetDedupeId !== null}
        onClose={() => setResetDedupeId(null)}
        onConfirm={handleResetUpdateDedupe}
        title={t("pages.notifications.resetUpdateDedupe2")}
        message={t("pages.notifications.thisClearsTheStoredUpdateVersionDedupeState")}
        confirmLabel={t("pages.notifications.resetDedupe")}
        loading={resetNotificationUpdateDedupe.isPending}
      />
    </Layout>
  );
}
