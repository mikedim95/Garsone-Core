import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { ipWhitelistMiddleware } from "../middleware/ipWhitelist.js";

const APPROVAL_TTL_SECONDS = (() => {
  const raw = process.env.LOCALITY_APPROVAL_TTL_SECONDS;
  const parsed = raw ? Number.parseInt(raw, 10) : 30;
  if (!Number.isFinite(parsed) || parsed <= 0) return 30;
  return parsed;
})();
const APPROVAL_TTL_MS = APPROVAL_TTL_SECONDS * 1000;
const PURPOSES = ["ORDER_SUBMIT"] as const;

const approvalSchema = z.object({
  publicCode: z.string().trim().min(2).max(64),
  tableId: z.string().uuid(),
  purpose: z.enum(PURPOSES).optional(),
  sessionId: z.string().trim().min(8).max(128),
  method: z.enum(["nfc", "qr", "link"]).optional(),
});

const normalizePublicCode = (value: string) => value.trim().toUpperCase();

function generateApprovalToken() {
  return crypto.randomBytes(24).toString("hex");
}

export async function localityRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/locality/approve",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const body = approvalSchema.parse(request.body ?? {});
        const publicCode = normalizePublicCode(body.publicCode);

        const tile = await db.qRTile.findUnique({
          where: { publicCode },
          include: {
            store: { select: { id: true, slug: true } },
            table: { select: { id: true, label: true, isActive: true } },
          },
        });

        if (!tile || !tile.isActive) {
          return reply.status(404).send({ error: "QR_TILE_NOT_FOUND_OR_INACTIVE" });
        }

        if (!tile.tableId || !tile.table || !tile.table.isActive) {
          return reply.status(409).send({ error: "QR_TILE_UNASSIGNED" });
        }

        if (tile.tableId !== body.tableId) {
          return reply.status(409).send({
            error: "WRONG_LOCATION",
            expectedTableId: tile.tableId,
          });
        }

        const requestedSlug = String(
          (request.headers as any)?.["x-store-slug"] ?? ""
        ).trim();
        if (requestedSlug && tile.store?.slug && requestedSlug !== tile.store.slug) {
          return reply.status(409).send({ error: "WRONG_STORE" });
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
        const approvalToken = generateApprovalToken();
        const purpose = body.purpose ?? "ORDER_SUBMIT";
        const method = body.method ?? "nfc";

        const approval = await db.localityApproval.create({
          data: {
            storeId: tile.storeId,
            tableId: tile.tableId,
            tileId: tile.id,
            approvalToken,
            purpose,
            method,
            sessionId: body.sessionId,
            expiresAt,
          },
        });

        return reply.send({
          approvalToken: approval.approvalToken,
          expiresAt: approval.expiresAt.toISOString(),
          purpose,
          method,
          storeSlug: tile.store?.slug ?? null,
          tableId: tile.tableId,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        fastify.log.error(error, "Failed to create locality approval");
        return reply.status(500).send({ error: "Failed to create approval" });
      }
    }
  );
}
