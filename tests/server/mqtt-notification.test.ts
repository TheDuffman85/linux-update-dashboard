import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../../server/db";
import { notifications, systems, updateCache } from "../../server/db/schema";
import { initEncryptor } from "../../server/security";
import notificationsRoutes from "../../server/routes/notifications";
import { __testing as mqttClientTesting } from "../../server/services/mqtt-client";
import * as notificationRuntime from "../../server/services/notification-runtime";
import { __testing as mqttRuntimeTesting } from "../../server/services/mqtt-runtime";
import { resetAppUpdateStatusCache } from "../../server/services/app-update-service";
import { testNotification } from "../../server/services/notification-service";

class FakeMqttClient extends EventEmitter {
  connected = false;
  publishes: Array<{ topic: string; payload: string; options: { qos: number; retain: boolean } }> = [];
  subscriptions: Array<{ topics: string[]; qos: number }> = [];
  unsubscriptions: string[] = [];

  constructor(public brokerUrl: string, public options: Record<string, unknown>) {
    super();
    queueMicrotask(() => {
      this.connected = true;
      this.emit("connect");
    });
  }

  publish(
    topic: string,
    payload: string | Buffer,
    options: { qos?: number; retain?: boolean },
    callback?: (error?: Error | null) => void,
  ) {
    this.publishes.push({
      topic,
      payload: typeof payload === "string" ? payload : payload.toString(),
      options: {
        qos: options.qos ?? 0,
        retain: options.retain === true,
      },
    });
    callback?.(null);
    return true;
  }

  subscribe(
    topics: string[] | string,
    options: { qos?: number },
    callback?: (error?: Error | null) => void,
  ) {
    const values = Array.isArray(topics) ? topics : [topics];
    this.subscriptions.push({ topics: values, qos: options.qos ?? 0 });
    callback?.(null);
    return this;
  }

  unsubscribe(topics: string[] | string, callback?: (error?: Error | null) => void) {
    const values = Array.isArray(topics) ? topics : [topics];
    this.unsubscriptions.push(...values);
    callback?.(null);
    return this;
  }

  end(_force?: boolean, _options?: Record<string, unknown>, callback?: () => void) {
    this.connected = false;
    callback?.();
    return this;
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mqtt notifications", () => {
  let tempDir: string;
  let app: Hono;
  let clients: FakeMqttClient[];
  let envSnapshot: NodeJS.ProcessEnv;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ludash-mqtt-test-"));
    initDatabase(join(tempDir, "dashboard.db"));
    initEncryptor(randomBytes(32).toString("base64"));
    resetAppUpdateStatusCache();
    envSnapshot = { ...process.env };

    app = new Hono();
    app.route("/api/notifications", notificationsRoutes);

    clients = [];
    mqttClientTesting.setConnectFactory((brokerUrl, options) => {
      const client = new FakeMqttClient(brokerUrl, options as Record<string, unknown>);
      clients.push(client);
      return client as any;
    });

  });

  afterEach(async () => {
    await notificationRuntime.stop();
    mqttClientTesting.reset();
    mqttRuntimeTesting.reset();
    globalThis.fetch = originalFetch;
    resetAppUpdateStatusCache();

    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });

    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("creates mqtt notifications with encrypted passwords and masked reads", async () => {
    const createRes = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "MQTT Ops",
        type: "mqtt",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          brokerUrl: "mqtt://broker.example.com:1883",
          username: "ops",
          password: "broker-secret",
          topic: "ludash/events",
          publishEvents: true,
          homeAssistantEnabled: true,
          discoveryPrefix: "homeassistant",
          baseTopic: "ludash",
          publishAppEntity: true,
          commandsEnabled: true,
          payloadInstall: "install",
          qos: 1,
          keepaliveSeconds: 60,
          connectTimeoutMs: 10000,
        },
      }),
    });

    expect(createRes.status).toBe(201);
    const { id } = await createRes.json() as { id: number };

    const stored = getDb().select().from(notifications).where(eq(notifications.id, id)).get();
    expect(stored?.config).toContain("\"password\":\"");
    expect(stored?.config).not.toContain("broker-secret");

    const getRes = await app.request(`/api/notifications/${id}`);
    expect(getRes.status).toBe(200);
    const channel = await getRes.json() as { config: Record<string, unknown> };
    expect(channel.config.password).toBe("(stored)");
  });

  test("rejects mqtt notifications with invalid broker schemes", async () => {
    const res = await app.request("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "MQTT Ops",
        type: "mqtt",
        enabled: true,
        notifyOn: ["updates"],
        systemIds: null,
        config: {
          brokerUrl: "http://broker.example.com",
          topic: "ludash/events",
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("mqtt://");
  });

  test("test notification publishes canonical mqtt payload metadata", async () => {
    const inserted = getDb().insert(notifications).values({
      name: "MQTT Events",
      type: "mqtt",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: "[1,2]",
      schedule: "0 * * * *",
      config: JSON.stringify({
        brokerUrl: "mqtt://broker.example.com:1883",
        topic: "ludash/events",
        publishEvents: true,
        homeAssistantEnabled: false,
        qos: 1,
      }),
    }).returning({ id: notifications.id }).get();

    const result = await testNotification(inserted.id);
    expect(result.success).toBe(true);
    expect(clients).toHaveLength(1);

    const publish = clients[0].publishes.find((entry) => entry.topic === "ludash/events");
    expect(publish).toBeTruthy();
    const payload = JSON.parse(publish!.payload);
    expect(payload.title).toBe("Test Notification");
    expect(payload.channelId).toBe(inserted.id);
    expect(payload.channelName).toBe("MQTT Events");
    expect(payload.systemIds).toEqual([1, 2]);
    expect(payload.schedule).toBe("0 * * * *");
  });

  test("disabled mqtt notifications cannot be used for saved test sends", async () => {
    const inserted = getDb().insert(notifications).values({
      name: "Disabled MQTT",
      type: "mqtt",
      enabled: 0,
      notifyOn: '["updates"]',
      systemIds: null,
      config: JSON.stringify({
        brokerUrl: "mqtt://broker.example.com:1883",
        topic: "ludash/events",
        publishEvents: true,
      }),
    }).returning({ id: notifications.id }).get();

    const serviceResult = await testNotification(inserted.id);
    expect(serviceResult.success).toBe(false);
    expect(serviceResult.error).toContain("disabled");

    const routeResult = await app.request("/api/notifications/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "mqtt",
        existingId: inserted.id,
        config: {
          brokerUrl: "mqtt://broker.example.com:1883",
          topic: "ludash/events",
          publishEvents: true,
        },
      }),
    });

    expect(routeResult.status).toBe(400);
    const routeBody = await routeResult.json() as { error: string };
    expect(routeBody.error).toContain("disabled");
    expect(clients).toHaveLength(0);
  });

  test("runtime publishes Home Assistant discovery/state and executes install commands", async () => {
    const systemRow = getDb().insert(systems).values({
      name: "web-1",
      hostname: "web-1.local",
      port: 22,
      credentialId: null,
      authType: "password",
      username: "root",
      isReachable: 1,
      osName: "Ubuntu",
      osVersion: "24.04",
    }).returning({ id: systems.id }).get();

    getDb().insert(updateCache).values([
      { systemId: systemRow.id, pkgManager: "apt", packageName: "bash", newVersion: "1", isSecurity: 0 },
      { systemId: systemRow.id, pkgManager: "apt", packageName: "curl", newVersion: "1", isSecurity: 0 },
      { systemId: systemRow.id, pkgManager: "apt", packageName: "openssl", newVersion: "1", isSecurity: 1 },
    ]).run();

    getDb().insert(notifications).values({
      name: "HA MQTT",
      type: "mqtt",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: null,
      config: JSON.stringify({
        brokerUrl: "mqtt://broker.example.com:1883",
        topic: "ludash/events",
        publishEvents: false,
        homeAssistantEnabled: true,
        deviceName: "Home Lab Updates",
        discoveryPrefix: "homeassistant",
        baseTopic: "ludash",
        publishAppEntity: false,
        commandsEnabled: true,
        payloadInstall: "install",
        qos: 1,
      }),
    }).run();

    let commandSystemId: number | null = null;
    mqttRuntimeTesting.setCommandExecutor(async (systemId: number) => {
      commandSystemId = systemId;
      return { success: true, output: "ok" };
    });

    await notificationRuntime.start();
    await flush();
    await flush();

    expect(clients.length).toBeGreaterThan(0);
    const runtimeClient = clients[0];

    const discovery = runtimeClient.publishes.find((entry) => entry.topic === "homeassistant/update/ludash_1_system_1/config");
    expect(discovery).toBeTruthy();
    const discoveryPayload = JSON.parse(discovery!.payload);
    expect(discoveryPayload.origin.name).toBe("linux-update-dashboard");
    expect(discoveryPayload.origin.url).toBe("http://localhost:3001");
    expect(discoveryPayload.device.identifiers).toEqual(["ludash_channel_1"]);
    expect(discoveryPayload.device.name).toBe("Home Lab Updates");
    expect(discoveryPayload.command_topic).toContain("/command");
    expect(discoveryPayload.icon).toBe("mdi:linux");
    expect(discoveryPayload.entity_picture).toBe("http://localhost:3001/assets/logo.png");
    expect(discoveryPayload.json_attributes_topic).toBe("ludash/channels/1/system_1/attributes");
    expect(discoveryPayload.unique_id).toBe("ludash_1_system_1");

    const state = runtimeClient.publishes.find((entry) => entry.topic.endsWith("/system_1/state"));
    expect(state).toBeTruthy();
    const statePayload = JSON.parse(state!.payload);
    expect(statePayload.installed_version).toBe("current");
    expect(statePayload.latest_version).toMatch(/^pending-[0-9a-f]{12}$/);
    expect(statePayload.release_summary).toContain("3 updates, 1 security");
    expect(statePayload.release_summary).toContain("bash");
    expect(statePayload.in_progress).toBe(false);
    expect(statePayload.entity_picture).toBeUndefined();
    expect(statePayload.needs_reboot).toBeUndefined();
    expect(statePayload.system).toBeUndefined();
    expect(statePayload.packages).toBeUndefined();

    const attributes = runtimeClient.publishes.find((entry) => entry.topic.endsWith("/system_1/attributes"));
    expect(attributes).toBeTruthy();
    const attributesPayload = JSON.parse(attributes!.payload);
    expect(attributesPayload.needs_reboot).toBe(false);
    expect(attributesPayload.system.os_name).toBe("Ubuntu");
    expect(attributesPayload.packages).toHaveLength(3);
    expect(attributesPayload.packages[0].package_name).toBe("bash");
    expect(attributesPayload.packages[2].is_security).toBe(true);

    expect(runtimeClient.subscriptions.some((entry) => entry.topics.some((topic) => topic.endsWith("/system_1/command")))).toBe(true);

    runtimeClient.emit("message", "ludash/channels/1/system_1/command", Buffer.from("ignore"));
    runtimeClient.emit("message", "ludash/channels/1/system_1/command", Buffer.from("install"));
    await flush();

    expect(commandSystemId).toBe(systemRow.id);
  });

  test("legacy home assistant mqtt configs migrate channel name into device name", async () => {
    const inserted = getDb().insert(notifications).values({
      name: "Legacy HA MQTT",
      type: "mqtt",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: null,
      config: JSON.stringify({
        brokerUrl: "mqtt://broker.example.com:1883",
        topic: "ludash/events",
        publishEvents: false,
        homeAssistantEnabled: true,
        discoveryPrefix: "homeassistant",
        baseTopic: "ludash",
        publishAppEntity: false,
        commandsEnabled: false,
        qos: 1,
      }),
    }).returning({ id: notifications.id }).get();

    const getRes = await app.request(`/api/notifications/${inserted.id}`);
    expect(getRes.status).toBe(200);
    const channel = await getRes.json() as { config: Record<string, unknown> };
    expect(channel.config.deviceName).toBe("Legacy HA MQTT");

    const stored = getDb().select().from(notifications).where(eq(notifications.id, inserted.id)).get();
    expect(stored?.config).toContain("\"deviceName\":\"Legacy HA MQTT\"");
  });

  test("runtime excludes hidden systems from Home Assistant entities", async () => {
    const visibleSystem = getDb().insert(systems).values({
      name: "visible-web",
      hostname: "visible-web.local",
      port: 22,
      credentialId: null,
      authType: "password",
      username: "root",
      isReachable: 1,
      hidden: 0,
    }).returning({ id: systems.id }).get();
    const hiddenSystem = getDb().insert(systems).values({
      name: "hidden-web",
      hostname: "hidden-web.local",
      port: 22,
      credentialId: null,
      authType: "password",
      username: "root",
      isReachable: 1,
      hidden: 1,
    }).returning({ id: systems.id }).get();

    getDb().insert(updateCache).values([
      { systemId: visibleSystem.id, pkgManager: "apt", packageName: "bash", newVersion: "1", isSecurity: 0 },
      { systemId: hiddenSystem.id, pkgManager: "apt", packageName: "curl", newVersion: "1", isSecurity: 0 },
    ]).run();

    getDb().insert(notifications).values({
      name: "HA MQTT",
      type: "mqtt",
      enabled: 1,
      notifyOn: '["updates"]',
      systemIds: null,
      config: JSON.stringify({
        brokerUrl: "mqtt://broker.example.com:1883",
        topic: "ludash/events",
        publishEvents: false,
        homeAssistantEnabled: true,
        discoveryPrefix: "homeassistant",
        baseTopic: "ludash",
        publishAppEntity: false,
        commandsEnabled: true,
        payloadInstall: "install",
        qos: 1,
      }),
    }).run();

    await notificationRuntime.start();
    await flush();
    await flush();

    const runtimeClient = clients[0];
    expect(runtimeClient.publishes.some((entry) => entry.topic === `homeassistant/update/ludash_1_system_${visibleSystem.id}/config`)).toBe(true);
    expect(runtimeClient.publishes.some((entry) => entry.topic === `homeassistant/update/ludash_1_system_${hiddenSystem.id}/config`)).toBe(false);
    expect(runtimeClient.subscriptions.some((entry) => entry.topics.some((topic) => topic.endsWith(`/system_${hiddenSystem.id}/command`)))).toBe(false);
  });

  test("runtime publishes app entity state with current and latest versions", async () => {
    process.env.LUDASH_APP_REPOSITORY = "TheDuffman85/linux-update-dashboard";
    process.env.LUDASH_APP_BRANCH = "main";
    process.env.LUDASH_APP_VERSION = "2026.3.1";

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          tag_name: "2026.3.2",
          html_url: "https://github.com/TheDuffman85/linux-update-dashboard/releases/tag/2026.3.2",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    getDb().insert(notifications).values({
      name: "HA App MQTT",
      type: "mqtt",
      enabled: 1,
      notifyOn: '["appUpdates"]',
      systemIds: null,
      config: JSON.stringify({
        brokerUrl: "mqtt://broker.example.com:1883",
        publishEvents: false,
        homeAssistantEnabled: true,
        discoveryPrefix: "homeassistant",
        baseTopic: "ludash",
        publishAppEntity: true,
        commandsEnabled: false,
        qos: 1,
      }),
    }).run();

    await notificationRuntime.start();
    await flush();
    await flush();

    const runtimeClient = clients[0];
    const state = runtimeClient.publishes.find((entry) => entry.topic.endsWith("/app_update/state"));
    expect(state).toBeTruthy();
    const discovery = runtimeClient.publishes.find((entry) => entry.topic === "homeassistant/update/ludash_1_app_update/config");
    expect(discovery).toBeTruthy();
    expect(JSON.parse(discovery!.payload).icon).toBe("mdi:linux");
    expect(JSON.parse(discovery!.payload).entity_picture).toBe("http://localhost:3001/assets/logo.png");
    expect(JSON.parse(discovery!.payload).json_attributes_topic).toBe("ludash/channels/1/app_update/attributes");
    const payload = JSON.parse(state!.payload);
    expect(payload.installed_version).toBe("2026.3.1");
    expect(payload.latest_version).toBe("2026.3.2");
    expect(payload.release_url).toContain("/releases/tag/2026.3.2");
    expect(payload.origin_url).toBeUndefined();
    expect(payload.entity_picture).toBeUndefined();

    const attributes = runtimeClient.publishes.find((entry) => entry.topic.endsWith("/app_update/attributes"));
    expect(attributes).toBeTruthy();
    const attributesPayload = JSON.parse(attributes!.payload);
    expect(attributesPayload.origin_url).toBe("http://localhost:3001");
  });
});
