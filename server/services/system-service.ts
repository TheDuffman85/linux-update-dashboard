import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb } from "../db";
import { settings, systems, upgradeGroups } from "../db/schema";
import { getEncryptor } from "../security";
import { resolveSystemCredential } from "./credential-service";
import * as cacheService from "./cache-service";
import * as hiddenUpdateService from "./hidden-update-service";
import type { ApprovedHostKeyInput } from "./system-connection-validation";
import type { SSHConnectionManager } from "../ssh/connection";
import type { Client } from "ssh2";
import type { PackageManagerConfigs } from "../package-manager-configs";
import {
  parsePackageManagerConfigs,
  serializePackageManagerConfigs,
} from "../package-manager-configs";
import {
  detectPackageManagersWithScripts,
  listPackageManagerDefinitions,
  parseSystemInfoWithScript,
  resolveRuntimeSteps,
  resolveScript,
} from "./script-service";

const SYSTEM_CONNECTION_UNIQUE_CONSTRAINT =
  "systems.hostname, systems.port, systems.username";
const SYSTEM_CONNECTION_UNIQUE_INDEX = "systems_connection_identity_idx";
export const MAX_PROXY_JUMP_DEPTH = 10;
const UPGRADE_UNGROUPED_SORT_ORDER_KEY = "upgrade_ungrouped_sort_order";
const DEFAULT_UNGROUPED_UPGRADE_SORT_ORDER = 1_000_000;

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

export class RebootDismissalSnapshotRequiredError extends Error {
  constructor() {
    super("Run a system check before dismissing this reboot warning.");
    this.name = "RebootDismissalSnapshotRequiredError";
  }
}

function clearRootUserBannerDismissal(values: Record<string, unknown>): void {
  values.rootUserBannerDismissed = 0;
  values.rootUserBannerDismissedHostKeyFingerprintSha256 = null;
}

function normalizeStringList(value: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string" && value.length > 0
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];

  return Array.from(new Set(raw.filter((entry): entry is string => typeof entry === "string"))).sort();
}

function normalizeStringListPreservingOrder(value: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string" && value.length > 0
      ? (() => {
          try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];

  return Array.from(new Set(raw.filter((entry): entry is string => typeof entry === "string")));
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

export function deriveConnectionHostKeyStatus(system: {
  id?: number;
  hostKeyVerificationEnabled?: number | null;
  trustedHostKey?: string | null;
  proxyJumpSystemId?: number | null;
}): "verified" | "verification_disabled" | "needs_approval" {
  const ownStatus = deriveHostKeyStatus(system);
  if (ownStatus === "needs_approval") {
    return ownStatus;
  }

  let hasVerificationDisabled = ownStatus === "verification_disabled";
  const seen = new Set<number>();
  if (typeof system.id === "number") {
    seen.add(system.id);
  }

  let currentProxyJumpId = system.proxyJumpSystemId ?? null;
  let depth = 0;

  while (currentProxyJumpId) {
    if (seen.has(currentProxyJumpId) || depth >= MAX_PROXY_JUMP_DEPTH) {
      break;
    }
    seen.add(currentProxyJumpId);
    depth++;

    const hop = getSystem(currentProxyJumpId);
    if (!hop) break;

    const hopStatus = deriveHostKeyStatus(hop);
    if (hopStatus === "needs_approval") {
      return hopStatus;
    }
    if (hopStatus === "verification_disabled") {
      hasVerificationDisabled = true;
    }

    currentProxyJumpId = hop.proxyJumpSystemId ?? null;
  }

  return hasVerificationDisabled ? "verification_disabled" : "verified";
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

export function listUpgradeGroups() {
  return getDb()
    .select()
    .from(upgradeGroups)
    .orderBy(asc(upgradeGroups.sortOrder), asc(upgradeGroups.name), asc(upgradeGroups.id))
    .all();
}

function getStoredUngroupedUpgradeGroupSortOrder(): number | null {
  const value = getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, UPGRADE_UNGROUPED_SORT_ORDER_KEY))
    .get()?.value;
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

export function getUngroupedUpgradeGroupSortOrder(): number {
  return getStoredUngroupedUpgradeGroupSortOrder() ?? DEFAULT_UNGROUPED_UPGRADE_SORT_ORDER;
}

function setUngroupedUpgradeGroupSortOrder(sortOrder: number): void {
  getDb()
    .insert(settings)
    .values({
      key: UPGRADE_UNGROUPED_SORT_ORDER_KEY,
      value: String(sortOrder),
      description: "Sort position of the implicit Ungrouped upgrade group",
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: String(sortOrder),
        updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      },
    })
    .run();
}

export function createUpgradeGroup(name: string): number {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 100) {
    throw new Error("Group name is required (max 100 chars)");
  }
  const storedUngroupedSortOrder = getStoredUngroupedUpgradeGroupSortOrder();
  const minRealGroupSortOrder = getDb()
    .select({ value: sql<number>`MIN(${upgradeGroups.sortOrder})` })
    .from(upgradeGroups)
    .get()?.value;
  const firstSortOrder = Math.min(
    storedUngroupedSortOrder ?? DEFAULT_UNGROUPED_UPGRADE_SORT_ORDER,
    minRealGroupSortOrder ?? DEFAULT_UNGROUPED_UPGRADE_SORT_ORDER,
  );
  const inserted = getDb()
    .insert(upgradeGroups)
    .values({
      name: trimmedName,
      sortOrder: firstSortOrder - 1,
    })
    .returning({ id: upgradeGroups.id })
    .get();
  return inserted.id;
}

export function updateUpgradeGroup(groupId: number, name: string): void {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 100) {
    throw new Error("Group name is required (max 100 chars)");
  }
  const result = getDb()
    .update(upgradeGroups)
    .set({
      name: trimmedName,
      updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    })
    .where(eq(upgradeGroups.id, groupId))
    .run();
  if (result.changes === 0) throw new Error("Upgrade group not found");
}

export function deleteUpgradeGroup(groupId: number): void {
  const db = getDb();
  const existing = db
    .select({ id: upgradeGroups.id })
    .from(upgradeGroups)
    .where(eq(upgradeGroups.id, groupId))
    .get();
  if (!existing) throw new Error("Upgrade group not found");
  db.update(systems)
    .set({
      upgradeGroupId: null,
      updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    })
    .where(eq(systems.upgradeGroupId, groupId))
    .run();
  db.delete(upgradeGroups).where(eq(upgradeGroups.id, groupId)).run();
}

export function reorderUpgradeGroups(groupKeys: Array<number | "ungrouped">): void {
  const existingIds = listUpgradeGroups().map((group) => group.id);
  const ungroupedCount = groupKeys.filter((key) => key === "ungrouped").length;
  const groupIds = groupKeys.filter((key): key is number => typeof key === "number");
  if (ungroupedCount !== 1) {
    throw new Error("Group order must include Ungrouped exactly once");
  }
  if (groupIds.length !== existingIds.length) {
    throw new Error("Group order must include every saved group exactly once");
  }
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error("Group order contains duplicate IDs");
  }
  if (!existingIds.every((id) => groupIds.includes(id))) {
    throw new Error("Group order contains unknown IDs");
  }
  for (const [sortOrder, key] of groupKeys.entries()) {
    if (key === "ungrouped") {
      setUngroupedUpgradeGroupSortOrder(sortOrder);
    } else {
      getDb()
        .update(upgradeGroups)
        .set({ sortOrder, updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19) })
        .where(eq(upgradeGroups.id, key))
        .run();
    }
  }
}

export function isSystemVisible(systemId: number): boolean {
  const row = getDb()
    .select({ hidden: systems.hidden })
    .from(systems)
    .where(eq(systems.id, systemId))
    .get();

  return !!row && row.hidden === 0;
}

export function filterVisibleSystemIds(systemIds: number[]): number[] {
  const uniqueIds = Array.from(
    new Set(systemIds.filter((systemId) => Number.isInteger(systemId) && systemId > 0)),
  );
  if (uniqueIds.length === 0) return [];

  return getDb()
    .select({ id: systems.id })
    .from(systems)
    .where(
      and(
        inArray(systems.id, uniqueIds),
        eq(systems.hidden, 0),
      ),
    )
    .all()
    .map((row) => row.id);
}

export function filterVisibleSystemItems<T extends { systemId: number }>(items: T[]): T[] {
  if (items.length === 0) return [];

  const visibleIds = new Set(filterVisibleSystemIds(items.map((item) => item.systemId)));
  return items.filter((item) => visibleIds.has(item.systemId));
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
  detectedPkgManagers?: string[];
  pkgManagerConfigs?: PackageManagerConfigs | null;
  autoHideKeptBackUpdates?: boolean;
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
  if (data.detectedPkgManagers !== undefined) {
    const detectedPkgManagers = normalizeStringListPreservingOrder(data.detectedPkgManagers);
    values.detectedPkgManagers = JSON.stringify(detectedPkgManagers);
    values.pkgManager = detectedPkgManagers[0] ?? null;
  }
  if (data.pkgManagerConfigs !== undefined) {
    values.pkgManagerConfigs = serializePackageManagerConfigs(data.pkgManagerConfigs, listPackageManagerDefinitions());
  }
  if (data.autoHideKeptBackUpdates !== undefined) {
    values.autoHideKeptBackUpdates = data.autoHideKeptBackUpdates ? 1 : 0;
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
    detectedPkgManagers?: string[];
    pkgManagerConfigs?: PackageManagerConfigs | null;
    autoHideKeptBackUpdates?: boolean;
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
    JSON.stringify(normalizeStringList(data.disabledPkgManagers)) !==
      JSON.stringify(normalizeStringList(existing.disabledPkgManagers));
  const detectedPkgManagersChanged =
    data.detectedPkgManagers !== undefined &&
    JSON.stringify(normalizeStringList(data.detectedPkgManagers)) !==
      JSON.stringify(normalizeStringList(existing.detectedPkgManagers));

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
  if (data.detectedPkgManagers !== undefined) {
    const detectedPkgManagers = normalizeStringListPreservingOrder(data.detectedPkgManagers);
    values.detectedPkgManagers = JSON.stringify(detectedPkgManagers);
    values.pkgManager = detectedPkgManagers[0] ?? null;
  }
  if (data.pkgManagerConfigs !== undefined) {
    values.pkgManagerConfigs = serializePackageManagerConfigs(data.pkgManagerConfigs, listPackageManagerDefinitions());
  }
  if (data.autoHideKeptBackUpdates !== undefined) {
    values.autoHideKeptBackUpdates = data.autoHideKeptBackUpdates ? 1 : 0;
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
    clearRootUserBannerDismissal(values);
  }
  if (data.hostKeyVerificationEnabled === false) {
    values.trustedHostKey = null;
    values.trustedHostKeyAlgorithm = null;
    values.trustedHostKeyFingerprintSha256 = null;
    values.hostKeyTrustedAt = null;
    clearRootUserBannerDismissal(values);
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
    if (disabledPkgManagersChanged || detectedPkgManagersChanged) {
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

export function dismissNeedsReboot(systemId: number): void {
  const db = getDb();
  const existing = getSystem(systemId);
  if (!existing) throw new Error("System not found");

  const bootId = existing.bootId?.trim() || "";
  const uptimeSeconds = existing.uptimeSeconds ?? null;
  if (!bootId && uptimeSeconds == null) {
    throw new RebootDismissalSnapshotRequiredError();
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  db.update(systems)
    .set({
      needsReboot: 0,
      rebootDismissedBootId: bootId || null,
      rebootDismissedUptimeSeconds: uptimeSeconds,
      rebootDismissedAt: now,
      updatedAt: now,
    })
    .where(eq(systems.id, systemId))
    .run();
}

export function dismissRootUserBanner(systemId: number): void {
  const db = getDb();
  const existing = getSystem(systemId);
  if (!existing) throw new Error("System not found");

  db.update(systems)
    .set({
      rootUserBannerDismissed: 1,
      rootUserBannerDismissedHostKeyFingerprintSha256:
        existing.trustedHostKeyFingerprintSha256 ?? null,
      updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    })
    .where(eq(systems.id, systemId))
    .run();
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

export function reorderSystemUpgradeOrder(systemIds: number[]): void {
  const db = getDb();
  const uniqueIds = Array.from(new Set(systemIds));

  if (uniqueIds.length !== systemIds.length) {
    throw new Error("Upgrade order contains duplicate IDs");
  }
  if (systemIds.length === 0) {
    throw new Error("Upgrade order must include at least one system");
  }

  const existingIds = new Set(
    db
      .select({ id: systems.id })
      .from(systems)
      .where(inArray(systems.id, systemIds))
      .all()
      .map((system) => system.id)
  );
  if (!systemIds.every((id) => existingIds.has(id))) {
    throw new Error("Upgrade order contains unknown IDs");
  }

  for (const [index, id] of systemIds.entries()) {
    db.update(systems)
      .set({ upgradeOrder: index + 1 })
      .where(eq(systems.id, id))
      .run();
  }
}

export function moveSystemsForUpgradeGroups(
  items: Array<{ systemId: number; groupId: number | null; upgradeOrder: number }>
): void {
  if (items.length === 0) throw new Error("At least one system is required");
  const systemIds = items.map((item) => item.systemId);
  if (new Set(systemIds).size !== systemIds.length) {
    throw new Error("System list contains duplicate IDs");
  }
  if (items.some((item) => !Number.isInteger(item.systemId) || item.systemId <= 0)) {
    throw new Error("System IDs must be positive integers");
  }
  if (items.some((item) => item.groupId !== null && (!Number.isInteger(item.groupId) || item.groupId <= 0))) {
    throw new Error("Group IDs must be positive integers or null");
  }
  if (items.some((item) => !Number.isInteger(item.upgradeOrder) || item.upgradeOrder <= 0)) {
    throw new Error("Upgrade order values must be positive integers");
  }

  const db = getDb();
  const existingSystemIds = new Set(
    db
      .select({ id: systems.id })
      .from(systems)
      .where(inArray(systems.id, systemIds))
      .all()
      .map((system) => system.id)
  );
  if (!systemIds.every((id) => existingSystemIds.has(id))) {
    throw new Error("System list contains unknown IDs");
  }

  const groupIds = Array.from(new Set(items.map((item) => item.groupId).filter((id): id is number => id !== null)));
  if (groupIds.length > 0) {
    const existingGroupIds = new Set(
      db
        .select({ id: upgradeGroups.id })
        .from(upgradeGroups)
        .where(inArray(upgradeGroups.id, groupIds))
        .all()
        .map((group) => group.id)
    );
    if (!groupIds.every((id) => existingGroupIds.has(id))) {
      throw new Error("System list contains unknown group IDs");
    }
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  for (const item of items) {
    db.update(systems)
      .set({
        upgradeGroupId: item.groupId,
        upgradeOrder: item.upgradeOrder,
        updatedAt: now,
      })
      .where(eq(systems.id, item.systemId))
      .run();
  }
}

export function updateSystemUpgradeMode(systemId: number, fullUpgrade: boolean): void {
  const db = getDb();
  const system = getSystem(systemId);
  if (!system) throw new Error("System not found");

  const activeManagers = getActivePkgManagers(system);
  const supportsUpgradeMode =
    activeManagers.includes("apt") || activeManagers.includes("dnf");
  if (!supportsUpgradeMode) {
    throw new Error("Upgrade mode is only supported for APT and DNF systems");
  }

  const configs = parsePackageManagerConfigs(
    system.pkgManagerConfigs,
    listPackageManagerDefinitions(),
  ) ?? {};

  if (activeManagers.includes("apt")) {
    configs.apt = {
      ...(configs.apt ?? {}),
      defaultUpgradeMode: fullUpgrade ? "full-upgrade" : "upgrade",
    };
  }
  if (activeManagers.includes("dnf")) {
    configs.dnf = {
      ...(configs.dnf ?? {}),
      defaultUpgradeMode: fullUpgrade ? "distro-sync" : "upgrade",
    };
  }

  db.update(systems)
    .set({
      pkgManagerConfigs: serializePackageManagerConfigs(
        configs,
        listPackageManagerDefinitions(),
      ),
      updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    })
    .where(eq(systems.id, systemId))
    .run();
}

export function updateSystemUpgradeAllExclusion(systemId: number, excluded: boolean): void {
  const system = getSystem(systemId);
  if (!system) throw new Error("System not found");

  getDb().update(systems)
    .set({
      excludeFromUpgradeAll: excluded ? 1 : 0,
      updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    })
    .where(eq(systems.id, systemId))
    .run();
}

export async function updateSystemInfo(
  systemId: number,
  sshManager: SSHConnectionManager,
  conn: Client
): Promise<void> {
  const previous = getSystem(systemId);
  const script = resolveScript(systemId, "system_info", null);
  const steps = resolveRuntimeSteps({ systemId, operation: "system_info" });
  const sudoPassword = previous ? getSudoPassword(previous as Record<string, unknown>) : undefined;
  let stdout = "";
  for (const step of steps) {
    const result = await sshManager.runCommand(conn, step.command, undefined, sudoPassword);
    stdout += `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}\n`;
  }
  // Don't bail on non-zero exit: individual sections may fail on minimal
  // containers (e.g. missing hostname) while the rest still provides data.
  const parsed = parseSystemInfoWithScript(stdout, script, previous);
  if (!parsed) return;

  const { info } = parsed;
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const db = getDb();

  db.update(systems)
    .set({
      osName: info.osName,
      osVersion: info.osVersion,
      kernel: info.kernel,
      hostnameRemote: info.hostname,
      uptime: info.uptime,
      uptimeSeconds: info.uptimeSeconds,
      arch: info.arch,
      cpuCores: info.cpuCores,
      memory: info.memory,
      disk: info.disk,
      bootId: info.bootId || previous?.bootId || null,
      needsReboot: parsed.needsReboot ? 1 : 0,
      rebootDismissedBootId: parsed.dismissalExpired
        ? null
        : previous?.rebootDismissedBootId ?? null,
      rebootDismissedUptimeSeconds: parsed.dismissalExpired
        ? null
        : previous?.rebootDismissedUptimeSeconds ?? null,
      rebootDismissedAt: parsed.dismissalExpired
        ? null
        : previous?.rebootDismissedAt ?? null,
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
  const detected = await detectPackageManagersWithScripts(systemId, sshManager, conn);
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

  const result = hiddenUpdateService.getVisibleUpdateSummary(systemId);

  return {
    ...system,
    updateCount: result.updateCount,
    securityCount: result.securityCount,
    keptBackCount: result.keptBackCount,
  };
}

export function listSystemsWithUpdateCounts() {
  const allSystems = listSystems();
  const summaries = hiddenUpdateService.getVisibleUpdateSummaries(
    allSystems.map((system) => system.id),
  );

  return allSystems.map((s) => {
    const result = summaries.get(s.id) ?? {
      updateCount: 0,
      securityCount: 0,
      keptBackCount: 0,
    };
    return {
      ...s,
      updateCount: result.updateCount,
      securityCount: result.securityCount,
      keptBackCount: result.keptBackCount,
    };
  });
}

export function listVisibleSystemsWithUpdateCounts() {
  const allSystems = listVisibleSystems();
  const summaries = hiddenUpdateService.getVisibleUpdateSummaries(
    allSystems.map((system) => system.id),
  );

  return allSystems.map((s) => {
    const result = summaries.get(s.id) ?? {
      updateCount: 0,
      securityCount: 0,
      keptBackCount: 0,
    };
    return {
      ...s,
      updateCount: result.updateCount,
      securityCount: result.securityCount,
      keptBackCount: result.keptBackCount,
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
      rootUserBannerDismissed: 0,
      rootUserBannerDismissedHostKeyFingerprintSha256: null,
    })
    .where(eq(systems.id, systemId))
    .run();
}
