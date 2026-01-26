import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { emitRealtime } from "../lib/realtime.js";
import { ipWhitelistMiddleware } from "../middleware/ipWhitelist.js";
import { db } from "../db/index.js";

const PUBLIC_EVENTS = [
  "locality_gate_opened",
  "locality_scan_started",
  "locality_scan_succeeded",
  "locality_scan_failed",
  "locality_approved",
  "order_submit_attempted",
  "order_submit_succeeded",
  "order_submit_failed",
] as const;

const publicEventSchema = z.object({
  event: z.enum(PUBLIC_EVENTS),
  storeSlug: z.string().trim().max(120).optional(),
  tableId: z.string().uuid().optional(),
  sessionId: z.string().trim().max(128).optional(),
  deviceType: z.string().trim().max(64).optional(),
  platform: z.string().trim().max(32).optional(),
  method: z.string().trim().max(16).optional(),
  ts: z.string().optional(),
  meta: z.record(z.any()).optional(),
});

export async function eventsRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/events/publish",
    {
      preHandler: [authMiddleware, requireRole(["waiter", "cook", "manager", "architect"])],
    },
    async (request, reply) => {
      try {
        const body = z
          .object({
            topic: z.string().min(1),
            payload: z.any().optional(),
          })
          .parse(request.body ?? {});

        emitRealtime(body.topic, body.payload ?? {});

        return reply.send({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        fastify.log.error(error, "Failed to publish realtime event");
        return reply
          .status(500)
          .send({ error: "Failed to publish realtime event" });
      }
    }
  );

  fastify.post(
    "/public/events",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const body = publicEventSchema.parse(request.body ?? {});
        const storeSlug =
          typeof body.storeSlug === "string" ? body.storeSlug.trim() : "";
        let storeId: string | null = null;
        let resolvedSlug = storeSlug || null;

        if (storeSlug) {
          const store = await db.store.findUnique({
            where: { slug: storeSlug },
            select: { id: true, slug: true },
          });
          if (store) {
            storeId = store.id;
            resolvedSlug = store.slug;
          }
        }

        if (!storeId && body.tableId) {
          const table = await db.table.findUnique({
            where: { id: body.tableId },
            select: { storeId: true, store: { select: { slug: true } } },
          });
          if (table) {
            storeId = table.storeId;
            resolvedSlug = table.store?.slug ?? resolvedSlug;
          }
        }

        if (!storeId) {
          return reply.send({ ok: true, stored: false });
        }

        const meta = {
          storeSlug: resolvedSlug,
          tableId: body.tableId ?? null,
          sessionId: body.sessionId ?? null,
          deviceType: body.deviceType ?? null,
          platform: body.platform ?? null,
          method: body.method ?? null,
          ts: body.ts ?? new Date().toISOString(),
          ...(body.meta ?? {}),
        };

        await db.auditLog.create({
          data: {
            storeId,
            action: body.event,
            entityType: "locality",
            entityId: body.tableId ?? null,
            metaJson: meta,
          },
        });

        return reply.send({ ok: true, stored: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        fastify.log.error(error, "Failed to record public event");
        return reply.status(500).send({ error: "Failed to record event" });
      }
    }
  );
}
