import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { emitRealtime } from "../lib/realtime.js";

export async function eventsRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/events/publish",
    {
      preHandler: [authMiddleware, requireRole(["waiter", "cook", "manager"])],
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
}
