import { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { ensureStore } from "../lib/store.js";

export async function storeRoutes(fastify: FastifyInstance) {
  fastify.get("/store", async (_request, reply) => {
    try {
      const store = await ensureStore();
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
      const store = await ensureStore();
      const tables = await db.table.findMany({
        where: { storeId: store.id, isActive: true },
        orderBy: { label: "asc" },
        include: {
          waiterTables: {
            include: {
              waiter: true,
            },
          },
        },
      });

      return reply.send({
        tables: tables.map((table) => ({
          id: table.id,
          label: table.label,
          active: table.isActive,
          waiters: table.waiterTables.map((assignment) => ({
            id: assignment.waiter.id,
            displayName: assignment.waiter.displayName ?? assignment.waiter.email,
            email: assignment.waiter.email,
          })),
        })),
      });
    } catch (error) {
      console.error("Table list error:", error);
      return reply.status(500).send({ error: "Failed to fetch tables" });
    }
  });
}
