import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { systems, updateCache } from "../db/schema";
import * as cacheService from "./cache-service";
import * as updateService from "./update-service";
import * as notificationService from "./notification-service";
import { logger } from "../logger";

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimeout: ReturnType<typeof setTimeout> | null = null;
let digestTimer: ReturnType<typeof setInterval> | null = null;

const DIGEST_INTERVAL_MS = 60_000; // Check scheduled digests every 60s

function getCheckIntervalMs(): number {
  return cacheService.getCheckIntervalMinutes() * 60_000;
}

async function runCheck(forceAll = false): Promise<void> {
  try {
    const staleIds = forceAll
      ? cacheService.getAllSystemIds()
      : cacheService.getStaleSystemIds();
    if (staleIds.length === 0) return;

    logger.debug("Scheduler refreshing systems", {
      count: staleIds.length,
      mode: forceAll ? "all" : "stale",
    });

    const db = getDb();

    // Snapshot reachability BEFORE checks
    const preCheckState = new Map<
      number,
      { name: string; wasReachable: boolean }
    >();
    for (const id of staleIds) {
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

    // Run checks (existing logic)
    await Promise.allSettled(
      staleIds.map((id) => updateService.checkUpdates(id))
    );

    // Build results for notification processing
    const checkResults: notificationService.CheckResult[] = [];
    for (const id of staleIds) {
      const pre = preCheckState.get(id);
      if (!pre) continue;

      const system = db
        .select({ isReachable: systems.isReachable })
        .from(systems)
        .where(eq(systems.id, id))
        .get();

      const updates = db
        .select({ isSecurity: updateCache.isSecurity })
        .from(updateCache)
        .where(eq(updateCache.systemId, id))
        .all();

      checkResults.push({
        systemId: id,
        systemName: pre.name,
        updateCount: updates.length,
        securityCount: updates.filter((u) => u.isSecurity).length,
        previouslyReachable: pre.wasReachable,
        nowUnreachable: system?.isReachable === -1,
      });
    }

    // Process notifications (non-blocking)
    await notificationService
      .processScheduledResults(checkResults)
      .catch((e) =>
        logger.error("Notification processing error", { error: String(e) })
      );
  } catch (e) {
    logger.error("Scheduler error", { error: String(e) });
  }
}

async function runDigestCheck(): Promise<void> {
  try {
    await notificationService.processScheduledDigests();
  } catch (e) {
    logger.error("Digest scheduler error", { error: String(e) });
  }
}

export function start(): void {
  const intervalMs = getCheckIntervalMs();
  logger.info("Scheduler check interval configured", {
    minutes: intervalMs / 60_000,
  });
  // Wait 30s before first check to let the app fully start, then refresh all systems
  initialTimeout = setTimeout(() => {
    runCheck(true);
    timer = setInterval(runCheck, intervalMs);
  }, 30_000);

  // Start digest timer for scheduled notifications
  digestTimer = setInterval(runDigestCheck, DIGEST_INTERVAL_MS);
}

export function restart(): void {
  stop();
  const intervalMs = getCheckIntervalMs();
  logger.info("Scheduler restarting", { minutes: intervalMs / 60_000 });
  runCheck();
  timer = setInterval(runCheck, intervalMs);

  // Restart digest timer
  digestTimer = setInterval(runDigestCheck, DIGEST_INTERVAL_MS);
}

export function stop(): void {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}
