import { useEffect, useRef, useState } from "react";
import Sortable from "sortablejs";
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
  useReorderNotifications,
  useTestNotification,
  useTestNotificationConfig,
  useUnlinkTelegramChat,
  type NotificationChannel,
  type NotificationConfig,
  type TelegramConfig,
  type WebhookConfig,
  type WebhookField,
} from "../lib/notifications";
import { useSystems } from "../lib/systems";
import { useToast } from "../context/ToastContext";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const checkboxClass =
  "w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500";
const mutedTextClass = "text-xs text-slate-500 dark:text-slate-400";
const MASKED_VALUE = "(stored)";
const TELEGRAM_BINDING_STATUS_LABELS: Record<string, string> = {
  unbound: "Not linked",
  pending: "Link pending",
  bound: "Linked",
};
const TELEGRAM_COMMAND_TOKEN_STATUS_LABELS: Record<string, string> = {
  "not-required": "Not required",
  pending: "Waiting for linked chat",
  missing: "Missing or revoked",
  expired: "Expired",
  active: "Active",
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
  email: "Email",
  gotify: "Gotify",
  ntfy: "ntfy.sh",
  telegram: "Telegram",
  webhook: "Webhook",
};

const SCHEDULE_PRESETS: { label: string; value: string }[] = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 3 hours", value: "0 */3 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at 00:00", value: "0 0 * * *" },
  { label: "Weekly Monday 09:00", value: "0 9 * * 1" },
  { label: "Custom", value: "custom" },
];

const PUSH_PRIORITY_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "min", label: "Min" },
  { value: "low", label: "Low" },
  { value: "default", label: "Default" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const GOTIFY_PRIORITY_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "0", label: "0 - Silent" },
  { value: "1", label: "1 - Low" },
  { value: "3", label: "3 - Default low" },
  { value: "5", label: "5 - Normal" },
  { value: "8", label: "8 - High" },
  { value: "10", label: "10 - Max" },
];

const EMAIL_IMPORTANCE_OPTIONS = [
  { value: "auto", label: "Automatic" },
  { value: "normal", label: "Normal" },
  { value: "important", label: "Important" },
];

const EVENT_LABELS: Record<string, string> = {
  updates: "Updates",
  unreachable: "Unreachable",
  appUpdates: "Application updates",
};

const DEFAULT_NOTIFY_ON = ["updates", "appUpdates"];

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

function describeSchedule(cron: string | null): string {
  if (!cron) return "Immediate";
  const presetMatch = SCHEDULE_PRESETS.find((preset) => preset.value === cron);
  if (presetMatch) return presetMatch.label;
  return cron;
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

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function describeDelivery(channel: NotificationChannel): string | null {
  if (!channel.lastDeliveryStatus) return null;
  const when = formatTimestamp(channel.lastDeliveryAt);
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
      return "This destination is blocked server-side because it targets cloud metadata endpoints.";
    }
    if (isLoopbackOrPrivateHost(host)) {
      return "This destination appears to be loopback, link-local, or private. That is allowed for trusted self-hosted targets, but treat it as an advanced setting.";
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
          Add row
        </button>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <p className={mutedTextClass}>No entries configured</p>
        ) : (
          items.map((item, index) => (
            <div key={index} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
              <input
                type="text"
                value={item.name}
                onChange={(e) => updateItem(index, { name: e.target.value })}
                className={inputClass}
                placeholder="Name"
              />
              <input
                type={allowSensitive && item.sensitive ? "password" : "text"}
                value={item.value === MASKED_VALUE ? "" : item.value}
                onChange={(e) => updateItem(index, { value: e.target.value })}
                className={inputClass}
                placeholder={item.value === MASKED_VALUE ? "(unchanged)" : "Value"}
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
                  Secret
                </label>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => removeItem(index)}
                className="px-2 py-2 text-xs rounded border border-border hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500"
              >
                Remove
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
  }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const { data: systemsList } = useSystems();
  const testConfig = useTestNotificationConfig();
  const createTelegramLink = useCreateTelegramLink();
  const reissueTelegramCommandToken = useReissueTelegramCommandToken();
  const unlinkTelegramChat = useUnlinkTelegramChat();
  const { addToast } = useToast();
  const initialWebhook = initial ? coerceWebhookConfig(initial.config) : defaultWebhookConfig();
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
  const [smtpSecure, setSmtpSecure] = useState(
    readString(initial?.config || {}, "smtpSecure", "true") !== "false"
  );
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
        ? TELEGRAM_COMMAND_TOKEN_STATUS_LABELS[initialTelegram.commandTokenStatus || "not-required"] || "Unknown"
        : !initial?.id
          ? "Save notification first"
          : !initialTelegram.chatId
            ? "Waiting for linked chat"
            : "Will be issued after save";

  const [webhookConfig, setWebhookConfig] = useState<WebhookConfig>(initialWebhook);

  const initialScheduleMode = initial?.schedule ? "scheduled" : "immediate";
  const initialPreset = initial?.schedule
    ? SCHEDULE_PRESETS.find((preset) => preset.value === initial.schedule)
      ? initial.schedule
      : "custom"
    : SCHEDULE_PRESETS[0].value;
  const [scheduleMode, setScheduleMode] = useState<"immediate" | "scheduled">(
    initialScheduleMode
  );
  const [schedulePreset, setSchedulePreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(
    initial?.schedule && !SCHEDULE_PRESETS.find((preset) => preset.value === initial.schedule)
      ? initial.schedule
      : ""
  );

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
        smtpSecure: smtpSecure ? "true" : "false",
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

    if (type === "telegram") {
      return {
        telegramBotToken:
          telegramBotToken || (initialTelegram.telegramBotToken === MASKED_VALUE ? MASKED_VALUE : ""),
        commandsEnabled: telegramCommandsEnabled,
      };
    }

    return finalizeWebhookConfig(webhookConfig, initial ? coerceWebhookConfig(initial.config) : undefined);
  };

  const getScheduleValue = (): string | null => {
    if (scheduleMode === "immediate") return null;
    if (schedulePreset === "custom") return customCron || null;
    return schedulePreset;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name,
      type,
      enabled,
      notifyOn,
      systemIds: allSystems ? null : selectedSystemIds,
      config: buildConfig(),
      schedule: getScheduleValue(),
    });
  };

  const handleInlineTest = () => {
    testConfig.mutate(
      {
        type,
        config: buildConfig(),
        name: name || undefined,
        existingId: initial?.id,
      },
      {
        onSuccess: (data) => {
          if (data.success) {
            addToast("Test notification sent", "success");
          } else {
            addToast(`Test failed: ${data.error}`, "danger");
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
        addToast("Telegram link created", "success");
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
        addToast("Telegram chat unlinked", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleTelegramReissueCommandToken = () => {
    if (!initial?.id) return;
    reissueTelegramCommandToken.mutate(initial.id, {
      onSuccess: () => addToast("Telegram command token reissued", "success"),
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const destinationWarning = type === "webhook" ? getWebhookDestinationWarning(webhookConfig.url) : null;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            placeholder="e.g. Ops Team Email"
            required
          />
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className={inputClass}
            disabled={!!initial}
          >
            <option value="email">Email (SMTP)</option>
            <option value="gotify">Gotify</option>
            <option value="ntfy">ntfy.sh</option>
            <option value="telegram">Telegram</option>
            <option value="webhook">Webhook</option>
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
        <span className="text-sm font-medium">Enabled</span>
      </label>

      <div>
        <span className={labelClass}>Events</span>
        <div className="flex flex-wrap gap-4">
          {Object.entries(EVENT_LABELS).map(([event, label]) => (
            <label key={event} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={notifyOn.includes(event)}
                onChange={() => toggleNotifyOn(event)}
                className={checkboxClass}
              />
              <span className="text-sm">{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <span className={labelClass}>Systems</span>
        <label className="flex items-center gap-2 mb-2">
          <input
            type="checkbox"
            checked={allSystems}
            onChange={(e) => setAllSystems(e.target.checked)}
            className={checkboxClass}
          />
          <span className="text-sm font-medium">All systems</span>
        </label>
        {!allSystems && systemsList && (
          <div className="max-h-40 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
            {systemsList.length === 0 ? (
              <p className="text-xs text-slate-400 p-1">No systems configured</p>
            ) : (
              systemsList.map((system) => (
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
        <span className={labelClass}>Schedule</span>
        <div className="flex gap-4 mb-2">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="scheduleMode"
              checked={scheduleMode === "immediate"}
              onChange={() => setScheduleMode("immediate")}
              className="w-4 h-4 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm">Immediate</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="scheduleMode"
              checked={scheduleMode === "scheduled"}
              onChange={() => setScheduleMode("scheduled")}
              className="w-4 h-4 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm">Scheduled (digest)</span>
          </label>
        </div>
        {scheduleMode === "scheduled" && (
          <div className="space-y-2">
            <select
              value={schedulePreset}
              onChange={(e) => setSchedulePreset(e.target.value)}
              className={inputClass}
            >
              {SCHEDULE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            {schedulePreset === "custom" && (
              <div>
                <input
                  type="text"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  className={inputClass}
                  placeholder="e.g. 0 23 * * 1 (Mon 23:00)"
                />
                <p className="text-xs text-slate-400 mt-1">
                  Standard cron format: minute hour day-of-month month day-of-week
                </p>
              </div>
            )}
            <p className={mutedTextClass}>
              Events are batched and sent as a digest at the scheduled time.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {TYPE_LABELS[type] || type}
        </h3>

        {type === "email" && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>SMTP Host</label>
                <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>SMTP Port</label>
                <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} className={inputClass} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>SMTP User</label>
                <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} className={inputClass} />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>SMTP Password</label>
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  className={inputClass}
                  placeholder={readString(initial?.config || {}, "smtpPassword") === MASKED_VALUE ? "(unchanged)" : ""}
                />
              </div>
              <div>
                <label className={labelClass}>From Address</label>
                <input value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>To Address(es)</label>
                <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Importance</label>
                <select
                  value={emailImportanceOverride}
                  onChange={(e) => setEmailImportanceOverride(e.target.value)}
                  className={inputClass}
                >
                  {EMAIL_IMPORTANCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={smtpSecure}
                onChange={(e) => setSmtpSecure(e.target.checked)}
                className={checkboxClass}
              />
              <span className="text-sm">Use TLS</span>
            </label>
          </>
        )}

        {type === "gotify" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Server URL</label>
              <input value={gotifyUrl} onChange={(e) => setGotifyUrl(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Priority</label>
              <select
                value={gotifyPriorityOverride}
                onChange={(e) => setGotifyPriorityOverride(e.target.value)}
                className={inputClass}
              >
                {GOTIFY_PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass}>App Token</label>
              <input
                type="password"
                value={gotifyToken}
                onChange={(e) => setGotifyToken(e.target.value)}
                className={inputClass}
                placeholder={readString(initial?.config || {}, "gotifyToken") === MASKED_VALUE ? "(unchanged)" : ""}
              />
            </div>
          </div>
        )}

        {type === "ntfy" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Server URL</label>
              <input value={ntfyUrl} onChange={(e) => setNtfyUrl(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Topic</label>
              <input value={ntfyTopic} onChange={(e) => setNtfyTopic(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Access Token</label>
              <input
                type="password"
                value={ntfyToken}
                onChange={(e) => setNtfyToken(e.target.value)}
                className={inputClass}
                placeholder={readString(initial?.config || {}, "ntfyToken") === MASKED_VALUE ? "(unchanged)" : ""}
              />
            </div>
            <div>
              <label className={labelClass}>Priority</label>
              <select
                value={ntfyPriorityOverride}
                onChange={(e) => setNtfyPriorityOverride(e.target.value)}
                className={inputClass}
              >
                {PUSH_PRIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {type === "telegram" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className={labelClass}>Bot Token</label>
                <input
                  type="password"
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                  className={inputClass}
                  placeholder={initialTelegram.telegramBotToken === MASKED_VALUE ? "(unchanged)" : "123456789:AA..."}
                />
                <p className={mutedTextClass}>
                  Create the bot with BotFather, then paste the bot token here.
                </p>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-medium">Chat binding</div>
                  <div className={mutedTextClass}>
                    {TELEGRAM_BINDING_STATUS_LABELS[initialTelegram.chatBindingStatus || "unbound"] || "Not linked"}
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
                    {createTelegramLink.isPending ? <span className="spinner spinner-sm" /> : "Create Link"}
                  </button>
                  <button
                    type="button"
                    onClick={handleTelegramUnlink}
                    disabled={!initial?.id || !initialTelegram.chatId || unlinkTelegramChat.isPending}
                    className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-50"
                  >
                    {unlinkTelegramChat.isPending ? <span className="spinner spinner-sm" /> : "Unlink"}
                  </button>
                </div>
              </div>
              {!initial?.id && (
                <p className={mutedTextClass}>
                  Save this notification first, then reopen it to create the one-time Telegram connect link.
                </p>
              )}
              {telegramLinkUrl && (
                <div className="rounded-lg border border-blue-200 dark:border-blue-800/60 bg-blue-50 dark:bg-blue-950/20 p-3 space-y-2">
                  <p className="text-sm">
                    Open this link in Telegram to bind the private chat:
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
                      Expires: {formatTimestamp(telegramLinkExpiresAt)}
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
                <span className="text-sm font-medium">Enable bot commands</span>
              </label>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Disabled by default. When enabled, the dashboard auto-generates a dedicated writable API token for this Telegram channel after the private chat is linked.
              </p>
            </div>

            {showTelegramCommandToken && (
              <div className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium">Command token</div>
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
                    {reissueTelegramCommandToken.isPending ? <span className="spinner spinner-sm" /> : "Reissue Token"}
                  </button>
                </div>
                {persistedTelegramCommandsEnabled && initialTelegram.commandApiTokenId ? (
                  <p className={mutedTextClass}>Token ID: #{initialTelegram.commandApiTokenId}</p>
                ) : null}
                {persistedTelegramCommandsEnabled && initialTelegram.commandTokenCreatedAt ? (
                  <p className={mutedTextClass}>Created: {formatTimestamp(initialTelegram.commandTokenCreatedAt)}</p>
                ) : null}
                {persistedTelegramCommandsEnabled && initialTelegram.commandTokenLastUsedAt ? (
                  <p className={mutedTextClass}>Last used: {formatTimestamp(initialTelegram.commandTokenLastUsedAt)}</p>
                ) : null}
                {persistedTelegramCommandsEnabled && initialTelegram.commandTokenExpiresAt ? (
                  <p className={mutedTextClass}>Expires: {formatTimestamp(initialTelegram.commandTokenExpiresAt)}</p>
                ) : null}
                {!persistedTelegramCommandsEnabled && (
                  <p className={mutedTextClass}>
                    Save this notification to activate Telegram commands and issue the dedicated command token.
                  </p>
                )}
                {persistedTelegramCommandsEnabled && !initialTelegram.chatId && (
                  <p className={mutedTextClass}>
                    Link the Telegram private chat first. The command token is issued only after the chat is linked.
                  </p>
                )}
                {persistedTelegramCommandsEnabled && initialTelegram.chatId && (initialTelegram.commandTokenStatus === "missing" || initialTelegram.commandTokenStatus === "expired") && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    Telegram bot commands cannot authenticate right now. Reissue the token to restore command access.
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
                <label className={labelClass}>Preset</label>
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
                  <option value="custom">Custom</option>
                  <option value="discord">Discord</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Method</label>
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
              <label className={labelClass}>URL</label>
              <input
                type="url"
                value={webhookConfig.url}
                onChange={(e) => setWebhookConfig((prev) => ({ ...prev, url: e.target.value }))}
                className={inputClass}
                placeholder="https://example.com/webhook"
              />
              {destinationWarning && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{destinationWarning}</p>
              )}
            </div>

            <RowEditor
              label="Query Parameters"
              items={webhookConfig.query.map((entry) => ({ ...entry, sensitive: false }))}
              onChange={(items) => setWebhookConfig((prev) => ({
                ...prev,
                query: items.map(({ name, value }) => ({ name, value })),
              }))}
            />
            <p className={mutedTextClass}>
              Query parameters are intentionally not secret. URLs are more likely to be logged by receivers, proxies, and monitoring systems.
            </p>

            <RowEditor
              label="Headers"
              items={webhookConfig.headers}
              onChange={(items) => setWebhookConfig((prev) => ({ ...prev, headers: items }))}
              allowSensitive
            />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className={labelClass}>Auth</label>
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
                  <option value="none">None</option>
                  <option value="bearer">Bearer token</option>
                  <option value="basic">Basic auth</option>
                </select>
              </div>
              {webhookConfig.auth.mode === "bearer" && (
                <div className="sm:col-span-2">
                  <label className={labelClass}>Bearer Token</label>
                  <input
                    type="password"
                    value={webhookConfig.auth.token === MASKED_VALUE ? "" : webhookConfig.auth.token}
                    onChange={(e) => setWebhookConfig((prev) => ({
                      ...prev,
                      auth: { mode: "bearer", token: e.target.value },
                    }))}
                    className={inputClass}
                    placeholder={initialWebhook.auth.mode === "bearer" && initialWebhook.auth.token === MASKED_VALUE ? "(unchanged)" : ""}
                  />
                </div>
              )}
              {webhookConfig.auth.mode === "basic" && (
                <>
                  <div>
                    <label className={labelClass}>Username</label>
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
                    <label className={labelClass}>Password</label>
                    <input
                      type="password"
                      value={webhookConfig.auth.password === MASKED_VALUE ? "" : webhookConfig.auth.password}
                      onChange={(e) => setWebhookConfig((prev) => ({
                        ...prev,
                        auth: { mode: "basic", username: prev.auth.mode === "basic" ? prev.auth.username : "", password: e.target.value },
                      }))}
                      className={inputClass}
                      placeholder={initialWebhook.auth.mode === "basic" && initialWebhook.auth.password === MASKED_VALUE ? "(unchanged)" : ""}
                    />
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
              <div>
                <label className={labelClass}>Body Mode</label>
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
                  <option value="text">Text</option>
                  <option value="json">JSON</option>
                  <option value="form">Form URL Encoded</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Timeout (ms)</label>
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
                <label className={labelClass}>Retry Attempts</label>
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
                <label className={labelClass}>Retry Delay (ms)</label>
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
                label="Form Fields"
                items={webhookConfig.body.fields}
                onChange={(items) => setWebhookConfig((prev) => ({
                  ...prev,
                  body: { mode: "form", fields: items },
                }))}
                allowSensitive
              />
            ) : (
              <div>
                <label className={labelClass}>Body Template</label>
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
                  Templates support simple dotted event paths like <code>{"{{event.title}}"}</code>.
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
                <span className="text-sm font-medium">Allow insecure TLS (advanced)</span>
              </label>
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Disabled by default. Only use this for exceptional self-signed endpoints you explicitly trust.
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={handleInlineTest}
          disabled={testConfig.isPending}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors disabled:opacity-50 mr-auto"
          title="Send test notification"
        >
          {testConfig.isPending ? <span className="spinner spinner-sm" /> : "Send Test"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : "Save"}
        </button>
      </div>
    </form>
  );
}

export default function Notifications() {
  const { data: channels, isLoading } = useNotifications();
  const { data: systemsList } = useSystems();
  const createNotification = useCreateNotification();
  const updateNotification = useUpdateNotification();
  const deleteNotification = useDeleteNotification();
  const reorderNotifications = useReorderNotifications();
  const testNotification = useTestNotification();
  const { addToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [editChannel, setEditChannel] = useState<NotificationChannel | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
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
  }) => {
    createNotification.mutate(data, {
      onSuccess: () => {
        setShowForm(false);
        addToast("Notification channel created", "success");
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
  }) => {
    if (!editChannel) return;
    updateNotification.mutate(
      { id: editChannel.id, ...data },
      {
        onSuccess: () => {
          setEditChannel(null);
          addToast("Notification channel updated", "success");
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
        addToast("Notification channel deleted", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleTest = (id: number) => {
    testNotification.mutate(id, {
      onSuccess: (data) => {
        if (data.success) {
          addToast("Test notification sent", "success");
        } else {
          addToast(`Test failed: ${data.error}`, "danger");
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
    if (systemIds === null) return "All";
    if (systemIds.length === 0) return "None";
    if (!systemsList) return `${systemIds.length} system${systemIds.length !== 1 ? "s" : ""}`;
    const names = systemIds
      .map((id) => systemsList.find((system) => system.id === id)?.name)
      .filter(Boolean);
    if (names.length <= 2) return names.join(", ");
    return `${names.length} systems`;
  };

  return (
    <Layout
      title="Notifications"
      actions={
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          Add Notification
        </button>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      ) : channels && channels.length > 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-border overflow-x-auto overflow-y-hidden">
          <table className="min-w-full w-max text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 hidden sm:table-cell">Events</th>
                <th className="px-4 py-3 hidden md:table-cell">Systems</th>
                <th className="px-4 py-3 hidden lg:table-cell">Schedule</th>
                <th className="px-4 py-3">Enabled</th>
                <th className="px-4 py-3 text-right">Actions</th>
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
                        title="Drag to reorder"
                        aria-label={`Drag to reorder ${channel.name}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                        </svg>
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{channel.name}</div>
                        {describeDelivery(channel) && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            Last delivery: {describeDelivery(channel)}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {TYPE_LABELS[channel.type] || channel.type}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-slate-500 dark:text-slate-400">
                    {channel.notifyOn.map((event) => EVENT_LABELS[event] || event).join(", ")}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-slate-500 dark:text-slate-400">
                    {getSystemScopeLabel(channel.systemIds)}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-slate-500 dark:text-slate-400">
                    {describeSchedule(channel.schedule)}
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
                        title="Send test notification"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setEditChannel(channel)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Edit"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteId(channel.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title="Delete"
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
            No notification channels configured yet
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Add Your First Notification
          </button>
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="Add Notification"
        dismissible={false}
      >
        <NotificationForm
          onSubmit={handleCreate}
          onCancel={() => setShowForm(false)}
          loading={createNotification.isPending}
        />
      </Modal>

      <Modal
        open={editChannel !== null}
        onClose={() => setEditChannel(null)}
        title="Edit Notification"
        dismissible={false}
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
        title="Delete Notification"
        message="Are you sure you want to delete this notification channel? This action cannot be undone."
        confirmLabel="Delete"
        danger
        loading={deleteNotification.isPending}
      />
    </Layout>
  );
}
