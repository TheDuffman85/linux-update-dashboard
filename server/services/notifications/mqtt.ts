import type {
  NotificationConfig,
  NotificationPayload,
  NotificationProvider,
  NotificationResult,
} from "./types";
import {
  buildMqttConnectionOptions,
  maskMqttConfig,
  mergeMqttConfig,
  prepareMqttConfigForStorage,
  sanitizeMqttConfig,
  validateMqttConfig,
} from "./mqtt-shared";
import { createMqttClient, endMqttClient, publishMqttMessage, waitForMqttConnect } from "../mqtt-client";

async function publishEventPayload(
  payload: NotificationPayload,
  config: ReturnType<typeof sanitizeMqttConfig>,
): Promise<NotificationResult> {
  if (!config.publishEvents) {
    return {
      success: true,
      summary: "MQTT event publishing disabled for this channel",
    };
  }

  const client = createMqttClient(
    config.brokerUrl,
    buildMqttConnectionOptions(config),
  );

  try {
    await waitForMqttConnect(client);
    await publishMqttMessage(client, {
      topic: config.topic,
      payload: JSON.stringify({
        title: payload.title,
        body: payload.body,
        priority: payload.priority ?? "default",
        tags: payload.tags ?? [],
        event: payload.event,
        channelId: payload.channelId ?? null,
        channelName: payload.channelName ?? null,
        systemIds: payload.systemIds ?? null,
        schedule: payload.schedule ?? null,
      }),
      qos: config.qos,
      retain: config.retainEvents,
    });

    return { success: true };
  } finally {
    await endMqttClient(client, true).catch(() => {});
  }
}

export const mqttProvider: NotificationProvider = {
  name: "mqtt",

  sanitizeConfig(config: NotificationConfig) {
    return sanitizeMqttConfig(config);
  },

  maskConfig(config: NotificationConfig) {
    return maskMqttConfig(config);
  },

  mergeConfig(storedConfig: NotificationConfig, incomingConfig: NotificationConfig) {
    return mergeMqttConfig(storedConfig, incomingConfig);
  },

  prepareConfigForStorage(config: NotificationConfig) {
    return prepareMqttConfigForStorage(config);
  },

  validateConfig(config: NotificationConfig) {
    return validateMqttConfig(config);
  },

  async send(payload: NotificationPayload, config: NotificationConfig): Promise<NotificationResult> {
    return publishEventPayload(payload, sanitizeMqttConfig(config));
  },
};
