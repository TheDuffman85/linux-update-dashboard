import { Hono } from "hono";
import { Cron } from "croner";
import { eq } from "drizzle-orm";
import * as notificationService from "../services/notification-service";
import { getDb } from "../db";
import { notifications } from "../db/schema";
import { getProvider, getProviderNames, type NotificationConfig } from "../services/notifications";
import {
  sanitizeNotificationConfig,
} from "../services/notification-service";

const VALID_TYPES = getProviderNames();
const VALID_EVENTS = ["updates", "unreachable", "appUpdates"];
const MAX_NAME_LENGTH = 100;
const MAX_CONFIG_JSON_LENGTH = 50_000;

function isValidSchedule(value: unknown): boolean {
  if (value === null || value === "immediate") return true;
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    // Validate cron expression — Cron constructor throws on invalid patterns
    new Cron(value);
    return true;
  } catch {
    return false;
  }
}

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  return id;
}

function parseNotificationIdList(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null;

  const ids = input.map((value) => Number(value));
  if (!ids.every((id) => Number.isInteger(id) && id > 0)) return null;

  return ids;
}

function parseConfigJson(raw: string): NotificationConfig {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

function validateProviderConfig(type: string, config: NotificationConfig): string | null {
  const provider = getProvider(type);
  if (!provider) {
    return `type must be one of: ${VALID_TYPES.join(", ")}`;
  }

  return provider.validateConfig(config);
}

const notificationsRouter = new Hono();

// List all notifications
notificationsRouter.get("/", (c) => {
  const items = notificationService.listNotifications();
  return c.json({ notifications: items });
});

notificationsRouter.put("/reorder", async (c) => {
  const body = await c.req.json().catch(() => null);
  const notificationIds = parseNotificationIdList(body?.notificationIds);

  if (!notificationIds) {
    return c.json({ error: "notificationIds must be an array of positive integers" }, 400);
  }

  try {
    notificationService.reorderNotifications(notificationIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reorder notifications";
    return c.json({ error: message }, 400);
  }

  return c.json({ status: "ok" });
});

// Get single notification
notificationsRouter.get("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const item = notificationService.getNotification(id);
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

// Create notification
notificationsRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { name, type, enabled, notifyOn, systemIds, config } = body;

  // Validate name
  if (typeof name !== "string" || !name.trim() || name.length > MAX_NAME_LENGTH) {
    return c.json({ error: "name is required and must be 1-100 characters" }, 400);
  }

  // Validate type
  if (!VALID_TYPES.includes(type)) {
    return c.json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` }, 400);
  }

  // Validate config
  const configShapeError = validateConfigShape(config);
  if (configShapeError) {
    return c.json({ error: configShapeError }, 400);
  }

  const providerConfigError = validateProviderConfig(type, config);
  if (providerConfigError) {
    return c.json({ error: providerConfigError }, 400);
  }

  // Validate notifyOn
  if (notifyOn !== undefined) {
    if (!Array.isArray(notifyOn) || !notifyOn.every((e: unknown) => VALID_EVENTS.includes(String(e)))) {
      return c.json({ error: `notifyOn must be an array of: ${VALID_EVENTS.join(", ")}` }, 400);
    }
  }

  // Validate systemIds
  if (systemIds !== undefined && systemIds !== null) {
    if (!Array.isArray(systemIds) || !systemIds.every((id: unknown) => typeof id === "number" && Number.isInteger(id) && id > 0)) {
      return c.json({ error: "systemIds must be null or an array of positive integers" }, 400);
    }
  }

  // Validate enabled
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  // Validate schedule
  const { schedule } = body;
  if (schedule !== undefined && !isValidSchedule(schedule)) {
    return c.json({ error: "schedule must be null, \"immediate\", or a valid cron expression" }, 400);
  }

  const id = notificationService.createNotification({
    name: name.trim(),
    type,
    enabled,
    notifyOn,
    systemIds,
    config,
    schedule: schedule ?? null,
  });

  return c.json({ id }, 201);
});

// Update notification
notificationsRouter.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const db = getDb();
  const existing = db.select().from(notifications).where(eq(notifications.id, id)).get();
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }

  // Whitelist allowed fields
  const allowed: Record<string, unknown> = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > MAX_NAME_LENGTH) {
      return c.json({ error: "name must be 1-100 characters" }, 400);
    }
    allowed.name = body.name.trim();
  }

  if (body.type !== undefined) {
    if (!VALID_TYPES.includes(body.type)) {
      return c.json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` }, 400);
    }
    allowed.type = body.type;
  }

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    allowed.enabled = body.enabled;
  }

  if (body.notifyOn !== undefined) {
    if (!Array.isArray(body.notifyOn) || !body.notifyOn.every((e: unknown) => VALID_EVENTS.includes(String(e)))) {
      return c.json({ error: `notifyOn must be an array of: ${VALID_EVENTS.join(", ")}` }, 400);
    }
    allowed.notifyOn = body.notifyOn;
  }

  if (body.systemIds !== undefined) {
    if (body.systemIds !== null) {
      if (!Array.isArray(body.systemIds) || !body.systemIds.every((sid: unknown) => typeof sid === "number" && Number.isInteger(sid) && sid > 0)) {
        return c.json({ error: "systemIds must be null or an array of positive integers" }, 400);
      }
    }
    allowed.systemIds = body.systemIds;
  }

  if (body.config !== undefined) {
    const configShapeError = validateConfigShape(body.config);
    if (configShapeError) {
      return c.json({ error: configShapeError }, 400);
    }
    allowed.config = body.config;
  }

  if (body.schedule !== undefined) {
    if (!isValidSchedule(body.schedule)) {
      return c.json({ error: "schedule must be null, \"immediate\", or a valid cron expression" }, 400);
    }
    allowed.schedule = body.schedule;
  }

  if (body.type !== undefined || body.config !== undefined) {
    const mergedType = typeof body.type === "string" ? body.type : existing.type;
    const storedConfig =
      mergedType === existing.type
        ? parseConfigJson(existing.config)
        : {};
    const effectiveConfig = notificationService.mergeStoredSensitiveConfig(
      mergedType,
      storedConfig,
      (body.config as NotificationConfig | undefined) ?? {}
    );
    const providerConfigError = validateProviderConfig(
      mergedType,
      effectiveConfig
    );
    if (providerConfigError) {
      return c.json({ error: providerConfigError }, 400);
    }
  }

  const ok = notificationService.updateNotification(id, allowed as any);
  if (!ok) return c.json({ error: "Not found" }, 404);

  return c.json({ ok: true });
});

// Delete notification
notificationsRouter.delete("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  const ok = notificationService.deleteNotification(id);
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true });
});

// Test notification config inline (no saved notification required)
notificationsRouter.post("/test", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { type, config, name, existingId } = body;

  if (!VALID_TYPES.includes(type)) {
    return c.json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` }, 400);
  }

  const configShapeError = validateConfigShape(config);
  if (configShapeError) {
    return c.json({ error: configShapeError }, 400);
  }

  // Validate name if provided
  if (name !== undefined && (typeof name !== "string" || name.length > MAX_NAME_LENGTH)) {
    return c.json({ error: "name must be a string of 1-100 characters" }, 400);
  }

  let effectiveConfig = config as NotificationConfig;
  if (existingId !== undefined) {
    if (typeof existingId !== "number" || !Number.isInteger(existingId) || existingId <= 0) {
      return c.json({ error: "existingId must be a positive integer" }, 400);
    }

    const existing = getDb()
      .select()
      .from(notifications)
      .where(eq(notifications.id, existingId))
      .get();

    if (!existing) {
      return c.json({ error: "Existing notification not found" }, 404);
    }

    if (existing.type !== type) {
      return c.json({ error: "existingId type does not match the test notification type" }, 400);
    }

    effectiveConfig = notificationService.mergeStoredSensitiveConfig(
      type,
      parseConfigJson(existing.config),
      config as NotificationConfig
    );
  }

  const providerConfigError = validateProviderConfig(
    type,
    notificationService.sanitizeNotificationConfig(type, effectiveConfig)
  );
  if (providerConfigError) {
    return c.json({ error: providerConfigError }, 400);
  }

  try {
    const result = await notificationService.testNotificationConfig(
      type,
      notificationService.sanitizeNotificationConfig(type, effectiveConfig),
      name
    );
    return c.json(result);
  } catch {
    return c.json({ success: false, error: "Internal error while sending test notification" }, 500);
  }
});

// Test saved notification by ID
notificationsRouter.post("/:id/test", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid ID" }, 400);

  try {
    const result = await notificationService.testNotification(id);
    return c.json(result);
  } catch {
    return c.json({ success: false, error: "Internal error while sending test notification" }, 500);
  }
});

export default notificationsRouter;
