import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { ensureStore } from "../lib/store.js";
import { getCustomerPushConfig } from "../lib/customerPush.js";

const pushSubscriptionSchema = z.object({
  tableId: z.string().uuid(),
  orderId: z.string().uuid().nullable().optional(),
  subscription: z.object({
    endpoint: z.string().url().max(1000),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({
      p256dh: z.string().min(1).max(255),
      auth: z.string().min(1).max(255),
    }),
  }),
});

const truncate = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) : value;

export async function customerPushRoutes(fastify: FastifyInstance) {
  fastify.get("/public/push/key", async () => getCustomerPushConfig());

  fastify.post("/public/push/subscriptions", async (request, reply) => {
    try {
      const body = pushSubscriptionSchema.parse(request.body);
      const config = getCustomerPushConfig();
      if (!config.enabled) {
        return reply.send({ ok: false, enabled: false });
      }

      const store = await ensureStore(request);
      const table = await db.table.findFirst({
        where: { id: body.tableId, storeId: store.id },
        select: { id: true },
      });

      if (!table) {
        return reply.status(404).send({ error: "Table not found" });
      }

      const requestedOrderId = body.orderId || null;
      if (requestedOrderId) {
        const order = await db.order.findFirst({
          where: {
            id: requestedOrderId,
            storeId: store.id,
            tableId: table.id,
          },
          select: { id: true },
        });

        if (!order) {
          return reply.status(404).send({ error: "Order not found" });
        }
      }

      const userAgent = request.headers["user-agent"]?.toString();
      await db.customerPushSubscription.upsert({
        where: { endpoint: body.subscription.endpoint },
        create: {
          storeId: store.id,
          tableId: table.id,
          orderId: requestedOrderId,
          endpoint: body.subscription.endpoint,
          p256dh: body.subscription.keys.p256dh,
          auth: body.subscription.keys.auth,
          userAgent: userAgent ? truncate(userAgent, 500) : null,
        },
        update: {
          storeId: store.id,
          tableId: table.id,
          orderId: requestedOrderId,
          p256dh: body.subscription.keys.p256dh,
          auth: body.subscription.keys.auth,
          userAgent: userAgent ? truncate(userAgent, 500) : null,
        },
      });

      return reply.send({ ok: true, enabled: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply
          .status(400)
          .send({ error: "Invalid request", details: error.errors });
      }
      console.error("Customer push subscription error:", error);
      return reply
        .status(500)
        .send({ error: "Failed to save push subscription" });
    }
  });
}
