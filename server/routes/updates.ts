import { Hono } from "hono";
import * as updateService from "../services/update-service";
import * as cacheService from "../services/cache-service";
import * as hiddenUpdateService from "../services/hidden-update-service";
import * as upgradeBatchService from "../services/upgrade-batch-service";
import { validatePackageName } from "../ssh/parsers/types";
import { logger } from "../logger";

const updates = new Hono();

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

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
    try {
      await updateService.checkUpdates(id);
      const latestCheck = updateService.getLatestCompletedCheck(id);
      return {
        ...hiddenUpdateService.getVisibleUpdateSummary(id),
        status: latestCheck?.status ?? "success",
        error: latestCheck?.error ?? null,
      };
    } catch (error) {
      if (updateService.isOperationCancelledError(error)) {
        return { status: "cancelled", updateCount: 0 };
      }
      throw error;
    }
  });
  return c.json({ status: "started", jobId });
});

updates.post("/systems/:id/cancel", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const cancelled = updateService.cancelActiveOperation(id);
  if (!cancelled) {
    return c.json({ error: "No running operation for this system" }, 409);
  }
  return c.json({ status: "cancelling" });
});

updates.post("/systems/:id/package-issues/:issueId/solve", async (c) => {
  const id = parseId(c.req.param("id"));
  const issueId = parseId(c.req.param("issueId"));
  if (!id || !issueId) {
    return c.json({ error: "Invalid package manager issue ID" }, 400);
  }
  const jobId = startJob(async () => {
    const result = await updateService.solvePackageManagerIssue(id, issueId);
    return {
      status: result.cancelled ? "cancelled" : result.success ? "success" : "failed",
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Check all systems
updates.post("/systems/check-all", async (c) => {
  // Run in background
  updateService.checkAllSystems().catch((error) => {
    logger.error("Check-all request failed", { error: String(error) });
  });
  return c.json({ status: "checking_all" });
});

updates.post("/systems/upgrade-all", async (c) => {
  const body = asObject(await c.req.json().catch(() => null));
  if (!body || !Array.isArray(body.items)) {
    return c.json({ error: "items must be an array" }, 400);
  }
  const items = body.items.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const raw = entry as Record<string, unknown>;
    const systemId = parseId(String(raw.systemId));
    if (!systemId) return null;
    const defaultUpgradeModeOverride = raw.defaultUpgradeModeOverride;
    if (
      defaultUpgradeModeOverride !== undefined &&
      defaultUpgradeModeOverride !== "standard" &&
      defaultUpgradeModeOverride !== "aggressive"
    ) {
      return null;
    }
    return {
      systemId,
      defaultUpgradeModeOverride,
    };
  });
  if (items.some((item) => item === null)) {
    return c.json({ error: "items must include valid systemId and defaultUpgradeModeOverride" }, 400);
  }
  try {
    const { batchId } = upgradeBatchService.createUpgradeBatch(items as Array<{
      systemId: number;
      defaultUpgradeModeOverride?: "standard" | "aggressive";
    }>);
    return c.json({ status: "queued", batchId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Upgrade All batch";
    return c.json({ error: message }, message.includes("already queued or running") ? 409 : 400);
  }
});

// Upgrade all packages on a system (async)
updates.post("/systems/:id/upgrade", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const body = await c.req.json().catch(() => null) as { defaultUpgradeModeOverride?: unknown } | null;
  const defaultUpgradeModeOverride = body?.defaultUpgradeModeOverride;
  if (
    defaultUpgradeModeOverride !== undefined &&
    defaultUpgradeModeOverride !== "standard" &&
    defaultUpgradeModeOverride !== "aggressive"
  ) {
    return c.json({ error: "defaultUpgradeModeOverride must be 'standard' or 'aggressive'" }, 400);
  }
  const jobId = startJob(async () => {
    const result = await updateService.applyUpgradeAll(id, {
      defaultUpgradeModeOverride,
    });
    return {
      status: result.cancelled ? "cancelled" : result.warning ? "warning" : result.success ? "success" : "failed",
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Full upgrade all packages on a system (async)
updates.post("/systems/:id/full-upgrade", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  if (!updateService.supportsFullUpgrade(id)) {
    return c.json({ error: "Full upgrade is not supported for this system" }, 400);
  }
  const jobId = startJob(async () => {
    const result = await updateService.applyFullUpgradeAll(id);
    return {
      status: result.cancelled ? "cancelled" : result.warning ? "warning" : result.success ? "success" : "failed",
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
  try {
    updateService.validateSelectedPackageUpgradeRequest(id, [packageName]);
  } catch (error) {
    return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
  }
  const jobId = startJob(async () => {
    const result = await updateService.applyUpgradePackage(id, packageName);
    return {
      status: result.cancelled ? "cancelled" : result.warning ? "warning" : result.success ? "success" : "failed",
      package: packageName,
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Upgrade selected packages on a system (async)
updates.post("/systems/:id/upgrade-packages", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);

  const body = asObject(await c.req.json().catch(() => null));
  if (!body) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  if (!Array.isArray(body.packageNames) || !body.packageNames.every((value) => typeof value === "string")) {
    return c.json({ error: "packageNames must be a non-empty array of strings" }, 400);
  }

  let normalizedPackageNames: string[];
  try {
    ({ packageNames: normalizedPackageNames } = updateService.validateSelectedPackageUpgradeRequest(
      id,
      body.packageNames as string[],
    ));
  } catch (error) {
    return c.json({ error: String(error instanceof Error ? error.message : error) }, 400);
  }

  const jobId = startJob(async () => {
    const result = await updateService.applyUpgradePackages(id, normalizedPackageNames);
    return {
      status: result.cancelled ? "cancelled" : result.warning ? "warning" : result.success ? "success" : "failed",
      packageCount: normalizedPackageNames.length,
      packages: normalizedPackageNames,
      output: result.output,
    };
  });
  return c.json({ status: "started", jobId });
});

// Refresh all cache
updates.post("/cache/refresh", async (c) => {
  cacheService.invalidateCache();
  updateService.checkAllSystems().catch((error) => {
    logger.error("Cache refresh check-all failed", { error: String(error) });
  });
  return c.json({ status: "refreshing" });
});

export default updates;
