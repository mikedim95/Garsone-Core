import { FastifyInstance } from "fastify";
import { ensureStore, OrderingMode } from "../lib/store.js";
import { db } from "../db/index.js";
import { getMenuPayload } from "../lib/menuService.js";
import { applyCacheHeaders, buildEtag, isNotModified } from "../lib/httpCache.js";
import { createLruCache } from "../lib/lru.js";

type BootstrapPayload = {
  store: { id: string; slug: string; name: string; orderingMode: OrderingMode };
  table: { id: string; label: string } | null;
  menu: Awaited<ReturnType<typeof getMenuPayload>>["payload"];
};

const BOOTSTRAP_CACHE = createLruCache<{
  payload: BootstrapPayload;
  etag: string;
  lastModified: number;
}>({
  ttlMs: (process.env.NODE_ENV || "").toLowerCase() === "development" ? 10_000 : 60_000,
  max: 100,
});

export async function publicMenuBootstrapRoutes(fastify: FastifyInstance) {
  fastify.get("/public/menu-bootstrap", async (request, reply) => {
    const query = request.query as {
      storeSlug?: string;
      tableCode?: string;
      lang?: string;
    };
    const tableCode = (query.tableCode || "").trim();
    try {
      const acceptLang = (request.headers["accept-language"] || "").toString().toLowerCase();
      const requestedLang = (query.lang || "").trim().toLowerCase();
      const normalizedLang = requestedLang.startsWith("el")
        ? "el"
        : requestedLang.startsWith("en")
        ? "en"
        : "";
      const preferGreek = normalizedLang
        ? normalizedLang === "el"
        : acceptLang.includes("el");
      const store = await ensureStore(query.storeSlug || request);

      const cacheKey = `${store.slug}:${tableCode || "all"}:${preferGreek ? "el" : "en"}`;
      const cached = BOOTSTRAP_CACHE.get(cacheKey);
      if (cached && isNotModified(request, cached.etag, cached.lastModified)) {
        applyCacheHeaders(reply, cached.etag, cached.lastModified);
        return reply.status(304).send();
      }
      if (cached) {
        applyCacheHeaders(reply, cached.etag, cached.lastModified);
        return reply.send(cached.payload);
      }

      const table = tableCode
        ? await db.table.findFirst({
            where: {
              storeId: store.id,
              OR: [{ id: tableCode }, { label: tableCode }],
            },
            select: { id: true, label: true, updatedAt: true },
          })
        : null;

      const menuResult = await getMenuPayload(store, preferGreek);
      const lastModified = Math.max(
        menuResult.lastModified,
        table?.updatedAt ? new Date(table.updatedAt).getTime() : 0,
        Date.now()
      );

      const payload: BootstrapPayload = {
        store: {
          id: store.id,
          slug: store.slug,
          name: store.name,
          orderingMode: (store as any).orderingMode,
        },
        table: table ? { id: table.id, label: table.label } : null,
        menu: menuResult.payload,
      };

      const etag = buildEtag({
        key: cacheKey,
        store: store.slug,
        table: table?.id || tableCode || null,
        updatedAt: lastModified,
      });

      BOOTSTRAP_CACHE.set(cacheKey, { payload, etag, lastModified });

      if (isNotModified(request, etag, lastModified)) {
        applyCacheHeaders(reply, etag, lastModified);
        return reply.status(304).send();
      }

      applyCacheHeaders(reply, etag, lastModified);
      return reply.send(payload);
    } catch (error) {
      console.error("Menu bootstrap error:", error);
      return reply.status(500).send({ error: "Failed to load menu bootstrap" });
    }
  });
}
