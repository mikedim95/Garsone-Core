import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { normalizeQrUrl, qrPublicCodeSchema } from "./qrEvents.js";
import { invalidateMenuBootstrapCache } from "../routes/publicMenuBootstrap.js";
import type { QrAssignments } from "./nodeQrAssignments.js";

export function localQrPublicUrl(store: any, code: string): string | null | undefined {
  if (store?.venueDeployment?.target !== "PI") return undefined;
  try {
    return `${normalizeQrUrl(store.venueDeployment.localUrl || "", true)}/q/${encodeURIComponent(code)}`;
  } catch { return null; }
}

export async function nodeQrSnapshot(store: { id: string; slug: string }) {
  const rows = await db.qRTile.findMany({
    where: { storeId: store.id }, orderBy: { publicCode: "asc" },
    select: { publicCode: true, label: true, isActive: true, tableId: true,
      table: { select: { id: true, label: true, isActive: true } } },
  });
  const tables = [...new Map(rows.flatMap(row => row.table ? [[row.table.id, row.table] as const] : [])).values()];
  return { schemaVersion: 1, sourceStoreId: store.id, storeSlug: store.slug, tables,
    tiles: rows.map(({ table, ...tile }) => tile) };
}

const snapshotSchema = z.object({
  schemaVersion: z.literal(1), sourceStoreId: z.string().uuid(), storeSlug: z.string().min(1).max(100),
  tables: z.array(z.object({ id: z.string().uuid(), label: z.string().min(1).max(255), isActive: z.boolean() }).strict()).max(5000),
  tiles: z.array(z.object({ publicCode: qrPublicCodeSchema, label: z.string().max(255).nullable(),
    tableId: z.string().uuid().nullable(), isActive: z.boolean() }).strict()).max(5000),
}).strict();

export async function importNodeQrSnapshot(input: unknown) {
  const snapshot = snapshotSchema.parse(input);
  if (snapshot.storeSlug !== process.env.STORE_SLUG) throw new Error("QR_STORE_MISMATCH");
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const result = await db.$transaction(async tx => {
    // Serialize QR imports without locking or replacing menu, staff or orders.
    await tx.$queryRaw`SELECT "id" FROM "stores" WHERE "slug" = ${snapshot.storeSlug} FOR UPDATE`;
    const store = await tx.store.findUnique({ where: { slug: snapshot.storeSlug } });
    if (!store) throw new Error("QR_LOCAL_STORE_MISSING");
    const settings: any = store.settingsJson || {};
    const previous = settings.nodeQrSync || {};
    if (previous.sourceStoreId && previous.sourceStoreId !== snapshot.sourceStoreId) throw new Error("QR_SOURCE_STORE_MISMATCH");
    const assignments = async (): Promise<QrAssignments> => ({
      schemaVersion: 1, sourceStoreId: snapshot.sourceStoreId, storeSlug: snapshot.storeSlug,
      tiles: (await tx.qRTile.findMany({ where: { storeId: store.id, publicCode: { in: snapshot.tiles.map(tile => tile.publicCode) } },
        orderBy: { publicCode: "asc" }, select: { publicCode: true, tableId: true, isActive: true, table: { select: { label: true } } } }))
        .map(({ table, ...tile }) => ({ ...tile, tableLabel: table?.label ?? null })),
    });
    // Even an unchanged cloud inventory must report fresh local Manager edits.
    if (previous.hash === hash) return { unchanged: true, tiles: snapshot.tiles.length, assignments: await assignments() };
    const codes = snapshot.tiles.map(tile => tile.publicCode);
    if (new Set(codes).size !== codes.length) throw new Error("QR_DUPLICATE_CODE");
    const existingTiles = new Map((await tx.qRTile.findMany({ where: { publicCode: { in: codes } } })).map(tile => [tile.publicCode, tile]));
    if ([...existingTiles.values()].some(tile => tile.storeId !== store.id)) throw new Error("QR_TILE_STORE_MISMATCH");
    const newTableIds = new Set(snapshot.tiles.flatMap(tile => !existingTiles.has(tile.publicCode) && tile.tableId ? [tile.tableId] : []));
    const tableMap = new Map<string, string>();
    for (const table of snapshot.tables) {
      if (!newTableIds.has(table.id)) continue;
      const savedId = previous.tableMap?.[table.id] || table.id;
      const byId = await tx.table.findUnique({ where: { id: savedId } });
      if (byId && byId.storeId !== store.id) throw new Error("QR_TABLE_STORE_MISMATCH");
      const existing = byId || await tx.table.findUnique({ where: { storeId_label: { storeId: store.id, label: table.label } } });
      // Local names and availability remain authoritative after initialization.
      const saved = existing || await tx.table.create({ data: { ...table, storeId: store.id } });
      tableMap.set(table.id, saved.id);
      if (!existing) {
        // New cloud-assigned tables must reach the local venue's staff.
        for (const staff of await tx.profile.findMany({ where: { storeId: store.id, role: { in: ["WAITER", "HYBRID"] } }, select: { id: true } })) {
          await tx.waiterTable.upsert({ where: { storeId_waiterId_tableId: { storeId: store.id, waiterId: staff.id, tableId: saved.id } },
            create: { storeId: store.id, waiterId: staff.id, tableId: saved.id }, update: {} });
        }
      }
    }
    for (const tile of snapshot.tiles) {
      const existing = existingTiles.get(tile.publicCode);
      // Cloud owns inventory, venue membership and activation. Once present at
      // this venue, assignments (including an explicit null) belong to its Pi.
      let tableId = existing ? existing.tableId : tile.tableId ? tableMap.get(tile.tableId) : null;
      if (!existing && tile.tableId && !tableId) throw new Error("QR_TABLE_MISSING");
      // A new cloud code cannot take a table already claimed by a local code.
      if (!existing && tableId && await tx.qRTile.findFirst({ where: { storeId: store.id, tableId }, select: { id: true } })) tableId = null;
      const data = { ...tile, tableId: tableId || null, storeId: store.id };
      // Omit tableId from UPDATE rather than copying an earlier read: a Manager
      // can change the assignment while this import is in flight.
      await tx.qRTile.upsert({ where: { publicCode: tile.publicCode }, create: data,
        update: { label: tile.label, isActive: tile.isActive, storeId: store.id } });
    }
    const removed = (previous.codes || []).filter((code: string) => !codes.includes(code));
    if (removed.length) await tx.qRTile.updateMany({ where: { storeId: store.id, publicCode: { in: removed } }, data: { isActive: false } });
    await tx.store.update({ where: { id: store.id }, data: { settingsJson: { ...settings,
      nodeQrSync: { sourceStoreId: snapshot.sourceStoreId, hash, codes, tableMap: { ...previous.tableMap, ...Object.fromEntries(tableMap) }, appliedAt: new Date().toISOString() } } } });
    return { unchanged: false, tiles: codes.length, assignments: await assignments() };
  }, { timeout: 60_000 });
  if (!result.unchanged) invalidateMenuBootstrapCache();
  return result;
}
