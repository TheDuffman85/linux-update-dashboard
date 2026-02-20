import { eq, sql, count } from "drizzle-orm";
import { getDb } from "../db";
import { systems, updateCache, settings } from "../db/schema";
import { getEncryptor } from "../security";
import { SYSTEM_INFO_CMD, parseSystemInfo } from "../ssh/system-info";
import { detectPackageManagers } from "../ssh/detector";
import type { SSHConnectionManager } from "../ssh/connection";
import type { Client } from "ssh2";

export function listSystems() {
  const db = getDb();
  return db.select().from(systems).orderBy(systems.name).all();
}

export function getSystem(systemId: number) {
  const db = getDb();
  return db
    .select()
    .from(systems)
    .where(eq(systems.id, systemId))
    .get();
}

export function createSystem(data: {
  name: string;
  hostname: string;
  port: number;
  authType: string;
  username: string;
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
}): number {
  const encryptor = getEncryptor();
  const db = getDb();

  const values: Record<string, unknown> = {
    name: data.name,
    hostname: data.hostname,
    port: data.port,
    authType: data.authType,
    username: data.username,
  };
  if (data.password) {
    values.encryptedPassword = encryptor.encrypt(data.password);
  }
  if (data.privateKey) {
    values.encryptedPrivateKey = encryptor.encrypt(data.privateKey);
  }
  if (data.keyPassphrase) {
    values.encryptedKeyPassphrase = encryptor.encrypt(data.keyPassphrase);
  }

  const result = db.insert(systems).values(values as typeof systems.$inferInsert).returning({ id: systems.id }).get();
  return result.id;
}

export function updateSystem(
  systemId: number,
  data: {
    name: string;
    hostname: string;
    port: number;
    authType: string;
    username: string;
    password?: string;
    privateKey?: string;
    keyPassphrase?: string;
  }
): void {
  const encryptor = getEncryptor();
  const db = getDb();

  const values: Record<string, unknown> = {
    name: data.name,
    hostname: data.hostname,
    port: data.port,
    authType: data.authType,
    username: data.username,
    updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
  if (data.password) {
    values.encryptedPassword = encryptor.encrypt(data.password);
  }
  if (data.privateKey) {
    values.encryptedPrivateKey = encryptor.encrypt(data.privateKey);
  }
  if (data.keyPassphrase) {
    values.encryptedKeyPassphrase = encryptor.encrypt(data.keyPassphrase);
  }

  db.update(systems)
    .set(values as Partial<typeof systems.$inferInsert>)
    .where(eq(systems.id, systemId))
    .run();
}

export function deleteSystem(systemId: number): void {
  const db = getDb();
  db.delete(systems).where(eq(systems.id, systemId)).run();
}

export async function updateSystemInfo(
  systemId: number,
  sshManager: SSHConnectionManager,
  conn: Client
): Promise<void> {
  const { stdout, exitCode } = await sshManager.runCommand(
    conn,
    SYSTEM_INFO_CMD
  );
  if (exitCode !== 0) return;

  const info = parseSystemInfo(stdout);
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const db = getDb();

  db.update(systems)
    .set({
      osName: info.osName,
      osVersion: info.osVersion,
      kernel: info.kernel,
      hostnameRemote: info.hostname,
      uptime: info.uptime,
      arch: info.arch,
      cpuCores: info.cpuCores,
      memory: info.memory,
      disk: info.disk,
      systemInfoUpdatedAt: now,
      isReachable: 1,
      lastSeenAt: now,
    })
    .where(eq(systems.id, systemId))
    .run();
}

export async function detectAndStorePkgManager(
  systemId: number,
  sshManager: SSHConnectionManager,
  conn: Client
): Promise<string[]> {
  const db = getDb();
  const checkFlatpak =
    (db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "check_flatpak"))
      .get()?.value || "0") === "1";

  const checkSnap =
    (db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "check_snap"))
      .get()?.value || "0") === "1";

  const detected = await detectPackageManagers(
    sshManager,
    conn,
    checkFlatpak,
    checkSnap
  );

  if (detected.length > 0) {
    db.update(systems)
      .set({ pkgManager: detected[0] })
      .where(eq(systems.id, systemId))
      .run();
  }

  return detected;
}

export function markUnreachable(systemId: number): void {
  const db = getDb();
  db.update(systems)
    .set({ isReachable: -1 })
    .where(eq(systems.id, systemId))
    .run();
}

export function getSystemWithUpdateCount(systemId: number) {
  const system = getSystem(systemId);
  if (!system) return null;

  const db = getDb();
  const result = db
    .select({ count: count() })
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .get();

  return { ...system, updateCount: result?.count ?? 0 };
}

export function listSystemsWithUpdateCounts() {
  const allSystems = listSystems();
  const db = getDb();

  return allSystems.map((s) => {
    const result = db
      .select({ count: count() })
      .from(updateCache)
      .where(eq(updateCache.systemId, s.id))
      .get();
    return { ...s, updateCount: result?.count ?? 0 };
  });
}
