import { useEffect, useRef, useState } from "react";
import Sortable from "sortablejs";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Layout } from "../components/Layout";
import { Modal } from "../components/Modal";
import {
  isRefreshConfig,
  isNotificationDigestConfig,
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
import { useToast } from "../context/ToastContext";

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-white dark:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm";
const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-slate-500 mb-1";
const checkboxClass =
  "w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500";

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

  if (schedule.type === "notification_digest" && isNotificationDigestConfig(schedule.config)) {
    const config = schedule.config;
    const preset = CRON_PRESETS.find((item) => item.value === config.cron);
    return preset ? preset.label : config.cron;
  }

  return "Invalid config";
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

type NotificationScheduleConflict = {
  notificationId: number;
  notificationName: string;
  scheduleId: number;
  scheduleName: string;
};

type PendingScheduleSave = {
  mode: "create" | "update";
  data: ScheduleFormData;
  conflicts: NotificationScheduleConflict[];
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
  const initialNotificationDigestConfig =
    initial?.config && isNotificationDigestConfig(initial.config)
      ? initial.config
      : { cron: "0 9 * * 1", notificationIds: [] };
  const initialCron =
    initialType === "refresh"
      ? initialRefreshConfig.cron
      : initialType === "notification_digest"
        ? initialNotificationDigestConfig.cron
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
    initialNotificationDigestConfig.notificationIds,
  );
  const [cacheDurationHours, setCacheDurationHours] = useState(String(initialRefreshConfig.cacheDurationHours));
  const [cronPreset, setCronPreset] = useState(initialCronPreset);
  const [customCron, setCustomCron] = useState(initialCronPreset === "custom" ? initialCron : "");
  const [error, setError] = useState("");

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
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            maxLength={100}
            autoFocus
          />
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

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
        </div>
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

function ScheduleMoveConfirmDialog({
  pendingSave,
  onClose,
  onConfirm,
  loading,
}: {
  pendingSave: PendingScheduleSave | null;
  onClose: () => void;
  onConfirm: () => void;
  loading: boolean;
}) {
  const conflicts = pendingSave?.conflicts ?? [];

  return (
    <Modal open={pendingSave !== null} onClose={onClose} title="Change Notification Schedule">
      <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">
        {conflicts.length === 1
          ? "This notification channel is already assigned to another schedule."
          : "These notification channels are already assigned to another schedule."}
      </p>
      <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border mb-5">
        {conflicts.map((conflict) => (
          <div
            key={`${conflict.scheduleId}-${conflict.notificationId}`}
            className="grid grid-cols-1 sm:grid-cols-[1fr_1fr] gap-1 sm:gap-4 px-3 py-2 text-sm"
          >
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {conflict.notificationName}
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              Current: {conflict.scheduleName}
            </span>
          </div>
        ))}
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300 mb-6">
        Move {conflicts.length === 1 ? "it" : "them"} to this schedule?
      </p>
      <div className="flex justify-end gap-3">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50"
        >
          {loading ? <span className="spinner spinner-sm" /> : "Move"}
        </button>
      </div>
    </Modal>
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
  const [editSchedule, setEditSchedule] = useState<Schedule | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingScheduleSave | null>(null);
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

    if (!isNotificationDigestConfig(schedule.config)) return "Invalid";
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

  const getNotificationScheduleConflicts = (
    data: ScheduleFormData,
    targetScheduleId: number | null,
  ): NotificationScheduleConflict[] => {
    if (data.type !== "notification_digest" || !isNotificationDigestConfig(data.config)) return [];
    const selectedIds = new Set(data.config.notificationIds);
    if (selectedIds.size === 0) return [];

    const conflicts: NotificationScheduleConflict[] = [];
    for (const schedule of schedules ?? []) {
      if (schedule.id === targetScheduleId || schedule.type !== "notification_digest") continue;
      if (!isNotificationDigestConfig(schedule.config)) continue;
      for (const notificationId of schedule.config.notificationIds) {
        if (!selectedIds.has(notificationId)) continue;
        const notificationName =
          notificationsList?.find((channel) => channel.id === notificationId)?.name ??
          `Notification ${notificationId}`;
        conflicts.push({
          notificationId,
          notificationName,
          scheduleId: schedule.id,
          scheduleName: schedule.name,
        });
      }
    }
    return conflicts;
  };

  const removeConflictsFromExistingSchedules = async (
    conflicts: NotificationScheduleConflict[],
  ): Promise<void> => {
    const conflictIds = new Set(conflicts.map((conflict) => conflict.notificationId));
    for (const schedule of schedules ?? []) {
      if (schedule.type !== "notification_digest" || !isNotificationDigestConfig(schedule.config)) continue;
      const nextNotificationIds = schedule.config.notificationIds.filter((id) => !conflictIds.has(id));
      if (nextNotificationIds.length === schedule.config.notificationIds.length) continue;
      await updateSchedule.mutateAsync({
        id: schedule.id,
        config: {
          ...schedule.config,
          notificationIds: nextNotificationIds,
        },
      });
    }
  };

  const createScheduleWithConflictMoves = async (
    data: ScheduleFormData,
    conflicts: NotificationScheduleConflict[],
  ) => {
    await removeConflictsFromExistingSchedules(conflicts);
    await createSchedule.mutateAsync(data);
  };

  const updateScheduleWithConflictMoves = async (
    id: number,
    data: ScheduleFormData,
    conflicts: NotificationScheduleConflict[],
  ) => {
    await removeConflictsFromExistingSchedules(conflicts);
    await updateSchedule.mutateAsync({ id, ...data });
  };

  const handleCreate = (data: ScheduleFormData) => {
    const conflicts = getNotificationScheduleConflicts(data, null);
    if (conflicts.length > 0) {
      setPendingSave({ mode: "create", data, conflicts });
      return;
    }
    createSchedule.mutate(data, {
      onSuccess: () => {
        setShowForm(false);
        addToast("Schedule created", "success");
      },
      onError: (err) => addToast(err.message, "danger"),
    });
  };

  const handleUpdate = (data: ScheduleFormData) => {
    if (!editSchedule) return;
    const conflicts = getNotificationScheduleConflicts(data, editSchedule.id);
    if (conflicts.length > 0) {
      setPendingSave({ mode: "update", data, conflicts });
      return;
    }
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

  const handleConfirmScheduleMove = async () => {
    if (!pendingSave) return;
    try {
      if (pendingSave.mode === "create") {
        await createScheduleWithConflictMoves(pendingSave.data, pendingSave.conflicts);
        setShowForm(false);
        addToast("Schedule created", "success");
      } else {
        if (!editSchedule) return;
        await updateScheduleWithConflictMoves(editSchedule.id, pendingSave.data, pendingSave.conflicts);
        setEditSchedule(null);
        addToast("Schedule updated", "success");
      }
      setPendingSave(null);
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Failed to save schedule", "danger");
    }
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
          <table className="min-w-full w-max text-sm">
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
                    {getTargetLabel(schedule)}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-slate-500 dark:text-slate-400">
                    {describeSchedule(schedule)}
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
                        onClick={() => setEditSchedule(schedule)}
                        className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                        title="Edit"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => setDeleteId(schedule.id)}
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
        onClose={() => setShowForm(false)}
        title="Add Schedule"
        dismissible={!createSchedule.isPending}
      >
        <ScheduleForm
          onSubmit={handleCreate}
          onCancel={() => setShowForm(false)}
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

      <ScheduleMoveConfirmDialog
        pendingSave={pendingSave}
        onClose={() => setPendingSave(null)}
        onConfirm={handleConfirmScheduleMove}
        loading={createSchedule.isPending || updateSchedule.isPending}
      />
    </Layout>
  );
}
