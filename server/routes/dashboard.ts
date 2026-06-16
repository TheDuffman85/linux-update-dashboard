import { Hono } from "hono";
import * as systemService from "../services/system-service";
import * as cacheService from "../services/cache-service";
import * as updateService from "../services/update-service";
import * as upgradeBatchService from "../services/upgrade-batch-service";

const dashboard = new Hono();

function hasCheckIssue(lastCheck: updateService.LastCheckSummary | null | undefined): boolean {
  return lastCheck?.status === "failed" || lastCheck?.status === "warning";
}

function withLifecycle<T extends {
  osId?: string | null;
  osIdLike?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  osVersionCodename?: string | null;
  osLifecycleDismissedKey?: string | null;
}>(system: T) {
  return {
    ...system,
    ...systemService.getOsLifecycle(system),
  };
}

function hasLifecycleWarning(system: { osLifecycleStatus?: string | null }): boolean {
  return (
    system.osLifecycleStatus === "eol" ||
    system.osLifecycleStatus === "approaching_eol" ||
    system.osLifecycleStatus === "support_ending" ||
    system.osLifecycleStatus === "support_ended"
  );
}

dashboard.get("/stats", (c) => {
  const allSystems = systemService.listVisibleSystemsWithUpdateCounts();
  const lastChecks = updateService.getLatestCompletedChecks(
    allSystems.map((system) => system.id),
  );

  const systemsWithMeta = allSystems.map((s) => withLifecycle({
    ...s,
    lastCheck: lastChecks.get(s.id) ?? null,
    cacheAge: cacheService.getCacheAge(s.id),
    cacheTimestamp: cacheService.getCacheTimestamp(s.id),
    isStale: cacheService.isCacheStale(s.id),
    activeOperation: updateService.getActiveOperation(s.id) ?? upgradeBatchService.getQueuedOrRunningOperation(s.id),
  }));

  const total = systemsWithMeta.length;
  const upToDate = systemsWithMeta.filter(
    (s) => s.updateCount === 0 && s.isReachable === 1 && !hasCheckIssue(s.lastCheck) && !hasLifecycleWarning(s)
  ).length;
  const needsUpdates = systemsWithMeta.filter(
    (s) => s.updateCount > 0 && !hasCheckIssue(s.lastCheck)
  ).length;
  const unreachable = systemsWithMeta.filter(
    (s) => s.isReachable === -1
  ).length;
  const checkIssues = systemsWithMeta.filter((s) => hasCheckIssue(s.lastCheck)).length;
  const totalUpdates = systemsWithMeta.reduce(
    (sum, s) => sum + s.updateCount,
    0
  );
  const needsReboot = systemsWithMeta.filter(
    (s) => s.needsReboot === 1
  ).length;
  const lifecycleWarnings = systemsWithMeta.filter(hasLifecycleWarning).length;

  return c.json({
    stats: { total, upToDate, needsUpdates, unreachable, checkIssues, totalUpdates, needsReboot, lifecycleWarnings },
  });
});

dashboard.get("/systems", (c) => {
  const allSystems = systemService.listVisibleSystemsWithUpdateCounts();
  const lastChecks = updateService.getLatestCompletedChecks(
    allSystems.map((system) => system.id),
  );

  const systemsWithMeta = allSystems.map((s) => withLifecycle({
    ...s,
    lastCheck: lastChecks.get(s.id) ?? null,
    cacheAge: cacheService.getCacheAge(s.id),
    cacheTimestamp: cacheService.getCacheTimestamp(s.id),
    isStale: cacheService.isCacheStale(s.id),
    activeOperation: updateService.getActiveOperation(s.id) ?? upgradeBatchService.getQueuedOrRunningOperation(s.id),
  }));

  return c.json({ systems: systemsWithMeta });
});

export default dashboard;
