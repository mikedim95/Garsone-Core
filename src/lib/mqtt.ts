import os from "os";
import mqtt from "mqtt";
import { emitRealtime } from "./realtime.js";

export type PublishOptions = {
  roles?: Array<"waiter" | "cook" | "manager">;
  userIds?: string[];
  /**
   * When true, only sessions without an authenticated role (table devices, kiosks)
   * will receive the message.
   */
  anonymousOnly?: boolean;
  /**
   * When true, only realtime delivery is performed; MQTT publish is skipped.
   */
  skipMqtt?: boolean;
};

export type BridgeHandler = (topic: string, payload: any) => void;

const topicHandlers = new Map<string, Set<BridgeHandler>>();

const MQTT_DISABLED =
  String(process.env.MQTT_DISABLED || "").toLowerCase() === "true";
const MQTT_BROKER_URL =
  process.env.EMQX_URL ||
  process.env.MQTT_URL ||
  process.env.MQTT_BROKER_URL ||
  "mqtt://localhost:1883";
const MQTT_USERNAME = process.env.EMQX_USERNAME || process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.EMQX_PASSWORD || process.env.MQTT_PASSWORD;
const MQTT_KEEPALIVE = Number(process.env.MQTT_KEEPALIVE || "30");
const MQTT_RECONNECT_MS = Number(process.env.MQTT_RECONNECT_MS || "5000");
const MQTT_REJECT_UNAUTHORIZED =
  String(process.env.MQTT_REJECT_UNAUTHORIZED || "true").toLowerCase() !==
  "false";
const MQTT_QOS = Number(process.env.MQTT_QOS || "1");
const MQTT_DEBUG =
  String(process.env.MQTT_DEBUG || "false").toLowerCase() === "true";

function buildClientId(): string {
  if (process.env.MQTT_CLIENT_ID) return process.env.MQTT_CLIENT_ID;
  const store = process.env.STORE_SLUG || "store";
  const env =
    process.env.NODE_ENV === "production" || process.env.RENDER
      ? "prod"
      : "local";
  const side = "back";
  const role = "server";
  let host = "host";
  try {
    host = os.hostname();
  } catch {}
  const rand = Math.random().toString(16).slice(2, 8);
  return `${store}:${side}:${env}:${role}:${host}-${process.pid}-${rand}`;
}

const MQTT_CLIENT_ID = buildClientId();

let client: mqtt.MqttClient | null = null;
let lastConnectLog = 0;

function mqttEnabled() {
  return !MQTT_DISABLED && Boolean(MQTT_BROKER_URL);
}

export function getMqttClient(): mqtt.MqttClient | null {
  if (!mqttEnabled()) return null;
  if (client) return client;

  try {
    const isTLS =
      MQTT_BROKER_URL.startsWith("mqtts://") ||
      MQTT_BROKER_URL.startsWith("wss://");
    client = mqtt.connect(MQTT_BROKER_URL, {
      clientId: MQTT_CLIENT_ID,
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,
      keepalive: MQTT_KEEPALIVE,
      reconnectPeriod: MQTT_RECONNECT_MS,
      clean: true,
      ...(isTLS ? { rejectUnauthorized: MQTT_REJECT_UNAUTHORIZED } : {}),
    });
  } catch (error) {
    console.error("Failed to initialize MQTT client:", error);
    return null;
  }

  client.on("connect", () => {
    const now = Date.now();
    if (now - lastConnectLog > 60_000) {
      console.log(
        "MQTT connected to",
        MQTT_BROKER_URL,
        "as",
        MQTT_CLIENT_ID
      );
      lastConnectLog = now;
    }
  });

  client.on("reconnect", () => {
    if (MQTT_DEBUG) {
      console.log("MQTT reconnecting…");
    }
  });

  client.on("close", () => {
    if (MQTT_DEBUG) {
      console.log("MQTT connection closed");
    }
  });

  client.on("error", (err) => {
    console.error("MQTT error:", err?.message || err);
  });

  client.on("message", (topic, payload) => {
    dispatchIncomingMessage(topic, payload);
  });

  return client;
}

function dispatchIncomingMessage(topic: string, payload: Buffer) {
  const handlers = topicHandlers.get(topic);
  if (!handlers || handlers.size === 0) {
    return;
  }
  let parsed: any = payload.toString();
  try {
    parsed = JSON.parse(parsed);
  } catch {
    // keep raw string
  }
  for (const handler of handlers) {
    try {
      handler(topic, parsed);
    } catch (error) {
      console.error("MQTT handler error:", error);
    }
  }
}

export function publishMessage(
  topic: string,
  payload: any,
  options?: PublishOptions
) {
  emitRealtime(topic, payload, options);
  if (options?.skipMqtt) {
    return;
  }
  const mqttClient = getMqttClient();
  if (!mqttClient) {
    return;
  }
  try {
    const data =
      typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
    mqttClient.publish(topic, data, { qos: MQTT_QOS }, (err) => {
      if (err) {
        console.error("MQTT publish error:", err?.message || err);
      }
    });
  } catch (error) {
    console.error("MQTT publish error:", error);
  }
}

export function subscribeToTopic(
  topic: string,
  handler: BridgeHandler
): () => void {
  const mqttClient = getMqttClient();
  if (!mqttClient) {
    console.warn(
      "MQTT subscribe called but broker disabled; handler will never fire"
    );
    return () => {};
  }

  if (!topicHandlers.has(topic)) {
    topicHandlers.set(topic, new Set());
    mqttClient.subscribe(topic, { qos: MQTT_QOS }, (err) => {
      if (err) {
        console.error("MQTT subscribe error", topic, err?.message || err);
      } else if (MQTT_DEBUG) {
        console.log("Subscribed to MQTT topic:", topic);
      }
    });
  }

  const handlers = topicHandlers.get(topic)!;
  handlers.add(handler);

  return () => {
    const current = topicHandlers.get(topic);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) {
      topicHandlers.delete(topic);
      mqttClient.unsubscribe(topic, (err) => {
        if (err) {
          console.error("MQTT unsubscribe error", topic, err?.message || err);
        } else if (MQTT_DEBUG) {
          console.log("Unsubscribed from MQTT topic:", topic);
        }
      });
    }
  };
}
