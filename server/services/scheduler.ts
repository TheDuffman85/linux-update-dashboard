import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { systems, updateCache } from "../db/schema";
import * as cacheService from "./cache-service";
import * as updateService from "./update-service";
import * as notificationService from "./notification-service";

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimeout: ReturnType<typeof setTimeout> | null = null;

function getCheckIntervalMs(): number {
  return cacheService.getCheckIntervalMinutes() * 60_000;
}

async function runCheck(): Promise<void> {
  try {
    const staleIds = cacheService.getStaleSystemIds();
    if (staleIds.length === 0) return;

    console.log(`Scheduler: refreshing ${staleIds.length} stale systems`);

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
      .catch((e) => console.error("Notification processing error:", e));
  } catch (e) {
    console.error("Scheduler error:", e);
  }
}

export function start(): void {
  const intervalMs = getCheckIntervalMs();
  console.log(`Scheduler: check interval set to ${intervalMs / 60_000} minutes`);
  // Wait 30s before first check to let the app fully start
  initialTimeout = setTimeout(() => {
    runCheck();
    timer = setInterval(runCheck, intervalMs);
  }, 30_000);
}

export function restart(): void {
  stop();
  const intervalMs = getCheckIntervalMs();
  console.log(`Scheduler: restarting with interval ${intervalMs / 60_000} minutes`);
  runCheck();
  timer = setInterval(runCheck, intervalMs);
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
}
