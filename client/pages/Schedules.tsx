import { useEffect, useMemo, useRef, useState } from "react";
import Sortable from "sortablejs";
import { Cron } from "croner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import {
  isRefreshConfig,
  isNotificationScheduleConfig,
  isUpdateConfig,
  useCreateSchedule,
  useDeleteSchedule,
  useReorderSchedules,
  useSchedules,
  useUpdateSchedule,
  type Schedule,
  type ScheduleConfig,
  type ScheduleType,
} from "../lib/schedules";
import { useNotifications } from "../lib/notifications";
import { useVisibleSystems } from "../lib/systems";
import { getMinScheduleIntervalMinutes } from "../lib/schedule-interval";
import { getCronPreview } from "../lib/cron-preview";
import { useToast } from "../context/ToastContext";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const checkboxClass =
  "w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500";
const MIN_SCHEDULE_INTERVAL_MINUTES = getMinScheduleIntervalMinutes();
const MIN_SCHEDULE_INTERVAL_MS = MIN_SCHEDULE_INTERVAL_MINUTES * 60 * 1000;
const MAX_SCHEDULE_NAME_LENGTH = 100;

const TYPE_LABELS: Record<ScheduleType, string> = {
  refresh: "Refresh",
  update: "Update",
  notification_digest: "Notification",
};

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 3 hours", value: "0 */3 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at 00:00", value: "0 0 * * *" },
  { label: "Daily at 03:00", value: "0 3 * * *" },
  { label: "Weekly Sunday 03:00", value: "0 3 * * 0" },
  { label: "Weekly Monday 09:00", value: "0 9 * * 1" },
  { label: "Monthly on the 1st", value: "0 3 1 * *" },
  { label: "Custom", value: "custom" },
];

function moveSchedule<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value.includes("T") ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
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

function truncateScheduleName(value: string): string {
  if (value.length <= MAX_SCHEDULE_NAME_LENGTH) return value;
  return `${value.slice(0, MAX_SCHEDULE_NAME_LENGTH - 3).trimEnd()}...`;
}

function generateScheduleName(type: ScheduleType, cron: string): string | null {
  const preview = getCronPreview(cron);
  if ("error" in preview) return null;
  return truncateScheduleName(`${TYPE_LABELS[type]} - ${preview.description}`);
}

function getScheduleCron(schedule: Schedule): string | null {
  return "cron" in schedule.config ? schedule.config.cron : null;
}

function describeSchedule(schedule: Schedule): string {
  if (schedule.type === "refresh" && isRefreshConfig(schedule.config)) {
    const config = schedule.config;
    const cache =
      config.cacheDurationHours === 0
        ? "no cache reuse"
        : `${config.cacheDurationHours}h cache`;
    const preset = CRON_PRESETS.find((item) => item.value === config.cron);
    return `${preset ? preset.label : config.cron}, ${cache}`;
  }

  if (schedule.type === "update" && isUpdateConfig(schedule.config)) {
    const config = schedule.config;
    const preset = CRON_PRESETS.find((item) => item.value === config.cron);
    return preset ? preset.label : config.cron;
  }

  if (schedule.type === "notification_digest" && isNotificationScheduleConfig(schedule.config)) {
    const config = schedule.config;
    const preset = CRON_PRESETS.find((item) => item.value === config.cron);
    return preset ? preset.label : config.cron;
  }

  return "Invalid config";
}

function ScheduleMinimumWarning({ cron }: { cron: string }) {
  if (!isBelowMinimumScheduleInterval(cron)) return null;

  return (
    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
      Runs more often than the supported {MIN_SCHEDULE_INTERVAL_MINUTES} minute minimum.
    </p>
  );
}

function ScheduleCronPreview({
  cron,
  showCronString,
  className = "",
}: {
  cron: string;
  showCronString: boolean;
  className?: string;
}) {
  const preview = useMemo(() => getCronPreview(cron), [cron]);

  if (!cron.trim()) return null;

  if ("error" in preview) return null;

  const nextRuns = preview.nextRuns.map((date) =>
    date.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
  );

  return (
    <div
      className={`rounded-lg border border-border bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900/40 ${className}`}
    >
      {showCronString && (
        <div className="mb-2 flex flex-wrap items-center">
          <code className="break-all rounded bg-white px-1.5 py-0.5 font-mono text-slate-700 dark:bg-slate-950/60 dark:text-slate-200">
            {cron}
          </code>
        </div>
      )}
      <div className="font-medium text-slate-700 dark:text-slate-200">
        {preview.description}
      </div>
      {preview.nextRuns.length > 0 && (
        <div className="mt-2 space-y-1 text-slate-500 dark:text-slate-400">
          <div className="font-medium">Next runs</div>
          {nextRuns.map((run) => (
            <div key={run}>{run}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleCronError({ cron }: { cron: string }) {
  const preview = useMemo(() => getCronPreview(cron), [cron]);

  if (!cron.trim() || !("error" in preview)) return null;

  return (
    <p className="mt-2 text-xs text-red-600 dark:text-red-300">
      {preview.error}
    </p>
  );
}

function statusClass(status: string | null): string {
  if (status === "success") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (status === "warning") return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300";
  if (status === "failed") return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300";
  return "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300";
}

type ScheduleFormData = {
  name: string;
  type: ScheduleType;
  enabled: boolean;
  systemIds: number[] | null;
  config: ScheduleConfig;
};

function ScheduleForm({
  initial,
  onSubmit,
  onCancel,
  loading,
}: {
  initial?: Schedule;
  onSubmit: (data: ScheduleFormData) => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  const { data: systemsList } = useVisibleSystems();
  const { data: notificationsList } = useNotifications();
  const initialType = initial?.type ?? "refresh";
  const initialRefreshConfig =
    initial?.config && isRefreshConfig(initial.config)
      ? initial.config
      : { cron: "*/15 * * * *", cacheDurationHours: 12 };
  const initialUpdateConfig =
    initial?.config && isUpdateConfig(initial.config)
      ? initial.config
      : { cron: "0 3 * * 0" };
  const initialNotificationScheduleConfig =
    initial?.config && isNotificationScheduleConfig(initial.config)
      ? initial.config
      : { cron: "0 9 * * 1", notificationIds: [] };
  const initialCron =
    initialType === "refresh"
      ? initialRefreshConfig.cron
      : initialType === "notification_digest"
        ? initialNotificationScheduleConfig.cron
        : initialUpdateConfig.cron;
  const initialCronPreset = CRON_PRESETS.find((preset) => preset.value === initialCron)
    ? initialCron
    : "custom";

  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<ScheduleType>(initialType);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [scope, setScope] = useState<"all" | "selected">(initial?.systemIds === null || !initial ? "all" : "selected");
  const [selectedSystemIds, setSelectedSystemIds] = useState<number[]>(initial?.systemIds ?? []);
  const [selectedNotificationIds, setSelectedNotificationIds] = useState<number[]>(
    initialNotificationScheduleConfig.notificationIds,
  );
  const [cacheDurationHours, setCacheDurationHours] = useState(String(initialRefreshConfig.cacheDurationHours));
  const [cronPreset, setCronPreset] = useState(initialCronPreset);
  const [customCron, setCustomCron] = useState(initialCronPreset === "custom" ? initialCron : "");
  const [error, setError] = useState("");
  const activeCron = cronPreset === "custom" ? customCron.trim() : cronPreset;

  const toggleSystem = (id: number) => {
    setSelectedSystemIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id],
    );
  };

  const toggleNotification = (id: number) => {
    setSelectedNotificationIds((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id],
    );
  };

  const parseBoundedInteger = (
    value: string,
    min: number,
    max: number,
    fallback: number,
  ): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const handleGenerateName = () => {
    setError("");
    const generatedName = generateScheduleName(type, activeCron);
    if (!generatedName) {
      setError("Enter a valid cron expression before generating a name");
      return;
    }
    setName(generatedName);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    const cron = cronPreset === "custom" ? customCron.trim() : cronPreset;
    const config: ScheduleConfig =
      type === "refresh"
        ? {
            cron,
            cacheDurationHours: parseBoundedInteger(cacheDurationHours, 0, 168, 12),
          }
        : type === "notification_digest"
          ? {
              cron,
              notificationIds: selectedNotificationIds,
            }
          : { cron };

    if (!config.cron) {
      setError("Cron expression is required");
      return;
    }
    if ("error" in getCronPreview(config.cron)) {
      setError("Cron expression is invalid");
      return;
    }

    onSubmit({
      name: name.trim(),
      type,
      enabled,
      systemIds: type === "notification_digest" || scope === "all" ? null : selectedSystemIds,
      config,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-300 text-sm">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Name</label>
          <div className="relative">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${inputClass} pr-11`}
              maxLength={MAX_SCHEDULE_NAME_LENGTH}
              autoFocus
            />
            <button
              type="button"
              onClick={handleGenerateName}
              className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200 transition-colors"
              title="Generate schedule name"
              aria-label="Generate schedule name"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16z" />
              </svg>
            </button>
          </div>
        </div>
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ScheduleType)}
            className={inputClass}
          >
            <option value="refresh">Refresh</option>
            <option value="update">Update</option>
            <option value="notification_digest">Notification</option>
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

      {type === "notification_digest" ? (
        <div>
          <label className={labelClass}>Notification channels</label>
          <div className="max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {(notificationsList ?? []).map((channel) => (
              <label
                key={channel.id}
                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700/50"
              >
                <input
                  type="checkbox"
                  checked={selectedNotificationIds.includes(channel.id)}
                  onChange={() => toggleNotification(channel.id)}
                  className={checkboxClass}
                />
                <span>{channel.name}</span>
                <span className="text-xs text-slate-400">{channel.type}</span>
              </label>
            ))}
            {notificationsList?.length === 0 && (
              <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                No notification channels
              </div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <label className={labelClass}>Systems</label>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scheduleScope"
                checked={scope === "all"}
                onChange={() => setScope("all")}
                className={checkboxClass}
              />
              <span className="text-sm">All systems</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scheduleScope"
                checked={scope === "selected"}
                onChange={() => setScope("selected")}
                className={checkboxClass}
              />
              <span className="text-sm">Selected systems</span>
            </label>
          </div>
          {scope === "selected" && (
            <div className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-border divide-y divide-border">
              {(systemsList ?? []).map((system) => (
                <label
                  key={system.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-700/50"
                >
                  <input
                    type="checkbox"
                    checked={selectedSystemIds.includes(system.id)}
                    onChange={() => toggleSystem(system.id)}
                    className={checkboxClass}
                  />
                  <span>{system.name}</span>
                </label>
              ))}
              {systemsList?.length === 0 && (
                <div className="px-3 py-2 text-sm text-slate-500 dark:text-slate-400">
                  No visible systems
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
        <div>
          <label className={labelClass}>Cron</label>
          <select
            value={cronPreset}
            onChange={(e) => setCronPreset(e.target.value)}
            className={inputClass}
          >
            {CRON_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          {cronPreset === "custom" && (
            <input
              value={customCron}
              onChange={(e) => setCustomCron(e.target.value)}
              className={`${inputClass} mt-3 font-mono`}
              placeholder={type === "refresh" ? "*/15 * * * *" : "0 3 * * 0"}
            />
          )}
          {activeCron && <ScheduleMinimumWarning cron={activeCron} />}
          {activeCron && <ScheduleCronError cron={activeCron} />}
          {activeCron && (
            <ScheduleCronPreview
              cron={activeCron}
              showCronString={cronPreset !== "custom"}
              className="mt-3"
            />
          )}
        </div>
        <div className="space-y-4">
          {type === "refresh" && (
            <div>
              <label className={labelClass}>Cache duration hours</label>
              <input
                type="number"
                min={0}
                max={168}
                value={cacheDurationHours}
                onChange={(e) => setCacheDurationHours(e.target.value)}
                className={inputClass}
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-2">
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

export default function Schedules() {
  const { data: schedules, isLoading } = useSchedules();
  const { data: systemsList } = useVisibleSystems();
  const { data: notificationsList } = useNotifications();
  const createSchedule = useCreateSchedule();
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const reorderSchedules = useReorderSchedules();
  const { addToast } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [duplicateSchedule, setDuplicateSchedule] = useState<Schedule | null>(null);
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [orderedSchedules, setOrderedSchedules] = useState<Schedule[]>([]);
  const orderedSchedulesRef = useRef<Schedule[]>([]);
  const tbodyRef = useRef<HTMLTableSectionElement | null>(null);
  const sortableRef = useRef<Sortable | null>(null);

  useEffect(() => {
    setOrderedSchedules(schedules ?? []);
  }, [schedules]);

  useEffect(() => {
    if (!editSchedule) return;
    const refreshed = schedules?.find((schedule) => schedule.id === editSchedule.id) || null;
    if (!refreshed) {
      setEditSchedule(null);
      return;
    }
    if (refreshed !== editSchedule) {
      setEditSchedule(refreshed);
    }
  }, [schedules, editSchedule]);

  useEffect(() => {
    orderedSchedulesRef.current = orderedSchedules;
  }, [orderedSchedules]);

  useEffect(() => {
    const tbody = tbodyRef.current;
    if (!tbody || orderedSchedules.length <= 1) {
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

        const previousSchedules = orderedSchedulesRef.current;
        const nextSchedules = moveSchedule(previousSchedules, evt.oldIndex, evt.newIndex);
        setOrderedSchedules(nextSchedules);
        reorderSchedules.mutate(nextSchedules.map((schedule) => schedule.id), {
          onError: (err) => {
            setOrderedSchedules(previousSchedules);
            addToast(err.message, "danger");
          },
        });
      },
    });

    return () => {
      sortableRef.current?.destroy();
      sortableRef.current = null;
    };
  }, [orderedSchedules.length, reorderSchedules, addToast]);

  useEffect(() => {
    sortableRef.current?.option("disabled", reorderSchedules.isPending);
  }, [reorderSchedules.isPending]);

  const getSystemScopeLabel = (systemIds: number[] | null): string => {
    if (systemIds === null) return "All";
    if (systemIds.length === 0) return "None";
    if (!systemsList) return `${systemIds.length} system${systemIds.length !== 1 ? "s" : ""}`;
    const names = systemIds
      .map((id) => systemsList.find((system) => system.id === id)?.name)
      .filter(Boolean);
    if (names.length === 0) return `${systemIds.length} system${systemIds.length !== 1 ? "s" : ""}`;
    if (names.length <= 2) return names.join(", ");
    return `${names.length} systems`;
  };

  const getTargetLabel = (schedule: Schedule): string => {
    if (schedule.type !== "notification_digest") {
      return getSystemScopeLabel(schedule.systemIds);
    }

    if (!isNotificationScheduleConfig(schedule.config)) return "Invalid";
    const notificationIds = schedule.config.notificationIds;
    if (notificationIds.length === 0) return "None";
    if (!notificationsList) return `${notificationIds.length} channel${notificationIds.length !== 1 ? "s" : ""}`;
    const names = notificationIds
      .map((id) => notificationsList.find((channel) => channel.id === id)?.name)
      .filter(Boolean);
    if (names.length === 0) return `${notificationIds.length} channel${notificationIds.length !== 1 ? "s" : ""}`;
    if (names.length <= 2) return names.join(", ");
    return `${names.length} channels`;
  };

  const handleCreate = (data: ScheduleFormData) => {
    createSchedule.mutate(data, {
      onSuccess: () => {
        setShowForm(false);
        setDuplicateSchedule(null);
        addToast("Schedule created", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleUpdate = (data: ScheduleFormData) => {
    if (!editSchedule) return;
    updateSchedule.mutate(
      { id: editSchedule.id, ...data },
      {
        onSuccess: () => {
          setEditSchedule(null);
          addToast("Schedule updated", "success");
        },
        onError: (err) => addToast(err.message, "danger"),
      },
    );
  };

  const handleDelete = () => {
    if (deleteId === null) return;
    deleteSchedule.mutate(deleteId, {
      onSuccess: () => {
        setDeleteId(null);
        addToast("Schedule deleted", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleToggleEnabled = (schedule: Schedule) => {
    updateSchedule.mutate(
      { id: schedule.id, enabled: !schedule.enabled },
      { onError: (err) => addToast(err.message, "danger") },
    );
  };

  return (
    <Layout
      title="Schedules"
      actions={
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          Add Schedule
        </button>
      }
    >
      {isLoading ? (
        <div className="flex justify-center py-16">
          <span className="spinner !w-6 !h-6 text-blue-500" />
        </div>
      ) : schedules && schedules.length > 0 ? (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-border overflow-x-auto overflow-y-hidden">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3 hidden md:table-cell">Targets</th>
                <th className="px-4 py-3 hidden lg:table-cell">Schedule</th>
                <th className="px-4 py-3 hidden xl:table-cell">Last run</th>
                <th className="px-4 py-3">Enabled</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody ref={tbodyRef}>
              {orderedSchedules.map((schedule) => (
                <tr
                  key={schedule.id}
                  className="border-b border-border last:border-0 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2 min-w-0">
                      <span
                        className={`drag-handle shrink-0 rounded-md p-1 text-slate-400 transition-colors ${
                          reorderSchedules.isPending || orderedSchedules.length < 2
                            ? "cursor-not-allowed opacity-40"
                            : "cursor-grab hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-700"
                        }`}
                        title="Drag to reorder"
                        aria-label={`Drag to reorder ${schedule.name}`}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01" />
                        </svg>
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium">{schedule.name}</div>
                        {schedule.lastRunMessage && (
                          <div className="text-xs text-slate-500 dark:text-slate-400 truncate">
                            {schedule.lastRunMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                    {TYPE_LABELS[schedule.type]}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-slate-500 dark:text-slate-400">
                    <span className="block max-w-md truncate" title={getTargetLabel(schedule)}>
                      {getTargetLabel(schedule)}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-slate-500 dark:text-slate-400">
                    <div>
                      <div>{describeSchedule(schedule)}</div>
                      {(() => {
                        const cron = getScheduleCron(schedule);
                        return cron ? <ScheduleMinimumWarning cron={cron} /> : null;
                      })()}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden xl:table-cell">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${statusClass(schedule.lastRunStatus)}`}>
                        {schedule.lastRunStatus || "None"}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {formatDate(schedule.lastRunAt)}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleToggleEnabled(schedule)}
                      className={`relative w-9 h-5 rounded-full transition-colors ${
                        schedule.enabled ? "bg-blue-500" : "bg-slate-300 dark:bg-slate-600"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          schedule.enabled ? "translate-x-4" : ""
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => {
                          setDuplicateSchedule(schedule);
                          setShowForm(true);
                        }}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Copy schedule"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setEditSchedule(schedule)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Edit schedule"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteId(schedule.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title="Delete schedule"
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
            No schedules configured yet
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Add Your First Schedule
          </button>
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setDuplicateSchedule(null);
        }}
        title={duplicateSchedule ? "Duplicate Schedule" : "Add Schedule"}
        dismissible={!createSchedule.isPending}
      >
        <ScheduleForm
          key={duplicateSchedule?.id ?? "new"}
          initial={duplicateSchedule ? {
            ...duplicateSchedule,
            id: 0,
            name: `${duplicateSchedule.name} (Copy)`,
          } : undefined}
          onSubmit={handleCreate}
          onCancel={() => {
            setShowForm(false);
            setDuplicateSchedule(null);
          }}
          loading={createSchedule.isPending}
        />
      </Modal>

      <Modal
        open={editSchedule !== null}
        onClose={() => setEditSchedule(null)}
        title="Edit Schedule"
        dismissible={!updateSchedule.isPending}
      >
        {editSchedule && (
          <ScheduleForm
            initial={editSchedule}
            onSubmit={handleUpdate}
            onCancel={() => setEditSchedule(null)}
            loading={updateSchedule.isPending}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Delete Schedule"
        message="Are you sure you want to delete this schedule? This action cannot be undone."
        confirmLabel="Delete"
        danger
        loading={deleteSchedule.isPending}
      />

    </Layout>
  );
}
