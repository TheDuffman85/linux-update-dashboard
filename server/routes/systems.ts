import { Hono } from "hono";
import * as systemService from "../services/system-service";
import * as cacheService from "../services/cache-service";
import * as updateService from "../services/update-service";
import { getSSHManager } from "../ssh/connection";
import { detectPackageManagers } from "../ssh/detector";
import * as outputStream from "../services/output-stream";
import { logger } from "../logger";
import { resolveSystemCredential } from "../services/credential-service";

const systems = new Hono();

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  if (isNaN(id) || id <= 0) return null;
  return id;
}

const VALID_HOSTNAME = /^[a-zA-Z0-9]([a-zA-Z0-9._:-]*[a-zA-Z0-9])?$/;

function validateSystemInput(body: Record<string, unknown>): string | null {
  if (!body.name || typeof body.name !== "string" || body.name.length > 255)
    return "name is required (max 255 chars)";
  if (!body.hostname || typeof body.hostname !== "string" || body.hostname.length > 255 || !VALID_HOSTNAME.test(body.hostname))
    return "hostname is required and must be a valid hostname or IP";
  if (body.port !== undefined && body.port !== null) {
    const port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return "port must be an integer between 1 and 65535";
  }
  const credentialId = Number(body.credentialId);
  if (!Number.isInteger(credentialId) || credentialId <= 0) {
    return "credentialId must be a positive integer";
  }
  return null;
}

function parseJsonArrayField(value: string | null): string[] | null {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function parseSystemIdList(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;

  const ids = value.map((entry) => parseId(String(entry)));
  if (ids.some((id) => id === null)) return null;

  return ids as number[];
}

function getSystemWriteErrorResponse(error: unknown): Response | null {
  if (error instanceof systemService.DuplicateSystemConnectionError) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (error instanceof Error && error.message.includes("credential")) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return null;
}

function serializeSystem(s: Record<string, unknown>) {
  const {
    encryptedPassword,
    encryptedPrivateKey,
    encryptedKeyPassphrase,
    encryptedSudoPassword,
    ...safe
  } = s;
  return {
    ...safe,
    hasSudoPassword: !!encryptedSudoPassword,
    detectedPkgManagers: parseJsonArrayField(s.detectedPkgManagers as string | null),
    disabledPkgManagers: parseJsonArrayField(s.disabledPkgManagers as string | null),
  };
}

// List all systems
systems.get("/", (c) => {
  const allSystems = systemService.listSystemsWithUpdateCounts();
  const systemsWithMeta = allSystems.map((s) => ({
    ...serializeSystem(s as Record<string, unknown>),
    cacheAge: cacheService.getCacheAge(s.id),
    activeOperation: updateService.getActiveOperation(s.id),
  }));
  return c.json({ systems: systemsWithMeta });
});

// Get single system detail
systems.get("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const system = systemService.getSystemWithUpdateCount(id);
  if (!system) return c.json({ error: "System not found" }, 404);

  const updates = cacheService.getCachedUpdates(id);
  const history = updateService.getHistory(id, 20).map((h) => ({
    ...h,
    packagesList: h.packages ? JSON.parse(h.packages) : [],
  }));

  return c.json({
    system: {
      ...serializeSystem(system as Record<string, unknown>),
      cacheAge: cacheService.getCacheAge(id),
      isStale: cacheService.isCacheStale(id),
      activeOperation: updateService.getActiveOperation(id),
      supportsFullUpgrade: updateService.supportsFullUpgrade(id),
    },
    updates,
    history,
  });
});

// Create system
systems.post("/", async (c) => {
  const body = await c.req.json();
  const validationError = validateSystemInput(body);
  if (validationError) return c.json({ error: validationError }, 400);
  const sourceIdCandidate =
    body.sourceSystemId === undefined || body.sourceSystemId === null
      ? undefined
      : parseId(String(body.sourceSystemId));
  const sourceSystemId = sourceIdCandidate ?? undefined;
  if (body.sourceSystemId !== undefined && body.sourceSystemId !== null && !sourceIdCandidate) {
    return c.json({ error: "sourceSystemId must be a positive integer" }, 400);
  }

  let systemId: number;
  try {
    systemId = systemService.createSystem({
      name: body.name,
      hostname: body.hostname,
      port: body.port || 22,
      credentialId: Number(body.credentialId),
      sudoPassword: body.sudoPassword || undefined,
      disabledPkgManagers: body.disabledPkgManagers || undefined,
      excludeFromUpgradeAll: body.excludeFromUpgradeAll,
      sourceSystemId,
    });
  } catch (error) {
    const response = getSystemWriteErrorResponse(error);
    if (response) return response;
    throw error;
  }

  // Trigger initial check in background
  updateService.checkUpdates(systemId).catch((error) => {
    logger.error("Initial update check failed after system creation", {
      systemId,
      error: String(error),
    });
  });

  return c.json({ id: systemId }, 201);
});

// Reorder systems
systems.put("/reorder", async (c) => {
  const body = await c.req.json();
  const systemIds = parseSystemIdList(body.systemIds);

  if (!systemIds) {
    return c.json({ error: "systemIds must be an array of positive integers" }, 400);
  }

  try {
    systemService.reorderSystems(systemIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reorder systems";
    return c.json({ error: message }, 400);
  }

  return c.json({ status: "ok" });
});

// Update system
systems.put("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const body = await c.req.json();
  const validationError = validateSystemInput(body);
  if (validationError) return c.json({ error: validationError }, 400);

  try {
    systemService.updateSystem(id, {
      name: body.name,
      hostname: body.hostname,
      port: body.port || 22,
      credentialId: Number(body.credentialId),
      sudoPassword: body.sudoPassword || undefined,
      disabledPkgManagers: body.disabledPkgManagers || undefined,
      excludeFromUpgradeAll: body.excludeFromUpgradeAll,
    });
  } catch (error) {
    const response = getSystemWriteErrorResponse(error);
    if (response) return response;
    throw error;
  }

  return c.json({ status: "ok" });
});

// Reboot system
systems.post("/:id/reboot", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const result = await updateService.rebootSystem(id);
  return c.json(result, result.success ? 200 : 500);
});

// Delete system
systems.delete("/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  outputStream.removeStream(id);
  systemService.deleteSystem(id);
  return c.json({ status: "ok" });
});

// Test connection with provided credentials
systems.post("/test-connection", async (c) => {
  const body = await c.req.json();
  const credentialId =
    body.credentialId === undefined || body.credentialId === null
      ? null
      : parseId(String(body.credentialId));
  if (!credentialId) {
    return c.json({ error: "credentialId must be a positive integer" }, 400);
  }
  const sourceSystemId =
    body.systemId === undefined || body.systemId === null
      ? null
      : parseId(String(body.systemId));
  if (body.systemId !== undefined && body.systemId !== null && !sourceSystemId) {
    return c.json({ error: "systemId must be a positive integer" }, 400);
  }

  const credential = resolveSystemCredential(credentialId);
  if (!credential) {
    return c.json({ error: "Selected credential is not valid for system SSH access" }, 400);
  }

  const system: Record<string, unknown> = {
    hostname: body.hostname,
    port: body.port || 22,
    credentialId,
    username: credential.username,
    authType: credential.authType,
  };

  const sshManager = getSSHManager();
  const result = await sshManager.testConnection(system, {
    systemId: sourceSystemId ?? undefined,
  });

  // On successful connection, also detect available package managers
  if (result.success) {
    try {
      const conn = await sshManager.connect(system, {
        systemId: sourceSystemId ?? undefined,
      });
      try {
        const detectedManagers = await detectPackageManagers(sshManager, conn);
        return c.json({ ...result, detectedManagers });
      } finally {
        sshManager.disconnect(conn);
      }
    } catch {
      // Detection failed but connection test succeeded — return without managers
      return c.json({ ...result, detectedManagers: [] });
    }
  }

  return c.json(result);
});

// Get cached updates for system
systems.get("/:id/updates", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const updates = cacheService.getCachedUpdates(id);
  return c.json({ updates });
});

// Get history for system
systems.get("/:id/history", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid system ID" }, 400);
  const history = updateService.getHistory(id).map((h) => ({
    ...h,
    packagesList: h.packages ? JSON.parse(h.packages) : [],
  }));
  return c.json({ history });
});

export default systems;
