import { connect, type IClientOptions, type MqttClient } from "mqtt";
import type { MqttPublishMessage } from "./notifications/mqtt-shared";

type ConnectFn = (brokerUrl: string, options: IClientOptions) => MqttClient;

let connectFn: ConnectFn = connect;

function waitForEvent<T = void>(
  client: MqttClient,
  register: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    register(resolve, reject);
  });
}

export function createMqttClient(
  brokerUrl: string,
  options: IClientOptions,
): MqttClient {
  return connectFn(brokerUrl, options);
}

export async function waitForMqttConnect(client: MqttClient): Promise<void> {
  if (client.connected) return;

  await waitForEvent(client, (resolve, reject) => {
    const handleConnect = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("MQTT connection closed before connect"));
    };
    const cleanup = () => {
      client.removeListener("connect", handleConnect);
      client.removeListener("error", handleError);
      client.removeListener("close", handleClose);
    };

    client.once("connect", handleConnect);
    client.once("error", handleError);
    client.once("close", handleClose);
  });
}

export async function publishMqttMessage(
  client: MqttClient,
  message: MqttPublishMessage,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.publish(
      message.topic,
      message.payload,
      {
        retain: message.retain === true,
        qos: message.qos ?? 0,
      },
      (error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

export async function publishMqttMessages(
  client: MqttClient,
  messages: MqttPublishMessage[],
): Promise<void> {
  for (const message of messages) {
    await publishMqttMessage(client, message);
  }
}

export async function subscribeMqttTopics(
  client: MqttClient,
  topics: string[],
  qos: 0 | 1,
): Promise<void> {
  if (topics.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    client.subscribe(topics, { qos }, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function unsubscribeMqttTopics(
  client: MqttClient,
  topics: string[],
): Promise<void> {
  if (topics.length === 0) return;

  await new Promise<void>((resolve, reject) => {
    client.unsubscribe(topics, (error?: Error | null) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function endMqttClient(client: MqttClient, force = false): Promise<void> {
  await new Promise<void>((resolve) => {
    client.end(force, {}, () => resolve());
  });
}

export const __testing = {
  setConnectFactory(factory: ConnectFn) {
    connectFn = factory;
  },
  reset() {
    connectFn = connect;
  },
};
