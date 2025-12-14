import { FastifyInstance } from "fastify";
import crypto from "crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const adminOnly = [authMiddleware, requireRole(["manager", "architect"])];

const bulkCreateSchema = z.object({
  count: z.coerce.number().int().min(1).max(500),
});

const updateSchema = z
  .object({
    tableId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
    label: z.string().trim().max(255).optional(),
  })
  .refine(
    (val) =>
      typeof val.tableId !== "undefined" ||
      typeof val.isActive !== "undefined" ||
      typeof val.label !== "undefined",
    { message: "No fields provided" }
  );

function generatePublicCode(length = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

function serializeTile(tile: any) {
  return {
    id: tile.id,
    storeId: tile.storeId,
    storeSlug: tile.store?.slug,
    publicCode: tile.publicCode,
    label: null,
    isActive: tile.isActive,
    tableId: tile.tableId,
    tableLabel: tile.table?.label ?? null,
    createdAt: tile.createdAt,
    updatedAt: tile.updatedAt,
  };
}

const PUBLIC_APP_BASE_URL = (process.env.PUBLIC_APP_BASE_URL || "").trim();
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || "").trim();
const FRONTEND_PORT = (process.env.FRONTEND_PORT || process.env.PUBLIC_APP_PORT || "").trim();
const PUBLIC_APP_DOMAIN = (process.env.PUBLIC_APP_DOMAIN || "garsone.gr")
  .replace(/^https?:\/\//i, "")
  .replace(/\/.*/, "");
const PUBLIC_APP_PROTOCOL = (process.env.PUBLIC_APP_PROTOCOL || "https")
  .replace(/:$/, "")
  .toLowerCase();

function renderPublicMessage(title: string, message: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
      .card { background: #0b1220; border: 1px solid #1f2937; border-radius: 14px; padding: 32px 28px; max-width: 520px; box-shadow: 0 25px 50px rgba(0,0,0,0.35); text-align: center; }
      h1 { font-size: 22px; margin: 0 0 12px; color: #f8fafc; }
      p { margin: 0; color: #cbd5e1; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  </body>
</html>`;
}

function buildPublicRedirectUrl(
  storeSlug: string,
  tableId: string,
  requestHost?: string,
  requestProtocol?: string
) {
  const slug = (storeSlug || "").trim() || "www";
  const params = new URLSearchParams({ storeSlug: slug });

  // If explicit base is provided, prefer it (supports {storeSlug})
  if (PUBLIC_APP_BASE_URL.length > 0) {
    const explicit = PUBLIC_APP_BASE_URL.replace("{storeSlug}", slug).replace(/\/+$/, "");
    return `${explicit}/table/${tableId}?${params.toString()}`;
  }

  // Otherwise honor FRONTEND_ORIGIN env if provided (supports {storeSlug})
  if (FRONTEND_ORIGIN.length > 0) {
    const explicit = FRONTEND_ORIGIN.replace("{storeSlug}", slug).replace(/\/+$/, "");
    return `${explicit}/table/${tableId}?${params.toString()}`;
  }

  // Fallback: derive from incoming host to support local/IP testing
  if (requestHost && requestHost.trim().length > 0) {
    const protocol = (requestProtocol || PUBLIC_APP_PROTOCOL || "http").replace(/:$/, "");
    const hostRaw = requestHost.trim();
    const [hostBase, hostPort] = hostRaw.split(":");
    const isIpOrLocal = /^(\d{1,3}\.){3}\d{1,3}$/i.test(hostBase) || /^localhost$/i.test(hostBase);
    const targetPort = FRONTEND_PORT.length > 0 ? FRONTEND_PORT : hostPort;
    const hostname = isIpOrLocal ? hostBase : `${slug}.${hostBase}`;
    const portPart = targetPort ? `:${targetPort.replace(/^:/, "")}` : hostPort ? `:${hostPort}` : "";
    return `${protocol}://${hostname}${portPart}/table/${tableId}?${params.toString()}`;
  }

  // Default production host
  return `${PUBLIC_APP_PROTOCOL}://${slug}.${PUBLIC_APP_DOMAIN}/table/${tableId}?${params.toString()}`;
}

export async function qrTileRoutes(fastify: FastifyInstance) {
  fastify.get("/publiccode/:publicCode", async (request, reply) => {
    const { publicCode } = request.params as { publicCode: string };
    const normalizedCode = (publicCode || "").trim().toUpperCase();
    try {
      const tile = await db.qRTile.findUnique({
        where: { publicCode: normalizedCode },
        include: {
          store: { select: { id: true, slug: true } },
          table: { select: { id: true, label: true, isActive: true } },
        },
      });

      if (!tile || !tile.isActive) {
        return reply
          .status(404)
          .type("text/html")
          .send(
            renderPublicMessage(
              "Code not active",
              "This code is not active or does not exist."
            )
          );
      }

      if (!tile.tableId || !tile.table || !tile.table.isActive) {
        return reply
          .type("text/html")
          .send(
            renderPublicMessage(
              "Unassigned QR",
              "This QR tile is not assigned to a table yet."
            )
          );
      }

      const target = buildPublicRedirectUrl(
        tile.store?.slug || "",
        tile.tableId,
        request.headers.host,
        (request as any).protocol
      );
      return reply.redirect(302, target);
    } catch (error) {
      fastify.log.error(
        { err: error, publicCode: normalizedCode },
        "Failed to resolve public QR code"
      );
      return reply
        .status(500)
        .type("text/html")
        .send(
          renderPublicMessage(
            "Temporary issue",
            "We could not resolve this code right now. Please try again in a moment."
          )
        );
    }
  });

  // Resolve a tableId to its store slug/label for QR redirects that lack storeSlug param
  fastify.get("/public/table/:tableId", async (request, reply) => {
    const { tableId } = request.params as { tableId: string };
    if (!tableId) {
      return reply.status(400).send({ error: "TABLE_ID_REQUIRED" });
    }
    const table = await db.table.findUnique({
      where: { id: tableId },
      select: {
        id: true,
        label: true,
        store: { select: { slug: true, name: true } },
      },
    });
    if (!table || !table.store?.slug) {
      return reply.status(404).send({ error: "TABLE_NOT_FOUND" });
    }
    return reply.send({
      tableId: table.id,
      tableLabel: table.label,
      storeSlug: table.store.slug,
      storeName: table.store.name,
    });
  });

  fastify.get("/q/:publicCode", async (request, reply) => {
    const { publicCode } = request.params as { publicCode: string };
    const tile = await db.qRTile.findUnique({
      where: { publicCode },
      include: {
        store: { select: { slug: true } },
        table: { select: { id: true, label: true } },
      },
    });

    if (!tile || !tile.isActive) {
      return reply.status(404).send({ error: "QR_TILE_NOT_FOUND_OR_INACTIVE" });
    }

    if (!tile.tableId) {
      return reply.send({
        status: "UNASSIGNED_TILE",
        storeSlug: tile.store?.slug,
        publicCode: tile.publicCode,
      });
    }

    return reply.send({
      status: "OK",
      storeSlug: tile.store?.slug,
      tableId: tile.tableId,
      tableLabel: tile.table?.label ?? "",
      publicCode: tile.publicCode,
    });
  });

  fastify.get(
    "/admin/stores",
    { preHandler: adminOnly },
    async (_request, reply) => {
      const stores = await db.store.findMany({
        select: { id: true, slug: true, name: true },
        orderBy: { name: "asc" },
      });
      return reply.send({ stores });
    }
  );

  fastify.get(
    "/admin/stores/:storeId/tables",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const store = await db.store.findUnique({
        where: { id: storeId },
        select: { id: true },
      });
      if (!store) {
        return reply.status(404).send({ error: "STORE_NOT_FOUND" });
      }
      const tables = await db.table.findMany({
        where: { storeId },
        orderBy: { label: "asc" },
        include: {
          _count: {
            select: { waiterTables: true, orders: true },
          },
        },
      });
      return reply.send({
        tables: tables.map((table) => ({
          id: table.id,
          label: table.label,
          isActive: table.isActive,
          waiterCount: (table as any)._count?.waiterTables ?? 0,
          orderCount: (table as any)._count?.orders ?? 0,
        })),
      });
    }
  );

  fastify.get(
    "/admin/stores/:storeId/qr-tiles",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const store = await db.store.findUnique({
        where: { id: storeId },
        select: { id: true, slug: true, name: true },
      });
      if (!store) {
        return reply.status(404).send({ error: "STORE_NOT_FOUND" });
      }

      const tiles = await db.qRTile.findMany({
        where: { storeId },
        include: {
          store: { select: { slug: true } },
          table: { select: { id: true, label: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({
        store,
        tiles: tiles.map(serializeTile),
      });
    }
  );

  fastify.post(
    "/admin/stores/:storeId/qr-tiles/bulk",
    { preHandler: adminOnly },
    async (request, reply) => {
      try {
        const { storeId } = request.params as { storeId: string };
        const body = bulkCreateSchema.parse(request.body ?? {});

        const store = await db.store.findUnique({
          where: { id: storeId },
          select: { id: true, slug: true },
        });
        if (!store) {
          return reply.status(404).send({ error: "STORE_NOT_FOUND" });
        }

        const created = await db.$transaction(async (tx) => {
          const tiles: any[] = [];
          const generatedCodes = new Set<string>();
          let attempts = 0;
          const maxAttempts = body.count * 250;

          while (tiles.length < body.count && attempts < maxAttempts) {
            attempts += 1;
            const publicCode = generatePublicCode(4);
            if (generatedCodes.has(publicCode)) continue;

            const exists = await tx.qRTile.findUnique({
              where: { publicCode },
              select: { id: true },
            });
            if (exists) continue;

            const tile = await tx.qRTile.create({
              data: {
                storeId: store.id,
                publicCode,
                label: null,
              },
            });
            generatedCodes.add(publicCode);
            tiles.push(tile);
          }

          if (tiles.length < body.count) {
            throw new Error("FAILED_TO_GENERATE_CODES");
          }
          return tiles;
        });

        const hydrated = await db.qRTile.findMany({
          where: { id: { in: created.map((t) => t.id) } },
          include: {
            store: { select: { slug: true } },
            table: { select: { id: true, label: true } },
          },
          orderBy: { createdAt: "desc" },
        });

        return reply
          .status(201)
          .send({ tiles: hydrated.map(serializeTile) });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        if ((error as Error)?.message === "FAILED_TO_GENERATE_CODES") {
          return reply.status(500).send({ error: "Failed to generate unique QR codes" });
        }
        fastify.log.error(error, "Failed to bulk create QR tiles");
        return reply.status(500).send({ error: "Failed to create QR tiles" });
      }
    }
  );

  fastify.patch(
    "/admin/qr-tiles/:id",
    { preHandler: adminOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = updateSchema.parse(request.body ?? {});

        const tile = await db.qRTile.findUnique({
          where: { id },
          include: {
            store: { select: { id: true, slug: true } },
            table: { select: { id: true, label: true } },
          },
        });

        if (!tile) {
          return reply.status(404).send({ error: "QR_TILE_NOT_FOUND" });
        }

        const updateData: any = {};
        if (typeof body.isActive !== "undefined") {
          updateData.isActive = body.isActive;
        }
        if (typeof body.label !== "undefined") {
          updateData.label = null;
        }
        if (typeof body.tableId !== "undefined") {
          if (body.tableId === null) {
            updateData.tableId = null;
          } else {
            const table = await db.table.findFirst({
              where: { id: body.tableId, storeId: tile.storeId },
            });
            if (!table) {
              return reply
                .status(400)
                .send({ error: "TABLE_NOT_FOUND_FOR_STORE" });
            }
            updateData.tableId = table.id;
          }
        }

        const updated = await db.qRTile.update({
          where: { id },
          data: updateData,
          include: {
            store: { select: { slug: true } },
            table: { select: { id: true, label: true } },
          },
        });

        return reply.send({ tile: serializeTile(updated) });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        fastify.log.error(error, "Failed to update QR tile");
        return reply.status(500).send({ error: "Failed to update QR tile" });
      }
    }
  );

  fastify.delete(
    "/admin/qr-tiles/:id",
    { preHandler: adminOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.qRTile.delete({ where: { id } });
        return reply.send({ ok: true });
      } catch (error) {
        if ((error as any)?.code === "P2025") {
          return reply.status(404).send({ error: "QR_TILE_NOT_FOUND" });
        }
        fastify.log.error(error, "Failed to delete QR tile");
        return reply.status(500).send({ error: "Failed to delete QR tile" });
      }
    }
  );
}
