import { Hono } from "hono";
import * as updateService from "../services/update-service";
import * as cacheService from "../services/cache-service";

const updates = new Hono();

// Check single system
updates.post("/systems/:id/check", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const result = await updateService.checkUpdates(id);
  return c.json({
    status: "done",
    updateCount: result.length,
  });
});

// Check all systems
updates.post("/systems/check-all", async (c) => {
  // Run in background
  updateService.checkAllSystems().catch(console.error);
  return c.json({ status: "checking_all" });
});

// Upgrade all packages on a system
updates.post("/systems/:id/upgrade", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const result = await updateService.applyUpgradeAll(id);
  return c.json({
    status: result.success ? "success" : "failed",
    output: result.output,
  });
});

// Upgrade single package
updates.post("/systems/:id/upgrade/:packageName", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const packageName = c.req.param("packageName");
  const result = await updateService.applyUpgradePackage(id, packageName);
  return c.json({
    status: result.success ? "success" : "failed",
    package: packageName,
    output: result.output,
  });
});

// Refresh all cache
updates.post("/cache/refresh", async (c) => {
  cacheService.invalidateCache();
  updateService.checkAllSystems().catch(console.error);
  return c.json({ status: "refreshing" });
});

export default updates;
