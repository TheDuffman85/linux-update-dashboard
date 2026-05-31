import { Hono } from "hono";
import * as vsphereService from "../services/vsphere-service";

const vsphere = new Hono();

function parseId(value: string | undefined): number | null {
  const id = Number.parseInt(value ?? "", 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function bodyObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

vsphere.get("/connections", (c) => c.json(vsphereService.listVsphereConnections()));

vsphere.post("/connections", async (c) => {
  const body = bodyObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);
  try {
    const result = vsphereService.createVsphereConnection({
      name: String(body.name ?? ""),
      url: String(body.url ?? ""),
      username: String(body.username ?? ""),
      password: String(body.password ?? ""),
      tlsMode: body.tlsMode === "allow_self_signed" ? "allow_self_signed" : "strict",
    });
    return c.json(result, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create vSphere connection" }, 400);
  }
});



vsphere.delete("/connections/:id", (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid connection ID" }, 400);
  try {
    return c.json(vsphereService.deleteVsphereConnection(id));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to remove vSphere connection" }, 400);
  }
});

vsphere.post("/connections/:id/test", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid connection ID" }, 400);
  try {
    return c.json(await vsphereService.testVsphereConnection(id));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "vSphere connection test failed" }, 400);
  }
});

vsphere.get("/connections/:id/vms", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid connection ID" }, 400);
  try {
    const query = c.req.query("search") ?? "";
    return c.json(await vsphereService.searchVms(id, query));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "VM search failed" }, 400);
  }
});

vsphere.put("/systems/:id", async (c) => {
  const systemId = parseId(c.req.param("id"));
  if (!systemId) return c.json({ error: "Invalid system ID" }, 400);
  const body = bodyObject(await c.req.json().catch(() => null));
  if (!body) return c.json({ error: "Invalid request body" }, 400);

  try {
    return c.json(vsphereService.updateSystemVsphere(systemId, {
      vsphereConnectionId: body.vsphereConnectionId == null ? null : Number(body.vsphereConnectionId),
      vsphereVmMoref: body.vsphereVmMoref == null ? null : String(body.vsphereVmMoref),
      vsphereVmName: body.vsphereVmName == null ? null : String(body.vsphereVmName),
      snapshotBeforeUpgrade: body.snapshotBeforeUpgrade === true,
      snapshotQuiesce: body.snapshotQuiesce !== false,
      snapshotMemory: body.snapshotMemory === true,
      snapshotRetentionHours: body.snapshotRetentionHours == null ? null : Number(body.snapshotRetentionHours),
    }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to update system vSphere settings" }, 400);
  }
});

vsphere.get("/systems/:id/snapshots", (c) => {
  const systemId = parseId(c.req.param("id"));
  if (!systemId) return c.json({ error: "Invalid system ID" }, 400);
  return c.json(vsphereService.listSystemSnapshots(systemId));
});

vsphere.post("/systems/:id/snapshots", async (c) => {
  const systemId = parseId(c.req.param("id"));
  if (!systemId) return c.json({ error: "Invalid system ID" }, 400);
  try {
    return c.json(await vsphereService.createPreUpgradeSnapshot(systemId), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Snapshot creation failed" }, 400);
  }
});

vsphere.delete("/snapshots/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid snapshot ID" }, 400);
  try {
    return c.json(await vsphereService.deleteSnapshot(id));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Snapshot delete failed" }, 400);
  }
});

export default vsphere;
