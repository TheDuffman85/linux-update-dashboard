import { Hono } from "hono";
import * as updateService from "../services/update-service";
import * as cacheService from "../services/cache-service";

const updates = new Hono();

// --------------- background job tracking ---------------
interface Job {
  status: "running" | "done" | "failed";
  result?: unknown;
}

const jobs = new Map<string, Job>();
let jobCounter = 0;

function startJob(fn: () => Promise<unknown>): string {
  const id = `job_${++jobCounter}_${Date.now()}`;
  jobs.set(id, { status: "running" });
  fn()
    .then((result) => {
      jobs.set(id, { status: "done", result });
      setTimeout(() => jobs.delete(id), 300_000);
    })
    .catch((err) => {
      jobs.set(id, { status: "failed", result: { error: String(err) } });
      setTimeout(() => jobs.delete(id), 300_000);
    });
  return id;
}

// Poll job status
updates.get("/jobs/:id", (c) => {
  const id = c.req.param("id");
  const job = jobs.get(id);
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// --------------- endpoints ---------------

// Check single system (async)
updates.post("/systems/:id/check", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const jobId = startJob(async () => {
    const result = await updateService.checkUpdates(id);
    return { updateCount: result.length };
  });
  return c.json({ status: "started", jobId });
});

// Check all systems
updates.post("/systems/check-all", async (c) => {
  // Run in background
  updateService.checkAllSystems().catch(console.error);
  return c.json({ status: "checking_all" });
});

// Upgrade all packages on a system (async)
updates.post("/systems/:id/upgrade", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const jobId = startJob(async () => {
    const result = await updateService.applyUpgradeAll(id);
    return {
      status: result.success ? "success" : "failed",
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Full upgrade all packages on a system (async)
updates.post("/systems/:id/full-upgrade", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const jobId = startJob(async () => {
    const result = await updateService.applyFullUpgradeAll(id);
    return {
      status: result.success ? "success" : "failed",
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Upgrade single package (async)
updates.post("/systems/:id/upgrade/:packageName", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const packageName = c.req.param("packageName");
  const jobId = startJob(async () => {
    const result = await updateService.applyUpgradePackage(id, packageName);
    return {
      status: result.success ? "success" : "failed",
      package: packageName,
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Refresh all cache
updates.post("/cache/refresh", async (c) => {
  cacheService.invalidateCache();
  updateService.checkAllSystems().catch(console.error);
  return c.json({ status: "refreshing" });
});

export default updates;
