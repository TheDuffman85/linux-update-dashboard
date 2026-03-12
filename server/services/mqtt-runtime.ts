import { createHash } from "crypto";
import type { MqttClient } from "mqtt";
import { asc, eq } from "drizzle-orm";
import { notifications, systems, updateCache } from "../db/schema";
import { getDb } from "../db";
import { logger } from "../logger";
import {
  buildEntityBaseTopic,
  buildHomeAssistantDiscoveryTopic,
  buildMqttConnectionOptions,
  sanitizeMqttConfig,
  type MqttConfig,
  type MqttPublishMessage,
} from "./notifications/mqtt-shared";
import {
  createMqttClient,
  endMqttClient,
  publishMqttMessages,
  subscribeMqttTopics,
  unsubscribeMqttTopics,
  waitForMqttConnect,
} from "./mqtt-client";
import { getActiveOperation } from "./active-operation-store";
import { getAppUpdateStatus } from "./app-update-service";
import * as updateService from "./update-service";
import * as systemService from "./system-service";

type NotificationRow = typeof notifications.$inferSelect;
type SystemRow = typeof systems.$inferSelect;

interface DiscoveryEntity {
  componentId: string;
  discoveryTopic: string;
  discoveryPayload: Record<string, unknown>;
  stateTopic: string;
  statePayload: string;
  availabilityTopic: string;
  availabilityPayload: "online" | "offline";
  commandTopic?: string;
}

interface RuntimeRecord {
  channelId: number;
  fingerprint: string;
  config: MqttConfig;
  client: MqttClient;
  publishedDiscoveryTopics: Set<string>;
  subscribedCommandTopics: Set<string>;
  commandTopicMap: Map<string, number>;
  taskChain: Promise<void>;
  connected: boolean;
}

const runtimeRecords = new Map<number, RuntimeRecord>();
let started = false;
let commandExecutor: typeof updateService.applyUpgradeAll = (systemId) => updateService.applyUpgradeAll(systemId);

function parseConfigJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseNotifyOn(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseSystemIds(raw: string | null): number[] | null {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)
      : null;
  } catch {
    return null;
  }
}

function shouldRunRuntime(row: NotificationRow): boolean {
  if (row.type !== "mqtt" || row.enabled !== 1) return false;
  const config = sanitizeMqttConfig(parseConfigJson(row.config));
  return config.homeAssistantEnabled;
}

function buildFingerprint(row: NotificationRow): string {
  return JSON.stringify({
    id: row.id,
    enabled: row.enabled,
    name: row.name,
    notifyOn: row.notifyOn,
    systemIds: row.systemIds,
    schedule: row.schedule,
    config: sanitizeMqttConfig(parseConfigJson(row.config)),
  });
}

function availabilityForSystem(system: SystemRow): "online" | "offline" {
  return system.isReachable === 1 ? "online" : "offline";
}

function isMutatingOperation(type: string | undefined): boolean {
  return type === "upgrade_all" || type === "full_upgrade_all" || type === "upgrade_package";
}

function buildSystemReleaseSummary(
  updateCount: number,
  securityCount: number,
  packageNames: string[],
): string {
  if (updateCount === 0) return "System up to date";

  let summary = `${updateCount} update${updateCount === 1 ? "" : "s"}`;
  if (securityCount > 0) {
    summary += `, ${securityCount} security`;
  }
  if (packageNames.length > 0) {
    summary += `: ${packageNames.join(", ")}`;
  }
  return summary;
}

function buildSyntheticUpdateFingerprintVersion(
  updates: Array<{ packageName: string; isSecurity: number; newVersion?: string | null }>,
): string {
  if (updates.length === 0) return "current";

  const raw = updates
    .map((entry) => `${entry.packageName}:${entry.newVersion || ""}:${entry.isSecurity}`)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
  const hash = createHash("sha256").update(raw).digest("hex");
  return `pending-${hash.slice(0, 12)}`;
}

function buildAppEntity(
  row: NotificationRow,
  config: MqttConfig,
  status: Awaited<ReturnType<typeof getAppUpdateStatus>>,
): DiscoveryEntity {
  const componentId = "app_update";
  const topicBase = buildEntityBaseTopic(config, row.id, componentId);
  const installedVersion = status.currentVersion || "unknown";
  const latestVersion = status.remoteVersion || installedVersion;
  const releaseSummary = status.updateAvailable
    ? `Linux Update Dashboard: ${installedVersion} -> ${latestVersion}`
    : "Linux Update Dashboard is up to date";

  return {
    componentId,
    discoveryTopic: buildHomeAssistantDiscoveryTopic(config, row.id, componentId),
    discoveryPayload: {
      device: {
        identifiers: [`ludash_channel_${row.id}`],
        name: row.name || "Linux Update Dashboard",
        manufacturer: "Linux Update Dashboard",
        model: "MQTT Update Channel",
      },
      origin: {
        name: "linux-update-dashboard",
        url: "https://github.com/TheDuffman85/linux-update-dashboard",
      },
      unique_id: `ludash_${row.id}_${componentId}`,
      name: "Linux Update Dashboard Update",
      default_entity_id: `update.ludash_${row.id}_${componentId}`,
      state_topic: `${topicBase}/state`,
      availability_topic: `${topicBase}/availability`,
      payload_available: "online",
      payload_not_available: "offline",
      qos: config.qos,
      device_class: "firmware",
    },
    stateTopic: `${topicBase}/state`,
    statePayload: JSON.stringify({
      installed_version: installedVersion,
      latest_version: latestVersion,
      title: "Linux Update Dashboard",
      release_summary: releaseSummary,
      ...(status.releaseUrl || status.repoUrl
        ? { release_url: status.releaseUrl || status.repoUrl }
        : {}),
      in_progress: false,
    }),
    availabilityTopic: `${topicBase}/availability`,
    availabilityPayload: "online",
  };
}

function buildSystemEntity(
  row: NotificationRow,
  config: MqttConfig,
  system: SystemRow,
  updates: Array<{ packageName: string; isSecurity: number; newVersion?: string | null }>,
): DiscoveryEntity {
  const componentId = `system_${system.id}`;
  const topicBase = buildEntityBaseTopic(config, row.id, componentId);
  const updateCount = updates.length;
  const securityCount = updates.filter((entry) => entry.isSecurity === 1).length;
  const packageNames = updates
    .map((entry) => entry.packageName)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 3);
  const activeOperation = getActiveOperation(system.id);

  return {
    componentId,
    discoveryTopic: buildHomeAssistantDiscoveryTopic(config, row.id, componentId),
    discoveryPayload: {
      device: {
        identifiers: [`ludash_channel_${row.id}`],
        name: row.name || "Linux Update Dashboard",
        manufacturer: "Linux Update Dashboard",
        model: "MQTT Update Channel",
      },
      origin: {
        name: "linux-update-dashboard",
        url: "https://github.com/TheDuffman85/linux-update-dashboard",
      },
      unique_id: `ludash_${row.id}_${componentId}`,
      name: `${system.name} Package updates`,
      default_entity_id: `update.ludash_${row.id}_${componentId}`,
      state_topic: `${topicBase}/state`,
      availability_topic: `${topicBase}/availability`,
      payload_available: "online",
      payload_not_available: "offline",
      qos: config.qos,
      device_class: "firmware",
      ...(config.commandsEnabled
        ? {
            command_topic: `${topicBase}/command`,
            payload_install: config.payloadInstall,
          }
        : {}),
    },
    stateTopic: `${topicBase}/state`,
    statePayload: JSON.stringify({
      installed_version: "current",
      latest_version: buildSyntheticUpdateFingerprintVersion(updates),
      title: "Package updates",
      release_summary: buildSystemReleaseSummary(updateCount, securityCount, packageNames),
      in_progress: isMutatingOperation(activeOperation?.type),
    }),
    availabilityTopic: `${topicBase}/availability`,
    availabilityPayload: availabilityForSystem(system),
    commandTopic: config.commandsEnabled ? `${topicBase}/command` : undefined,
  };
}

async function buildEntitiesForChannel(
  row: NotificationRow,
  config: MqttConfig,
): Promise<DiscoveryEntity[]> {
  if (!config.homeAssistantEnabled) return [];

  const db = getDb();
  const notifyOn = parseNotifyOn(row.notifyOn);
  const scopedSystemIds = parseSystemIds(row.systemIds);
  const allSystems = systemService.listVisibleSystems();
  const selectedSystems = scopedSystemIds === null
    ? allSystems
    : allSystems.filter((system) => scopedSystemIds.includes(system.id));

  const entities: DiscoveryEntity[] = [];

  if (config.publishAppEntity && notifyOn.includes("appUpdates")) {
    entities.push(buildAppEntity(row, config, await getAppUpdateStatus()));
  }

  if (notifyOn.includes("updates") || notifyOn.includes("unreachable")) {
    for (const system of selectedSystems) {
      const updates = db
        .select({
          packageName: updateCache.packageName,
          isSecurity: updateCache.isSecurity,
          newVersion: updateCache.newVersion,
        })
        .from(updateCache)
        .where(eq(updateCache.systemId, system.id))
        .all();
      entities.push(buildSystemEntity(row, config, system, updates));
    }
  }

  return entities;
}

async function publishRemovalMessages(record: RuntimeRecord, topics: string[]): Promise<void> {
  if (topics.length === 0) return;

  if (!record.connected) {
    const tempClient = createMqttClient(
      record.config.brokerUrl,
      buildMqttConnectionOptions(record.config),
    );
    try {
      await waitForMqttConnect(tempClient);
      await publishMqttMessages(
        tempClient,
        topics.map((topic) => ({ topic, payload: "", retain: true, qos: record.config.qos })),
      );
    } finally {
      await endMqttClient(tempClient, true).catch(() => {});
    }
    return;
  }

  await publishMqttMessages(
    record.client,
    topics.map((topic) => ({ topic, payload: "", retain: true, qos: record.config.qos })),
  );
}

function buildDeviceDiscoveryTopic(config: MqttConfig, channelId: number): string {
  return `${config.discoveryPrefix}/device/ludash_${channelId}/config`;
}

async function syncRecord(record: RuntimeRecord): Promise<void> {
  const row = getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.id, record.channelId))
    .get();

  if (!row || !shouldRunRuntime(row)) {
    await stopRecord(record.channelId, true).catch((error) => {
      logger.warn("Failed to stop MQTT runtime record", {
        channelId: record.channelId,
        error: String(error),
      });
    });
    return;
  }

  if (!record.connected) return;

  const config = sanitizeMqttConfig(parseConfigJson(row.config));
  record.config = config;

  const entities = await buildEntitiesForChannel(row, config);
  const nextDiscoveryTopics = new Set(entities.map((entity) => entity.discoveryTopic));
  const topicsToRemove = new Set<string>([
    ...[...record.publishedDiscoveryTopics].filter((topic) => !nextDiscoveryTopics.has(topic)),
    buildDeviceDiscoveryTopic(config, row.id),
  ]);

  await publishRemovalMessages(record, [...topicsToRemove]);

  const nextCommandTopics = new Set<string>();
  const nextCommandMap = new Map<string, number>();
  const messages: MqttPublishMessage[] = [];

  for (const entity of entities) {
    if (entity.commandTopic) {
      nextCommandTopics.add(entity.commandTopic);
      const match = entity.componentId.match(/^system_(\d+)$/);
      if (match) {
        nextCommandMap.set(entity.commandTopic, Number(match[1]));
      }
    }
    messages.push({
      topic: entity.discoveryTopic,
      payload: JSON.stringify(entity.discoveryPayload),
      retain: true,
      qos: config.qos,
    });
    messages.push({
      topic: entity.stateTopic,
      payload: entity.statePayload,
      retain: true,
      qos: config.qos,
    });
    messages.push({
      topic: entity.availabilityTopic,
      payload: entity.availabilityPayload,
      retain: true,
      qos: config.qos,
    });
  }

  const removedCommandTopics = [...record.subscribedCommandTopics].filter((topic) => !nextCommandTopics.has(topic));
  const addedCommandTopics = [...nextCommandTopics].filter((topic) => !record.subscribedCommandTopics.has(topic));

  if (removedCommandTopics.length > 0) {
    await unsubscribeMqttTopics(record.client, removedCommandTopics).catch((error) => {
      logger.warn("Failed to unsubscribe MQTT command topics", {
        channelId: record.channelId,
        error: String(error),
      });
    });
  }
  if (addedCommandTopics.length > 0) {
    await subscribeMqttTopics(record.client, addedCommandTopics, config.qos);
  }

  await publishMqttMessages(record.client, messages);

  record.publishedDiscoveryTopics = nextDiscoveryTopics;
  record.subscribedCommandTopics = nextCommandTopics;
  record.commandTopicMap = nextCommandMap;
}

function queueRecordSync(record: RuntimeRecord): Promise<void> {
  record.taskChain = record.taskChain
    .catch(() => {})
    .then(() => syncRecord(record))
    .catch((error) => {
      logger.warn("MQTT runtime sync failed", {
        channelId: record.channelId,
        error: String(error),
      });
    });
  return record.taskChain;
}

function attachRecordHandlers(record: RuntimeRecord): void {
  record.client.on("connect", () => {
    record.connected = true;
    void queueRecordSync(record);
  });

  record.client.on("close", () => {
    record.connected = false;
  });

  record.client.on("error", (error) => {
    logger.warn("MQTT runtime client error", {
      channelId: record.channelId,
      error: String(error),
    });
  });

  record.client.on("message", (topic, payload) => {
    const systemId = record.commandTopicMap.get(topic);
    if (!systemId) return;
    void handleInstallCommand(record.channelId, record.config, systemId, payload.toString());
  });
}

async function createRecord(row: NotificationRow): Promise<RuntimeRecord> {
  const config = sanitizeMqttConfig(parseConfigJson(row.config));
  const client = createMqttClient(
    config.brokerUrl,
    buildMqttConnectionOptions(config),
  );
  const record: RuntimeRecord = {
    channelId: row.id,
    fingerprint: buildFingerprint(row),
    config,
    client,
    publishedDiscoveryTopics: new Set(),
    subscribedCommandTopics: new Set(),
    commandTopicMap: new Map(),
    taskChain: Promise.resolve(),
    connected: client.connected,
  };
  attachRecordHandlers(record);
  runtimeRecords.set(row.id, record);
  await waitForMqttConnect(client).catch((error) => {
    logger.warn("Initial MQTT runtime connect failed", {
      channelId: row.id,
      error: String(error),
    });
  });
  return record;
}

async function stopRecord(channelId: number, clearDiscovery: boolean): Promise<void> {
  const record = runtimeRecords.get(channelId);
  if (!record) return;
  runtimeRecords.delete(channelId);

  if (clearDiscovery) {
    const topicsToClear = new Set<string>([
      ...record.publishedDiscoveryTopics,
      buildDeviceDiscoveryTopic(record.config, channelId),
    ]);
    await publishRemovalMessages(record, [...topicsToClear]).catch((error) => {
      logger.warn("Failed to clear MQTT discovery topics", {
        channelId,
        error: String(error),
      });
    });
  }

  await endMqttClient(record.client, true).catch((error) => {
    logger.warn("Failed to close MQTT runtime client", {
      channelId,
      error: String(error),
    });
  });
}

async function handleInstallCommand(
  channelId: number,
  config: MqttConfig,
  systemId: number,
  payload: string,
): Promise<void> {
  if (payload !== config.payloadInstall) {
    return;
  }

  const db = getDb();
  const row = db.select().from(notifications).where(eq(notifications.id, channelId)).get();
  if (!row || !shouldRunRuntime(row)) {
    logger.warn("Ignoring MQTT install command for unavailable channel", { channelId, systemId });
    return;
  }

  const currentConfig = sanitizeMqttConfig(parseConfigJson(row.config));
  if (!currentConfig.commandsEnabled || !currentConfig.homeAssistantEnabled) {
    logger.warn("Ignoring MQTT install command because commands are disabled", { channelId, systemId });
    return;
  }

  const scopedSystemIds = parseSystemIds(row.systemIds);
  if (scopedSystemIds !== null && !scopedSystemIds.includes(systemId)) {
    logger.warn("Ignoring MQTT install command for out-of-scope system", { channelId, systemId });
    return;
  }

  const system = db.select().from(systems).where(eq(systems.id, systemId)).get();
  if (!system) {
    logger.warn("Ignoring MQTT install command for missing system", { channelId, systemId });
    return;
  }
  if (!systemService.isSystemVisible(systemId)) {
    logger.warn("Ignoring MQTT install command for hidden system", { channelId, systemId });
    return;
  }

  if (isMutatingOperation(getActiveOperation(systemId)?.type)) {
    logger.warn("Ignoring MQTT install command for busy system", { channelId, systemId });
    return;
  }

  logger.info("Executing MQTT install command", { channelId, systemId });
  const result = await commandExecutor(systemId);
  logger.info("Finished MQTT install command", {
    channelId,
    systemId,
    success: result.success,
    warning: result.warning === true,
  });
}

async function syncAllChannels(): Promise<void> {
  if (!started) return;

  const rows = getDb()
    .select()
    .from(notifications)
    .where(eq(notifications.type, "mqtt"))
    .all();
  const activeIds = new Set<number>();

  for (const row of rows) {
    const shouldRun = shouldRunRuntime(row);
    const fingerprint = buildFingerprint(row);
    const existing = runtimeRecords.get(row.id);

    if (!shouldRun) {
      if (existing) {
        await stopRecord(row.id, true);
      }
      continue;
    }

    activeIds.add(row.id);

    if (existing && existing.fingerprint === fingerprint) {
      void queueRecordSync(existing);
      continue;
    }

    if (existing) {
      await stopRecord(row.id, true);
    }

    const record = await createRecord(row);
    record.fingerprint = fingerprint;
    void queueRecordSync(record);
  }

  for (const [channelId] of runtimeRecords) {
    if (!activeIds.has(channelId)) {
      await stopRecord(channelId, true);
    }
  }
}

export async function start(): Promise<void> {
  started = true;
  await syncAllChannels();
}

export async function stop(): Promise<void> {
  started = false;
  const ids = [...runtimeRecords.keys()];
  for (const channelId of ids) {
    await stopRecord(channelId, false);
  }
}

export async function reconcileNotificationChange(
  previousRow: NotificationRow | null,
  currentRow: NotificationRow | null,
): Promise<void> {
  if (!started) return;

  const previousWasMqtt = previousRow?.type === "mqtt";
  const currentIsMqtt = currentRow?.type === "mqtt";
  if (!previousWasMqtt && !currentIsMqtt) return;
  await syncAllChannels();
}

export async function syncSystemState(_systemId?: number): Promise<void> {
  if (!started) return;
  await Promise.all([...runtimeRecords.values()].map((record) => queueRecordSync(record)));
}

export async function syncAppUpdateState(): Promise<void> {
  if (!started) return;
  await Promise.all([...runtimeRecords.values()].map((record) => queueRecordSync(record)));
}

export const __testing = {
  reset() {
    started = false;
    runtimeRecords.clear();
    commandExecutor = (systemId) => updateService.applyUpgradeAll(systemId);
  },
  setCommandExecutor(executor: typeof updateService.applyUpgradeAll) {
    commandExecutor = executor;
  },
  getRuntimeRecords() {
    return runtimeRecords;
  },
};
