import { useEffect, useRef, useState } from "react";
import Sortable from "sortablejs";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  useNotifications,
  useCreateNotification,
  useUpdateNotification,
  useDeleteNotification,
  useReorderNotifications,
  useTestNotification,
  useTestNotificationConfig,
  type NotificationChannel,
} from "../lib/notifications";
import { useSystems } from "../lib/systems";
import { useToast } from "../context/ToastContext";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const checkboxClass =
  "w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500";

const TYPE_LABELS: Record<string, string> = {
  email: "Email",
  gotify: "Gotify",
  ntfy: "ntfy.sh",
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

function describeSchedule(cron: string | null): string {
  if (!cron) return "Immediate";
  const presetMatch = SCHEDULE_PRESETS.find((p) => p.value === cron);
  if (presetMatch) return presetMatch.label;
  return cron;
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
    config: Record<string, string>;
    schedule: string | null;
  }) => void;
  onCancel: () => void;
  loading: boolean;
}) {
  const { data: systemsList } = useSystems();
  const testConfig = useTestNotificationConfig();
  const { addToast } = useToast();
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

  const [smtpHost, setSmtpHost] = useState(initial?.config.smtpHost || "");
  const [smtpPort, setSmtpPort] = useState(initial?.config.smtpPort || "587");
  const [smtpSecure, setSmtpSecure] = useState(
    initial?.config.smtpSecure !== "false"
  );
  const [smtpUser, setSmtpUser] = useState(initial?.config.smtpUser || "");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpFrom, setSmtpFrom] = useState(initial?.config.smtpFrom || "");
  const [emailTo, setEmailTo] = useState(initial?.config.emailTo || "");
  const [emailImportanceOverride, setEmailImportanceOverride] = useState(
    initial?.config.emailImportanceOverride || "auto"
  );

  const [gotifyUrl, setGotifyUrl] = useState(
    initial?.config.gotifyUrl || ""
  );
  const [gotifyToken, setGotifyToken] = useState("");
  const [gotifyPriorityOverride, setGotifyPriorityOverride] = useState(
    normalizeGotifyPriorityOverride(initial?.config.gotifyPriorityOverride)
  );

  const [ntfyUrl, setNtfyUrl] = useState(
    initial?.config.ntfyUrl || "https://ntfy.sh"
  );
  const [ntfyTopic, setNtfyTopic] = useState(initial?.config.ntfyTopic || "");
  const [ntfyToken, setNtfyToken] = useState("");
  const [ntfyPriorityOverride, setNtfyPriorityOverride] = useState(
    initial?.config.ntfyPriorityOverride || "auto"
  );

  const initialScheduleMode = initial?.schedule ? "scheduled" : "immediate";
  const initialPreset = initial?.schedule
    ? SCHEDULE_PRESETS.find((p) => p.value === initial.schedule)
      ? initial.schedule
      : "custom"
    : SCHEDULE_PRESETS[0].value;
  const [scheduleMode, setScheduleMode] = useState<"immediate" | "scheduled">(
    initialScheduleMode
  );
  const [schedulePreset, setSchedulePreset] = useState(initialPreset);
  const [customCron, setCustomCron] = useState(
    initial?.schedule && !SCHEDULE_PRESETS.find((p) => p.value === initial.schedule)
      ? initial.schedule
      : ""
  );

  const toggleNotifyOn = (event: string) => {
    setNotifyOn((prev) =>
      prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event]
    );
  };

  const toggleSystem = (id: number) => {
    setSelectedSystemIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const buildConfig = (): Record<string, string> =>
    type === "email"
      ? {
          smtpHost,
          smtpPort,
          smtpSecure: smtpSecure ? "true" : "false",
          smtpUser,
          smtpPassword:
            smtpPassword || (initial?.config.smtpPassword === "(stored)" ? "(stored)" : ""),
          smtpFrom,
          emailTo,
          emailImportanceOverride,
        }
      : type === "gotify"
        ? {
            gotifyUrl,
            gotifyToken:
              gotifyToken || (initial?.config.gotifyToken === "(stored)" ? "(stored)" : ""),
            gotifyPriorityOverride,
          }
      : {
          ntfyUrl,
          ntfyTopic,
          ntfyToken:
            ntfyToken || (initial?.config.ntfyToken === "(stored)" ? "(stored)" : ""),
          ntfyPriorityOverride,
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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyOn.includes("updates")}
              onChange={() => toggleNotifyOn("updates")}
              className={checkboxClass}
            />
            <span className="text-sm">Updates available</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyOn.includes("unreachable")}
              onChange={() => toggleNotifyOn("unreachable")}
              className={checkboxClass}
            />
            <span className="text-sm">System unreachable</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyOn.includes("appUpdates")}
              onChange={() => toggleNotifyOn("appUpdates")}
              className={checkboxClass}
            />
            <span className="text-sm">Application update available</span>
          </label>
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
              systemsList.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 px-2 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-700/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedSystemIds.includes(s.id)}
                    onChange={() => toggleSystem(s.id)}
                    className={checkboxClass}
                  />
                  <span className="text-sm">{s.name}</span>
                  <span className="text-xs text-slate-400">
                    {s.hostname}
                  </span>
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
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
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
            <p className="text-xs text-slate-500">
              Events are batched and sent as a digest at the scheduled time.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-border pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3">
          {type === "email" ? "Email (SMTP)" : type === "gotify" ? "Gotify" : "ntfy.sh"}
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {type === "email" ? (
            <>
              <div>
                <label className={labelClass}>SMTP Host</label>
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => setSmtpHost(e.target.value)}
                  className={inputClass}
                  placeholder="smtp.example.com"
                />
              </div>
              <div>
                <label className={labelClass}>SMTP Port</label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>SMTP User</label>
                <input
                  type="text"
                  value={smtpUser}
                  onChange={(e) => setSmtpUser(e.target.value)}
                  className={inputClass}
                  placeholder="mailer"
                />
              </div>
              <div className="sm:col-span-2">
                <label className={labelClass}>SMTP Password</label>
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  className={inputClass}
                  placeholder={initial?.config.smtpPassword === "(stored)" ? "(unchanged)" : ""}
                />
              </div>
              <div>
                <label className={labelClass}>From Address</label>
                <input
                  type="email"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  className={inputClass}
                  placeholder="dashboard@example.com"
                />
              </div>
              <div>
                <label className={labelClass}>To Address(es)</label>
                <input
                  type="text"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  className={inputClass}
                  placeholder="admin@example.com"
                />
              </div>
              <div>
                <label className={labelClass}>Importance</label>
                <select
                  value={emailImportanceOverride}
                  onChange={(e) => setEmailImportanceOverride(e.target.value)}
                  className={inputClass}
                >
                  {EMAIL_IMPORTANCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : type === "gotify" ? (
            <>
              <div>
                <label className={labelClass}>Server URL</label>
                <input
                  type="url"
                  value={gotifyUrl}
                  onChange={(e) => setGotifyUrl(e.target.value)}
                  className={inputClass}
                  placeholder="https://gotify.example.com"
                />
              </div>
              <div>
                <label className={labelClass}>Priority</label>
                <select
                  value={gotifyPriorityOverride}
                  onChange={(e) => setGotifyPriorityOverride(e.target.value)}
                  className={inputClass}
                >
                  {GOTIFY_PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
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
                  placeholder={initial?.config.gotifyToken === "(stored)" ? "(unchanged)" : ""}
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className={labelClass}>Server URL</label>
                <input
                  type="url"
                  value={ntfyUrl}
                  onChange={(e) => setNtfyUrl(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>Topic</label>
                <input
                  type="text"
                  value={ntfyTopic}
                  onChange={(e) => setNtfyTopic(e.target.value)}
                  className={inputClass}
                  placeholder="my-updates"
                />
              </div>
              <div>
                <label className={labelClass}>Access Token</label>
                <input
                  type="password"
                  value={ntfyToken}
                  onChange={(e) => setNtfyToken(e.target.value)}
                  className={inputClass}
                  placeholder={initial?.config.ntfyToken === "(stored)" ? "(unchanged)" : ""}
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
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </div>

        {type === "email" && (
          <label className="flex items-center gap-2 mt-3">
            <input
              type="checkbox"
              checked={smtpSecure}
              onChange={(e) => setSmtpSecure(e.target.checked)}
              className={checkboxClass}
            />
            <span className="text-sm">Use TLS</span>
          </label>
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
          {testConfig.isPending ? (
            <span className="spinner spinner-sm" />
          ) : (
            "Send Test"
          )}
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
  const [editChannel, setEditChannel] = useState<NotificationChannel | null>(
    null
  );
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [orderedChannels, setOrderedChannels] = useState<NotificationChannel[]>([]);
  const orderedChannelsRef = useRef<NotificationChannel[]>([]);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);

  useEffect(() => {
    setOrderedChannels(channels ?? []);
  }, [channels]);

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
    config: Record<string, string>;
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
    config: Record<string, string>;
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
      .map((id) => systemsList.find((s) => s.id === id)?.name)
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
              {orderedChannels.map((ch) => (
                <tr
                  key={ch.id}
                  className="border-b border-border last:border-0 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                          reorderNotifications.isPending || orderedChannels.length < 2
                            ? "cursor-not-allowed opacity-40"
                            : "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                        }`}
                        title="Drag to reorder"
                        aria-label={`Drag to reorder ${ch.name}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                        </svg>
                      </span>
                      <span className="min-w-0 truncate font-medium">{ch.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {TYPE_LABELS[ch.type] || ch.type}
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell text-slate-500 dark:text-slate-400">
                    {ch.notifyOn
                      .map((e) => EVENT_LABELS[e] || e)
                      .join(", ")}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-slate-500 dark:text-slate-400">
                    {getSystemScopeLabel(ch.systemIds)}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-slate-500 dark:text-slate-400">
                    {describeSchedule(ch.schedule)}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggleEnabled(ch)}
                      className={`relative w-9 h-5 rounded-full transition-colors ${
                        ch.enabled
                          ? "bg-blue-500"
                          : "bg-slate-300 dark:bg-slate-600"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          ch.enabled ? "translate-x-4" : ""
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => handleTest(ch.id)}
                        disabled={testNotification.isPending}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Send test notification"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => setEditChannel(ch)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Edit"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteId(ch.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title="Delete"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
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
