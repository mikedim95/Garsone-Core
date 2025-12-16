import { FastifyInstance } from "fastify";
import { Prisma, OrderStatus, ShiftStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { ipWhitelistMiddleware } from "../middleware/ipWhitelist.js";
import { publishMessage, PublishOptions } from "../lib/mqtt.js";
import {
  ensureStore,
  STORE_SLUG,
  getRequestedStoreSlug,
} from "../lib/store.js";
import {
  validateTableVisitToken,
  REQUIRE_TABLE_VISIT,
} from "../lib/tableVisits.js";
import { createVivaPaymentOrder } from "../lib/viva.js";

const modifierSelectionSchema = z.record(z.string());

const createOrderSchema = z.object({
  tableId: z.string().uuid(),
  visit: z.string().trim().min(8).max(128).optional(),
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantity: z.number().int().positive(),
        modifiers: z.union([z.string(), modifierSelectionSchema]).optional(),
      })
    )
    .min(1),
  note: z.string().max(500).optional(),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(OrderStatus),
  cancelReason: z.string().trim().min(1).max(255).optional(),
  skipMqtt: z.boolean().optional(),
});

const callWaiterSchema = z.object({
  tableId: z.string().uuid(),
  visit: z.string().trim().min(8).max(128).optional(),
});

type OrderWithRelations = Prisma.OrderGetPayload<{
  include: {
    table: { select: { id: true; label: true } };
    orderItems: {
      include: {
        orderItemOptions: true;
      };
    };
  };
}>;

const STATUS_PROGRESS_FLOW: OrderStatus[] = [
  OrderStatus.PLACED,
  OrderStatus.PREPARING,
  OrderStatus.READY,
  OrderStatus.SERVED,
  OrderStatus.PAID,
];

type StatusTimestampField =
  | "preparingAt"
  | "readyAt"
  | "servedAt"
  | "paidAt"
  | "cancelledAt";

const STATUS_TIMESTAMP_FIELDS: Record<
  OrderStatus,
  StatusTimestampField | undefined
> = {
  [OrderStatus.PLACED]: undefined,
  [OrderStatus.PREPARING]: "preparingAt",
  [OrderStatus.READY]: "readyAt",
  [OrderStatus.SERVED]: "servedAt",
  [OrderStatus.PAID]: "paidAt",
  [OrderStatus.CANCELLED]: "cancelledAt",
};

const parsePositiveInt = (
  value: string | number | undefined,
  fallback: number
) => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? parseInt(value, 10)
      : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

// Increase defaults so month-long histories are returned without trimming
const ORDERS_DEFAULT_TAKE = parsePositiveInt(
  process.env.ORDERS_DEFAULT_TAKE,
  5000
);
const ORDERS_MAX_TAKE = Math.max(
  ORDERS_DEFAULT_TAKE,
  parsePositiveInt(process.env.ORDERS_MAX_TAKE, 10000)
);
const REQUIRE_VISIT_TOKEN = REQUIRE_TABLE_VISIT;

const ORDER_ITEM_INCLUDE = {
  include: {
    orderItemOptions: true,
    item: {
      select: {
        id: true,
        title: true,
        categoryId: true,
        category: {
          select: {
            title: true,
            slug: true,
          },
        },
      },
    },
  },
};

const pickHeaderToken = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

function getVisitTokenFromRequest(request: any, provided?: unknown) {
  const bodyToken = typeof provided === "string" ? provided : undefined;
  const headerToken = pickHeaderToken(
    (request?.headers as any)?.["x-table-visit"] as
      | string
      | string[]
      | undefined
  );
  const token = bodyToken || headerToken || "";
  return typeof token === "string" ? token.trim() : "";
}

function serializeOrder(order: OrderWithRelations) {
  return {
    id: order.id,
    tableId: order.tableId,
    tableLabel: order.table?.label ?? "Unknown",
    ticketNumber: (order as any).ticketNumber ?? undefined,
    status: order.status,
    note: order.note,
    totalCents: order.totalCents,
    total: order.totalCents / 100,
    placedAt: order.placedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    servedAt: order.servedAt,
    preparingAt: order.preparingAt,
    readyAt: order.readyAt,
    paidAt: order.paidAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    paymentStatus: (order as any).paymentStatus ?? "PENDING",
    paymentProvider: (order as any).paymentProvider ?? null,
    paymentId: (order as any).paymentId ?? null,
    items: order.orderItems.map((orderItem) => ({
      id: orderItem.id,
      itemId: orderItem.itemId,
      categoryId: (orderItem as any)?.item?.categoryId ?? null,
      categoryTitle: (orderItem as any)?.item?.category?.title ?? undefined,
      title: orderItem.titleSnapshot,
      unitPriceCents: orderItem.unitPriceCents,
      unitPrice: orderItem.unitPriceCents / 100,
      quantity: orderItem.quantity,
      modifiers: orderItem.orderItemOptions.map((option) => ({
        id: option.id,
        modifierId: option.modifierId,
        modifierOptionId: option.modifierOptionId,
        title: option.titleSnapshot,
        priceDeltaCents: option.priceDeltaCents,
        priceDelta: option.priceDeltaCents / 100,
      })),
    })),
  };
}

async function getWaiterIdsForTable(storeId: string, tableId: string) {
  const t0 = Date.now();
  const assignments = await db.waiterTable.findMany({
    where: { storeId, tableId },
    select: { waiterId: true },
  });
  if (assignments.length === 0) {
    console.log(
      "[orders:waiters] no assignments for table",
      tableId,
      "store",
      storeId,
      `+${Date.now() - t0}ms`
    );
  }
  return assignments.map((a) => a.waiterId);
}

function notifyWaiters(
  topic: string,
  payload: any,
  waiterIds: string[],
  options?: PublishOptions
) {
  if (waiterIds.length === 0) {
    console.log(
      "[orders:notify] topic",
      topic,
      "no waiterIds → broadcast to waiters"
    );
  }
  const baseOptions = options ?? {};
  if (waiterIds.length > 0) {
    publishMessage(topic, payload, { ...baseOptions, userIds: waiterIds });
  } else {
    publishMessage(topic, payload, { ...baseOptions, roles: ["waiter"] });
  }
}

function parseModifiers(value?: unknown) {
  if (!value) {
    return {} as Record<string, string>;
  }

  if (typeof value === "string") {
    if (value.trim().length === 0) {
      return {} as Record<string, string>;
    }

    try {
      const parsed = JSON.parse(value);
      return modifierSelectionSchema.parse(parsed);
    } catch (error) {
      throw new Error("Invalid modifiers payload");
    }
  }

  return modifierSelectionSchema.parse(value);
}

const resolveStoreSlug = (request: any) =>
  getRequestedStoreSlug(request) ||
  (request as any)?.user?.storeSlug ||
  STORE_SLUG;

export async function orderRoutes(fastify: FastifyInstance) {
  // Create order (IP whitelisted)
  fastify.post(
    "/orders",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const t0 = Date.now();
        const logStep = (label: string) =>
          console.log(`[orders:create] ${label} +${Date.now() - t0}ms`);
        const body = createOrderSchema.parse(request.body);
        logStep("parsed");
        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);
        logStep("store");

        const table = await db.table.findFirst({
          where: { id: body.tableId, storeId: store.id },
        });
        logStep("table");

        if (!table) {
          return reply.status(404).send({ error: "Table not found" });
        }

        const itemIds = body.items.map((item) => item.itemId);
        const items = await db.item.findMany({
          where: {
            storeId: store.id,
            id: { in: itemIds },
            isAvailable: true,
          },
          include: {
            itemModifiers: {
              include: {
                modifier: {
                  include: {
                    modifierOptions: true,
                  },
                },
              },
            },
          },
        });
        logStep("itemsFetched");

        const itemMap = new Map(items.map((item) => [item.id, item]));

        let orderTotalCents = 0;
        const orderItemsToCreate: Prisma.OrderItemCreateWithoutOrderInput[] =
          [];

        for (const item of body.items) {
          const dbItem = itemMap.get(item.itemId);

          if (!dbItem) {
            return reply.status(400).send({ error: "Item not available" });
          }

          const selections = parseModifiers(item.modifiers);
          const modifierLinks = new Map(
            dbItem.itemModifiers.map((link) => [link.modifierId, link])
          );

          let unitPriceCents = dbItem.priceCents;
          const orderItemOptions: Prisma.OrderItemOptionCreateWithoutOrderItemInput[] =
            [];

          for (const [modifierId, optionId] of Object.entries(selections)) {
            const link = modifierLinks.get(modifierId);

            if (!link) {
              return reply
                .status(400)
                .send({ error: "Modifier not allowed for item" });
            }

            const modifier = link.modifier;
            const option = modifier.modifierOptions.find(
              (opt) => opt.id === optionId
            );

            if (!option) {
              return reply
                .status(400)
                .send({ error: "Modifier option not found" });
            }

            unitPriceCents += option.priceDeltaCents;
            orderItemOptions.push({
              modifier: {
                connect: { id: modifier.id },
              },
              modifierOption: {
                connect: { id: option.id },
              },
              titleSnapshot: `${modifier.title}: ${option.title}`,
              priceDeltaCents: option.priceDeltaCents,
            });
          }

          const requiredModifiersMissing = dbItem.itemModifiers.some((link) => {
            const modifier = link.modifier;
            const minRequired =
              link.isRequired || modifier.minSelect > 0
                ? 1
                : modifier.minSelect;
            if (!minRequired) {
              return false;
            }
            return !selections[link.modifierId];
          });

          if (requiredModifiersMissing) {
            return reply
              .status(400)
              .send({ error: "Missing required modifiers" });
          }

          orderTotalCents += unitPriceCents * item.quantity;

          orderItemsToCreate.push({
            item: {
              connect: { id: dbItem.id },
            },
            titleSnapshot: dbItem.title,
            unitPriceCents,
            quantity: item.quantity,
            orderItemOptions: {
              create: orderItemOptions,
            },
          });
        }
        logStep("computed");

        const createdOrder = await db.order.create({
          data: {
            storeId: store.id,
            tableId: table.id,
            status: OrderStatus.PLACED,
            totalCents: orderTotalCents,
            note: body.note,
            orderItems: {
              create: orderItemsToCreate,
            },
          },
          include: {
            table: { select: { id: true, label: true } },
            orderItems: ORDER_ITEM_INCLUDE,
          },
        });
        logStep("dbCreate");

        const waiterIds = await getWaiterIdsForTable(store.id, table.id);
        const placedPayload = {
          orderId: createdOrder.id,
          tableId: createdOrder.tableId,
          tableLabel: table.label,
          ticketNumber: (createdOrder as any).ticketNumber ?? undefined,
          createdAt: createdOrder.createdAt,
          totalCents: createdOrder.totalCents,
          note: createdOrder.note,
          items: createdOrder.orderItems.map((orderItem) => ({
            title: orderItem.titleSnapshot,
            quantity: orderItem.quantity,
            unitPriceCents: orderItem.unitPriceCents,
            modifiers: orderItem.orderItemOptions,
          })),
        };
        const topicSlug = store.slug;
        publishMessage(`${topicSlug}/orders/placed`, placedPayload, {
          roles: ["cook"],
        });
        notifyWaiters(`${topicSlug}/orders/placed`, placedPayload, waiterIds, {
          skipMqtt: true,
        });
        logStep("published");
        logStep("total");

        return reply
          .status(201)
          .header("Server-Timing", 'total;desc="createOrder"')
          .send({ order: serializeOrder(createdOrder) });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Create order error:", error);
        return reply.status(500).send({ error: "Failed to create order" });
      }
    }
  );
  // in your server.ts, near /orders
  fastify.get("/orders-benchmark", async (request, reply) => {
    try {
      const storeSlug = resolveStoreSlug(request);
      const store = await ensureStore(storeSlug);
      const orders = await db.order.findMany({
        where: { storeId: store.id },
        take: 50,
        orderBy: { createdAt: "desc" },
      });

      return reply.send({ orders });
    } catch (error) {
      fastify.log.error({ error }, "Get orders error");
      return reply.status(500).send({ error: "Failed to fetch orders" });
    }
  });

  // Get orders (protected)
  fastify.get(
    "/orders",
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      try {
        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);
        const query = z
          .object({
            status: z.nativeEnum(OrderStatus).optional(),
            tableIds: z.union([z.string(), z.array(z.string())]).optional(),
          })
          .parse(request.query ?? {});
        const actor = (request as any).user;
        let shiftWindow:
          | {
              start?: Date | null;
              end?: Date | null;
              id?: string;
              status?: ShiftStatus;
            }
          | undefined;
        if (actor?.role === "waiter" && actor?.id) {
          const now = new Date();
          const activeShift = await db.waiterShift.findFirst({
            where: {
              storeId: store.id,
              waiterId: actor.id,
              status: ShiftStatus.ACTIVE,
              startedAt: { lte: now },
              OR: [{ endedAt: null }, { endedAt: { gte: now } }],
            },
            orderBy: { startedAt: "desc" },
          });
          const fallbackShift =
            activeShift ||
            (await db.waiterShift.findFirst({
              where: { storeId: store.id, waiterId: actor.id },
              orderBy: { startedAt: "desc" },
            }));
          if (fallbackShift) {
            shiftWindow = {
              start: fallbackShift.startedAt,
              end: fallbackShift.endedAt,
              id: fallbackShift.id,
              status: fallbackShift.status,
            };
          }
        }
        const tableIdList = (() => {
          const raw = query.tableIds;
          const arr = Array.isArray(raw)
            ? raw
            : typeof raw === "string"
            ? raw.split(",")
            : [];
          const cleaned = arr
            .map((value) => (typeof value === "string" ? value.trim() : ""))
            .filter((value) => value.length > 0);
          const uuid = z.string().uuid();
          return cleaned.filter((value) => uuid.safeParse(value).success);
        })();

        const requestedTake =
          typeof (request.query as any)?.take !== "undefined"
            ? Number((request.query as any)?.take)
            : ORDERS_DEFAULT_TAKE;
        const queryTake = Math.min(
          Math.max(
            Number.isFinite(requestedTake)
              ? requestedTake
              : ORDERS_DEFAULT_TAKE,
            1
          ),
          ORDERS_MAX_TAKE
        );
        console.log(
          "[orders:list] store",
          store.slug,
          "status",
          query.status ?? "any",
          "requestedTake",
          requestedTake,
          "effectiveTake",
          queryTake,
          "tableIds",
          tableIdList.length,
          "user",
          actor?.id ?? "anon",
          "role",
          actor?.role ?? "unknown",
          "shift",
          shiftWindow?.id ?? "none",
          shiftWindow?.start?.toISOString(),
          shiftWindow?.end?.toISOString() ?? "open",
          shiftWindow?.status ?? "n/a"
        );
        const ordersData = await db.order.findMany({
          where: {
            storeId: store.id,
            ...(query.status ? { status: query.status } : {}),
            ...(tableIdList.length ? { tableId: { in: tableIdList } } : {}),
            ...(shiftWindow?.start
              ? {
                  placedAt: {
                    gte: shiftWindow.start,
                    ...(shiftWindow.end ? { lte: shiftWindow.end } : {}),
                  },
                }
              : {}),
          },
          orderBy: { placedAt: "desc" },
          take: queryTake,
          include: {
            table: { select: { id: true, label: true } },
            orderItems: ORDER_ITEM_INCLUDE,
          },
        });
        const placedDates = ordersData
          .map((o) => o.placedAt || o.createdAt)
          .filter(Boolean)
          .map((d) => new Date(d as Date).toISOString())
          .sort();
        const tableStats = ordersData.reduce<Record<string, number>>(
          (acc, o) => {
            const label = (o as any)?.table?.label ?? o.tableId ?? "unknown";
            acc[label] = (acc[label] ?? 0) + 1;
            return acc;
          },
          {}
        );
        const categoryStats = ordersData.reduce<Record<string, number>>(
          (acc, o) => {
            (o.orderItems || []).forEach((oi) => {
              const cat =
                (oi as any)?.item?.category?.title ??
                (oi as any)?.item?.categoryId ??
                "Uncategorized";
              acc[cat] = (acc[cat] ?? 0) + 1;
            });
            return acc;
          },
          {}
        );
        console.log(
          "[orders:list] returned",
          ordersData.length,
          "firstDate",
          placedDates[0],
          "lastDate",
          placedDates[placedDates.length - 1],
          "tables",
          Object.entries(tableStats)
            .slice(0, 6)
            .map(([table, count]) => `${table}:${count}`),
          "categorySamples",
          Object.entries(categoryStats)
            .slice(0, 5)
            .map(([cat, count]) => `${cat}:${count}`)
        );

        const shiftResponse =
          shiftWindow?.start != null
            ? {
                id: shiftWindow.id,
                status: shiftWindow.status,
                start: shiftWindow.start.toISOString(),
                end: shiftWindow.end
                  ? shiftWindow.end.toISOString()
                  : undefined,
              }
            : undefined;

        return reply.send({
          orders: ordersData.map(serializeOrder),
          shift: shiftResponse,
        });
      } catch (error) {
        console.error("Get orders error:", error);
        return reply.status(500).send({ error: "Failed to fetch orders" });
      }
    }
  );

  fastify.get(
    "/orders/:id",
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);

        const order = await db.order.findFirst({
          where: { id, storeId: store.id },
          include: {
            table: { select: { id: true, label: true } },
            orderItems: {
              include: {
                orderItemOptions: true,
              },
            },
          },
        });

        if (!order) {
          return reply.status(404).send({ error: "Order not found" });
        }

        return reply.send({ order: serializeOrder(order) });
      } catch (error) {
        console.error("Get order error:", error);
        return reply.status(500).send({ error: "Failed to fetch order" });
      }
    }
  );

  // Update order status (protected)
  fastify.patch(
    "/orders/:id/status",
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = updateStatusSchema.parse(request.body);
        const skipStatusMqtt = body.skipMqtt === true;
        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);
        const actorRole = (request as any).user?.role as string | undefined;

        const existing = await db.order.findFirst({
          where: { id, storeId: store.id },
        });

        if (!existing) {
          return reply.status(404).send({ error: "Order not found" });
        }

        // Role-based status transitions
        // - PREPARING, READY: cook or manager
        // - SERVED: waiter or manager
        // - CANCELLED: manager or cook
        const next = body.status;
        const allowByRole = (role?: string) => {
          if (!role) return false;
          const isManager = role === "manager" || role === "architect";
          if (next === OrderStatus.SERVED || next === OrderStatus.PAID)
            return role === "waiter" || isManager;
          if (next === OrderStatus.PREPARING || next === OrderStatus.READY)
            return role === "cook" || isManager;
          if (next === OrderStatus.CANCELLED)
            return isManager || role === "cook";
          return isManager;
        };

        if (!allowByRole(actorRole)) {
          return reply
            .status(403)
            .send({ error: "Insufficient permissions for status change" });
        }

        const now = new Date();
        const trimmedReason =
          typeof body.cancelReason === "string" &&
          body.cancelReason.trim().length > 0
            ? body.cancelReason.trim()
            : undefined;
        const updateData: any = {
          status: body.status,
          updatedAt: now,
        };
        const statusTimestampField = STATUS_TIMESTAMP_FIELDS[body.status];
        if (statusTimestampField) {
          updateData[statusTimestampField] = now;
        }
        const flowIndex = STATUS_PROGRESS_FLOW.indexOf(body.status);
        if (flowIndex >= 0) {
          for (let i = flowIndex + 1; i < STATUS_PROGRESS_FLOW.length; i++) {
            const futureStatus = STATUS_PROGRESS_FLOW[i];
            const futureField = STATUS_TIMESTAMP_FIELDS[futureStatus];
            if (futureField && (existing as any)[futureField]) {
              updateData[futureField] = null;
            }
          }
        }
        if (body.status === OrderStatus.CANCELLED) {
          updateData.cancelReason =
            trimmedReason ?? existing.cancelReason ?? null;
        } else {
          if (existing.cancelReason) {
            updateData.cancelReason = null;
          }
          if (existing.cancelledAt) {
            updateData.cancelledAt = null;
          }
        }
        let updatedOrder = await db.order.update({
          where: { id },
          data: updateData,
          include: {
            table: true,
            orderItems: {
              include: {
                orderItemOptions: true,
              },
            },
          },
        });

        const waiterIdsForOrder = await getWaiterIdsForTable(
          store.id,
          updatedOrder.tableId
        );

        if (body.status === OrderStatus.PREPARING) {
          // Allocate daily ticket number if missing
          if ((updatedOrder as any).ticketNumber == null) {
            const day = new Date().toISOString().slice(0, 10); // UTC day
            const result = await db.$transaction(async (tx) => {
              // Re-check inside the transaction to avoid double allocation
              const current = await tx.order.findUnique({
                where: { id },
                select: { ticketNumber: true },
              });
              if (current?.ticketNumber != null) {
                return tx.order.findUnique({
                  where: { id },
                  include: {
                    table: true,
                    orderItems: { include: { orderItemOptions: true } },
                  },
                });
              }
              const counter = await tx.kitchenTicketSeq.upsert({
                where: { storeId_day: { storeId: store.id, day } },
                create: { storeId: store.id, day, seq: 1 },
                update: { seq: { increment: 1 } },
                select: { seq: true },
              });
              return tx.order.update({
                where: { id },
                data: { ticketNumber: counter.seq },
                include: {
                  table: true,
                  orderItems: { include: { orderItemOptions: true } },
                },
              });
            });
            updatedOrder = result as any;
          }
          // Notify that kitchen accepted the order
          const orderSnapshot = serializeOrder(
            updatedOrder as OrderWithRelations
          );
          const payload = {
            orderId: updatedOrder.id,
            tableId: updatedOrder.tableId,
            tableLabel: updatedOrder.table?.label ?? "",
            ticketNumber: (updatedOrder as any).ticketNumber ?? undefined,
            status: OrderStatus.PREPARING,
            ts: new Date().toISOString(),
            items: updatedOrder.orderItems.map((oi) => ({
              title: oi.titleSnapshot,
              quantity: oi.quantity,
              unitPriceCents: oi.unitPriceCents,
              modifiers: oi.orderItemOptions,
            })),
            order: orderSnapshot,
          };
          const topicBase = store.slug;
          publishMessage(`${topicBase}/orders/preparing`, payload, {
            roles: ["cook"],
            ...(skipStatusMqtt ? { skipMqtt: true } : {}),
          });
          notifyWaiters(
            `${topicBase}/orders/preparing`,
            payload,
            waiterIdsForOrder,
            { skipMqtt: true }
          );
          publishMessage(`${topicBase}/orders/preparing`, payload, {
            anonymousOnly: true,
            skipMqtt: true,
          });
        }

        if (body.status === OrderStatus.READY) {
          const payload = {
            orderId: updatedOrder.id,
            tableId: updatedOrder.tableId,
            tableLabel: updatedOrder.table?.label ?? "",
            ticketNumber: (updatedOrder as any).ticketNumber ?? undefined,
            status: OrderStatus.READY,
            ts: new Date().toISOString(),
            items: updatedOrder.orderItems.map((oi) => ({
              title: oi.titleSnapshot,
              quantity: oi.quantity,
              unitPriceCents: oi.unitPriceCents,
              modifiers: oi.orderItemOptions,
            })),
          };
          const topicBase = store.slug;
          publishMessage(`${topicBase}/orders/ready`, payload, {
            roles: ["cook"],
          });
          notifyWaiters(
            `${topicBase}/orders/ready`,
            payload,
            waiterIdsForOrder
          );
        }

        if (body.status === OrderStatus.CANCELLED) {
          const payload = {
            orderId: updatedOrder.id,
            tableId: updatedOrder.tableId,
            tableLabel: updatedOrder.table?.label ?? "",
            ticketNumber: (updatedOrder as any).ticketNumber ?? undefined,
            status: OrderStatus.CANCELLED,
            ts: new Date().toISOString(),
            items: updatedOrder.orderItems.map((oi) => ({
              title: oi.titleSnapshot,
              quantity: oi.quantity,
              unitPriceCents: oi.unitPriceCents,
              modifiers: oi.orderItemOptions,
            })),
          };
          const topicBase = store.slug;
          publishMessage(`${topicBase}/orders/canceled`, payload, {
            roles: ["cook"],
          });
          notifyWaiters(
            `${topicBase}/orders/canceled`,
            payload,
            waiterIdsForOrder,
            { skipMqtt: true }
          );
        }

        if (body.status === OrderStatus.SERVED) {
          const payload = {
            orderId: updatedOrder.id,
            tableId: updatedOrder.tableId,
            tableLabel: updatedOrder.table?.label ?? "",
            ticketNumber: (updatedOrder as any).ticketNumber ?? undefined,
            status: OrderStatus.SERVED,
            ts: new Date().toISOString(),
            items: updatedOrder.orderItems.map((oi) => ({
              title: oi.titleSnapshot,
              quantity: oi.quantity,
              unitPriceCents: oi.unitPriceCents,
              modifiers: oi.orderItemOptions,
            })),
          };
          const topicBase = store.slug;
          publishMessage(`${topicBase}/orders/served`, payload, {
            roles: ["cook"],
          });
          notifyWaiters(
            `${topicBase}/orders/served`,
            payload,
            waiterIdsForOrder,
            { skipMqtt: true }
          );
        }

        if (body.status === OrderStatus.PAID) {
          const payload = {
            orderId: updatedOrder.id,
            tableId: updatedOrder.tableId,
            tableLabel: updatedOrder.table?.label ?? "",
            ticketNumber: (updatedOrder as any).ticketNumber ?? undefined,
            status: OrderStatus.PAID,
            ts: new Date().toISOString(),
            items: updatedOrder.orderItems.map((oi) => ({
              title: oi.titleSnapshot,
              quantity: oi.quantity,
              unitPriceCents: oi.unitPriceCents,
              modifiers: oi.orderItemOptions,
            })),
          };
          const topicBase = store.slug;
          publishMessage(`${topicBase}/orders/paid`, payload, {
            roles: ["cook"],
          });
          notifyWaiters(
            `${topicBase}/orders/paid`,
            payload,
            waiterIdsForOrder,
            { skipMqtt: true }
          );
        }

        return reply.send({ order: serializeOrder(updatedOrder) });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Update order status error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to update order status" });
      }
    }
  );

  fastify.get(
    "/orders/queue",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);
        const ahead = await db.order.count({
          where: {
            storeId: store.id,
            status: {
              in: [OrderStatus.PLACED, OrderStatus.PREPARING],
            },
          },
        });
        return reply.send({ ahead });
      } catch (error) {
        console.error("Order queue summary error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to fetch order queue summary" });
      }
    }
  );

  // Edit order (public device while still PLACED)
  fastify.patch(
    "/orders/:id",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = createOrderSchema.partial().parse(request.body);
        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);

        const existing = await db.order.findFirst({
          where: { id, storeId: store.id },
          include: {
            orderItems: { include: { orderItemOptions: true } },
            table: true,
          },
        });
        if (!existing)
          return reply.status(404).send({ error: "Order not found" });
        if (existing.status !== OrderStatus.PLACED) {
          return reply
            .status(409)
            .send({ error: "Order can no longer be edited" });
        }

        // Rebuild items if provided
        let orderItemsData: any | undefined = undefined;
        let totalCents = existing.totalCents;
        if (Array.isArray(body.items) && body.items.length > 0) {
          const itemIds = body.items.map((it: any) => it.itemId);
          const dbItems = await db.item.findMany({
            where: {
              storeId: store.id,
              id: { in: itemIds },
              isAvailable: true,
            },
            include: {
              itemModifiers: {
                include: { modifier: { include: { modifierOptions: true } } },
              },
            },
          });
          const mapById = new Map(dbItems.map((d) => [d.id, d]));
          totalCents = 0;
          const itemsToCreate: any[] = [];
          for (const it of body.items) {
            const dbItem = mapById.get(it.itemId);
            if (!dbItem) continue;
            const quantity = Math.max(1, Number(it.quantity || 1));
            const selections = parseModifiers(it.modifiers);
            const links = dbItem.itemModifiers;
            const options = Object.entries(selections)
              .map(([modifierId, optionId]) => {
                const mod = links.find(
                  (l: any) => l.modifierId === modifierId
                )?.modifier;
                const opt = mod?.modifierOptions.find(
                  (o: any) => o.id === optionId
                );
                if (!opt) return null;
                return {
                  modifierId,
                  modifierOptionId: optionId,
                  titleSnapshot: opt.title,
                  priceDeltaCents: opt.priceDeltaCents,
                };
              })
              .filter(Boolean) as any[];
            const unitPriceCents =
              dbItem.priceCents +
              options.reduce((s, o) => s + o.priceDeltaCents, 0);
            totalCents += unitPriceCents * quantity;
            itemsToCreate.push({
              item: { connect: { id: dbItem.id } },
              titleSnapshot: dbItem.title,
              unitPriceCents,
              quantity,
              orderItemOptions: { create: options },
            });
          }
          // Replace items
          await db.orderItem.deleteMany({ where: { orderId: id } });
          orderItemsData = { create: itemsToCreate };
        }

        const updated = await db.order.update({
          where: { id },
          data: {
            ...(typeof body.note === "string" ? { note: body.note } : {}),
            ...(orderItemsData
              ? { orderItems: orderItemsData, totalCents }
              : {}),
            updatedAt: new Date(),
          },
          include: {
            table: { select: { id: true, label: true } },
            orderItems: ORDER_ITEM_INCLUDE,
          },
        });

        // Notify clients (re-emit placed with new content)
        const waiterIds = await getWaiterIdsForTable(store.id, updated.tableId);
        const payloadPlaced = {
          orderId: updated.id,
          tableId: updated.tableId,
          tableLabel: updated.table?.label ?? "",
          ticketNumber: (updated as any).ticketNumber ?? undefined,
          createdAt: updated.createdAt,
          totalCents: updated.totalCents,
          note: updated.note,
          items: updated.orderItems.map((oi) => ({
            title: oi.titleSnapshot,
            quantity: oi.quantity,
            unitPriceCents: oi.unitPriceCents,
            modifiers: oi.orderItemOptions,
          })),
        };
        const topicBase = store.slug;
        publishMessage(`${topicBase}/orders/placed`, payloadPlaced, {
          roles: ["cook"],
        });
        notifyWaiters(`${topicBase}/orders/placed`, payloadPlaced, waiterIds, {
          skipMqtt: true,
        });

        return reply.send({ order: serializeOrder(updated) });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Edit order error:", error);
        return reply.status(500).send({ error: "Failed to edit order" });
      }
    }
  );

  fastify.post(
    "/orders/:id/print",
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      try {
        const params = z
          .object({
            id: z.string().uuid(),
          })
          .parse(request.params ?? {});
        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);
        const order = await db.order.findFirst({
          where: { id: params.id, storeId: store.id },
          include: {
            table: { select: { id: true, label: true } },
            orderItems: ORDER_ITEM_INCLUDE,
          },
        });
        if (!order) {
          return reply.status(404).send({ error: "Order not found" });
        }

        const preparedPayload = {
          orderId: order.id,
          tableId: order.tableId,
          tableLabel: order.table?.label ?? "",
          ticketNumber: (order as any).ticketNumber ?? undefined,
          status: OrderStatus.PREPARING,
          createdAt: order.createdAt,
          ts: new Date().toISOString(),
          items: order.orderItems.map((oi) => ({
            title: oi.titleSnapshot,
            quantity: oi.quantity,
            unitPriceCents: oi.unitPriceCents,
            modifiers: oi.orderItemOptions,
          })),
          order: serializeOrder(order as any),
        };
        publishMessage(`${store.slug}/orders/preparing`, preparedPayload, {
          roles: ["cook"],
        });
        return reply.send({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Print order error:", error);
        return reply.status(500).send({ error: "Failed to print order" });
      }
    }
  );

  // Call waiter (IP whitelisted)
  fastify.post(
    "/call-waiter",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const body = callWaiterSchema.parse(request.body);
        const store = await ensureStore(resolveStoreSlug(request));

        const table = await db.table.findFirst({
          where: { id: body.tableId, storeId: store.id },
        });

        if (!table) {
          return reply.status(404).send({ error: "Table not found" });
        }

        // New waiter call topic: {slug}/waiter/call
        const waiterIds = await getWaiterIdsForTable(store.id, table.id);
        notifyWaiters(
          `${store.slug}/waiter/call`,
          {
            tableId: body.tableId,
            action: "called",
            ts: new Date().toISOString(),
          },
          waiterIds
        );

        return reply.send({ success: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Call waiter error:", error);
        return reply.status(500).send({ error: "Failed to call waiter" });
      }
    }
  );

  // Generate demo Viva payment URL before placing order
  fastify.post(
    "/payment/viva/checkout-url",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        // Log the exact incoming payload for debugging Viva checkout URL failures
        try {
          console.log(
            "[payment/checkout-url] incoming body:",
            JSON.stringify(request.body)
          );
        } catch (e) {
          console.log(
            "[payment/checkout-url] incoming body (raw):",
            request.body
          );
        }
        const body = z
          .object({
            tableId: z.string().uuid(),
            amount: z.number().positive(),
            description: z.string().optional(),
          })
          .parse(request.body);

        const storeSlug = resolveStoreSlug(request);
        const store = await ensureStore(storeSlug);

        const table = await db.table.findFirst({
          where: { id: body.tableId, storeId: store.id },
        });

        if (!table) {
          return reply.status(404).send({ error: "Table not found" });
        }

        // Generate unique session ID for this payment attempt
        const sessionId = `${store.id}_${body.tableId}_${Date.now()}`;

        // Create payment order via Viva Smart Checkout API
        console.log("[payment/checkout-url] creating Viva payment order", {
          amount: body.amount,
          orderId: sessionId,
          tableId: body.tableId,
          description: body.description || "Restaurant Order",
        });

        // Build return URL for after payment completion
        // Prefer explicit FRONTEND_BASE_URL env var. Otherwise derive from headers/hostname
        const frontendBase =
          process.env.FRONTEND_BASE_URL ||
          (() => {
            const h = ((request.headers as any)["x-forwarded-host"] ||
              (request.headers as any)["host"] ||
              request.hostname) as string;
            const hostOnly = String(h).split(":")[0];
            const port = process.env.FRONTEND_PORT || "8080";
            return `${request.protocol}://${hostOnly}${port ? `:${port}` : ""}`;
          })();

        const returnUrl = `${frontendBase}/payment-complete?sessionId=${sessionId}&tableId=${body.tableId}`;
        console.log("[payment/checkout-url] return URL for Viva:", returnUrl);

        const paymentSession = await createVivaPaymentOrder({
          amount: body.amount,
          orderId: sessionId,
          tableId: body.tableId,
          description: body.description || "Restaurant Order",
          returnUrl: returnUrl,
        });

        console.log(
          "[payment/checkout-url] Viva returned session:",
          paymentSession
        );

        return reply.send({
          checkoutUrl: paymentSession.checkoutUrl,
          sessionId: sessionId,
          amount: paymentSession.amount,
          tableId: body.tableId,
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Payment URL generation error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to generate payment URL" });
      }
    }
  );
}
