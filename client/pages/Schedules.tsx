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
import { useI18n } from "../lib/i18n";
import { useDateTime } from "../lib/date-time";

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
const TYPE_LABEL_KEYS: Record<ScheduleType, string> = {
  refresh: "pages.schedules.type.refresh",
  update: "pages.schedules.type.update",
  notification_digest: "pages.schedules.type.notification",
};

const CRON_PRESETS: { label: string; labelKey: string; value: string }[] = [
  { label: "Every 5 minutes", labelKey: "common.cron.every5Minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", labelKey: "common.cron.every15Minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", labelKey: "common.cron.every30Minutes", value: "*/30 * * * *" },
  { label: "Every hour", labelKey: "common.cron.everyHour", value: "0 * * * *" },
  { label: "Every 3 hours", labelKey: "common.cron.every3Hours", value: "0 */3 * * *" },
  { label: "Every 6 hours", labelKey: "common.cron.every6Hours", value: "0 */6 * * *" },
  { label: "Daily at 00:00", labelKey: "common.cron.dailyAt0000", value: "0 0 * * *" },
  { label: "Daily at 03:00", labelKey: "common.cron.dailyAt0300", value: "0 3 * * *" },
  { label: "Weekly Sunday 03:00", labelKey: "common.cron.weeklySunday0300", value: "0 3 * * 0" },
  { label: "Weekly Monday 09:00", labelKey: "common.cron.weeklyMonday0900", value: "0 9 * * 1" },
  { label: "Monthly on the 1st", labelKey: "common.cron.monthlyOnThe1st", value: "0 3 1 * *" },
  { label: "Custom", labelKey: "common.custom", value: "custom" },
];

type Translate = ReturnType<typeof useI18n>["t"];

function moveSchedule<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex) return items;
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function formatDate(
  value: string | null,
  t: Translate,
  formatDateTime: (value: Date | string | number) => string,
): string {
  if (!value) return t("pages.schedules.never");
  const parsed = new Date(value.includes("T") ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatDateTime(parsed);
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

function generateScheduleName(
  type: ScheduleType,
  cron: string,
  language: ReturnType<typeof useI18n>["language"],
  timeZone: string | null,
  use24HourTimeFormat: boolean,
): string | null {
  const preview = getCronPreview(cron, new Date(), 3, language, timeZone, use24HourTimeFormat);
  if ("error" in preview) return null;
  return truncateScheduleName(`${TYPE_LABELS[type]} - ${preview.description}`);
}

function getScheduleCron(schedule: Schedule): string | null {
  return "cron" in schedule.config ? schedule.config.cron : null;
}

function describeCronExpression(
  cron: string,
  t: Translate,
  language: ReturnType<typeof useI18n>["language"],
  use24HourTimeFormat: boolean,
): string {
  const preset = CRON_PRESETS.find((item) => item.value === cron);
  if (preset) return t(preset.labelKey);
  const preview = getCronPreview(cron, new Date(), 0, language, null, use24HourTimeFormat);
  return "error" in preview ? cron : preview.description;
}

function describeSchedule(
  schedule: Schedule,
  t: Translate,
  language: ReturnType<typeof useI18n>["language"],
  use24HourTimeFormat: boolean,
): string {
  if (schedule.type === "refresh" && isRefreshConfig(schedule.config)) {
    const config = schedule.config;
    const cache =
      config.cacheDurationHours === 0
        ? t("pages.schedules.noCacheReuse")
        : t("pages.schedules.hoursCache", { hours: config.cacheDurationHours });
    return t("pages.schedules.descriptionWithCache", {
      schedule: describeCronExpression(config.cron, t, language, use24HourTimeFormat),
      cache,
    });
  }

  if (schedule.type === "update" && isUpdateConfig(schedule.config)) {
    return describeCronExpression(schedule.config.cron, t, language, use24HourTimeFormat);
  }

  if (schedule.type === "notification_digest" && isNotificationScheduleConfig(schedule.config)) {
    return describeCronExpression(schedule.config.cron, t, language, use24HourTimeFormat);
  }

  return t("pages.schedules.invalidConfig");
}

function ScheduleMinimumWarning({ cron }: { cron: string }) {
  const { t } = useI18n();
  if (!isBelowMinimumScheduleInterval(cron)) return null;

  return (
    <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
      {t("pages.schedules.runsMoreOftenThanTheSupportedMinutesMinute", {
        minutes: MIN_SCHEDULE_INTERVAL_MINUTES,
      })}
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
  const { language, t } = useI18n();
  const { browserTimeFormat, formatDateTime, timeFormat, timeZone } = useDateTime();
  const resolvedTimeFormat = timeFormat === "browser" ? browserTimeFormat : timeFormat;
  const preview = useMemo(
    () => getCronPreview(cron, new Date(), 3, language, timeZone, resolvedTimeFormat === "24h"),
    [cron, language, resolvedTimeFormat, timeZone],
  );

  if (!cron.trim()) return null;

  if ("error" in preview) return null;

  const nextRuns = preview.nextRuns.map((date) =>
    formatDateTime(date, {
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
          <div className="font-medium">{t("pages.schedules.nextRuns")}</div>
          {nextRuns.map((run) => (
            <div key={run}>{run}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleCronError({ cron }: { cron: string }) {
  const { language, t } = useI18n();
  const preview = useMemo(() => getCronPreview(cron, new Date(), 3, language), [cron, language]);

  if (!cron.trim() || !("error" in preview)) return null;

  return (
    <p className="mt-2 text-xs text-red-600 dark:text-red-300">
      {t("pages.schedules.cronExpressionIsInvalid")}
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
  const { language, t } = useI18n();
  const { browserTimeFormat, timeFormat, timeZone } = useDateTime();
  const resolvedTimeFormat = timeFormat === "browser" ? browserTimeFormat : timeFormat;
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
    const generatedName = generateScheduleName(
      type,
      activeCron,
      language,
      timeZone,
      resolvedTimeFormat === "24h",
    );
    if (!generatedName) {
      setError(t("pages.schedules.enterValidCronBeforeGeneratingName"));
      return;
    }
    setName(generatedName);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!name.trim()) {
      setError(t("pages.schedules.nameIsRequired"));
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
      setError(t("pages.schedules.cronExpressionIsRequired"));
      return;
    }
    if (
      "error" in
      getCronPreview(
        config.cron,
        new Date(),
        3,
        language,
        timeZone,
        resolvedTimeFormat === "24h",
      )
    ) {
      setError(t("pages.schedules.cronExpressionIsInvalid"));
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
          <label className={labelClass}>{t("pages.schedules.name")}</label>
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
              title={t("pages.schedules.generateScheduleName")}
              aria-label={t("pages.schedules.generateScheduleName")}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16z" />
              </svg>
            </button>
          </div>
        </div>
        <div>
          <label className={labelClass}>{t("pages.schedules.type")}</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ScheduleType)}
            className={inputClass}
          >
            <option value="refresh">{t("pages.schedules.type.refresh")}</option>
            <option value="update">{t("pages.schedules.type.update")}</option>
            <option value="notification_digest">{t("pages.schedules.type.notification")}</option>
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
        <span className="text-sm font-medium">{t("pages.schedules.enabled")}</span>
      </label>

      {type === "notification_digest" ? (
        <div>
          <label className={labelClass}>{t("pages.schedules.notificationChannels")}</label>
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
                {t("pages.schedules.noNotificationChannels")}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div>
          <label className={labelClass}>{t("pages.schedules.systems")}</label>
          <div className="flex flex-wrap gap-3">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scheduleScope"
                checked={scope === "all"}
                onChange={() => setScope("all")}
                className={checkboxClass}
              />
              <span className="text-sm">{t("pages.schedules.allSystems")}</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scheduleScope"
                checked={scope === "selected"}
                onChange={() => setScope("selected")}
                className={checkboxClass}
              />
              <span className="text-sm">{t("pages.schedules.selectedSystems")}</span>
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
                  {t("pages.schedules.noVisibleSystems")}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-start">
        <div>
          <label className={labelClass}>{t("pages.schedules.cron")}</label>
          <select
            value={cronPreset}
            onChange={(e) => setCronPreset(e.target.value)}
            className={inputClass}
          >
            {CRON_PRESETS.map((preset) => (
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
              <label className={labelClass}>{t("pages.schedules.cacheDurationHours")}</label>
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
          {t("pages.schedules.cancel")}
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : t("pages.schedules.save")}
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
  const { language, t } = useI18n();
  const { browserTimeFormat, formatDateTime, timeFormat } = useDateTime();
  const resolvedTimeFormat = timeFormat === "browser" ? browserTimeFormat : timeFormat;
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
    if (systemIds === null) return t("pages.schedules.all");
    if (systemIds.length === 0) return t("pages.schedules.none");
    if (!systemsList) return t("pages.schedules.countSystemlabel", {
      count: systemIds.length,
      systemLabel: systemIds.length === 1 ? t("pages.schedules.system") : t("pages.schedules.systems"),
    });
    const names = systemIds
      .map((id) => systemsList.find((system) => system.id === id)?.name)
      .filter(Boolean);
    if (names.length === 0) return t("pages.schedules.countSystemlabel", {
      count: systemIds.length,
      systemLabel: systemIds.length === 1 ? t("pages.schedules.system") : t("pages.schedules.systems"),
    });
    if (names.length <= 2) return names.join(", ");
    return t("pages.schedules.countSystems", { count: names.length });
  };

  const getTargetLabel = (schedule: Schedule): string => {
    if (schedule.type !== "notification_digest") {
      return getSystemScopeLabel(schedule.systemIds);
    }

    if (!isNotificationScheduleConfig(schedule.config)) return t("pages.schedules.invalid");
    const notificationIds = schedule.config.notificationIds;
    if (notificationIds.length === 0) return t("pages.schedules.none");
    if (!notificationsList) return t("pages.schedules.countChannellabel", {
      count: notificationIds.length,
      channelLabel: notificationIds.length === 1 ? t("pages.schedules.channel") : t("pages.schedules.channels"),
    });
    const names = notificationIds
      .map((id) => notificationsList.find((channel) => channel.id === id)?.name)
      .filter(Boolean);
    if (names.length === 0) return t("pages.schedules.countChannellabel", {
      count: notificationIds.length,
      channelLabel: notificationIds.length === 1 ? t("pages.schedules.channel") : t("pages.schedules.channels"),
    });
    if (names.length <= 2) return names.join(", ");
    return t("pages.schedules.countChannels", { count: names.length });
  };

  const handleCreate = (data: ScheduleFormData) => {
    createSchedule.mutate(data, {
      onSuccess: () => {
        setShowForm(false);
        setDuplicateSchedule(null);
        addToast(t("pages.schedules.scheduleCreated"), "success");
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
          addToast(t("pages.schedules.scheduleUpdated"), "success");
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
        addToast(t("pages.schedules.scheduleDeleted"), "success");
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
      title={t("pages.schedules.schedules")}
      actions={
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          {t("pages.schedules.addSchedule")}
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
                <th className="px-4 py-3">{t("pages.schedules.name")}</th>
                <th className="px-4 py-3">{t("pages.schedules.type")}</th>
                <th className="px-4 py-3 hidden md:table-cell">{t("pages.schedules.targets")}</th>
                <th className="px-4 py-3 hidden lg:table-cell">{t("pages.schedules.schedule")}</th>
                <th className="px-4 py-3 hidden xl:table-cell">{t("pages.schedules.lastRun")}</th>
                <th className="px-4 py-3">{t("pages.schedules.enabled")}</th>
                <th className="px-4 py-3 text-right">{t("pages.schedules.actions")}</th>
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
                        title={t("pages.schedules.dragToReorder")}
                        aria-label={t("pages.schedules.dragToReorderName", { name: schedule.name })}
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
                    {t(TYPE_LABEL_KEYS[schedule.type])}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-slate-500 dark:text-slate-400">
                    <span className="block max-w-md truncate" title={getTargetLabel(schedule)}>
                      {getTargetLabel(schedule)}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-slate-500 dark:text-slate-400">
                    <div>
                      <div>{describeSchedule(schedule, t, language, resolvedTimeFormat === "24h")}</div>
                      {(() => {
                        const cron = getScheduleCron(schedule);
                        return cron ? <ScheduleMinimumWarning cron={cron} /> : null;
                      })()}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden xl:table-cell">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded-full text-xs ${statusClass(schedule.lastRunStatus)}`}>
                        {schedule.lastRunStatus
                          ? t(`pages.schedules.status.${schedule.lastRunStatus}`)
                          : t("pages.schedules.none")}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400">
                        {formatDate(schedule.lastRunAt, t, formatDateTime)}
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
                        title={t("pages.schedules.copySchedule")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setEditSchedule(schedule)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title={t("pages.schedules.editSchedule")}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteId(schedule.id)}
                        className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500 transition-colors"
                        title={t("pages.schedules.deleteSchedule")}
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
            {t("pages.schedules.noSchedulesConfiguredYet")}
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            {t("pages.schedules.addYourFirstSchedule")}
          </button>
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setDuplicateSchedule(null);
        }}
        title={duplicateSchedule ? t("pages.schedules.duplicateSchedule") : t("pages.schedules.addSchedule")}
        dismissible={!createSchedule.isPending}
      >
        <ScheduleForm
          key={duplicateSchedule?.id ?? "new"}
          initial={duplicateSchedule ? {
            ...duplicateSchedule,
            id: 0,
            name: t("pages.schedules.nameCopy", { name: duplicateSchedule.name }),
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
        title={t("pages.schedules.editSchedule2")}
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
        title={t("pages.schedules.deleteSchedule2")}
        message={t("pages.schedules.areYouSureYouWantToDeleteThis")}
        confirmLabel={t("pages.schedules.delete")}
        danger
        loading={deleteSchedule.isPending}
      />

    </Layout>
  );
}
