import { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { ensureStore, getRequestedStoreSlug } from "../lib/store.js";
import { verifyToken } from "../lib/jwt.js";
import { applyCacheHeaders, buildEtag, isNotModified } from "../lib/httpCache.js";

export async function storeRoutes(fastify: FastifyInstance) {
  fastify.get("/landing/stores", async (_request, reply) => {
    try {
      const stores = await db.store.findMany({
        select: { id: true, slug: true, name: true, updatedAt: true },
        orderBy: { name: "asc" },
      });

      if (stores.length === 0) {
        return reply.send({ stores: [] });
      }

      const storeIds = stores.map((s) => s.id);
      const tables = await db.table.findMany({
        where: { storeId: { in: storeIds }, isActive: true },
        orderBy: [{ label: "asc" }, { createdAt: "asc" }],
        select: { id: true, label: true, storeId: true, updatedAt: true },
      });

      let tiles: Array<(typeof tables)[number] & { publicCode?: string | null }> = [];
      try {
        tiles = await db.qRTile.findMany({
          where: {
            storeId: { in: storeIds },
            isActive: true,
            tableId: { not: null },
          },
          include: {
            table: { select: { id: true, label: true } },
          },
          orderBy: [{ updatedAt: "desc" }],
        }) as any;
      } catch (error: any) {
        // If the QR tiles table is missing on an older database, don't fail the landing page.
        if (error?.code === "P2021" || error?.code === "P2022") {
          fastify.log.warn({ err: error }, "QR tile table missing; skipping tiles for landing");
          tiles = [];
        } else {
          throw error;
        }
      }

      const firstTableByStore = new Map<string, { id: string; label: string }>();
      for (const table of tables) {
        if (!firstTableByStore.has(table.storeId)) {
          firstTableByStore.set(table.storeId, { id: table.id, label: table.label });
        }
      }

      const tileByStore = new Map<string, (typeof tiles)[number]>();
      for (const tile of tiles) {
        if (tile.tableId && !tileByStore.has(tile.storeId)) {
          tileByStore.set(tile.storeId, tile);
        }
      }

      const payload = stores
        .filter((store) => firstTableByStore.has(store.id))
        .map((store) => {
          const tile = tileByStore.get(store.id);
          const table =
            (tile?.tableId && tables.find((t) => t.id === tile.tableId)) ||
            firstTableByStore.get(store.id) ||
            null;
          return {
            id: store.id,
            slug: store.slug,
            name: store.name,
            tableId: table?.id ?? null,
            tableLabel: table?.label ?? null,
            publicCode: tile?.publicCode ?? null,
          };
        });

      const lastModified = Math.max(
        ...stores.map((s) => (s.updatedAt ? new Date(s.updatedAt).getTime() : 0)),
        ...tables.map((t) => (t.updatedAt ? new Date(t.updatedAt).getTime() : 0)),
        ...(tiles.length ? tiles.map((t: any) => (t.updatedAt ? new Date(t.updatedAt).getTime() : 0)) : [0]),
        Date.now()
      );
      const etag = buildEtag({ stores: payload.length, updatedAt: lastModified });
      if (isNotModified(_request, etag, lastModified)) {
        applyCacheHeaders(reply, etag, lastModified);
        return reply.status(304).send();
      }
      applyCacheHeaders(reply, etag, lastModified);
      return reply.send({ stores: payload });
    } catch (error) {
      console.error("Landing stores fetch error:", error);
      return reply.status(500).send({ error: "Failed to load landing stores" });
    }
  });

  fastify.get("/store", async (request, reply) => {
    try {
      const storeSlug = getRequestedStoreSlug(request);
      const store = await ensureStore(storeSlug || request);
      const meta = await db.storeMeta.findUnique({
        where: { storeId: store.id },
      });

      const lastModified = Math.max(
        store.updatedAt ? new Date(store.updatedAt).getTime() : 0,
        meta?.updatedAt ? new Date(meta.updatedAt).getTime() : 0,
        Date.now()
      );
      const etag = buildEtag({ store: store.slug, updatedAt: lastModified });
      if (isNotModified(request, etag, lastModified)) {
        applyCacheHeaders(reply, etag, lastModified);
        return reply.status(304).send();
      }

      applyCacheHeaders(reply, etag, lastModified);
      return reply.send({
        store: {
          id: store.id,
          slug: store.slug,
          name: store.name,
          settings: store.settingsJson,
        },
        meta: meta
          ? {
              currencyCode: meta.currencyCode,
              locale: meta.locale,
            }
          : null,
      });
    } catch (error) {
      console.error("Store fetch error:", error);
      return reply.status(500).send({ error: "Failed to fetch store" });
    }
  });

  fastify.get("/tables", async (request, reply) => {
    try {
      // Try to read auth context to return waiter assignments only for the authenticated waiter
      const authHeader = request.headers.authorization;
      let userId: string | undefined;
      let userRole: string | undefined;
      try {
        if (authHeader && authHeader.startsWith("Bearer ")) {
          const token = authHeader.substring(7);
          const payload = verifyToken(token);
          userId = payload.userId;
          userRole = payload.role;
        }
      } catch {
        // ignore invalid tokens; endpoint stays public
      }

      const storeSlug = getRequestedStoreSlug(request);
      const store = await ensureStore(storeSlug || request);
      let waiterAssignmentsByTable = new Map<string, string[]>();

      if (userRole === "waiter" && userId) {
        const assignments = await db.waiterTable.findMany({
          where: { storeId: store.id, waiterId: userId },
          select: { tableId: true, waiterId: true },
        });
        waiterAssignmentsByTable = assignments.reduce<Map<string, string[]>>((acc, a) => {
          if (!a.tableId) return acc;
          const list = acc.get(a.tableId) ?? [];
          list.push(a.waiterId);
          acc.set(a.tableId, list);
          return acc;
        }, new Map());
      }

      const tables = await db.table.findMany({
        where: { storeId: store.id, isActive: true },
        orderBy: { label: "asc" },
        select: { id: true, label: true, isActive: true, updatedAt: true },
      });

      const lastModified = Math.max(
        ...tables.map((t) => (t.updatedAt ? new Date(t.updatedAt).getTime() : 0)),
        Date.now()
      );
      const etag = buildEtag({ store: store.slug, tables: tables.length, updatedAt: lastModified });
      if (isNotModified(request, etag, lastModified)) {
        applyCacheHeaders(reply, etag, lastModified);
        return reply.status(304).send();
      }

      applyCacheHeaders(reply, etag, lastModified);
      return reply.send({
        tables: tables.map((table) => ({
          id: table.id,
          label: table.label,
          active: table.isActive,
          // Include waiter assignment only for the authenticated waiter (scopes waiter dashboard)
          waiters:
            userRole === "waiter"
              ? (waiterAssignmentsByTable.get(table.id) ?? []).map((wid) => ({ id: wid }))
              : [],
        })),
      });
    } catch (error) {
      console.error("Table list error:", error);
      return reply.status(500).send({ error: "Failed to fetch tables" });
    }
  });
}
