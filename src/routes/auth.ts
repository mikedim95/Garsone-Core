import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { db } from "../db/index.js";
import { signToken } from "../lib/jwt.js";
import { ensureStore, getRequestedStoreSlug } from "../lib/store.js";

const signinSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/signin", async (request, reply) => {
    try {
      const body = signinSchema.parse(request.body);
      const email = body.email.toLowerCase();

      const requestedSlug = getRequestedStoreSlug(request);
      let store = requestedSlug ? await ensureStore(requestedSlug) : null;

      // Try store-scoped lookup first if slug was provided, otherwise fall back to global unique email lookup.
      let user = store
        ? await db.profile.findFirst({
            where: { email, storeId: store.id },
          })
        : null;

      if (!user) {
        user = await db.profile.findFirst({ where: { email } });
        if (user) {
          // ensure we have the store that owns this profile
          if (!store || store.id !== user.storeId) {
            store = await db.store.findUnique({
              where: { id: user.storeId },
            });
          }
        }
      }

      if (!user || !store || user.storeId !== store.id) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const validPassword = await bcrypt.compare(
        body.password,
        user.passwordHash
      );

      if (!validPassword) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const role =
        user.role === "MANAGER"
          ? "manager"
          : user.role === "COOK"
            ? "cook"
            : user.role === "ARCHITECT"
              ? "architect"
              : "waiter";

      const token = signToken({
        userId: user.id,
        email: user.email,
        role,
        storeId: store.id,
        storeSlug: store.slug,
      });

      return reply.send({
        accessToken: token,
        user: {
          id: user.id,
          email: user.email,
          role,
          displayName: user.displayName,
          storeId: store.id,
          storeSlug: store.slug,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply
          .status(400)
          .send({ error: "Invalid request", details: error.errors });
      }
      console.error("Signin error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
