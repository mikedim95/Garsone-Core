import { FastifyInstance } from "fastify";
import { Prisma, OrderStatus } from "@prisma/client";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware } from "../middleware/auth.js";
import { ipWhitelistMiddleware } from "../middleware/ipWhitelist.js";
import { publishMessage } from "../lib/mqtt.js";
import { ensureStore, STORE_SLUG } from "../lib/store.js";

const modifierSelectionSchema = z.record(z.string());

const createOrderSchema = z.object({
  tableId: z.string().uuid(),
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
});

const callWaiterSchema = z.object({
  tableId: z.string().uuid(),
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
    cancelReason: order.cancelReason,
    items: order.orderItems.map((orderItem) => ({
      id: orderItem.id,
      itemId: orderItem.itemId,
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

export async function orderRoutes(fastify: FastifyInstance) {
  // Create order (IP whitelisted)
  fastify.post(
    "/orders",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const body = createOrderSchema.parse(request.body);
        const store = await ensureStore();

        const table = await db.table.findFirst({
          where: { id: body.tableId, storeId: store.id },
        });

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
            orderItems: {
              include: {
                orderItemOptions: true,
              },
            },
          },
        });

        // Notify kitchen/clients over MQTT (topic used by frontend)
        // printing = new order placed
        publishMessage(`${STORE_SLUG}/orders/placed`, {
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
        });

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

  // Get orders (protected)
  fastify.get(
    "/orders",
    {
      preHandler: [authMiddleware],
    },
    async (request, reply) => {
      try {
        const store = await ensureStore();
        const query = z
          .object({ status: z.nativeEnum(OrderStatus).optional() })
          .parse(request.query ?? {});

        const queryTake = Math.min(
          Math.max(Number((request.query as any)?.take ?? 30), 1),
          100
        );
        const ordersData = await db.order.findMany({
          where: {
            storeId: store.id,
            ...(query.status ? { status: query.status } : {}),
          },
          orderBy: { placedAt: "desc" },
          take: queryTake,
          include: {
            table: { select: { id: true, label: true } },
            orderItems: {
              include: {
                orderItemOptions: true,
              },
            },
          },
        });

        return reply.send({ orders: ordersData.map(serializeOrder) });
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
        const store = await ensureStore();

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
        const store = await ensureStore();
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
          if (next === OrderStatus.SERVED)
            return role === "waiter" || role === "manager";
          if (next === OrderStatus.PREPARING || next === OrderStatus.READY)
            return role === "cook" || role === "manager";
          if (next === OrderStatus.CANCELLED)
            return role === "manager" || role === "cook";
          return role === "manager";
        };

        if (!allowByRole(actorRole)) {
          return reply
            .status(403)
            .send({ error: "Insufficient permissions for status change" });
        }

        const prev = existing.status;
        const now = new Date();
        const trimmedReason =
          typeof body.cancelReason === "string" && body.cancelReason.trim().length > 0
            ? body.cancelReason.trim()
            : undefined;
        const updateData: any = {
          status: body.status,
          updatedAt: now,
        };
        if (body.status === OrderStatus.SERVED) {
          updateData.servedAt = existing.servedAt ?? now;
          updateData.cancelReason = null;
        } else {
          if (existing.servedAt && prev === OrderStatus.SERVED) {
            updateData.servedAt = null;
          }
          if (body.status === OrderStatus.CANCELLED) {
            updateData.cancelReason = trimmedReason ?? existing.cancelReason ?? null;
          } else if (existing.cancelReason) {
            updateData.cancelReason = null;
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
              const counter = await (tx as any).kitchenCounter.upsert({
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
          };
          publishMessage(`${STORE_SLUG}/orders/preparing`, payload);
        }

        if (body.status === OrderStatus.READY) {
          publishMessage(`${STORE_SLUG}/orders/ready`, {
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
          });
        }

        if (body.status === OrderStatus.CANCELLED) {
          publishMessage(`${STORE_SLUG}/orders/canceled`, {
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
          });
        }

        if (body.status === OrderStatus.SERVED) {
          publishMessage(`${STORE_SLUG}/orders/served`, {
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
          });
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
    async (_request, reply) => {
      try {
        const store = await ensureStore();
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
        const store = await ensureStore();

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
            orderItems: { include: { orderItemOptions: true } },
          },
        });

        // Notify clients (re-emit placed with new content)
        publishMessage(`${STORE_SLUG}/orders/placed`, {
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

  // Call waiter (IP whitelisted)
  fastify.post(
    "/call-waiter",
    {
      preHandler: [ipWhitelistMiddleware],
    },
    async (request, reply) => {
      try {
        const body = callWaiterSchema.parse(request.body);
        const store = await ensureStore();

        const table = await db.table.findFirst({
          where: { id: body.tableId, storeId: store.id },
        });

        if (!table) {
          return reply.status(404).send({ error: "Table not found" });
        }

        // New waiter call topic: {slug}/waiter/call
        publishMessage(`${STORE_SLUG}/waiter/call`, {
          tableId: body.tableId,
          action: "called",
          ts: new Date().toISOString(),
        });

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
}
