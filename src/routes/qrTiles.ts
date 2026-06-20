import { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { z } from "zod";
import bcrypt from "bcrypt";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { getOrderingMode, invalidateStoreCache } from "../lib/store.js";
import { serializeRole } from "../lib/roles.js";

const adminOnly = [authMiddleware, requireRole(["manager", "architect"])];
const architectOnly = [authMiddleware, requireRole(["architect"])];

const QR_CODE_REGEX = /^GT-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/;
const QR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const QR_SEGMENT_LEN = 4;

const manualPublicCodeSchema = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine((value) => QR_CODE_REGEX.test(value), {
    message: "QR code must use the format GT-XXXX-XXXX",
  });

const generateTilesSchema = z
  .object({
    count: z.coerce.number().int().min(1).max(500).optional(),
    publicCodes: z.array(manualPublicCodeSchema).min(1).max(500).optional(),
  })
  .refine((value) => Boolean(value.count) !== Boolean(value.publicCodes), {
    message: "Provide either count or publicCodes",
  })
  .refine(
    (value) => !value.publicCodes || new Set(value.publicCodes).size === value.publicCodes.length,
    { message: "Manual QR codes must be unique" }
  );

const createStoreSchema = z.object({
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(255),
  defaultPassword: z.string().min(8).max(200),
  currencyCode: z.string().trim().min(1).max(8).default("EUR"),
  locale: z.string().trim().min(1).max(16).default("el"),
  printerTopic: z.string().trim().min(1).max(255).default("printer_1"),
  tableCount: z.coerce.number().int().min(1).max(200).default(10),
  managerEmail: z.string().email().optional(),
  waiterEmail: z.string().email().optional(),
  cookEmail: z.string().email().optional(),
});

const storeUserRoleSchema = z.enum(["MANAGER", "WAITER", "COOK", "HYBRID"]);

const storeUserCreateSchema = z.object({
  email: z.string().email(),
  password: z.string().min(4).max(200),
  displayName: z.string().trim().min(1).max(255),
  role: storeUserRoleSchema.default("WAITER"),
});

const storeUserUpdateSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(4).max(200).optional(),
  displayName: z.string().trim().min(1).max(255).optional(),
  role: storeUserRoleSchema.optional(),
});

const updateSchema = z
  .object({
    storeId: z.string().uuid().nullable().optional(),
    tableId: z.string().uuid().nullable().optional(),
    isActive: z.boolean().optional(),
    label: z.string().trim().max(255).nullable().optional(),
  })
  .refine(
    (val) =>
      typeof val.storeId !== "undefined" ||
      typeof val.tableId !== "undefined" ||
      typeof val.isActive !== "undefined" ||
      typeof val.label !== "undefined",
    { message: "No fields provided" }
  );

const purgeStoreHistorySchema = z.object({
  confirmation: z.string().trim().min(1).max(255),
});

const normalizePublicCode = (value: string) => (value || "").trim().toUpperCase();

function serializeStoreUser(profile: any) {
  return {
    id: profile.id,
    storeId: profile.storeId,
    email: profile.email,
    displayName: profile.displayName ?? "",
    role: serializeRole(profile.role),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function randomQrSegment(length = QR_SEGMENT_LEN) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += QR_ALPHABET[Math.floor(Math.random() * QR_ALPHABET.length)];
  }
  return out;
}

function generatePublicCodeCandidate() {
  return `GT-${randomQrSegment()}-${randomQrSegment()}`;
}

async function generateUniquePublicCodes(count: number) {
  const selected: string[] = [];
  const selectedSet = new Set<string>();
  let guard = 0;

  while (selected.length < count) {
    guard += 1;
    if (guard > 1000) {
      throw new Error("FAILED_TO_GENERATE_UNIQUE_CODES");
    }

    const remaining = count - selected.length;
    const batchSize = Math.max(remaining * 3, 20);
    const candidates: string[] = [];
    while (candidates.length < batchSize) {
      candidates.push(generatePublicCodeCandidate());
    }

    const uniqueCandidates = Array.from(new Set(candidates)).filter(
      (code) => !selectedSet.has(code)
    );
    if (uniqueCandidates.length === 0) continue;

    const existing = await db.qRTile.findMany({
      where: { publicCode: { in: uniqueCandidates } },
      select: { publicCode: true },
    });
    const existingSet = new Set(existing.map((row) => row.publicCode));

    for (const code of uniqueCandidates) {
      if (existingSet.has(code) || selectedSet.has(code)) continue;
      if (!QR_CODE_REGEX.test(code)) continue;
      selected.push(code);
      selectedSet.add(code);
      if (selected.length >= count) break;
    }
  }

  return selected;
}

function wantsJsonResponse(request: any) {
  const accept = String(request?.headers?.accept || "").toLowerCase();
  if (!accept) return true;
  if (accept.includes("text/html") || accept.includes("application/xhtml+xml")) {
    return false;
  }
  if (
    accept.includes("application/json") ||
    accept.includes("text/json") ||
    accept.includes("+json")
  ) {
    return true;
  }
  return true;
}

function serializeTile(tile: any) {
  return {
    id: tile.id,
    storeId: tile.storeId ?? null,
    storeSlug: tile.store?.slug ?? null,
    storeName: tile.store?.name ?? null,
    publicCode: tile.publicCode,
    label: tile.label ?? null,
    isActive: tile.isActive,
    tableId: tile.tableId ?? null,
    tableLabel: tile.table?.label ?? null,
    createdAt: tile.createdAt,
    updatedAt: tile.updatedAt,
  };
}

async function createTiles(
  storeId: string | null,
  count?: number,
  publicCodes?: string[]
) {
  const generatedCodes = publicCodes ?? await generateUniquePublicCodes(count ?? 0);

  if (publicCodes) {
    const existing = await db.qRTile.findFirst({
      where: { publicCode: { in: publicCodes } },
      select: { publicCode: true },
    });
    if (existing) {
      const error = new Error(`QR code ${existing.publicCode} already exists`) as Error & {
        code: string;
      };
      error.code = "PUBLIC_CODE_ALREADY_EXISTS";
      throw error;
    }
  }

  const created = await db.$transaction(async (tx) => {
    const tiles: any[] = [];
    for (const publicCode of generatedCodes) {
      const tile = await tx.qRTile.create({
        data: storeId
          ? {
              storeId,
              publicCode,
              label: null,
            }
          : {
              publicCode,
              label: null,
            },
      });
      tiles.push(tile);
    }
    return tiles;
  });

  return db.qRTile.findMany({
    where: { id: { in: created.map((tile) => tile.id) } },
    include: {
      store: { select: { slug: true, name: true } },
      table: { select: { id: true, label: true } },
    },
    orderBy: { createdAt: "desc" },
  });
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
  fastify.post(
    "/admin/stores",
    { preHandler: architectOnly },
    async (request, reply) => {
      const body = createStoreSchema.parse(request.body ?? {});
      const existing = await db.store.findUnique({ where: { slug: body.slug } });
      if (existing) {
        return reply.status(409).send({ error: "STORE_ALREADY_EXISTS", id: existing.id });
      }

      const passwordHash = await bcrypt.hash(body.defaultPassword, 10);
      const store = await db.$transaction(async (tx) => {
        const createdStore = await tx.store.create({
          data: {
            slug: body.slug,
            name: body.name,
            settingsJson: { orderingMode: "hybrid", printers: [body.printerTopic] },
          },
        });
        await tx.storeMeta.create({
          data: {
            storeId: createdStore.id,
            currencyCode: body.currencyCode,
            locale: body.locale,
          },
        });
        const manager = await tx.profile.create({
          data: {
            storeId: createdStore.id,
            email: body.managerEmail ?? `manager@${body.slug}.local`,
            passwordHash,
            role: Role.MANAGER,
            displayName: `${body.name} Manager`,
            isVerified: true,
          },
        });
        const waiter = await tx.profile.create({
          data: {
            storeId: createdStore.id,
            email: body.waiterEmail ?? `waiter@${body.slug}.local`,
            passwordHash,
            role: Role.WAITER,
            displayName: `${body.name} Waiter`,
            isVerified: true,
          },
        });
        const cook = await tx.profile.create({
          data: {
            storeId: createdStore.id,
            email: body.cookEmail ?? `cook@${body.slug}.local`,
            passwordHash,
            role: Role.COOK,
            displayName: `${body.name} Cook`,
            printerTopic: body.printerTopic,
            isVerified: true,
          },
        });

        for (let i = 1; i <= body.tableCount; i += 1) {
          const table = await tx.table.create({
            data: { storeId: createdStore.id, label: `T${i}`, isActive: true },
          });
          await tx.waiterTable.create({
            data: {
              storeId: createdStore.id,
              waiterId: waiter.id,
              tableId: table.id,
            },
          });
        }

        return { createdStore, manager, waiter, cook };
      });
      invalidateStoreCache(body.slug);

      return reply.status(201).send({
        store: {
          id: store.createdStore.id,
          slug: store.createdStore.slug,
          name: store.createdStore.name,
        },
        profiles: {
          manager: store.manager.email,
          waiter: store.waiter.email,
          cook: store.cook.email,
        },
        tableCount: body.tableCount,
      });
    }
  );

  fastify.get(
    "/admin/stores/:storeId/users",
    { preHandler: architectOnly },
    async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const store = await db.store.findUnique({ where: { id: storeId } });
      if (!store) return reply.status(404).send({ error: "STORE_NOT_FOUND" });
      const users = await db.profile.findMany({
        where: {
          storeId,
          role: { in: [Role.MANAGER, Role.WAITER, Role.COOK, Role.HYBRID] },
        },
        orderBy: [{ role: "asc" }, { displayName: "asc" }],
      });
      return reply.send({ users: users.map(serializeStoreUser) });
    }
  );

  fastify.post(
    "/admin/stores/:storeId/users",
    { preHandler: architectOnly },
    async (request, reply) => {
      try {
        const { storeId } = request.params as { storeId: string };
        const body = storeUserCreateSchema.parse(request.body ?? {});
        const store = await db.store.findUnique({ where: { id: storeId } });
        if (!store) return reply.status(404).send({ error: "STORE_NOT_FOUND" });
        const user = await db.profile.create({
          data: {
            storeId,
            email: body.email.toLowerCase(),
            passwordHash: await bcrypt.hash(body.password, 10),
            role: body.role as Role,
            displayName: body.displayName,
            isVerified: true,
          },
        });
        return reply.status(201).send({ user: serializeStoreUser(user) });
      } catch (error: any) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: "Invalid request", details: error.errors });
        }
        if (error?.code === "P2002") {
          return reply.status(409).send({ error: "USER_ALREADY_EXISTS" });
        }
        fastify.log.error(error, "Failed to create store user");
        return reply.status(500).send({ error: "Failed to create store user" });
      }
    }
  );

  fastify.patch(
    "/admin/stores/:storeId/users/:userId",
    { preHandler: architectOnly },
    async (request, reply) => {
      try {
        const { storeId, userId } = request.params as { storeId: string; userId: string };
        const body = storeUserUpdateSchema.parse(request.body ?? {});
        const existing = await db.profile.findFirst({ where: { id: userId, storeId } });
        if (!existing) return reply.status(404).send({ error: "USER_NOT_FOUND" });
        const data: any = {};
        if (body.email) data.email = body.email.toLowerCase();
        if (body.displayName) data.displayName = body.displayName;
        if (body.password) data.passwordHash = await bcrypt.hash(body.password, 10);
        if (body.role) {
          data.role = body.role as Role;
          if (body.role !== "WAITER" && body.role !== "HYBRID") data.waiterTypeId = null;
          if (body.role !== "COOK" && body.role !== "HYBRID") {
            data.cookTypeId = null;
            data.printerTopic = null;
          }
        }
        const user = await db.profile.update({ where: { id: userId }, data });
        return reply.send({ user: serializeStoreUser(user) });
      } catch (error: any) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: "Invalid request", details: error.errors });
        }
        if (error?.code === "P2002") {
          return reply.status(409).send({ error: "USER_ALREADY_EXISTS" });
        }
        fastify.log.error(error, "Failed to update store user");
        return reply.status(500).send({ error: "Failed to update store user" });
      }
    }
  );

  fastify.delete(
    "/admin/stores/:storeId/users/:userId",
    { preHandler: architectOnly },
    async (request, reply) => {
      try {
        const { storeId, userId } = request.params as { storeId: string; userId: string };
        const existing = await db.profile.findFirst({ where: { id: userId, storeId } });
        if (!existing) return reply.status(404).send({ error: "USER_NOT_FOUND" });
        await db.$transaction(async (tx) => {
          await tx.auditLog.updateMany({
            where: { actorProfileId: userId },
            data: { actorProfileId: null },
          });
          await tx.waiterTable.deleteMany({ where: { waiterId: userId } });
          await tx.waiterShift.deleteMany({ where: { waiterId: userId } });
          await tx.profile.delete({ where: { id: userId } });
        });
        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error, "Failed to delete store user");
        return reply.status(500).send({ error: "Failed to delete store user" });
      }
    }
  );

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
    const normalizedCode = normalizePublicCode(publicCode);
    const prefersJson = wantsJsonResponse(request);

    try {
      const tile = await db.qRTile.findUnique({
        where: { publicCode: normalizedCode },
        include: {
          store: { select: { id: true, slug: true } },
          table: { select: { id: true, label: true, isActive: true } },
        },
      });

      if (!tile || !tile.isActive) {
        if (prefersJson) {
          return reply.status(404).send({ error: "QR_TILE_NOT_FOUND_OR_INACTIVE" });
        }
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

      const hasActiveTable = Boolean(tile.tableId && tile.table && tile.table.isActive);
      if (!hasActiveTable) {
        if (prefersJson) {
          return reply.send({
            status: "UNASSIGNED_TILE",
            storeSlug: tile.store?.slug,
            publicCode: tile.publicCode,
          });
        }
        return reply
          .type("text/html")
          .send(
            renderPublicMessage(
              "Unassigned QR",
              "This QR tile is not assigned to a table yet."
            )
          );
      }

      if (prefersJson) {
        return reply.send({
          status: "OK",
          storeSlug: tile.store?.slug,
          tableId: tile.tableId,
          tableLabel: tile.table?.label ?? "",
          publicCode: tile.publicCode,
        });
      }

      const target = buildPublicRedirectUrl(
        tile.store?.slug || "",
        tile.tableId as string,
        request.headers.host,
        (request as any).protocol
      );
      return reply.redirect(302, target);
    } catch (error) {
      fastify.log.error(
        { err: error, publicCode: normalizedCode },
        "Failed to resolve public QR code"
      );
      if (prefersJson) {
        return reply.status(500).send({ error: "FAILED_TO_RESOLVE_QR_TILE" });
      }
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

  fastify.get(
    "/admin/stores",
    { preHandler: adminOnly },
    async (_request, reply) => {
      const stores = await db.store.findMany({
        select: { id: true, slug: true, name: true, settingsJson: true },
        orderBy: { name: "asc" },
      });
      return reply.send({
        stores: stores.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          orderingMode: getOrderingMode(s as any),
          printers:
            Array.isArray((s as any)?.settingsJson?.printers) &&
            ((s as any).settingsJson.printers as any[]).every((p) => typeof p === "string")
              ? ((s as any).settingsJson.printers as string[])
              : [],
        })),
      });
    }
  );

  fastify.get(
    "/admin/stores/overview",
    { preHandler: adminOnly },
    async (_request, reply) => {
      const stores = await db.store.findMany({
        select: { id: true, slug: true, name: true },
        orderBy: { name: "asc" },
      });

      const safeGroupBy = async <T>(fn: () => Promise<T>, label: string): Promise<T> => {
        try {
          return await fn();
        } catch (error: any) {
          if (error?.code === "P2021" || error?.code === "P2022") {
            fastify.log.warn({ err: error }, `${label} table missing; skipping counts`);
            return [] as any;
          }
          throw error;
        }
      };

      const [profileCounts, tileCounts, orderCounts] = await Promise.all([
        safeGroupBy(
          () =>
            db.profile.groupBy({
              by: ["storeId"],
              where: { storeId: { not: null } },
              _count: { _all: true },
            }),
          "profiles"
        ),
        safeGroupBy(
          () =>
            db.qRTile.groupBy({
              by: ["storeId"],
              _count: { _all: true },
            }),
          "qr_tiles"
        ),
        safeGroupBy(
          () =>
            db.order.groupBy({
              by: ["storeId"],
              _count: { _all: true },
            }),
          "orders"
        ),
      ]);

      const profileMap = new Map(
        (profileCounts as Array<{ storeId: string; _count: { _all: number } }>).map((row) => [
          row.storeId,
          row._count._all,
        ])
      );
      const tileMap = new Map(
        (tileCounts as Array<{ storeId: string; _count: { _all: number } }>).map((row) => [
          row.storeId,
          row._count._all,
        ])
      );
      const orderMap = new Map(
        (orderCounts as Array<{ storeId: string; _count: { _all: number } }>).map((row) => [
          row.storeId,
          row._count._all,
        ])
      );

      return reply.send({
        stores: stores.map((store) => ({
          id: store.id,
          slug: store.slug,
          name: store.name,
          usersCount: profileMap.get(store.id) ?? 0,
          tilesCount: tileMap.get(store.id) ?? 0,
          ordersCount: orderMap.get(store.id) ?? 0,
        })),
      });
    }
  );

  fastify.delete(
    "/admin/stores/:storeId/history",
    { preHandler: architectOnly },
    async (request, reply) => {
      try {
        const { storeId } = request.params as { storeId: string };
        const body = purgeStoreHistorySchema.parse(request.body ?? {});
        const store = await db.store.findUnique({
          where: { id: storeId },
          select: { id: true, slug: true, name: true },
        });
        if (!store) {
          return reply.status(404).send({ error: "STORE_NOT_FOUND" });
        }

        const expectedConfirmation = `DELETE HISTORY ${store.slug}`;
        if (body.confirmation !== expectedConfirmation) {
          return reply.status(400).send({
            error: "CONFIRMATION_MISMATCH",
            expected: expectedConfirmation,
          });
        }

        const actorId =
          typeof (request as any)?.user?.userId === "string"
            ? (request as any).user.userId
            : null;

        const result = await db.$transaction(async (tx: any) => {
          const [
            orders,
            tableVisits,
            localityApprovals,
            waiterShifts,
            kitchenTicketSeqs,
            auditLogs,
            nodeAgentEvents,
          ] = await Promise.all([
            tx.order.count({ where: { storeId } }),
            tx.tableVisit.count({ where: { storeId } }),
            tx.localityApproval.count({ where: { storeId } }),
            tx.waiterShift.count({ where: { storeId } }),
            tx.kitchenTicketSeq.count({ where: { storeId } }),
            tx.auditLog.count({ where: { storeId } }),
            tx.nodeAgentEvent.count({ where: { storeId } }),
          ]);

          await tx.localityApproval.deleteMany({ where: { storeId } });
          await tx.tableVisit.deleteMany({ where: { storeId } });
          await tx.waiterShift.deleteMany({ where: { storeId } });
          await tx.kitchenTicketSeq.deleteMany({ where: { storeId } });
          await tx.nodeAgentEvent.deleteMany({ where: { storeId } });
          await tx.auditLog.deleteMany({ where: { storeId } });
          await tx.order.deleteMany({ where: { storeId } });

          await tx.auditLog.create({
            data: {
              storeId,
              action: "store.history_purged",
              entityType: "store",
              entityId: storeId,
              actorProfileId: actorId,
              metaJson: {
                storeSlug: store.slug,
                storeName: store.name,
                deleted: {
                  orders,
                  tableVisits,
                  localityApprovals,
                  waiterShifts,
                  kitchenTicketSeqs,
                  auditLogs,
                  nodeAgentEvents,
                },
              },
            },
          });

          return {
            orders,
            tableVisits,
            localityApprovals,
            waiterShifts,
            kitchenTicketSeqs,
            auditLogs,
            nodeAgentEvents,
          };
        });

        return reply.send({
          success: true,
          store: { id: store.id, slug: store.slug, name: store.name },
          deleted: result,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        fastify.log.error(error, "Failed to purge store history");
        return reply.status(500).send({ error: "Failed to purge store history" });
      }
    }
  );

  fastify.get(
    "/admin/qr-tiles",
    { preHandler: architectOnly },
    async (_request, reply) => {
      const tiles = await db.qRTile.findMany({
        include: {
          store: { select: { slug: true, name: true } },
          table: { select: { id: true, label: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({
        tiles: tiles.map(serializeTile),
      });
    }
  );

  fastify.post(
    "/admin/qr-tiles/bulk",
    { preHandler: architectOnly },
    async (request, reply) => {
      try {
        const body = generateTilesSchema.parse(request.body ?? {});
        const created = await createTiles(null, body.count, body.publicCodes);
        return reply.status(201).send({
          tiles: created.map(serializeTile),
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        if (["P2002", "PUBLIC_CODE_ALREADY_EXISTS"].includes((error as any)?.code)) {
          return reply
            .status(409)
            .send({ error: (error as Error).message || "QR code already exists" });
        }
        fastify.log.error(error, "Failed to generate global QR tiles");
        return reply.status(500).send({ error: "Failed to generate QR tiles" });
      }
    }
  );

  fastify.patch(
    "/admin/stores/:storeId/ordering-mode",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const body = z
        .object({
          orderingMode: z.enum(["qr", "waiter", "hybrid"]),
        })
        .parse(request.body ?? {});

      const store = await db.store.findUnique({
        where: { id: storeId },
        select: { id: true, settingsJson: true },
      });
      if (!store) {
        return reply.status(404).send({ error: "STORE_NOT_FOUND" });
      }

      const nextSettings = {
        ...(store.settingsJson && typeof store.settingsJson === "object"
          ? store.settingsJson
          : {}),
        orderingMode: body.orderingMode,
      };

      const updated = await db.store.update({
        where: { id: storeId },
        data: { settingsJson: nextSettings },
        select: { id: true, slug: true, name: true, settingsJson: true },
      });

      invalidateStoreCache(updated.slug);

      return reply.send({
        store: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          orderingMode: getOrderingMode(updated as any),
          printers:
            Array.isArray((updated as any)?.settingsJson?.printers) &&
            ((updated as any).settingsJson.printers as any[]).every((p) => typeof p === "string")
              ? ((updated as any).settingsJson.printers as string[])
              : [],
          settings: updated.settingsJson,
        },
      });
    }
  );

  fastify.patch(
    "/admin/stores/:storeId/printers",
    { preHandler: adminOnly },
    async (request, reply) => {
      const { storeId } = request.params as { storeId: string };
      const body = z
        .object({
          printers: z
            .array(z.string().trim().max(255))
            .transform((arr) =>
              Array.from(
                new Set(
                  arr
                    .map((p) => p.trim())
                    .filter((p) => p.length > 0)
                )
              )
            ),
        })
        .parse(request.body ?? {});

      const store = await db.store.findUnique({
        where: { id: storeId },
        select: { id: true, slug: true, name: true, settingsJson: true },
      });
      if (!store) {
        return reply.status(404).send({ error: "STORE_NOT_FOUND" });
      }

      const nextSettings = {
        ...(store.settingsJson && typeof store.settingsJson === "object" ? store.settingsJson : {}),
        printers: body.printers,
      };

      const updated = await db.store.update({
        where: { id: storeId },
        data: { settingsJson: nextSettings },
        select: { id: true, slug: true, name: true, settingsJson: true },
      });

      invalidateStoreCache(updated.slug);

      return reply.send({
        store: {
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          orderingMode: getOrderingMode(updated as any),
          settings: updated.settingsJson,
        },
      });
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
          store: { select: { slug: true, name: true } },
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
        const body = generateTilesSchema.parse(request.body ?? {});

        const store = await db.store.findUnique({
          where: { id: storeId },
          select: { id: true, slug: true },
        });
        if (!store) {
          return reply.status(404).send({ error: "STORE_NOT_FOUND" });
        }

        const hydrated = await createTiles(store.id, body.count, body.publicCodes);

        return reply
          .status(201)
          .send({ tiles: hydrated.map(serializeTile) });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        if (["P2002", "PUBLIC_CODE_ALREADY_EXISTS"].includes((error as any)?.code)) {
          return reply
            .status(409)
            .send({ error: (error as Error).message || "QR code already exists" });
        }
        fastify.log.error(error, "Failed to generate QR tiles");
        return reply.status(500).send({ error: "Failed to generate QR tiles" });
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
        const userRole = String((request as any)?.user?.role || "").toLowerCase();

        const tile = await db.qRTile.findUnique({
          where: { id },
          include: {
            store: { select: { id: true, slug: true, name: true } },
            table: { select: { id: true, label: true } },
          },
        });

        if (!tile) {
          return reply.status(404).send({ error: "QR_TILE_NOT_FOUND" });
        }

        if (typeof body.storeId !== "undefined" && userRole !== "architect") {
          return reply
            .status(403)
            .send({ error: "Only architects can change venue bindings" });
        }

        const updateData: any = {};
        if (typeof body.isActive !== "undefined") {
          updateData.isActive = body.isActive;
        }
        if (typeof body.label !== "undefined") {
          updateData.label = body.label?.trim() ? body.label.trim() : null;
        }

        let nextStoreId =
          typeof body.storeId !== "undefined" ? body.storeId : tile.storeId ?? null;
        const hasStoreChange =
          typeof body.storeId !== "undefined" && body.storeId !== (tile.storeId ?? null);

        if (typeof body.storeId !== "undefined" && body.storeId) {
          const store = await db.store.findUnique({
            where: { id: body.storeId },
            select: { id: true },
          });
          if (!store) {
            return reply.status(400).send({ error: "STORE_NOT_FOUND" });
          }
        }

        if (body.storeId === null) {
          nextStoreId = null;
          updateData.storeId = null;
          updateData.tableId = null;
        } else if (typeof body.tableId !== "undefined") {
          if (body.tableId === null) {
            updateData.tableId = null;
            if (typeof body.storeId !== "undefined") {
              updateData.storeId = nextStoreId;
            }
          } else {
            const table = await db.table.findUnique({
              where: { id: body.tableId },
              select: { id: true, storeId: true },
            });
            if (!table) {
              return reply.status(400).send({ error: "TABLE_NOT_FOUND" });
            }
            if (nextStoreId && table.storeId !== nextStoreId) {
              return reply
                .status(400)
                .send({ error: "TABLE_NOT_FOUND_FOR_STORE" });
            }
            updateData.storeId = table.storeId;
            updateData.tableId = table.id;
            nextStoreId = table.storeId;
          }
        } else if (typeof body.storeId !== "undefined") {
          updateData.storeId = nextStoreId;
          if (hasStoreChange) {
            updateData.tableId = null;
          }
        }

        const updated = await db.qRTile.update({
          where: { id },
          data: updateData,
          include: {
            store: { select: { slug: true, name: true } },
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
