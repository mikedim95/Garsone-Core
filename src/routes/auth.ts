import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { Role } from "@prisma/client";
import { db } from "../db/index.js";
import { signToken } from "../lib/jwt.js";
import { serializeRole } from "../lib/roles.js";
import { ensureStore, getRequestedStoreSlug, getOrderingMode } from "../lib/store.js";
import { authMiddleware } from "../middleware/auth.js";

const signinSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(200),
});

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/signin", async (request, reply) => {
    try {
      const body = signinSchema.parse(request.body);
      const email = body.email.toLowerCase();

      const requestedSlug = getRequestedStoreSlug(request);
      let store: Awaited<ReturnType<typeof ensureStore>> | null = requestedSlug ? await ensureStore(requestedSlug) : null;

      // Try store-scoped lookup first if slug was provided, otherwise fall back to global unique email lookup.
      let user = store
        ? await db.profile.findFirst({
            where: { email, storeId: store.id },
            include: { cookType: true, waiterType: true },
          })
        : null;

      if (!user) {
        user = await db.profile.findFirst({
          where: { email },
          include: { cookType: true, waiterType: true },
        });
        if (user && user.storeId) {
          // ensure we have the store that owns this profile
          if (!store || store.id !== user.storeId) {
            const found = await db.store.findUnique({
              where: { id: user.storeId },
            });
            if (found) {
              // Align shape with ensureStore by attaching orderingMode
              store = {
                ...found,
                orderingMode: getOrderingMode(found as any),
              } as any;
            }
          }
        }
      }

      if (!user) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const role = serializeRole(user.role);
      if (user.storeId) {
        if (!store || user.storeId !== store.id) {
          return reply.status(401).send({ error: "Invalid credentials" });
        }
      } else if (role === "architect") {
        store = store || (await ensureStore(requestedSlug));
      } else {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const validPassword = await bcrypt.compare(
        body.password,
        user.passwordHash
      );

      if (!validPassword) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const token = signToken({
        userId: user.id,
        email: user.email,
        role,
        storeId: store.id,
        storeSlug: store.slug,
        cookTypeId: user.cookTypeId ?? null,
        waiterTypeId: user.waiterTypeId ?? null,
        printerTopic: user.printerTopic ?? null,
        cookTypePrinterTopic: user.printerTopic ?? user.cookType?.printerTopic ?? null,
        waiterTypePrinterTopic: user.waiterType?.printerTopic ?? null,
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
          cookTypeId: user.cookTypeId ?? null,
          waiterTypeId: user.waiterTypeId ?? null,
          printerTopic: user.printerTopic ?? null,
          cookType: user.cookType
            ? {
                id: user.cookType.id,
                slug: user.cookType.slug,
                title: user.cookType.title,
                printerTopic: user.cookType.printerTopic,
              }
            : null,
          waiterType: user.waiterType
            ? {
                id: user.waiterType.id,
                slug: user.waiterType.slug,
                title: user.waiterType.title,
                printerTopic: user.waiterType.printerTopic,
              }
            : null,
          mustChangePassword: body.password === "1234",
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

  fastify.post(
    "/auth/change-password",
    { preHandler: authMiddleware },
    async (request, reply) => {
      try {
        const body = changePasswordSchema.parse(request.body ?? {});
        const authUser = (request as any).user as { userId?: string } | undefined;
        const userId = authUser?.userId;
        if (!userId) return reply.status(401).send({ error: "Unauthorized" });
        const user = await db.profile.findUnique({ where: { id: userId } });
        if (!user) return reply.status(404).send({ error: "USER_NOT_FOUND" });
        const validPassword = await bcrypt.compare(body.currentPassword, user.passwordHash);
        if (!validPassword) {
          return reply.status(401).send({ error: "Invalid current password" });
        }
        await db.profile.update({
          where: { id: user.id },
          data: { passwordHash: await bcrypt.hash(body.newPassword, 10) },
        });
        return reply.send({ ok: true });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: "Invalid request", details: error.errors });
        }
        console.error("Change password error:", error);
        return reply.status(500).send({ error: "Internal server error" });
      }
    }
  );

  // Developer convenience: URL that mints a token for a known seed user
  // and redirects to the frontend with ?token=... .
  // Guarded to be available only in non-production by default; can be
  // explicitly enabled in production by setting ENABLE_DEV_LOGIN=1.
  fastify.get("/auth/dev-login/:storeSlug/:userKey", async (request, reply) => {
    const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
    const devEnabled = (process.env.ENABLE_DEV_LOGIN || "0") === "1";
    if (isProd && !devEnabled) {
      return reply
        .status(403)
        .send({ error: "DEV_LOGIN_DISABLED", message: "Enable with ENABLE_DEV_LOGIN=1" });
    }

    try {
      const { storeSlug, userKey } = request.params as {
        storeSlug: string;
        userKey: string;
      };

      // Resolve store and user
      const store = await ensureStore(storeSlug);
      const emailRaw = userKey.includes("@")
        ? userKey
        : `${userKey}@${storeSlug}.local`;
      const email = emailRaw.toLowerCase();

      let user = await db.profile.findFirst({
        where: { storeId: store.id, email },
        include: { cookType: true, waiterType: true },
      });

      if (!user && userKey.includes("@")) {
        user = await db.profile.findFirst({
          where: {
            email,
            role: Role.ARCHITECT,
          },
          include: { cookType: true, waiterType: true },
        });
      }

      if (!user) {
        return reply.status(404).send({ error: "USER_NOT_FOUND_FOR_STORE" });
      }

      const role = serializeRole(user.role);
      if (role !== "architect" && user.storeId !== store.id) {
        return reply.status(404).send({ error: "USER_NOT_FOUND_FOR_STORE" });
      }

      const token = signToken({
        userId: user.id,
        email: user.email,
        role,
        storeId: store.id,
        storeSlug: store.slug,
        cookTypeId: user.cookTypeId ?? null,
        waiterTypeId: user.waiterTypeId ?? null,
        printerTopic: user.printerTopic ?? null,
        cookTypePrinterTopic: user.printerTopic ?? user.cookType?.printerTopic ?? null,
        waiterTypePrinterTopic: user.waiterType?.printerTopic ?? null,
      });

      // Optionally return JSON for programmatic usage
      const q = request.query as any;
      if (q?.format === "json") {
        return reply.send({
          accessToken: token,
          user: {
            id: user.id,
            email: user.email,
            role,
            displayName: user.displayName,
            storeId: store.id,
            storeSlug: store.slug,
            cookTypeId: user.cookTypeId ?? null,
            waiterTypeId: user.waiterTypeId ?? null,
            printerTopic: user.printerTopic ?? null,
            cookType: user.cookType
              ? {
                  id: user.cookType.id,
                  slug: user.cookType.slug,
                  title: user.cookType.title,
                  printerTopic: user.cookType.printerTopic,
                }
              : null,
            waiterType: user.waiterType
              ? {
                  id: user.waiterType.id,
                  slug: user.waiterType.slug,
                  title: user.waiterType.title,
                  printerTopic: user.waiterType.printerTopic,
                }
              : null,
          },
        });
      }

      // Build frontend URL to redirect with ?token=...
      const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || "").trim();
      const OPS_APP_BASE_URL = (process.env.OPS_APP_BASE_URL || "").trim();
      const PUBLIC_APP_DOMAIN = (process.env.PUBLIC_APP_DOMAIN || "garsone.gr")
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*/, "");
      const PUBLIC_APP_PROTOCOL = (process.env.PUBLIC_APP_PROTOCOL || "https")
        .replace(/:$/, "")
        .toLowerCase();
      const FRONTEND_PORT = (process.env.FRONTEND_PORT || process.env.PUBLIC_APP_PORT || "").trim();
      const OPS_PATH = (process.env.OPS_APP_PATH || "/ops").replace(/\/+$/, "");

      function buildOpsRedirectUrl() {
        const slug = (store.slug || "").trim() || "www";
        const params = new URLSearchParams({ token, storeSlug: slug });

        if (OPS_APP_BASE_URL.length > 0) {
          const base = OPS_APP_BASE_URL.replace("{storeSlug}", slug).replace(/\/+$/, "");
          return `${base}${OPS_PATH}?${params.toString()}`;
        }
        if (FRONTEND_ORIGIN.length > 0) {
          const base = FRONTEND_ORIGIN.replace("{storeSlug}", slug).replace(/\/+$/, "");
          return `${base}${OPS_PATH}?${params.toString()}`;
        }

        const reqHost = request.headers.host || "";
        const protocol = (request as any).protocol || PUBLIC_APP_PROTOCOL || "http";
        const hostRaw = reqHost.trim();
        const [hostBase, hostPort] = hostRaw.split(":");
        const isIpOrLocal = /^(\d{1,3}\.){3}\d{1,3}$/i.test(hostBase) || /^localhost$/i.test(hostBase);
        const targetPort = FRONTEND_PORT.length > 0 ? FRONTEND_PORT : hostPort;
        const hostname = isIpOrLocal ? hostBase : `${slug}.${hostBase}`;
        const portPart = targetPort ? `:${String(targetPort).replace(/^:/, "")}` : hostPort ? `:${hostPort}` : "";
        return `${protocol}://${hostname}${portPart}${OPS_PATH}?${params.toString()}`;
      }

      const target = buildOpsRedirectUrl();
      return reply.redirect(302, target);
    } catch (error) {
      console.error("Dev login error:", error);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
