import { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { invalidateStoreCache } from "../lib/store.js";

const adminOnly = [authMiddleware, requireRole(["architect"])];

const printerSchema = z.object({
  id: z.string().trim().max(80).optional(),
  type: z.enum(["58", "80"]),
  ordinal: z.coerce.number().int().min(1).max(99),
  mac: z.string().trim().min(1).max(64),
  topicSuffix: z.string().trim().min(1).max(100),
  interface: z.string().trim().min(1).max(80).optional(),
  label: z.string().trim().max(120).optional(),
});

const nodeConfigSchema = z.object({
  displayName: z.string().trim().min(1).max(255).default("Venue Pi"),
  nodeSlug: z.string().trim().min(1).max(100).default("main"),
  tailscaleHostname: z.string().trim().max(255).optional().default(""),
  localHostname: z.string().trim().max(255).optional().default(""),
  wifiSsid: z.string().trim().max(255).optional().default(""),
  wifiPassword: z.string().max(255).optional().default(""),
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
  printers: z.array(printerSchema).min(1).max(99),
});

function tokenHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
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
    delete safeConfig.wifiPassword;
    delete safeConfig.mqttPass;
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
    },
    printers: Array.isArray(config.printers) ? config.printers : [],
  };
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
  fastify.get(
    "/admin/stores/:storeId/nodes",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const nodes = await db.nodeAgent.findMany({
        where: { storeId },
        orderBy: { createdAt: "asc" },
      });
      return reply.send({ nodes: nodes.map((node) => serializeNode(node)) });
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
        const config = {
          ...body,
          nodeSlug: slug,
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
        };

        const node = await db.nodeAgent.upsert({
          where: { storeId_slug: { storeId, slug } },
          update: {
            displayName: body.displayName,
            configJson: config,
            desiredConfigVersion: { increment: 1 },
            statusMessage: "Configuration updated from Architect",
          },
          create: {
            storeId,
            slug,
            displayName: body.displayName,
            tokenHash: tokenHash(secret as string),
            configJson: config,
            desiredConfigVersion: 1,
          },
        });

        await syncStorePrinterTopics(storeId, config);

        return reply.send({
          node: serializeNode(node),
          token: secret,
          tokenOnlyShownOnce: Boolean(secret),
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: "Invalid request", details: error.errors });
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
      });
      return reply.send({ node: serializeNode(node), token, tokenOnlyShownOnce: true });
    }
  );

  fastify.get("/node-agent/config", async (request, reply) => {
    const node = await authenticateNode(request);
    if (!node) return reply.status(401).send({ error: "INVALID_NODE_TOKEN" });
    await db.nodeAgent.update({
      where: { id: node.id },
      data: {
        lastSeenAt: new Date(),
        status: node.status === "PENDING" ? "ONLINE" : node.status,
      },
    });
    return reply.send(buildAgentConfig(node, node.store));
  });

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
