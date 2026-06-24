import { FastifyInstance } from "fastify";
import { Role } from "@prisma/client";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { ensureStore } from "../lib/store.js";
import {
  getStaffPushConfig,
  upsertStaffPushSubscription,
} from "../lib/staffPush.js";

const staffPushSubscriptionSchema = z.object({
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

export async function staffPushRoutes(fastify: FastifyInstance) {
  const cookPushOnly = [authMiddleware, requireRole(["cook"])];

  fastify.get("/staff/push/key", { preHandler: cookPushOnly }, async () =>
    getStaffPushConfig()
  );

  fastify.post(
    "/staff/push/subscriptions",
    { preHandler: cookPushOnly },
    async (request, reply) => {
      try {
        const body = staffPushSubscriptionSchema.parse(request.body);
        const config = getStaffPushConfig();
        if (!config.enabled) {
          return reply.send({ ok: false, enabled: false });
        }

        const user = (request as any).user;
        const store = await ensureStore(request);
        const profile = await db.profile.findFirst({
          where: {
            id: user.userId,
            storeId: store.id,
            role: { in: [Role.COOK, Role.HYBRID] },
          },
          include: { cookType: true },
        });

        if (!profile) {
          return reply.status(403).send({ error: "Cook profile not found" });
        }

        const userAgent = request.headers["user-agent"]?.toString();
        await upsertStaffPushSubscription({
          storeId: store.id,
          profileId: profile.id,
          role: user.role,
          printerTopic: profile.printerTopic ?? profile.cookType?.printerTopic ?? null,
          endpoint: body.subscription.endpoint,
          p256dh: body.subscription.keys.p256dh,
          auth: body.subscription.keys.auth,
          userAgent: userAgent ? truncate(userAgent, 500) : null,
        });

        return reply.send({ ok: true, enabled: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Staff push subscription error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to save staff push subscription" });
      }
    }
  );
}
