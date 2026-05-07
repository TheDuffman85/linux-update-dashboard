import { Hono } from "hono";
import * as scheduleService from "../services/schedule-service";
import * as scheduler from "../services/scheduler";
import type { ScheduleType } from "../services/schedule-service";
import type { SessionData } from "../auth/session";

type AuthEnv = {
  Variables: {
    user: SessionData;
  };
};

const MAX_CONFIG_JSON_LENGTH = 20_000;
const schedulesRouter = new Hono<AuthEnv>();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function parseScheduleIdList(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null;
  const ids = input.map((value) => Number(value));
  return ids.every((id) => Number.isInteger(id) && id > 0) ? ids : null;
}

function validateConfigShape(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "config must be an object";
  }

  try {
    const serialized = JSON.stringify(config);
    if (!serialized || serialized.length > MAX_CONFIG_JSON_LENGTH) {
      return `config must serialize to at most ${MAX_CONFIG_JSON_LENGTH} characters`;
    }
  } catch {
    return "config must be JSON-serializable";
  }

  return null;
}

function restartScheduler(): void {
  scheduler.restart();
}

schedulesRouter.get("/", (c) => {
  return c.json({ schedules: scheduleService.listSchedules() });
});

schedulesRouter.put("/reorder", async (c) => {
  const body = await c.req.json().catch(() => null);
  const scheduleIds = parseScheduleIdList(body?.scheduleIds);

  if (!scheduleIds) {
    return c.json({ error: "scheduleIds must be an array of positive integers" }, 400);
  }

  try {
    scheduleService.reorderSchedules(scheduleIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reorder schedules";
    return c.json({ error: message }, 400);
  }

  return c.json({ status: "ok" });
});

schedulesRouter.get("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const item = scheduleService.getSchedule(id);
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

schedulesRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { name, type, enabled, systemIds, config } = body as Record<string, unknown>;
  const nameError = scheduleService.validateScheduleName(name);
  if (nameError) return c.json({ error: nameError }, 400);

  if (!scheduleService.validateScheduleType(type)) {
    return c.json({ error: `type must be one of: ${scheduleService.getValidScheduleTypes().join(", ")}` }, 400);
  }

  if (enabled !== undefined && typeof enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  const systemIdsError = scheduleService.validateSystemIds(systemIds);
  if (systemIdsError) return c.json({ error: systemIdsError }, 400);

  const configShapeError = validateConfigShape(config);
  if (configShapeError) return c.json({ error: configShapeError }, 400);

  const configError = scheduleService.validateScheduleConfig(type, config);
  if (configError) return c.json({ error: configError }, 400);

  let id: number;
  try {
    id = scheduleService.createSchedule({
      name: (name as string).trim(),
      type,
      enabled: enabled as boolean | undefined,
      systemIds: (systemIds as number[] | null | undefined) ?? null,
      config,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create schedule";
    return c.json({ error: message }, 400);
  }
  restartScheduler();

  return c.json({ id }, 201);
});

schedulesRouter.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const existing = scheduleService.getSchedule(id);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const incoming = body as Record<string, unknown>;
  const allowed: {
    name?: string;
    type?: ScheduleType;
    enabled?: boolean;
    systemIds?: number[] | null;
    config?: unknown;
  } = {};

  if (incoming.name !== undefined) {
    const nameError = scheduleService.validateScheduleName(incoming.name);
    if (nameError) return c.json({ error: nameError }, 400);
    allowed.name = (incoming.name as string).trim();
  }

  if (incoming.type !== undefined) {
    if (!scheduleService.validateScheduleType(incoming.type)) {
      return c.json({ error: `type must be one of: ${scheduleService.getValidScheduleTypes().join(", ")}` }, 400);
    }
    allowed.type = incoming.type;
  }

  if (incoming.enabled !== undefined) {
    if (typeof incoming.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    allowed.enabled = incoming.enabled;
  }

  if (incoming.systemIds !== undefined) {
    const systemIdsError = scheduleService.validateSystemIds(incoming.systemIds);
    if (systemIdsError) return c.json({ error: systemIdsError }, 400);
    allowed.systemIds = incoming.systemIds as number[] | null;
  }

  if (incoming.config !== undefined) {
    const configShapeError = validateConfigShape(incoming.config);
    if (configShapeError) return c.json({ error: configShapeError }, 400);
    allowed.config = incoming.config;
  }

  if (incoming.type !== undefined || incoming.config !== undefined) {
    const type = (allowed.type ?? existing.type) as ScheduleType;
    const config = incoming.config ?? existing.config;
    const configError = scheduleService.validateScheduleConfig(type, config);
    if (configError) return c.json({ error: configError }, 400);
  }

  let ok = false;
  try {
    ok = scheduleService.updateSchedule(id, allowed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update schedule";
    return c.json({ error: message }, 400);
  }
  if (!ok) return c.json({ error: "Not found" }, 404);
  restartScheduler();

  return c.json({ ok: true });
});

schedulesRouter.delete("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const ok = scheduleService.deleteSchedule(id);
  if (!ok) return c.json({ error: "Not found" }, 404);
  restartScheduler();

  return c.json({ ok: true });
});

export default schedulesRouter;
