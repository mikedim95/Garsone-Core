import { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { invalidateStoreCache } from "../lib/store.js";
import { publishMessage } from "../lib/mqtt.js";

const adminOnly = [authMiddleware, requireRole(["architect"])];

function isMissingNodeAgentTable(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2021" || error.code === "P2022")
  );
}

const printerSchema = z.object({
  id: z.string().trim().max(80).optional(),
  type: z.enum(["58", "80"]),
  ordinal: z.coerce.number().int().min(1).max(99),
  mac: z.string().trim().min(1).max(64),
  topicSuffix: z.string().trim().min(1).max(100),
  interface: z.string().trim().min(1).max(80).optional(),
  label: z.string().trim().max(120).optional(),
});

const wifiNetworkSchema = z.object({
  id: z.string().trim().max(80).optional(),
  ssid: z.string().trim().min(1).max(255),
  password: z.string().max(255).optional().default(""),
  priority: z.coerce.number().int().min(1).max(20).optional().default(1),
  hidden: z.boolean().optional().default(false),
});

const nodeConfigSchema = z.object({
  displayName: z.string().trim().min(1).max(255).default("Venue Pi"),
  nodeSlug: z.string().trim().min(1).max(100).default("main"),
  tailscaleHostname: z.string().trim().max(255).optional().default(""),
  localHostname: z.string().trim().max(255).optional().default(""),
  wifiSsid: z.string().trim().max(255).optional().default(""),
  wifiPassword: z.string().max(255).optional().default(""),
  wifiNetworks: z.array(wifiNetworkSchema).max(10).optional().default([]),
  mqttHost: z.string().trim().min(1).max(255),
  mqttPort: z.coerce.number().int().min(1).max(65535).default(8883),
  mqttTls: z.boolean().default(true),
  mqttInsecure: z.boolean().default(false),
  mqttUser: z.string().trim().max(255).optional().default(""),
  mqttPass: z.string().max(255).optional().default(""),
  dockerImage: z.string().trim().max(255).optional().default("mikedim95/mqtt-printer:latest"),
  encoding: z.string().trim().max(64).optional().default("cp1253"),
  codepage: z.string().trim().max(32).optional().default("7"),
  feedLines: z.coerce.number().int().min(0).max(20).optional().default(3),
  pollSeconds: z.coerce.number().int().min(10).max(3600).optional().default(30),
  timezone: z.string().trim().max(64).optional().default("Europe/Athens"),
  supportPhone: z.string().trim().max(100).optional().default(""),
  supportWhatsapp: z.string().trim().max(100).optional().default(""),
  supportUrl: z.string().trim().max(255).optional().default(""),
  notes: z.string().trim().max(2000).optional().default(""),
  printers: z.array(printerSchema).max(99),
});

const claimConfigSchema = nodeConfigSchema.extend({
  mqttHost: z.string().trim().max(255).optional().default(""),
  printers: z.array(printerSchema.extend({
    mac: z.string().trim().max(64).optional().default(""),
  })).max(99).optional().default([]),
});

const bootstrapRegisterSchema = z.object({
  nodeKey: z.string().trim().min(8).max(128),
  pairingSecret: z.string().min(16).max(255),
  displayName: z.string().trim().min(1).max(255).default("Unclaimed Pi"),
  localHostname: z.string().trim().max(255).optional().default(""),
  tailscaleHostname: z.string().trim().max(255).optional().default(""),
  macAddresses: z.array(z.string().trim().min(1).max(64)).max(20).optional().default([]),
  ipAddresses: z.array(z.string().trim().min(1).max(64)).max(20).optional().default([]),
  bootstrap: z.record(z.unknown()).optional().default({}),
});

const claimPendingNodeSchema = z.object({
  storeId: z.string().uuid(),
  config: claimConfigSchema.optional(),
});

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function bootstrapTopic(nodeKey: string, event: "claim" | "config") {
  return `garsone/nodes/${nodeKey}/${event}`;
}

function normalizeSlug(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || "main";
}

function serializeNode(node: any, includeSensitive = false) {
  const config = node.configJson && typeof node.configJson === "object" ? node.configJson : {};
  const safeConfig = { ...config };
  if (!includeSensitive) {
    if ("wifiPassword" in safeConfig) safeConfig.wifiPasswordSet = Boolean(safeConfig.wifiPassword);
    if ("mqttPass" in safeConfig) safeConfig.mqttPassSet = Boolean(safeConfig.mqttPass);
    if (Array.isArray(safeConfig.wifiNetworks)) {
      safeConfig.wifiNetworks = safeConfig.wifiNetworks.map((wifi: any) => ({
        ...wifi,
        passwordSet: Boolean(wifi?.password),
        password: "",
      }));
    }
    delete safeConfig.wifiPassword;
    delete safeConfig.mqttPass;
    delete safeConfig.mqttConfigToken;
  }
  return {
    id: node.id,
    storeId: node.storeId,
    slug: node.slug,
    displayName: node.displayName,
    desiredConfigVersion: node.desiredConfigVersion,
    lastAppliedVersion: node.lastAppliedVersion,
    lastSeenAt: node.lastSeenAt,
    status: node.status,
    statusMessage: node.statusMessage,
    lastLog: node.lastLog,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    config: safeConfig,
  };
}

function serializePendingNode(row: any) {
  return {
    id: row.id,
    nodeKey: row.nodeKey,
    displayName: row.displayName,
    localHostname: row.localHostname ?? "",
    tailscaleHostname: row.tailscaleHostname ?? "",
    macAddresses: Array.isArray(row.macAddresses) ? row.macAddresses : [],
    ipAddresses: Array.isArray(row.ipAddresses) ? row.ipAddresses : [],
    status: row.status,
    storeId: row.storeId ?? null,
    claimedNodeId: row.claimedNodeId ?? null,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function syncStorePrinterTopics(storeId: string, config: any) {
  const printers = Array.isArray(config?.printers)
    ? Array.from(new Set(config.printers.map((p: any) => String(p?.topicSuffix || "").trim()).filter(Boolean)))
    : [];
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: { id: true, slug: true, settingsJson: true },
  });
  if (!store) return;
  const nextSettings = {
    ...(store.settingsJson && typeof store.settingsJson === "object" ? store.settingsJson : {}),
    printers,
  } as any;
  await db.store.update({
    where: { id: storeId },
    data: { settingsJson: nextSettings },
  });
  invalidateStoreCache(store.slug);
}

function mergeNodeConfig(body: z.infer<typeof nodeConfigSchema>, previousConfig: any = {}) {
  const slug = normalizeSlug(body.nodeSlug);
  const previousWifiById = new Map<string, any>(
    Array.isArray(previousConfig.wifiNetworks)
      ? previousConfig.wifiNetworks
          .filter((wifi: any) => wifi?.id)
          .map((wifi: any) => [String(wifi.id), wifi])
      : []
  );
  const previousWifiBySsid = new Map<string, any>(
    Array.isArray(previousConfig.wifiNetworks)
      ? previousConfig.wifiNetworks
          .filter((wifi: any) => wifi?.ssid)
          .map((wifi: any) => [String(wifi.ssid), wifi])
      : []
  );
  const wifiNetworks =
    body.wifiNetworks.length > 0
      ? body.wifiNetworks.map((wifi, index) => {
          const previous =
            previousWifiById.get(String(wifi.id || "")) ??
            previousWifiBySsid.get(wifi.ssid);
          return {
            ...wifi,
            id: wifi.id?.trim() || `wifi-${index + 1}`,
            password: wifi.password || previous?.password || "",
            priority: wifi.priority || index + 1,
            hidden: Boolean(wifi.hidden),
          };
        })
      : body.wifiSsid
      ? [
          {
            id: "wifi-1",
            ssid: body.wifiSsid,
            password: body.wifiPassword || previousConfig.wifiPassword || "",
            priority: 1,
            hidden: false,
          },
        ]
      : [];

  return {
    slug,
    config: {
      ...body,
      nodeSlug: slug,
      wifiNetworks,
      wifiPassword: body.wifiPassword || previousConfig.wifiPassword || "",
      mqttPass: body.mqttPass || previousConfig.mqttPass || "",
      printers: body.printers.map((printer, index) => ({
        id: printer.id?.trim() || `printer-${index + 1}`,
        type: printer.type,
        ordinal: printer.ordinal,
        mac: printer.mac.trim(),
        topicSuffix: printer.topicSuffix.trim(),
        interface: printer.interface?.trim() || `/dev/rfcomm${index}`,
        label: printer.label?.trim() || printer.topicSuffix.trim(),
      })),
    },
  };
}

function mqttDefaultsFromEnv() {
  const rawUrl =
    process.env.EMQX_URL ||
    process.env.MQTT_URL ||
    process.env.MQTT_BROKER_URL ||
    "";
  let host = "";
  let port = 8883;
  let tls = true;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      host = parsed.hostname;
      port = parsed.port ? Number(parsed.port) : parsed.protocol === "mqtt:" ? 1883 : 8883;
      tls = parsed.protocol === "mqtts:" || parsed.protocol === "wss:";
    } catch {
      host = rawUrl.replace(/^mqtts?:\/\//i, "").replace(/:\d+.*$/, "").replace(/\/.*$/, "");
    }
  }
  return {
    host,
    port,
    tls,
    insecure: String(process.env.MQTT_REJECT_UNAUTHORIZED || "true").toLowerCase() === "false",
    user: process.env.EMQX_USERNAME || process.env.MQTT_USERNAME || "",
    pass: process.env.EMQX_PASSWORD || process.env.MQTT_PASSWORD || "",
  };
}

function claimConfigFromPending(
  input: z.infer<typeof claimConfigSchema> | undefined,
  pending: any
): z.infer<typeof nodeConfigSchema> {
  const mqtt = mqttDefaultsFromEnv();
  const localHostname = String(pending.localHostname || "").trim();
  const displayName = String(pending.displayName || localHostname || "Venue Pi").trim();
  const nodeSlug = normalizeSlug(input?.nodeSlug || localHostname || displayName || "main");
  const printers = (input?.printers || [])
    .map((printer, index) => ({
      ...printer,
      id: printer.id || `printer-${index + 1}`,
      mac: String(printer.mac || "").trim(),
      topicSuffix: printer.topicSuffix || `printer_${index + 1}`,
      label: printer.label || printer.topicSuffix || `Printer ${index + 1}`,
    }))
    .filter((printer) => printer.mac.length > 0);

  return nodeConfigSchema.parse({
    displayName: input?.displayName || displayName,
    nodeSlug,
    tailscaleHostname: input?.tailscaleHostname || pending.tailscaleHostname || "",
    localHostname: input?.localHostname || localHostname,
    wifiSsid: input?.wifiSsid || "",
    wifiPassword: input?.wifiPassword || "",
    wifiNetworks: input?.wifiNetworks || [],
    mqttHost: input?.mqttHost || mqtt.host,
    mqttPort: input?.mqttPort || mqtt.port,
    mqttTls: typeof input?.mqttTls === "boolean" ? input.mqttTls : mqtt.tls,
    mqttInsecure: typeof input?.mqttInsecure === "boolean" ? input.mqttInsecure : mqtt.insecure,
    mqttUser: input?.mqttUser || mqtt.user,
    mqttPass: input?.mqttPass || mqtt.pass,
    dockerImage: input?.dockerImage || "mikedim95/mqtt-printer:latest",
    encoding: input?.encoding || "cp1253",
    codepage: input?.codepage || "7",
    feedLines: input?.feedLines || 3,
    pollSeconds: input?.pollSeconds || 30,
    timezone: input?.timezone || "Europe/Athens",
    supportPhone: input?.supportPhone || "",
    supportWhatsapp: input?.supportWhatsapp || "",
    supportUrl: input?.supportUrl || "",
    notes: input?.notes || "",
    printers,
  });
}

function buildAgentConfig(node: any, store: any) {
  const config = node.configJson && typeof node.configJson === "object" ? node.configJson : {};
  return {
    nodeId: node.id,
    nodeSlug: node.slug,
    version: node.desiredConfigVersion,
    store: {
      id: store.id,
      slug: store.slug,
      name: store.name,
    },
    runtime: {
      pollSeconds: config.pollSeconds ?? 30,
      timezone: config.timezone ?? "Europe/Athens",
      encoding: config.encoding ?? "cp1253",
      codepage: config.codepage ?? "7",
      feedLines: config.feedLines ?? 3,
      supportPhone: config.supportPhone ?? "",
      supportWhatsapp: config.supportWhatsapp ?? "",
      supportUrl: config.supportUrl ?? "",
    },
    mqtt: {
      host: config.mqttHost,
      port: config.mqttPort ?? 8883,
      tls: config.mqttTls ?? true,
      insecure: config.mqttInsecure ?? false,
      user: config.mqttUser ?? "",
      pass: config.mqttPass ?? "",
    },
    network: {
      localHostname: config.localHostname ?? "",
      tailscaleHostname: config.tailscaleHostname ?? "",
      wifiSsid: config.wifiSsid ?? "",
      wifiPassword: config.wifiPassword ?? "",
      wifiNetworks: Array.isArray(config.wifiNetworks)
        ? config.wifiNetworks
        : config.wifiSsid
        ? [
            {
              id: "wifi-1",
              ssid: config.wifiSsid,
              password: config.wifiPassword ?? "",
              priority: 1,
              hidden: false,
            },
          ]
        : [],
    },
    printers: Array.isArray(config.printers) ? config.printers : [],
  };
}

async function publishNodeConfigIfAddressable(node: any, store: any) {
  const config = node.configJson && typeof node.configJson === "object" ? node.configJson as any : {};
  const nodeKey = String(config.bootstrapNodeKey || "").trim();
  const configToken = String(config.mqttConfigToken || "").trim();
  if (!nodeKey) return;
  publishMessage(
    bootstrapTopic(nodeKey, "config"),
    {
      type: "CONFIG_UPDATED",
      nodeId: node.id,
      nodeToken: null,
      configToken,
      config: buildAgentConfig(node, store),
      ts: new Date().toISOString(),
    },
    { skipMqtt: false }
  );
}

async function authenticateNode(request: any) {
  const authHeader = String(request.headers.authorization || "");
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const token = bearer || String(request.headers["x-node-token"] || "").trim();
  if (!token) return null;
  const hash = tokenHash(token);
  return db.nodeAgent.findFirst({
    where: { tokenHash: hash },
    include: { store: { select: { id: true, slug: true, name: true } } },
  });
}

export async function nodeAgentRoutes(fastify: FastifyInstance) {
  fastify.post("/node-agent/bootstrap/register", async (request, reply) => {
    try {
      const body = bootstrapRegisterSchema.parse(request.body ?? {});
      const pairingHash = tokenHash(body.pairingSecret);
      const rows = await db.$queryRaw<any[]>`
        INSERT INTO "pending_node_agents"
          ("nodeKey", "pairingHash", "displayName", "localHostname", "tailscaleHostname",
           "macAddresses", "ipAddresses", "bootstrapJson", "status", "lastSeenAt", "updatedAt")
        VALUES
          (${body.nodeKey}, ${pairingHash}, ${body.displayName}, ${body.localHostname || null},
           ${body.tailscaleHostname || null}, ${JSON.stringify(body.macAddresses)}::jsonb,
           ${JSON.stringify(body.ipAddresses)}::jsonb, ${JSON.stringify(body.bootstrap)}::jsonb,
           'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("nodeKey") DO UPDATE SET
          "pairingHash" = EXCLUDED."pairingHash",
          "displayName" = EXCLUDED."displayName",
          "localHostname" = EXCLUDED."localHostname",
          "tailscaleHostname" = EXCLUDED."tailscaleHostname",
          "macAddresses" = EXCLUDED."macAddresses",
          "ipAddresses" = EXCLUDED."ipAddresses",
          "bootstrapJson" = EXCLUDED."bootstrapJson",
          "lastSeenAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
        RETURNING *
      `;
      const row = rows[0];
      return reply.send({
        pendingNode: serializePendingNode(row),
        claimTopic: bootstrapTopic(body.nodeKey, "claim"),
        configTopic: bootstrapTopic(body.nodeKey, "config"),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.status(400).send({ error: "Invalid request", details: error.errors });
      }
      fastify.log.error(error, "Failed to register pending node");
      return reply.status(500).send({ error: "Failed to register pending node" });
    }
  });

  fastify.get(
    "/admin/pending-nodes",
    { preHandler: adminOnly },
    async (_request, reply) => {
      const rows = await db.$queryRaw<any[]>`
        SELECT * FROM "pending_node_agents"
        ORDER BY
          CASE WHEN "status" = 'PENDING' THEN 0 ELSE 1 END,
          "lastSeenAt" DESC
        LIMIT 100
      `;
      return reply.send({ pendingNodes: rows.map(serializePendingNode) });
    }
  );

  fastify.post(
    "/admin/pending-nodes/:pendingNodeId/claim",
    { preHandler: adminOnly },
    async (request, reply) => {
      try {
        const { pendingNodeId } = request.params as { pendingNodeId: string };
        const body = claimPendingNodeSchema.parse(request.body ?? {});
        const pendingRows = await db.$queryRaw<any[]>`
          SELECT * FROM "pending_node_agents"
          WHERE "id" = ${pendingNodeId}::uuid
          LIMIT 1
        `;
        const pending = pendingRows[0];
        if (!pending) return reply.status(404).send({ error: "PENDING_NODE_NOT_FOUND" });
        if (pending.status === "CLAIMED" && pending.claimedNodeId) {
          return reply.status(409).send({ error: "PENDING_NODE_ALREADY_CLAIMED" });
        }

        const store = await db.store.findUnique({ where: { id: body.storeId } });
        if (!store) return reply.status(404).send({ error: "STORE_NOT_FOUND" });

        const claimConfig = claimConfigFromPending(body.config, pending);
        const claimSlug = normalizeSlug(claimConfig.nodeSlug);
        const existing = await db.nodeAgent.findUnique({
          where: { storeId_slug: { storeId: body.storeId, slug: claimSlug } },
        });
        const previousConfig =
          existing?.configJson && typeof existing.configJson === "object" ? (existing.configJson as any) : {};
        const { slug, config } = mergeNodeConfig(claimConfig, previousConfig);
        const configWithBootstrap = {
          ...config,
          bootstrapNodeKey: pending.nodeKey,
          bootstrapMacAddresses: Array.isArray(pending.macAddresses) ? pending.macAddresses : [],
          mqttConfigToken:
            previousConfig.mqttConfigToken ||
            `gcfg_${randomBytes(32).toString("base64url")}`,
        };
        const token = `gnode_${randomBytes(32).toString("base64url")}`;
        const node = await db.nodeAgent.upsert({
          where: { storeId_slug: { storeId: body.storeId, slug } },
          update: {
            displayName: claimConfig.displayName,
            tokenHash: tokenHash(token),
            configJson: configWithBootstrap,
            desiredConfigVersion: { increment: 1 },
            statusMessage: "Claimed from pending Pi",
          },
          create: {
            storeId: body.storeId,
            slug,
            displayName: claimConfig.displayName,
            tokenHash: tokenHash(token),
            configJson: configWithBootstrap,
            desiredConfigVersion: 1,
            statusMessage: "Claimed from pending Pi",
          },
        });

        await db.$executeRaw`
          UPDATE "pending_node_agents"
          SET "status" = 'CLAIMED',
              "storeId" = ${body.storeId}::uuid,
              "claimedNodeId" = ${node.id}::uuid,
              "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${pendingNodeId}::uuid
        `;
        await syncStorePrinterTopics(body.storeId, configWithBootstrap);

        const agentConfig = buildAgentConfig(node, store);
        publishMessage(
          bootstrapTopic(pending.nodeKey, "claim"),
          {
            type: "CLAIMED",
            nodeId: node.id,
            nodeToken: token,
            configToken: configWithBootstrap.mqttConfigToken,
            config: agentConfig,
            ts: new Date().toISOString(),
          },
          { skipMqtt: false }
        );

        return reply.send({
          node: serializeNode(node),
          token,
          tokenOnlyShownOnce: true,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: "Invalid request", details: error.errors });
        }
        fastify.log.error(error, "Failed to claim pending node");
        return reply.status(500).send({ error: "Failed to claim pending node" });
      }
    }
  );

  fastify.get(
    "/admin/stores/:storeId/nodes",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      try {
        const nodes = await db.nodeAgent.findMany({
          where: { storeId },
          orderBy: { createdAt: "asc" },
        });
        return reply.send({ nodes: nodes.map((node) => serializeNode(node)) });
      } catch (error) {
        if (isMissingNodeAgentTable(error)) {
          fastify.log.warn(error, "Node agent tables are not migrated yet");
          return reply.send({ nodes: [], migrationRequired: true });
        }
        fastify.log.error(error, "Failed to list nodes");
        return reply.status(500).send({ error: "Failed to list nodes" });
      }
    }
  );

  fastify.put(
    "/admin/stores/:storeId/nodes/main",
    { preHandler: adminOnly },
    async (request, reply) => {
      try {
        const { storeId } = request.params as { storeId: string };
        const store = await db.store.findUnique({ where: { id: storeId } });
        if (!store) return reply.status(404).send({ error: "STORE_NOT_FOUND" });

        const body = nodeConfigSchema.parse(request.body ?? {});
        const slug = normalizeSlug(body.nodeSlug);
        const existing = await db.nodeAgent.findUnique({
          where: { storeId_slug: { storeId, slug } },
        });
        const secret = existing ? null : `gnode_${randomBytes(32).toString("base64url")}`;
        const previousConfig =
          existing?.configJson && typeof existing.configJson === "object" ? (existing.configJson as any) : {};
        const { config } = mergeNodeConfig(body, previousConfig);
        const configWithSecret = {
          ...config,
          bootstrapNodeKey: previousConfig.bootstrapNodeKey,
          bootstrapMacAddresses: previousConfig.bootstrapMacAddresses,
          mqttConfigToken:
            previousConfig.mqttConfigToken ||
            `gcfg_${randomBytes(32).toString("base64url")}`,
        };

        const node = await db.nodeAgent.upsert({
          where: { storeId_slug: { storeId, slug } },
          update: {
            displayName: body.displayName,
            configJson: configWithSecret,
            desiredConfigVersion: { increment: 1 },
            statusMessage: "Configuration updated from Architect",
          },
          create: {
            storeId,
            slug,
            displayName: body.displayName,
            tokenHash: tokenHash(secret as string),
            configJson: configWithSecret,
            desiredConfigVersion: 1,
          },
        });

        await syncStorePrinterTopics(storeId, configWithSecret);
        await publishNodeConfigIfAddressable(node, store);

        return reply.send({
          node: serializeNode(node),
          token: secret,
          tokenOnlyShownOnce: Boolean(secret),
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: "Invalid request", details: error.errors });
        }
        if (isMissingNodeAgentTable(error)) {
          return reply.status(503).send({ error: "NODE_AGENT_MIGRATION_REQUIRED" });
        }
        fastify.log.error(error, "Failed to save node");
        return reply.status(500).send({ error: "Failed to save node" });
      }
    }
  );

  fastify.post(
    "/admin/nodes/:nodeId/rotate-token",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { nodeId } = request.params as { nodeId: string };
      const token = `gnode_${randomBytes(32).toString("base64url")}`;
      const node = await db.nodeAgent.update({
        where: { id: nodeId },
        data: {
          tokenHash: tokenHash(token),
          desiredConfigVersion: { increment: 1 },
          statusMessage: "Node token rotated",
        },
        include: { store: { select: { id: true, slug: true, name: true } } },
      });
      const config = node.configJson && typeof node.configJson === "object" ? node.configJson as any : {};
      const nodeKey = String(config.bootstrapNodeKey || "").trim();
      const configToken = String(config.mqttConfigToken || "").trim();
      if (nodeKey && configToken) {
        publishMessage(
          bootstrapTopic(nodeKey, "config"),
          {
            type: "CONFIG_UPDATED",
            nodeId: node.id,
            nodeToken: token,
            configToken,
            config: buildAgentConfig(node, node.store),
            ts: new Date().toISOString(),
          },
          { skipMqtt: false }
        );
      }
      return reply.send({ node: serializeNode(node), token, tokenOnlyShownOnce: true });
    }
  );

  const statusSchema = z.object({
    version: z.coerce.number().int().optional(),
    status: z.enum(["ONLINE", "APPLYING", "DEGRADED", "ERROR"]).default("ONLINE"),
    message: z.string().max(1000).optional().default(""),
    log: z.string().max(12000).optional().default(""),
    meta: z.record(z.unknown()).optional(),
  });

  fastify.post("/node-agent/status", async (request, reply) => {
    const node = await authenticateNode(request);
    if (!node) return reply.status(401).send({ error: "INVALID_NODE_TOKEN" });
    const body = statusSchema.parse(request.body ?? {});
    const updated = await db.nodeAgent.update({
      where: { id: node.id },
      data: {
        lastSeenAt: new Date(),
        lastAppliedVersion: body.version ?? node.lastAppliedVersion,
        status: body.status,
        statusMessage: body.message || null,
        lastLog: body.log || null,
      },
    });
    if (body.message || body.log) {
      await db.nodeAgentEvent.create({
        data: {
          nodeId: node.id,
          storeId: node.storeId,
          level: body.status,
          message: body.message || "Node status update",
          metaJson: body.meta ? (body.meta as any) : undefined,
        },
      });
    }
    return reply.send({ node: serializeNode(updated), ok: true });
  });
}
