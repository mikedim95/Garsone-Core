import { FastifyInstance } from "fastify";
import { ensureStore } from "../lib/store.js";
import { getMenuPayload, invalidateMenuCache } from "../lib/menuService.js";
import { applyCacheHeaders, isNotModified } from "../lib/httpCache.js";

export { invalidateMenuCache };

export async function menuRoutes(fastify: FastifyInstance) {
  fastify.get("/menu", async (request, reply) => {
    try {
      const acceptLang = (request.headers["accept-language"] || "").toString().toLowerCase();
      const preferGreek = acceptLang.includes("el");
      const store = await ensureStore(request);
      const { payload, etag, lastModified } = await getMenuPayload(store, preferGreek);

      if (isNotModified(request, etag, lastModified)) {
        applyCacheHeaders(reply, etag, lastModified);
        return reply.status(304).send();
      }

      applyCacheHeaders(reply, etag, lastModified);
      return reply.send(payload);
    } catch (error) {
      console.error("Menu fetch error:", error);
      return reply.status(500).send({ error: "Failed to fetch menu" });
    }
  });
}
