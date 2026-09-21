import { randomBytes } from "node:crypto";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import {
  QrEventError, exportQrEvent, importQrEventBundle, matchesQrSyncToken,
  qrEventBundleSchema, qrEventCreateSchema, qrEventIdSchema, qrEventPatchSchema,
  qrSyncTokenHash, requireEvent, serializeQrEvent, validateEventTables,
} from "../lib/qrEvents.js";

const architectOnly = [authMiddleware, requireRole(["architect"])];
const storeParams = z.object({ storeId: z.string().uuid() });
const eventParams = z.object({ eventId: qrEventIdSchema });

function guarded(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try { return await handler(request, reply); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.status(400).send({ error: "INVALID_QR_EVENT", issues: error.issues.map(({ path, message }) => ({ path, message })) });
      if (error instanceof QrEventError) return reply.status(error.statusCode).send({ error: error.code });
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
        return reply.status(409).send({ error: "QR_EVENT_CONFLICT" });
      }
      throw error;
    }
  };
}

async function audit(tx: Prisma.TransactionClient, request: FastifyRequest, storeId: string, eventId: string, action: string, revision: number) {
  const user = (request as any).user;
  const actorProfileId = z.string().uuid().safeParse(user?.userId);
  await tx.auditLog.create({ data: {
    storeId, entityType: "qr_event", entityId: eventId, action,
    actorProfileId: actorProfileId.success ? actorProfileId.data : null,
    metaJson: { revision },
  } });
}

function requireEditable(event: { isImported: boolean }) {
  if (event.isImported) throw new QrEventError(409, "QR_IMPORTED_EVENT_READ_ONLY");
}

async function authenticatedSyncEvent(request: FastifyRequest) {
  const { eventId } = eventParams.parse(request.params);
  const header = request.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const event = await db.qrEvent.findUnique({ where: { id: eventId }, include: { store: { select: { slug: true, name: true } } } });
  if (!event || !matchesQrSyncToken(token, event.syncTokenHash)) throw new QrEventError(401, "INVALID_QR_SYNC_TOKEN");
  return event;
}

export async function qrEventRoutes(fastify: FastifyInstance) {
  fastify.get("/admin/stores/:storeId/qr-events", { preHandler: architectOnly }, guarded(async (request) => {
    const { storeId } = storeParams.parse(request.params);
    if (!await db.store.findUnique({ where: { id: storeId }, select: { id: true } })) throw new QrEventError(404, "STORE_NOT_FOUND");
    const events = await db.qrEvent.findMany({ where: { storeId }, include: { store: { select: { slug: true, name: true } } }, orderBy: { updatedAt: "desc" }, take: 500 });
    return { events: events.map(serializeQrEvent) };
  }));

  fastify.post("/admin/stores/:storeId/qr-events", { preHandler: architectOnly }, guarded(async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const { assignments, ...fields } = qrEventCreateSchema.parse(request.body);
    const event = await db.$transaction(async (tx) => {
      if (!await tx.store.findUnique({ where: { id: storeId }, select: { id: true } })) throw new QrEventError(404, "STORE_NOT_FOUND");
      await validateEventTables(storeId, assignments, tx);
      const created = await tx.qrEvent.create({ data: { ...fields, storeId, assignmentsJson: assignments }, include: { store: { select: { slug: true, name: true } } } });
      await audit(tx, request, storeId, created.id, "QR_EVENT_CREATED", created.revision);
      return created;
    });
    return reply.status(201).send({ event: serializeQrEvent(event) });
  }));

  fastify.get("/admin/qr-events/:eventId", { preHandler: architectOnly }, guarded(async (request) => {
    const { eventId } = eventParams.parse(request.params);
    return { event: serializeQrEvent(await requireEvent(eventId)) };
  }));

  fastify.patch("/admin/qr-events/:eventId", { preHandler: architectOnly }, guarded(async (request) => {
    const { eventId } = eventParams.parse(request.params);
    const { expectedRevision, assignments, ...fields } = qrEventPatchSchema.parse(request.body);
    const event = await db.$transaction(async (tx) => {
      const current = await requireEvent(eventId, tx);
      requireEditable(current);
      if (current.revision !== expectedRevision) throw new QrEventError(409, "QR_EVENT_REVISION_CONFLICT");
      if (assignments) await validateEventTables(current.storeId, assignments, tx);
      const updated = await tx.qrEvent.updateMany({ where: { id: eventId, revision: expectedRevision, isImported: false }, data: {
        ...fields, ...(assignments ? { assignmentsJson: assignments } : {}), revision: { increment: 1 },
      } });
      if (updated.count !== 1) throw new QrEventError(409, "QR_EVENT_REVISION_CONFLICT");
      const result = await requireEvent(eventId, tx);
      await audit(tx, request, result.storeId, eventId, "QR_EVENT_UPDATED", result.revision);
      return result;
    });
    return { event: serializeQrEvent(event) };
  }));

  fastify.get("/admin/qr-events/:eventId/export", { preHandler: architectOnly }, guarded(async (request) => {
    const { eventId } = eventParams.parse(request.params);
    return { bundle: exportQrEvent(await requireEvent(eventId)) };
  }));

  fastify.post("/admin/qr-events/import", { preHandler: architectOnly }, guarded(async (request) => {
    const { bundle } = z.object({ bundle: qrEventBundleSchema }).strict().parse(request.body);
    const actorId = z.string().uuid().safeParse((request as any).user?.userId);
    const result = await importQrEventBundle(bundle, actorId.success ? actorId.data : null);
    return { event: serializeQrEvent(result.event), unchanged: result.unchanged };
  }));

  fastify.post("/admin/qr-events/:eventId/pairing", { preHandler: architectOnly }, guarded(async (request) => {
    const { eventId } = eventParams.parse(request.params);
    const token = randomBytes(32).toString("base64url");
    await db.$transaction(async (tx) => {
      const event = await requireEvent(eventId, tx);
      requireEditable(event);
      await tx.qrEvent.update({ where: { id: eventId }, data: { syncTokenHash: qrSyncTokenHash(token), lastAppliedRevision: 0, lastAppliedAt: null } });
      await audit(tx, request, event.storeId, eventId, "QR_EVENT_PAIRING_ROTATED", event.revision);
    });
    return { token };
  }));

  fastify.delete("/admin/qr-events/:eventId/pairing", { preHandler: architectOnly }, guarded(async (request) => {
    const { eventId } = eventParams.parse(request.params);
    await db.$transaction(async (tx) => {
      const event = await requireEvent(eventId, tx);
      requireEditable(event);
      await tx.qrEvent.update({ where: { id: eventId }, data: { syncTokenHash: null } });
      await audit(tx, request, event.storeId, eventId, "QR_EVENT_PAIRING_REVOKED", event.revision);
    });
    return { ok: true };
  }));

  fastify.get("/qr-sync/events/:eventId", guarded(async (request) => {
    const event = await authenticatedSyncEvent(request);
    return { bundle: exportQrEvent(event) };
  }));

  fastify.post("/qr-sync/events/:eventId/ack", guarded(async (request) => {
    const event = await authenticatedSyncEvent(request);
    const { appliedRevision } = z.object({ appliedRevision: z.number().int().min(1).max(2147483646) }).strict().parse(request.body);
    if (appliedRevision > event.revision) throw new QrEventError(400, "QR_ACK_REVISION_OUT_OF_RANGE");
    // Keep acknowledgements monotonic and reject a token revoked during the request.
    const updated = await db.qrEvent.updateMany({ where: {
      id: event.id, syncTokenHash: event.syncTokenHash, lastAppliedRevision: { lte: appliedRevision },
    }, data: { lastAppliedRevision: appliedRevision, lastAppliedAt: new Date() } });
    if (!updated.count) throw new QrEventError(409, "QR_ACK_CONFLICT");
    return { ok: true, appliedRevision };
  }));
}
