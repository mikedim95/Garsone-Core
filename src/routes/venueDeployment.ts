import { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { invalidateStoreCache } from "../lib/store.js";

const dateFields = new Set([
  "createdAt", "updatedAt", "placedAt", "preparingAt", "readyAt", "servedAt",
  "cancelledAt", "paidAt", "startedAt", "endedAt", "expiresAt", "closedAt", "consumedAt",
]);

function normalizeRow(value: any) {
  const row = { ...(value || {}) };
  for (const [key, item] of Object.entries(row)) {
    if (dateFields.has(key) && item) row[key] = new Date(String(item));
  }
  return row;
}

async function upsertRows(tx: any, model: string, rows: any[]) {
  for (const value of rows || []) {
    const row = normalizeRow(value);
    await tx[model].upsert({ where: { id: row.id }, create: row, update: row });
  }
}

export async function venueDeploymentRoutes(fastify: FastifyInstance) {
  fastify.post("/internal/deployment/import", async (request, reply) => {
    const expected = String(process.env.DEPLOYMENT_IMPORT_SECRET || "").trim();
    const provided = String(request.headers["x-deployment-secret"] || "").trim();
    if (!expected || provided !== expected) {
      return reply.status(401).send({ error: "INVALID_DEPLOYMENT_SECRET" });
    }

    const snapshot = request.body as any;
    if (!snapshot?.store?.id || !snapshot?.store?.slug || Number(snapshot?.schemaVersion) !== 1) {
      return reply.status(400).send({ error: "INVALID_DEPLOYMENT_SNAPSHOT" });
    }

    await db.$transaction(async (tx: any) => {
      const incomingStore = normalizeRow(snapshot.store);
      const conflicting = await tx.store.findUnique({ where: { slug: incomingStore.slug } });
      if (conflicting && conflicting.id !== incomingStore.id) {
        await tx.store.delete({ where: { id: conflicting.id } });
      }
      await tx.store.upsert({
        where: { id: incomingStore.id },
        create: incomingStore,
        update: incomingStore,
      });
      if (snapshot.storeMeta) {
        const meta = normalizeRow(snapshot.storeMeta);
        await tx.storeMeta.upsert({ where: { storeId: meta.storeId }, create: meta, update: meta });
      }
      await upsertRows(tx, "cookType", snapshot.cookTypes);
      await upsertRows(tx, "waiterType", snapshot.waiterTypes);
      await upsertRows(tx, "category", snapshot.categories);
      await upsertRows(tx, "modifier", snapshot.modifiers);
      await upsertRows(tx, "modifierOption", snapshot.modifierOptions);
      await upsertRows(tx, "item", snapshot.items);
      await upsertRows(tx, "itemModifier", snapshot.itemModifiers);
      await upsertRows(tx, "table", snapshot.tables);
      await upsertRows(tx, "profile", snapshot.profiles);
      await upsertRows(tx, "waiterTable", snapshot.waiterTables);
      await upsertRows(tx, "qRTile", snapshot.qrTiles);
    }, { timeout: 120_000 });

    invalidateStoreCache(snapshot.store.slug);
    return reply.send({
      ok: true,
      storeId: snapshot.store.id,
      storeSlug: snapshot.store.slug,
      importedAt: new Date().toISOString(),
    });
  });
}
