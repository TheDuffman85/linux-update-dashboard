import { Hono } from "hono";
import * as systemService from "../services/system-service";
import * as cacheService from "../services/cache-service";

const dashboard = new Hono();

dashboard.get("/stats", (c) => {
  const allSystems = systemService.listSystemsWithUpdateCounts();

  const systemsWithMeta = allSystems.map((s) => ({
    ...s,
    cacheAge: cacheService.getCacheAge(s.id),
    isStale: cacheService.isCacheStale(s.id),
  }));

  const total = systemsWithMeta.length;
  const upToDate = systemsWithMeta.filter(
    (s) => s.updateCount === 0 && s.isReachable === 1
  ).length;
  const needsUpdates = systemsWithMeta.filter(
    (s) => s.updateCount > 0
  ).length;
  const unreachable = systemsWithMeta.filter(
    (s) => s.isReachable === -1
  ).length;
  const totalUpdates = systemsWithMeta.reduce(
    (sum, s) => sum + s.updateCount,
    0
  );
  const needsReboot = systemsWithMeta.filter(
    (s) => s.needsReboot === 1
  ).length;

  return c.json({
    stats: { total, upToDate, needsUpdates, unreachable, totalUpdates, needsReboot },
  });
});

dashboard.get("/systems", (c) => {
  const allSystems = systemService.listSystemsWithUpdateCounts();

  const systemsWithMeta = allSystems.map((s) => ({
    ...s,
    cacheAge: cacheService.getCacheAge(s.id),
    isStale: cacheService.isCacheStale(s.id),
  }));

  return c.json({ systems: systemsWithMeta });
});

export default dashboard;
