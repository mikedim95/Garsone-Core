import { z } from "zod";
import { qrPublicCodeSchema } from "./qrEvents.js";

export const qrAssignmentsSchema = z.object({
  schemaVersion: z.literal(1),
  sourceStoreId: z.string().uuid(),
  storeSlug: z.string().min(1).max(100),
  tiles: z.array(z.object({
    publicCode: qrPublicCodeSchema,
    tableId: z.string().uuid().nullable(),
    tableLabel: z.string().max(255).nullable(),
    isActive: z.boolean(),
  }).strict()).max(5000),
}).strict().refine(value => new Set(value.tiles.map(tile => tile.publicCode)).size === value.tiles.length, "Duplicate QR codes");

export type QrAssignments = z.infer<typeof qrAssignmentsSchema>;

// Reports are observations from the associated Pi, never cloud table records or
// desired configuration. Keeping the two separate avoids a sync feedback loop.
export function acceptedQrAssignments(input: unknown, node: any, deployment: any, ownedCodes: Set<string>, now = new Date()) {
  const parsed = qrAssignmentsSchema.safeParse(input);
  if (!parsed.success || deployment?.target !== "PI" || deployment.nodeId !== node.id) return null;
  const report = parsed.data;
  if (report.sourceStoreId !== node.storeId || report.storeSlug !== node.store?.slug || report.tiles.some(tile => !ownedCodes.has(tile.publicCode))) return null;
  return { ...report, receivedAt: now.toISOString() };
}

export function qrAssignmentView(store: any) {
  const deployment = store?.venueDeployment;
  // Imported deployment metadata does not change the local database's authority.
  if (process.env.LOCAL_ONLY === "true" || deployment?.target !== "PI") return { source: "ONLINE" as const, receivedAt: null, tiles: new Map<string, QrAssignments["tiles"][number]>() };
  const pending = { source: "PI_PENDING" as const, receivedAt: null, tiles: new Map<string, QrAssignments["tiles"][number]>() };
  const node = deployment.node;
  if (!node || node.id !== deployment.nodeId || node.storeId !== store.id) return pending;
  const saved = node.configJson?.localQrReport;
  if (!saved || typeof saved !== "object") return pending;
  const { receivedAt, ...input } = saved;
  const parsed = qrAssignmentsSchema.safeParse(input);
  if (!parsed.success || typeof receivedAt !== "string" || !Number.isFinite(Date.parse(receivedAt)) || parsed.data.sourceStoreId !== store.id || parsed.data.storeSlug !== store.slug) return pending;
  return { source: "PI" as const, receivedAt, tiles: new Map(parsed.data.tiles.map(tile => [tile.publicCode, tile])) };
}
