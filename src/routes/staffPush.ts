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

const staffPushDiagnosticSchema = z.object({
  stage: z.string().trim().min(1).max(80),
  ok: z.boolean().optional(),
  message: z.string().trim().max(1000).optional(),
  permission: z.string().trim().max(40).optional(),
  swUrl: z.string().trim().max(200).optional(),
  hasServiceWorker: z.boolean().optional(),
  hasPushManager: z.boolean().optional(),
  hasNotification: z.boolean().optional(),
  secureContext: z.boolean().optional(),
  hasSubscription: z.boolean().optional(),
  endpointHost: z.string().trim().max(255).nullable().optional(),
});

const truncate = (value: string, max: number) =>
  value.length > max ? value.slice(0, max) : value;

export async function staffPushRoutes(fastify: FastifyInstance) {
  const staffPushAllowed = [authMiddleware, requireRole(["cook", "waiter"])];

  fastify.get("/staff/push/key", { preHandler: staffPushAllowed }, async (request) => {
    const config = getStaffPushConfig();
    const user = (request as any).user;
    console.log("[staff-push] key requested", {
      enabled: config.enabled,
      role: user?.role,
      storeSlug: (request as any).storeSlug,
    });
    return config;
  });

  fastify.post(
    "/staff/push/diagnostics",
    { preHandler: staffPushAllowed },
    async (request, reply) => {
      try {
        const body = staffPushDiagnosticSchema.parse(request.body);
        const user = (request as any).user;
        console.log("[staff-push] client diagnostic", {
          ...body,
          role: user?.role,
          profileId: user?.userId,
          storeSlug: (request as any).storeSlug,
        });
        return reply.send({ ok: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: error.errors });
        }
        console.error("Staff push diagnostic error:", error);
        return reply
          .status(500)
          .send({ error: "Failed to save staff push diagnostic" });
      }
    }
  );

  fastify.post(
    "/staff/push/subscriptions",
    { preHandler: staffPushAllowed },
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
            role: { in: [Role.COOK, Role.HYBRID, Role.WAITER] },
          },
          include: { cookType: true, waiterType: true },
        });

        if (!profile) {
          return reply.status(403).send({ error: "Staff profile not found" });
        }

        const userAgent = request.headers["user-agent"]?.toString();
        await upsertStaffPushSubscription({
          storeId: store.id,
          profileId: profile.id,
          role: user.role,
          printerTopic:
            profile.printerTopic ??
            profile.cookType?.printerTopic ??
            profile.waiterType?.printerTopic ??
            null,
          endpoint: body.subscription.endpoint,
          p256dh: body.subscription.keys.p256dh,
          auth: body.subscription.keys.auth,
          userAgent: userAgent ? truncate(userAgent, 500) : null,
        });
        console.log("[staff-push] subscription saved", {
          storeSlug: store.slug,
          profileId: profile.id,
          role: user.role,
          endpointHost: new URL(body.subscription.endpoint).host,
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
