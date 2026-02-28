import { Hono } from "hono";
import * as updateService from "../services/update-service";
import * as cacheService from "../services/cache-service";
import { validatePackageName } from "../ssh/parsers/types";

const updates = new Hono();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

// --------------- background job tracking ---------------
interface Job {
  status: "running" | "done" | "failed";
  result?: unknown;
}

const jobs = new Map<string, Job>();

function startJob(fn: () => Promise<unknown>): string {
  const id = crypto.randomUUID();
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
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
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
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const jobId = startJob(async () => {
    const result = await updateService.applyUpgradeAll(id);
    return {
      status: result.warning ? "warning" : result.success ? "success" : "failed",
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Full upgrade all packages on a system (async)
updates.post("/systems/:id/full-upgrade", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const jobId = startJob(async () => {
    const result = await updateService.applyFullUpgradeAll(id);
    return {
      status: result.warning ? "warning" : result.success ? "success" : "failed",
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Upgrade single package (async)
updates.post("/systems/:id/upgrade/:packageName", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const packageName = c.req.param("packageName");
  try {
    validatePackageName(packageName);
  } catch {
    return c.json({ error: "Invalid package name" }, 400);
  }
  const jobId = startJob(async () => {
    const result = await updateService.applyUpgradePackage(id, packageName);
    return {
      status: result.warning ? "warning" : result.success ? "success" : "failed",
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
