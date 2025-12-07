import { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { ensureStore, getRequestedStoreSlug } from "../lib/store.js";

export async function storeRoutes(fastify: FastifyInstance) {
  fastify.get("/landing/stores", async (_request, reply) => {
    try {
      const stores = await db.store.findMany({
        select: { id: true, slug: true, name: true },
        orderBy: { name: "asc" },
      });

      if (stores.length === 0) {
        return reply.send({ stores: [] });
      }

      const storeIds = stores.map((s) => s.id);
      const [tables, tiles] = await Promise.all([
        db.table.findMany({
          where: { storeId: { in: storeIds }, isActive: true },
          orderBy: [{ label: "asc" }, { createdAt: "asc" }],
          select: { id: true, label: true, storeId: true },
        }),
        db.qRTile.findMany({
          where: {
            storeId: { in: storeIds },
            isActive: true,
            tableId: { not: null },
          },
          include: {
            table: { select: { id: true, label: true } },
          },
          orderBy: [{ updatedAt: "desc" }],
        }),
      ]);

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

      return reply.send({ stores: payload });
    } catch (error) {
      console.error("Landing stores fetch error:", error);
      return reply.status(500).send({ error: "Failed to load landing stores" });
    }
  });

  fastify.get("/store", async (_request, reply) => {
    try {
      const storeSlug = getRequestedStoreSlug(_request);
      const store = await ensureStore(storeSlug);
      const meta = await db.storeMeta.findUnique({
        where: { storeId: store.id },
      });

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

  fastify.get("/tables", async (_request, reply) => {
    try {
      const storeSlug = getRequestedStoreSlug(_request);
      const store = await ensureStore(storeSlug);
      const tables = await db.table.findMany({
        where: { storeId: store.id, isActive: true },
        orderBy: { label: "asc" },
        select: { id: true, label: true, isActive: true },
      });

      return reply.send({
        tables: tables.map((table) => ({
          id: table.id,
          label: table.label,
          active: table.isActive,
          // Minimal shape sufficient for landing/random live QR
          waiters: [],
        })),
      });
    } catch (error) {
      console.error("Table list error:", error);
      return reply.status(500).send({ error: "Failed to fetch tables" });
    }
  });
}
