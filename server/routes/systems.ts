import { Hono } from "hono";
import * as systemService from "../services/system-service";
import * as cacheService from "../services/cache-service";
import * as updateService from "../services/update-service";
import { getSSHManager } from "../ssh/connection";
import { getEncryptor } from "../security";
import { detectPackageManagers } from "../ssh/detector";
import * as outputStream from "../services/output-stream";

const systems = new Hono();

function parseJsonArrayField(value: string | null): string[] | null {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function serializeSystem(s: Record<string, unknown>) {
  return {
    ...s,
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
  const id = parseInt(c.req.param("id"), 10);
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

  const systemId = systemService.createSystem({
    name: body.name,
    hostname: body.hostname,
    port: body.port || 22,
    authType: body.authType || "password",
    username: body.username,
    password: body.password || undefined,
    privateKey: body.privateKey || undefined,
    keyPassphrase: body.keyPassphrase || undefined,
    sudoPassword: body.sudoPassword || undefined,
    disabledPkgManagers: body.disabledPkgManagers || undefined,
  });

  // Trigger initial check in background
  updateService.checkUpdates(systemId).catch(console.error);

  return c.json({ id: systemId }, 201);
});

// Update system
systems.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();

  systemService.updateSystem(id, {
    name: body.name,
    hostname: body.hostname,
    port: body.port || 22,
    authType: body.authType || "password",
    username: body.username,
    password: body.password || undefined,
    privateKey: body.privateKey || undefined,
    keyPassphrase: body.keyPassphrase || undefined,
    sudoPassword: body.sudoPassword || undefined,
    disabledPkgManagers: body.disabledPkgManagers || undefined,
  });

  return c.json({ status: "ok" });
});

// Delete system
systems.delete("/:id", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  outputStream.removeStream(id);
  systemService.deleteSystem(id);
  return c.json({ status: "ok" });
});

// Test connection with provided credentials
systems.post("/test-connection", async (c) => {
  const body = await c.req.json();

  const system: Record<string, unknown> = {
    hostname: body.hostname,
    port: body.port || 22,
    username: body.username,
    authType: body.authType || "password",
  };

  // Encrypt raw credentials immediately — plaintext must never persist beyond this block
  const encryptor = getEncryptor();
  if (body.authType === "password" && body.password) {
    system.encryptedPassword = encryptor.encrypt(body.password);
  } else if (body.authType === "key" && body.privateKey) {
    system.encryptedPrivateKey = encryptor.encrypt(body.privateKey);
    if (body.keyPassphrase) {
      system.encryptedKeyPassphrase = encryptor.encrypt(body.keyPassphrase);
    }
  } else if (body.systemId) {
    // No new credentials entered — fall back to saved (encrypted) ones
    const saved = systemService.getSystem(body.systemId);
    if (saved) {
      const s = saved as Record<string, unknown>;
      system.encryptedPassword = s.encryptedPassword;
      system.encryptedPrivateKey = s.encryptedPrivateKey;
      system.encryptedKeyPassphrase = s.encryptedKeyPassphrase;
    }
  }

  const sshManager = getSSHManager();
  const result = await sshManager.testConnection(system);

  // On successful connection, also detect available package managers
  if (result.success) {
    try {
      const conn = await sshManager.connect(system);
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
  const id = parseInt(c.req.param("id"), 10);
  const updates = cacheService.getCachedUpdates(id);
  return c.json({ updates });
});

// Get history for system
systems.get("/:id/history", (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const history = updateService.getHistory(id).map((h) => ({
    ...h,
    packagesList: h.packages ? JSON.parse(h.packages) : [],
  }));
  return c.json({ history });
});

export default systems;
