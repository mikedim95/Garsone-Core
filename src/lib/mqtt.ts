import mqtt from "mqtt";
import os from "os";

// Prefer EMQX_*; fall back to MQTT_*; default to local broker
const MQTT_BROKER_URL =
  process.env.EMQX_URL ||
  process.env.MQTT_BROKER_URL ||
  "mqtt://localhost:1883";
const MQTT_USERNAME = process.env.EMQX_USERNAME || process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.EMQX_PASSWORD || process.env.MQTT_PASSWORD;

function buildClientId(): string {
  if (process.env.MQTT_CLIENT_ID) return process.env.MQTT_CLIENT_ID as string;
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

// Tunables (with safe defaults)
const MQTT_KEEPALIVE = Number(process.env.MQTT_KEEPALIVE || "30"); // seconds
const MQTT_RECONNECT_MS = Number(process.env.MQTT_RECONNECT_MS || "5000");
const MQTT_REJECT_UNAUTHORIZED =
  String(process.env.MQTT_REJECT_UNAUTHORIZED || "true").toLowerCase() !==
  "false";
const MQTT_DEBUG =
  String(process.env.MQTT_DEBUG || "false").toLowerCase() === "true";

let client: mqtt.MqttClient | null = null;
let lastConnectLog = 0;
let wasConnected = false;

export function getMqttClient(): mqtt.MqttClient {
  if (!client) {
    const isTLS = MQTT_BROKER_URL.startsWith("mqtts://");
    client = mqtt.connect(MQTT_BROKER_URL, {
      clientId: MQTT_CLIENT_ID,
      username: MQTT_USERNAME,
      password: MQTT_PASSWORD,
      clean: true,
      keepalive: MQTT_KEEPALIVE,
      reconnectPeriod: MQTT_RECONNECT_MS,
      ...(isTLS ? { rejectUnauthorized: MQTT_REJECT_UNAUTHORIZED } : {}),
    });

    client.on("connect", () => {
      wasConnected = true;
      const now = Date.now();
      if (now - lastConnectLog > 60000) {
        console.log("MQTT connected to", MQTT_BROKER_URL, "as", MQTT_CLIENT_ID);
        lastConnectLog = now;
      }
    });

    client.on("reconnect", () => {
      if (MQTT_DEBUG) console.log("MQTT reconnecting...");
    });

    client.on("close", () => {
      wasConnected = false;
      if (MQTT_DEBUG) console.log("MQTT connection closed");
    });

    client.on("end", () => {
      wasConnected = false;
      if (MQTT_DEBUG) console.log("MQTT connection ended");
    });

    client.on("offline", () => {
      if (MQTT_DEBUG) console.log("MQTT offline");
    });

    client.on("error", (err) => {
      console.error("MQTT error:", err?.message || err);
    });
  }

  return client;
}

export function publishMessage(topic: string, payload: any): void {
  const client = getMqttClient();
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  client.publish(topic, data, { qos: 1 }, (err) => {
    if (err) {
      console.error("MQTT publish error:", err);
    }
  });
}
