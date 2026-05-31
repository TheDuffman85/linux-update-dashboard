import { spawn } from "node:child_process";
import { eq, and } from "drizzle-orm";
import { getDb } from "../db";
import { systems, vsphereConnections, vmSnapshots } from "../db/schema";
import { getEncryptor } from "../security";
import { logger } from "../logger";

export type TlsMode = "strict" | "allow_self_signed";

export interface CreateVsphereConnectionInput {
  name: string;
  url: string;
  username: string;
  password: string;
  tlsMode?: TlsMode;
}

export interface UpdateSystemVsphereInput {
  vsphereConnectionId: number | null;
  vsphereVmMoref: string | null;
  vsphereVmName: string | null;
  snapshotBeforeUpgrade: boolean;
  snapshotQuiesce: boolean;
  snapshotMemory: boolean;
  snapshotRetentionHours: number | null;
}

interface GovcResult {
  stdout: string;
  stderr: string;
}

function assertGovcSafeValue(name: string, value: string): void {
  if (!value || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} contains invalid characters`);
  }
}

function runGovc(args: string[], env: Record<string, string>, timeoutMs = 120_000): Promise<GovcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("govc", args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`govc timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`govc exited with ${code}: ${stderr || stdout}`.trim()));
      }
    });
  });
}

function getConnection(id: number) {
  return getDb().select().from(vsphereConnections).where(eq(vsphereConnections.id, id)).get();
}

function govcEnv(connectionId: number): Record<string, string> {
  const connection = getConnection(connectionId);
  if (!connection) throw new Error("vSphere connection not found");

  const password = getEncryptor().decrypt(connection.encryptedPassword);
  return {
    GOVC_URL: connection.url,
    GOVC_USERNAME: connection.username,
    GOVC_PASSWORD: password,
    GOVC_INSECURE: connection.tlsMode === "allow_self_signed" ? "1" : "0",
  };
}

export function listVsphereConnections() {
  return getDb().select({
    id: vsphereConnections.id,
    name: vsphereConnections.name,
    url: vsphereConnections.url,
    username: vsphereConnections.username,
    tlsMode: vsphereConnections.tlsMode,
    createdAt: vsphereConnections.createdAt,
    updatedAt: vsphereConnections.updatedAt,
  }).from(vsphereConnections).all();
}

export function createVsphereConnection(input: CreateVsphereConnectionInput) {
  const name = input.name.trim();
  const url = input.url.trim();
  const username = input.username.trim();
  const password = input.password;
  const tlsMode = input.tlsMode ?? "strict";

  if (!name) throw new Error("name is required");
  if (!url) throw new Error("url is required");
  if (!username) throw new Error("username is required");
  if (!password) throw new Error("password is required");
  if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  if (tlsMode !== "strict" && tlsMode !== "allow_self_signed") throw new Error("invalid tlsMode");

  const encryptedPassword = getEncryptor().encrypt(password);
  const result = getDb().insert(vsphereConnections).values({
    name,
    url,
    username,
    encryptedPassword,
    tlsMode,
  }).run();

  return { id: Number(result.lastInsertRowid) };
}

export async function testVsphereConnection(connectionId: number) {
  const env = govcEnv(connectionId);
  await runGovc(["about"], env, 30_000);
  return { status: "ok" };
}

export async function searchVms(connectionId: number, query: string) {
  const env = govcEnv(connectionId);
  const pattern = query?.trim() ? `*${query.trim()}*` : "*";
  assertGovcSafeValue("query", pattern);

  const { stdout } = await runGovc(["find", "/", "-type", "m", "-name", pattern], env, 60_000);
  const paths = stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 100);

  const vms = [] as Array<{ path: string; moref: string; name: string }>;
  for (const path of paths) {
    const name = path.split("/").pop() ?? path;
    const morefResult = await runGovc(["vm.info", "-json", path], env, 60_000).catch(() => null);
    let moref = path;
    if (morefResult) {
      try {
        const parsed = JSON.parse(morefResult.stdout);
        moref = parsed?.VirtualMachines?.[0]?.Self?.Value ?? path;
      } catch {
        moref = path;
      }
    }
    vms.push({ path, moref, name });
  }

  return vms;
}

export function updateSystemVsphere(systemId: number, input: UpdateSystemVsphereInput) {
  if (input.vsphereConnectionId !== null && !getConnection(input.vsphereConnectionId)) {
    throw new Error("vSphere connection not found");
  }

  getDb().update(systems).set({
    vsphereConnectionId: input.vsphereConnectionId,
    vsphereVmMoref: input.vsphereVmMoref,
    vsphereVmName: input.vsphereVmName,
    snapshotBeforeUpgrade: input.snapshotBeforeUpgrade ? 1 : 0,
    snapshotQuiesce: input.snapshotQuiesce ? 1 : 0,
    snapshotMemory: input.snapshotMemory ? 1 : 0,
    snapshotRetentionHours: input.snapshotRetentionHours,
    updatedAt: new Date().toISOString(),
  }).where(eq(systems.id, systemId)).run();

  return { status: "ok" };
}

export async function createPreUpgradeSnapshot(systemId: number, activityId?: number | null) {
  const db = getDb();
  const system = db.select().from(systems).where(eq(systems.id, systemId)).get();
  if (!system) throw new Error("System not found");
  if (!system.vsphereConnectionId || !system.vsphereVmMoref) {
    throw new Error("System is not mapped to a vSphere VM");
  }

  const env = govcEnv(system.vsphereConnectionId);
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const safeSystemName = String(system.name).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 60);
  const snapshotName = `ludash-preupgrade-${safeSystemName}-${timestamp}`;
  assertGovcSafeValue("snapshotName", snapshotName);
  assertGovcSafeValue("vm", system.vsphereVmMoref);

  const insert = db.insert(vmSnapshots).values({
    systemId,
    vsphereConnectionId: system.vsphereConnectionId,
    vmMoref: system.vsphereVmMoref,
    vmName: system.vsphereVmName ?? system.name,
    snapshotName,
    status: "creating",
    createdBeforeHistoryId: activityId ?? null,
  }).run();
  const snapshotRecordId = Number(insert.lastInsertRowid);

  const args = ["snapshot.create"];
  if (system.snapshotQuiesce) args.push("-quiesce=true");
  if (system.snapshotMemory) args.push("-m=true");
  args.push("-vm", system.vsphereVmMoref, snapshotName);

  try {
    logger.info("Creating vSphere pre-upgrade snapshot", { systemId, vm: system.vsphereVmMoref, snapshotName });
    await runGovc(args, env, 10 * 60_000);
    db.update(vmSnapshots).set({ status: "created" }).where(eq(vmSnapshots.id, snapshotRecordId)).run();
    return { id: snapshotRecordId, snapshotName, status: "created" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(vmSnapshots).set({ status: "failed", errorMessage: message }).where(eq(vmSnapshots.id, snapshotRecordId)).run();
    throw error;
  }
}

export async function deleteSnapshot(snapshotId: number) {
  const snapshot = getDb().select().from(vmSnapshots).where(eq(vmSnapshots.id, snapshotId)).get();
  if (!snapshot) throw new Error("Snapshot not found");
  if (snapshot.status !== "created") throw new Error("Snapshot is not in created state");
  const env = govcEnv(snapshot.vsphereConnectionId);
  assertGovcSafeValue("vm", snapshot.vmMoref);
  assertGovcSafeValue("snapshotName", snapshot.snapshotName);

  await runGovc(["snapshot.remove", "-vm", snapshot.vmMoref, snapshot.snapshotName], env, 10 * 60_000);
  getDb().update(vmSnapshots).set({ status: "deleted", deletedAt: new Date().toISOString() }).where(eq(vmSnapshots.id, snapshotId)).run();
  return { status: "ok" };
}

export function listSystemSnapshots(systemId: number) {
  return getDb().select().from(vmSnapshots).where(eq(vmSnapshots.systemId, systemId)).all();
}

export async function cleanupExpiredSnapshots(now = new Date()) {
  const db = getDb();
  const rows = db.select().from(vmSnapshots).where(eq(vmSnapshots.status, "created")).all();
  for (const snapshot of rows) {
    const system = db.select().from(systems).where(and(eq(systems.id, snapshot.systemId), eq(systems.vsphereConnectionId, snapshot.vsphereConnectionId))).get();
    const retentionHours = system?.snapshotRetentionHours;
    if (!retentionHours || retentionHours <= 0) continue;
    const createdAt = new Date(snapshot.createdAt).getTime();
    if (createdAt + retentionHours * 3600_000 <= now.getTime()) {
      try {
        await deleteSnapshot(snapshot.id);
      } catch (error) {
        logger.error("Failed to clean up expired vSphere snapshot", { snapshotId: snapshot.id, error: String(error) });
      }
    }
  }
}

export function deleteVsphereConnection(connectionId: number) {
  const db = getDb();
  const connection = getConnection(connectionId);
  if (!connection) throw new Error("vSphere connection not found");

  const activeSnapshots = db
    .select()
    .from(vmSnapshots)
    .where(and(eq(vmSnapshots.vsphereConnectionId, connectionId), eq(vmSnapshots.status, "created")))
    .all();

  if (activeSnapshots.length > 0) {
    throw new Error("This vCenter connection still has dashboard-created snapshots in created state. Delete those snapshots before removing the credentials.");
  }

  db.update(systems).set({
    vsphereConnectionId: null,
    vsphereVmMoref: null,
    vsphereVmName: null,
    snapshotBeforeUpgrade: 0,
    updatedAt: new Date().toISOString(),
  }).where(eq(systems.vsphereConnectionId, connectionId)).run();

  // Remove local audit rows for this connection so the FK does not block credential removal.
  db.delete(vmSnapshots).where(eq(vmSnapshots.vsphereConnectionId, connectionId)).run();
  db.delete(vsphereConnections).where(eq(vsphereConnections.id, connectionId)).run();

  return { status: "ok" };
}
