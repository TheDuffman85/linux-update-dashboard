import { Cron } from "croner";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { systems } from "../db/schema";
import * as hiddenUpdateService from "./hidden-update-service";
import * as notificationService from "./notification-service";
import * as scheduleService from "./schedule-service";
import * as updateService from "./update-service";
import { logger } from "../logger";
import type {
  NotificationScheduleConfig,
  RefreshScheduleConfig,
  SerializedSchedule,
  UpdateScheduleConfig,
} from "./schedule-service";

let initialTimeout: ReturnType<typeof setTimeout> | null = null;
let schedulerGeneration = 0;
let scheduleCrons: Cron[] = [];

const STARTUP_REFRESH_DELAY_MS = 30_000;

function isRefreshConfig(config: SerializedSchedule["config"]): config is RefreshScheduleConfig {
  return "cron" in config && "cacheDurationHours" in config;
}

function isUpdateConfig(config: SerializedSchedule["config"]): config is UpdateScheduleConfig {
  return "cron" in config && !("cacheDurationHours" in config) && !("notificationIds" in config);
}

function isNotificationScheduleConfig(
  config: SerializedSchedule["config"],
): config is NotificationScheduleConfig {
  return "cron" in config && "notificationIds" in config;
}

function filterExistingSystemIds(systemIds: number[]): number[] {
  const knownSystemIds = scheduleService.getKnownSystemIds();
  return systemIds.filter((id) => knownSystemIds.has(id));
}

function getScheduleSystemIds(schedule: SerializedSchedule): number[] {
  return filterExistingSystemIds(scheduleService.getScopedSystemIds(schedule.systemIds));
}

async function checkSystemsAndNotify(systemIds: number[]): Promise<{
  checkedIds: number[];
  failedIds: number[];
}> {
  if (systemIds.length === 0) return { checkedIds: [], failedIds: [] };

  const db = getDb();
  const preCheckState = new Map<
    number,
    { name: string; wasReachable: boolean }
  >();

  for (const id of systemIds) {
    const system = db
      .select({ name: systems.name, isReachable: systems.isReachable })
      .from(systems)
      .where(eq(systems.id, id))
      .get();
    if (system) {
      preCheckState.set(id, {
        name: system.name,
        wasReachable: system.isReachable === 1,
      });
    }
  }

  const results = await Promise.allSettled(
    systemIds.map((id) => updateService.checkUpdates(id)),
  );
  const checkedIds = systemIds.filter((_, index) => results[index].status === "fulfilled");
  const failedIds = systemIds.filter((_, index) => results[index].status === "rejected");

  const checkResults: notificationService.CheckResult[] = [];
  for (const id of systemIds) {
    const pre = preCheckState.get(id);
    if (!pre) continue;

    const system = db
      .select({ isReachable: systems.isReachable })
      .from(systems)
      .where(eq(systems.id, id))
      .get();
    const updates = hiddenUpdateService.getVisibleUpdateSummary(id);

    checkResults.push({
      systemId: id,
      systemName: pre.name,
      updateCount: updates.updateCount,
      securityCount: updates.securityCount,
      keptBackCount: updates.keptBackCount,
      previouslyReachable: pre.wasReachable,
      nowUnreachable: system?.isReachable === -1,
    });
  }

  await notificationService
    .processScheduledResults(checkResults)
    .catch((error) =>
      logger.error("Notification processing error", { error: String(error) }),
    );
  await notificationService
    .processAppUpdateNotifications()
    .catch((error) =>
      logger.error("App update notification processing error", {
        error: String(error),
      }),
    );

  return { checkedIds, failedIds };
}

async function runRefreshSchedule(
  schedule: SerializedSchedule,
  generation: number,
  forceAll = false,
): Promise<void> {
  if (generation !== schedulerGeneration || !isRefreshConfig(schedule.config)) return;

  scheduleService.markScheduleStarted(schedule.id);
  try {
    const config = schedule.config;
    const scopedIds = getScheduleSystemIds(schedule);
    const refreshIds = forceAll
      ? scopedIds
      : scopedIds.filter((id) =>
          scheduleService.isSystemCacheStale(id, config.cacheDurationHours),
        );

    logger.debug("Refresh schedule running", {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      count: refreshIds.length,
      forceAll,
    });

    const { checkedIds, failedIds } = await checkSystemsAndNotify(refreshIds);
    const status =
      failedIds.length === 0
        ? "success"
        : checkedIds.length > 0
          ? "warning"
          : "failed";
    const message =
      refreshIds.length === 0
        ? "No stale systems to refresh"
        : `Refreshed ${checkedIds.length} system${checkedIds.length === 1 ? "" : "s"}${
            failedIds.length ? `, ${failedIds.length} failed` : ""
          }`;
    scheduleService.markScheduleFinished(schedule.id, status, message);
  } catch (error) {
    logger.error("Refresh schedule error", {
      scheduleId: schedule.id,
      error: String(error),
    });
    scheduleService.markScheduleFinished(schedule.id, "failed", String(error));
  }
}

async function runUpdateSchedule(
  schedule: SerializedSchedule,
  generation: number,
): Promise<void> {
  if (generation !== schedulerGeneration || !isUpdateConfig(schedule.config)) return;

  scheduleService.markScheduleStarted(schedule.id);
  try {
    const scopedIds = getScheduleSystemIds(schedule);
    logger.info("Update schedule running", {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      count: scopedIds.length,
    });

    const { checkedIds, failedIds } = await checkSystemsAndNotify(scopedIds);
    const upgradeIds = checkedIds.filter((id) => {
      const summary = hiddenUpdateService.getVisibleUpdateSummary(id);
      return summary.updateCount > 0;
    });

    let upgraded = 0;
    let upgradeWarnings = 0;
    let upgradeFailures = 0;
    for (const id of upgradeIds) {
      const result = await updateService.applyUpgradeAll(id);
      if (result.success) {
        upgraded += 1;
        if (result.warning) upgradeWarnings += 1;
      } else {
        upgradeFailures += 1;
      }
    }

    const status =
      failedIds.length === 0 && upgradeFailures === 0 && upgradeWarnings === 0
        ? "success"
        : upgraded > 0 || checkedIds.length > 0
          ? "warning"
          : "failed";
    const skipped = Math.max(0, checkedIds.length - upgradeIds.length);
    const message = `Checked ${checkedIds.length} system${checkedIds.length === 1 ? "" : "s"}, upgraded ${upgraded}, skipped ${skipped}${
      failedIds.length || upgradeFailures
        ? `, ${failedIds.length + upgradeFailures} failed`
        : ""
    }`;
    scheduleService.markScheduleFinished(schedule.id, status, message);
  } catch (error) {
    logger.error("Update schedule error", {
      scheduleId: schedule.id,
      error: String(error),
    });
    scheduleService.markScheduleFinished(schedule.id, "failed", String(error));
  }
}

async function runNotificationSchedule(
  schedule: SerializedSchedule,
  generation: number,
): Promise<void> {
  if (generation !== schedulerGeneration || !isNotificationScheduleConfig(schedule.config)) return;

  scheduleService.markScheduleStarted(schedule.id);
  try {
    const notificationIds = schedule.config.notificationIds;
    logger.info("Notification schedule running", {
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      count: notificationIds.length,
    });

    const result = await notificationService.processScheduledNotificationDeliveries(notificationIds);
    const status =
      result.failed === 0
        ? "success"
        : result.sent > 0
          ? "warning"
          : "failed";
    const message = `Sent ${result.sent} notification${result.sent === 1 ? "" : "s"}, skipped ${result.skipped}${
      result.failed ? `, ${result.failed} failed` : ""
    }`;
    scheduleService.markScheduleFinished(schedule.id, status, message);
  } catch (error) {
    logger.error("Notification schedule error", {
      scheduleId: schedule.id,
      error: String(error),
    });
    scheduleService.markScheduleFinished(schedule.id, "failed", String(error));
  }
}

async function runStartupRefreshes(generation: number): Promise<void> {
  if (generation !== schedulerGeneration) return;
  const refreshSchedules = scheduleService.listEnabledSchedulesByType("refresh");
  await Promise.allSettled(
    refreshSchedules.map((schedule) => runRefreshSchedule(schedule, generation, true)),
  );
}

function startRuntime(options: { startupRefresh: boolean }): void {
  const generation = ++schedulerGeneration;
  const refreshSchedules = scheduleService.listEnabledSchedulesByType("refresh");
  const updateSchedules = scheduleService.listEnabledSchedulesByType("update");
  const notificationSchedules = scheduleService.listEnabledSchedulesByType("notification_digest");

  logger.info("Schedule runtime configured", {
    refreshSchedules: refreshSchedules.length,
    updateSchedules: updateSchedules.length,
    notificationSchedules: notificationSchedules.length,
  });

  for (const schedule of refreshSchedules) {
    if (!isRefreshConfig(schedule.config)) continue;
    try {
      scheduleCrons.push(
        new Cron(schedule.config.cron, () => {
          void runRefreshSchedule(schedule, generation);
        }),
      );
    } catch (error) {
      logger.error("Failed to start refresh schedule", {
        scheduleId: schedule.id,
        error: String(error),
      });
      scheduleService.markScheduleFinished(schedule.id, "failed", String(error));
    }
  }

  for (const schedule of updateSchedules) {
    if (!isUpdateConfig(schedule.config)) continue;
    try {
      scheduleCrons.push(
        new Cron(schedule.config.cron, () => {
          void runUpdateSchedule(schedule, generation);
        }),
      );
    } catch (error) {
      logger.error("Failed to start update schedule", {
        scheduleId: schedule.id,
        error: String(error),
      });
      scheduleService.markScheduleFinished(schedule.id, "failed", String(error));
    }
  }

  for (const schedule of notificationSchedules) {
    if (!isNotificationScheduleConfig(schedule.config)) continue;
    try {
      scheduleCrons.push(
        new Cron(schedule.config.cron, () => {
          void runNotificationSchedule(schedule, generation);
        }),
      );
    } catch (error) {
      logger.error("Failed to start notification schedule", {
        scheduleId: schedule.id,
        error: String(error),
      });
      scheduleService.markScheduleFinished(schedule.id, "failed", String(error));
    }
  }

  if (options.startupRefresh) {
    initialTimeout = setTimeout(() => {
      initialTimeout = null;
      void runStartupRefreshes(generation);
    }, STARTUP_REFRESH_DELAY_MS);
  }
}

export function start(): void {
  stop();
  startRuntime({ startupRefresh: true });
}

export function restart(): void {
  stop();
  startRuntime({ startupRefresh: false });
}

export function stop(): void {
  schedulerGeneration += 1;
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  for (const cron of scheduleCrons) {
    cron.stop();
  }
  scheduleCrons = [];
}
