import { and, asc, count, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { systems, updateCache } from "../db/schema";
import { getEncryptor } from "../security";
import { resolveSystemCredential } from "./credential-service";
import * as cacheService from "./cache-service";
import type { ApprovedHostKeyInput } from "./system-connection-validation";
import {
  SYSTEM_INFO_CMD,
  parseSystemInfo,
  resolveRebootRequired,
} from "../ssh/system-info";
import { detectPackageManagers } from "../ssh/detector";
import type { SSHConnectionManager } from "../ssh/connection";
import type { Client } from "ssh2";

const SYSTEM_CONNECTION_UNIQUE_CONSTRAINT =
  "systems.hostname, systems.port, systems.username";
const SYSTEM_CONNECTION_UNIQUE_INDEX = "systems_connection_identity_idx";
export const MAX_PROXY_JUMP_DEPTH = 10;

export class DuplicateSystemConnectionError extends Error {
  constructor() {
    super(
      "A system with the same hostname, port, username, and ProxyJump host already exists. Change one of those fields before saving."
    );
    this.name = "DuplicateSystemConnectionError";
  }
}

export class InvalidProxyJumpConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProxyJumpConfigurationError";
  }
}

export class ProxyJumpDependencyError extends Error {
  dependents: Array<{ id: number; name: string }>;

  constructor(dependents: Array<{ id: number; name: string }>) {
    const names = dependents.map((system) => system.name).join(", ");
    super(
      `This system is used as a ProxyJump host by: ${names}. Remove those references before deleting it.`
    );
    this.name = "ProxyJumpDependencyError";
    this.dependents = dependents;
  }
}

export function deriveHostKeyStatus(system: {
  hostKeyVerificationEnabled?: number | null;
  trustedHostKey?: string | null;
}): "verified" | "verification_disabled" | "needs_approval" {
  if (system.hostKeyVerificationEnabled === 0) {
    return "verification_disabled";
  }
  return system.trustedHostKey ? "verified" : "needs_approval";
}

function isSystemConnectionUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return (
    error.message.includes("UNIQUE constraint failed") &&
    (
      error.message.includes(SYSTEM_CONNECTION_UNIQUE_CONSTRAINT) ||
      error.message.includes(SYSTEM_CONNECTION_UNIQUE_INDEX)
    )
  );
}

function assertSystemConnectionIsUnique(data: {
  hostname: string;
  port: number;
  username: string;
  proxyJumpSystemId?: number | null;
  excludeSystemId?: number;
}): void {
  const db = getDb();
  const baseConditions = [
    eq(systems.hostname, data.hostname),
    eq(systems.port, data.port),
    eq(systems.username, data.username),
    sql`coalesce(${systems.proxyJumpSystemId}, 0) = ${data.proxyJumpSystemId ?? 0}`,
  ];
  const whereClause = data.excludeSystemId
    ? and(...baseConditions, ne(systems.id, data.excludeSystemId))
    : and(...baseConditions);
  const existing = db
    .select({ id: systems.id })
    .from(systems)
    .where(whereClause)
    .get();

  if (existing) {
    throw new DuplicateSystemConnectionError();
  }
}

export function listSystems() {
  const db = getDb();
  return db
    .select()
    .from(systems)
    .orderBy(asc(systems.sortOrder), asc(systems.name), asc(systems.id))
    .all();
}

export function listVisibleSystems() {
  const db = getDb();
  return db
    .select()
    .from(systems)
    .where(eq(systems.hidden, 0))
    .orderBy(asc(systems.sortOrder), asc(systems.name), asc(systems.id))
    .all();
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
  credentialId: number;
  proxyJumpSystemId?: number | null;
  hostKeyVerificationEnabled?: boolean;
  sudoPassword?: string;
  disabledPkgManagers?: string[];
  ignoreKeptBackPackages?: boolean;
  excludeFromUpgradeAll?: boolean;
  hidden?: boolean;
  sourceSystemId?: number;
  trustedHostKeyData?: ApprovedHostKeyInput;
}): number {
  const encryptor = getEncryptor();
  const db = getDb();
  const nextSortOrder = getNextSortOrder();
  const credential = resolveSystemCredential(data.credentialId);
  if (!credential) {
    throw new Error("Selected credential is not valid for system SSH access");
  }
  validateProxyJumpConfiguration(data.proxyJumpSystemId ?? null);
  assertSystemConnectionIsUnique({
    hostname: data.hostname,
    port: data.port,
    username: credential.username,
    proxyJumpSystemId: data.proxyJumpSystemId ?? null,
  });

  const values: Record<string, unknown> = {
    sortOrder: nextSortOrder,
    name: data.name,
    hostname: data.hostname,
    port: data.port,
    credentialId: data.credentialId,
    proxyJumpSystemId: data.proxyJumpSystemId ?? null,
    authType: credential.authType,
    username: credential.username,
    hostKeyVerificationEnabled: data.hostKeyVerificationEnabled === false ? 0 : 1,
  }
  if (data.sudoPassword) {
    values.encryptedSudoPassword = encryptor.encrypt(data.sudoPassword);
  }

  // Copy sudo password from source system when duplicating unless explicitly overridden
  if (data.sourceSystemId && !data.sudoPassword) {
    const source = getSystem(data.sourceSystemId);
    if (source?.encryptedSudoPassword) {
      values.encryptedSudoPassword = source.encryptedSudoPassword;
    }
  }

  if (data.disabledPkgManagers) {
    values.disabledPkgManagers = JSON.stringify(data.disabledPkgManagers);
  }
  if (data.ignoreKeptBackPackages !== undefined) {
    values.ignoreKeptBackPackages = data.ignoreKeptBackPackages ? 1 : 0;
  }
  if (data.excludeFromUpgradeAll !== undefined) {
    values.excludeFromUpgradeAll = data.excludeFromUpgradeAll ? 1 : 0;
  }
  if (data.hidden !== undefined) {
    values.hidden = data.hidden ? 1 : 0;
  }
  if (data.hostKeyVerificationEnabled !== false && data.trustedHostKeyData) {
    values.trustedHostKey = data.trustedHostKeyData.rawKey;
    values.trustedHostKeyAlgorithm = data.trustedHostKeyData.algorithm;
    values.trustedHostKeyFingerprintSha256 = data.trustedHostKeyData.fingerprintSha256;
    values.hostKeyTrustedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  try {
    const result = db
      .insert(systems)
      .values(values as typeof systems.$inferInsert)
      .returning({ id: systems.id })
      .get();
    return result.id;
  } catch (error) {
    if (isSystemConnectionUniqueConstraintError(error)) {
      throw new DuplicateSystemConnectionError();
    }
    throw error;
  }
}

export function updateSystem(
  systemId: number,
  data: {
    name: string;
    hostname: string;
    port: number;
    credentialId: number;
    proxyJumpSystemId?: number | null;
    hostKeyVerificationEnabled?: boolean;
    sudoPassword?: string;
    disabledPkgManagers?: string[];
    ignoreKeptBackPackages?: boolean;
    excludeFromUpgradeAll?: boolean;
    hidden?: boolean;
    trustedHostKeyData?: ApprovedHostKeyInput;
  }
): void {
  const encryptor = getEncryptor();
  const db = getDb();
  const existing = getSystem(systemId);
  if (!existing) throw new Error("System not found");
  const credential = resolveSystemCredential(data.credentialId);
  if (!credential) {
    throw new Error("Selected credential is not valid for system SSH access");
  }
  validateProxyJumpConfiguration(data.proxyJumpSystemId ?? null, systemId);
  assertSystemConnectionIsUnique({
    hostname: data.hostname,
    port: data.port,
    username: credential.username,
    proxyJumpSystemId: data.proxyJumpSystemId ?? null,
    excludeSystemId: systemId,
  });
  const hostChanged =
    existing.hostname !== data.hostname || existing.port !== data.port;
  const disabledPkgManagersChanged =
    data.disabledPkgManagers !== undefined &&
    JSON.stringify(data.disabledPkgManagers) !==
      (existing.disabledPkgManagers ?? null);
  const ignoreKeptBackPackagesChanged =
    data.ignoreKeptBackPackages !== undefined &&
    (data.ignoreKeptBackPackages ? 1 : 0) !== existing.ignoreKeptBackPackages;

  const values: Record<string, unknown> = {
    name: data.name,
    hostname: data.hostname,
    port: data.port,
    credentialId: data.credentialId,
    proxyJumpSystemId: data.proxyJumpSystemId ?? null,
    authType: credential.authType,
    username: credential.username,
    hostKeyVerificationEnabled: data.hostKeyVerificationEnabled === false ? 0 : 1,
    updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
  if (data.sudoPassword) {
    values.encryptedSudoPassword = encryptor.encrypt(data.sudoPassword);
  }
  if (data.disabledPkgManagers !== undefined) {
    values.disabledPkgManagers = JSON.stringify(data.disabledPkgManagers);
  }
  if (data.ignoreKeptBackPackages !== undefined) {
    values.ignoreKeptBackPackages = data.ignoreKeptBackPackages ? 1 : 0;
  }
  if (data.excludeFromUpgradeAll !== undefined) {
    values.excludeFromUpgradeAll = data.excludeFromUpgradeAll ? 1 : 0;
  }
  if (data.hidden !== undefined) {
    values.hidden = data.hidden ? 1 : 0;
  }
  if (hostChanged) {
    values.trustedHostKey = null;
    values.trustedHostKeyAlgorithm = null;
    values.trustedHostKeyFingerprintSha256 = null;
    values.hostKeyTrustedAt = null;
  }
  if (data.hostKeyVerificationEnabled === false) {
    values.trustedHostKey = null;
    values.trustedHostKeyAlgorithm = null;
    values.trustedHostKeyFingerprintSha256 = null;
    values.hostKeyTrustedAt = null;
  } else if (data.trustedHostKeyData) {
    values.trustedHostKey = data.trustedHostKeyData.rawKey;
    values.trustedHostKeyAlgorithm = data.trustedHostKeyData.algorithm;
    values.trustedHostKeyFingerprintSha256 = data.trustedHostKeyData.fingerprintSha256;
    values.hostKeyTrustedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  }

  try {
    db.update(systems)
      .set(values as Partial<typeof systems.$inferInsert>)
      .where(eq(systems.id, systemId))
      .run();
    if (disabledPkgManagersChanged || ignoreKeptBackPackagesChanged) {
      cacheService.invalidateCache(systemId);
    }
  } catch (error) {
    if (isSystemConnectionUniqueConstraintError(error)) {
      throw new DuplicateSystemConnectionError();
    }
    throw error;
  }
}

export function deleteSystem(systemId: number): void {
  const db = getDb();
  const dependents = listSystemsUsingProxyJump(systemId);
  if (dependents.length > 0) {
    throw new ProxyJumpDependencyError(dependents);
  }
  db.delete(systems).where(eq(systems.id, systemId)).run();
}

export function reorderSystems(systemIds: number[]): void {
  const db = getDb();
  const existingSystems = db
    .select({ id: systems.id })
    .from(systems)
    .orderBy(asc(systems.sortOrder), asc(systems.name), asc(systems.id))
    .all();
  const existingIds = existingSystems.map((system) => system.id);

  if (systemIds.length !== existingIds.length) {
    throw new Error("System order must include every system exactly once");
  }
  if (new Set(systemIds).size !== systemIds.length) {
    throw new Error("System order contains duplicate IDs");
  }
  if (!existingIds.every((id) => systemIds.includes(id))) {
    throw new Error("System order contains unknown IDs");
  }

  for (const [sortOrder, id] of systemIds.entries()) {
    db.update(systems)
      .set({ sortOrder })
      .where(eq(systems.id, id))
      .run();
  }
}

export async function updateSystemInfo(
  systemId: number,
  sshManager: SSHConnectionManager,
  conn: Client
): Promise<void> {
  const previous = getSystem(systemId);
  const { stdout } = await sshManager.runCommand(
    conn,
    SYSTEM_INFO_CMD
  );
  // Don't bail on non-zero exit: individual sections may fail on minimal
  // containers (e.g. missing hostname) while the rest still provides data.
  if (!stdout.includes("===OS===")) return;

  const info = parseSystemInfo(stdout);
  const needsReboot = resolveRebootRequired(previous, info);
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
      bootId: info.bootId || previous?.bootId || null,
      needsReboot: needsReboot ? 1 : 0,
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
  const detected = await detectPackageManagers(sshManager, conn);
  const db = getDb();

  if (detected.length > 0) {
    db.update(systems)
      .set({
        pkgManager: detected[0],
        detectedPkgManagers: JSON.stringify(detected),
      })
      .where(eq(systems.id, systemId))
      .run();
  }

  return detected;
}

export function getActivePkgManagers(system: {
  detectedPkgManagers: string | null;
  disabledPkgManagers: string | null;
  pkgManager: string | null;
}): string[] {
  const detected: string[] = system.detectedPkgManagers
    ? JSON.parse(system.detectedPkgManagers)
    : system.pkgManager
      ? [system.pkgManager]
      : [];
  const disabled: string[] = system.disabledPkgManagers
    ? JSON.parse(system.disabledPkgManagers)
    : [];
  return detected.filter((m) => !disabled.includes(m));
}

/**
 * Resolve the sudo password for a system.
 * Uses the dedicated sudo password if set, otherwise falls back to the SSH password.
 */
export function getSudoPassword(system: Record<string, unknown>): string | undefined {
  const encryptor = getEncryptor();
  if (system.encryptedSudoPassword) {
    return encryptor.decrypt(system.encryptedSudoPassword as string);
  }
  if (typeof system.credentialId === "number") {
    const credential = resolveSystemCredential(system.credentialId);
    if (credential?.authType === "password" && credential.encryptedPassword) {
      return encryptor.decrypt(credential.encryptedPassword);
    }
  }
  if (system.authType === "password" && system.encryptedPassword) {
    return encryptor.decrypt(system.encryptedPassword as string);
  }
  return undefined;
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
    .select({
      count: count(),
      securityCount: sql<number>`coalesce(sum(case when ${updateCache.isSecurity} = 1 then 1 else 0 end), 0)`,
    })
    .from(updateCache)
    .where(eq(updateCache.systemId, systemId))
    .get();

  return {
    ...system,
    updateCount: result?.count ?? 0,
    securityCount: result?.securityCount ?? 0,
  };
}

export function listSystemsWithUpdateCounts() {
  const allSystems = listSystems();
  const db = getDb();

  return allSystems.map((s) => {
    const result = db
      .select({
        count: count(),
        securityCount: sql<number>`coalesce(sum(case when ${updateCache.isSecurity} = 1 then 1 else 0 end), 0)`,
      })
      .from(updateCache)
      .where(eq(updateCache.systemId, s.id))
      .get();
    return {
      ...s,
      updateCount: result?.count ?? 0,
      securityCount: result?.securityCount ?? 0,
    };
  });
}

export function listVisibleSystemsWithUpdateCounts() {
  const allSystems = listVisibleSystems();
  const db = getDb();

  return allSystems.map((s) => {
    const result = db
      .select({
        count: count(),
        securityCount: sql<number>`coalesce(sum(case when ${updateCache.isSecurity} = 1 then 1 else 0 end), 0)`,
      })
      .from(updateCache)
      .where(eq(updateCache.systemId, s.id))
      .get();
    return {
      ...s,
      updateCount: result?.count ?? 0,
      securityCount: result?.securityCount ?? 0,
    };
  });
}

function getNextSortOrder(): number {
  const db = getDb();
  const result = db
    .select({
      maxSortOrder: sql<number>`coalesce(max(${systems.sortOrder}), -1)`,
    })
    .from(systems)
    .get();

  return (result?.maxSortOrder ?? -1) + 1;
}

export function listSystemsUsingProxyJump(systemId: number): Array<{ id: number; name: string }> {
  return getDb()
    .select({ id: systems.id, name: systems.name })
    .from(systems)
    .where(eq(systems.proxyJumpSystemId, systemId))
    .all();
}

export function validateProxyJumpConfiguration(
  proxyJumpSystemId: number | null,
  systemId?: number
): void {
  if (!proxyJumpSystemId) return;

  const seen = new Set<number>();
  if (systemId) seen.add(systemId);
  let currentId: number | null = proxyJumpSystemId;
  let depth = 0;

  while (currentId) {
    if (seen.has(currentId)) {
      throw new InvalidProxyJumpConfigurationError(
        "ProxyJump configuration contains a cycle."
      );
    }
    seen.add(currentId);
    depth++;
    if (depth > MAX_PROXY_JUMP_DEPTH) {
      throw new InvalidProxyJumpConfigurationError(
        `ProxyJump chain exceeds the maximum depth of ${MAX_PROXY_JUMP_DEPTH}.`
      );
    }

    const hop = getSystem(currentId);
    if (!hop) {
      throw new InvalidProxyJumpConfigurationError(
        "Selected ProxyJump system does not exist."
      );
    }

    currentId = hop.proxyJumpSystemId ?? null;
  }
}

export function getProxyJumpChain(
  system: { proxyJumpSystemId?: number | null } | null
): Array<{ id: number; name: string }> {
  if (!system?.proxyJumpSystemId) return [];

  const chain: Array<{ id: number; name: string }> = [];
  const seen = new Set<number>();
  let currentId: number | null = system.proxyJumpSystemId;
  let depth = 0;

  while (currentId) {
    if (seen.has(currentId) || depth >= MAX_PROXY_JUMP_DEPTH) break;
    seen.add(currentId);
    const hop = getSystem(currentId);
    if (!hop) break;
    chain.push({ id: hop.id, name: hop.name });
    currentId = hop.proxyJumpSystemId ?? null;
    depth++;
  }

  return chain;
}

export function persistTrustedHostKey(
  systemId: number,
  approvedHostKey: ApprovedHostKeyInput
): void {
  getDb()
    .update(systems)
    .set({
      trustedHostKey: approvedHostKey.rawKey,
      trustedHostKeyAlgorithm: approvedHostKey.algorithm,
      trustedHostKeyFingerprintSha256: approvedHostKey.fingerprintSha256,
      hostKeyTrustedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    })
    .where(eq(systems.id, systemId))
    .run();
}

export function clearTrustedHostKey(systemId: number): void {
  getDb()
    .update(systems)
    .set({
      trustedHostKey: null,
      trustedHostKeyAlgorithm: null,
      trustedHostKeyFingerprintSha256: null,
      hostKeyTrustedAt: null,
    })
    .where(eq(systems.id, systemId))
    .run();
}
