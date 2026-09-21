import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Prisma, QrEvent } from "@prisma/client";
import { z } from "zod";
import { db } from "../db/index.js";

const controlCharacters = /[\u0000-\u001f\u007f]/;
export const qrEventIdSchema = z.string().uuid();
export const qrPublicCodeSchema = z.string().trim().toUpperCase().regex(/^GT-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/);

/** These URLs are published, never fetched by the cloud server. Local HTTP is intentional. */
export function normalizeQrUrl(value: string, originOnly = false): string {
  if (value !== value.trim() || controlCharacters.test(value) || value.includes("\\") || !/^https?:\/\//i.test(value)) {
    throw new Error("Use an absolute HTTP or HTTPS URL without whitespace or backslashes");
  }
  const url = new URL(value);
  if (!url.hostname || url.username || url.password || url.search || url.hash || value.includes("?") || value.includes("#")) {
    throw new Error("URLs must not contain credentials, a query, or a fragment");
  }
  // Reject escaped controls too, so generated redirect headers remain unambiguous.
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) throw new Error("URL contains an unsafe escape");
  if (originOnly && url.pathname !== "/") throw new Error("App URL must be an origin without a path");
  return originOnly ? url.origin : `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function urlSchema(originOnly: boolean) {
  return z.string().min(1).max(2000).transform((value, ctx) => {
    try { return normalizeQrUrl(value, originOnly); }
    catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message }); return z.NEVER; }
  });
}

export const qrAssignmentsSchema = z.array(z.object({
  publicCode: qrPublicCodeSchema,
  tableId: z.string().uuid().nullable(),
  label: z.string().trim().max(100).refine((value) => !controlCharacters.test(value), "Invalid label").nullable(),
  isActive: z.boolean(),
}).strict()).max(500).superRefine((rows, ctx) => {
  if (new Set(rows.map((row) => row.publicCode)).size !== rows.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Public codes must be unique within an event" });
  }
}).transform((rows) => rows.sort((a, b) => a.publicCode.localeCompare(b.publicCode)));

const eventFields = {
  name: z.string().trim().min(1).max(120).refine((value) => !controlCharacters.test(value), "Invalid event name"),
  publicAppUrl: urlSchema(true),
  publicApiUrl: urlSchema(false),
  isActive: z.boolean(),
  assignments: qrAssignmentsSchema,
};

export const qrEventCreateSchema = z.object({
  ...eventFields,
  isActive: eventFields.isActive.default(true),
  assignments: eventFields.assignments.default([]),
}).strict();
export const qrEventPatchSchema = z.object(eventFields).partial().extend({
  expectedRevision: z.number().int().min(1).max(2147483646),
}).strict().refine((value) => Object.keys(value).length > 1, "No fields provided");
export const qrEventBundleSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.object({
    id: qrEventIdSchema,
    storeId: z.string().uuid(),
    storeSlug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    ...eventFields,
    revision: z.number().int().min(1).max(2147483646),
  }).strict(),
  exportedAt: z.string().datetime(),
}).strict();

export type QrAssignments = z.infer<typeof qrAssignmentsSchema>;
export type QrEventBundle = z.infer<typeof qrEventBundleSchema>;
export type StoredQrEvent = QrEvent & { store: { slug: string; name: string } };

export class QrEventError extends Error {
  constructor(public statusCode: number, public code: string) { super(code); }
}

export function eventConfiguration(event: StoredQrEvent): QrEventBundle["event"] {
  return {
    id: event.id, storeId: event.storeId, storeSlug: event.store.slug, name: event.name,
    publicAppUrl: event.publicAppUrl, publicApiUrl: event.publicApiUrl,
    revision: event.revision, isActive: event.isActive,
    assignments: qrAssignmentsSchema.parse(event.assignmentsJson),
  };
}

export function serializeQrEvent(event: StoredQrEvent) {
  return {
    ...eventConfiguration(event), storeName: event.store.name,
    isImported: event.isImported,
    paired: Boolean(event.syncTokenHash), lastAppliedRevision: event.lastAppliedRevision,
    lastAppliedAt: event.lastAppliedAt, createdAt: event.createdAt, updatedAt: event.updatedAt,
  };
}

export function exportQrEvent(event: StoredQrEvent): QrEventBundle {
  return { schemaVersion: 1, event: eventConfiguration(event), exportedAt: new Date().toISOString() };
}

export async function requireEvent(eventId: string, tx: Prisma.TransactionClient = db): Promise<StoredQrEvent> {
  const event = await tx.qrEvent.findUnique({ where: { id: eventId }, include: { store: { select: { slug: true, name: true } } } });
  if (!event) throw new QrEventError(404, "QR_EVENT_NOT_FOUND");
  return event;
}

export async function validateEventTables(storeId: string, assignments: QrAssignments, tx: Prisma.TransactionClient = db) {
  const ids = [...new Set(assignments.flatMap((row) => row.tableId ? [row.tableId] : []))];
  if (!ids.length) return;
  const count = await tx.table.count({ where: { storeId, id: { in: ids } } });
  if (count !== ids.length) throw new QrEventError(400, "QR_TABLES_MUST_BELONG_TO_EVENT_STORE");
}

/** Shared by authenticated local upload and the optional outbound pull worker. */
export async function importQrEventBundle(input: unknown, actorProfileId: string | null = null) {
  if (process.env.LOCAL_ONLY !== "true") throw new QrEventError(403, "QR_IMPORT_REQUIRES_LOCAL_CORE");
  const imported = qrEventBundleSchema.parse(input).event;
  return db.$transaction(async (tx) => {
    const store = await tx.store.findUnique({ where: { id: imported.storeId }, select: { slug: true } });
    if (!store || store.slug !== imported.storeSlug) throw new QrEventError(400, "QR_EVENT_STORE_MISMATCH");
    await validateEventTables(imported.storeId, imported.assignments, tx);
    const current = await tx.qrEvent.findUnique({ where: { id: imported.id }, include: { store: { select: { slug: true, name: true } } } });
    if (current) {
      if (current.storeId !== imported.storeId) throw new QrEventError(409, "QR_EVENT_STORE_MISMATCH");
      if (!current.isImported) throw new QrEventError(409, "QR_EVENT_LOCAL_ID_CONFLICT");
      if (current.revision > imported.revision) throw new QrEventError(409, "QR_EVENT_OLDER_REVISION");
      if (current.revision === imported.revision) {
        // A lost sync acknowledgement may replay this revision; only identical content is idempotent.
        if (!isDeepStrictEqual(eventConfiguration(current), imported)) throw new QrEventError(409, "QR_EVENT_REVISION_CONTENT_CONFLICT");
        return { event: current, unchanged: true };
      }
      const changed = await tx.qrEvent.updateMany({ where: { id: current.id, revision: current.revision, isImported: true }, data: {
        name: imported.name, publicAppUrl: imported.publicAppUrl, publicApiUrl: imported.publicApiUrl,
        isActive: imported.isActive, assignmentsJson: imported.assignments, revision: imported.revision,
        lastAppliedRevision: imported.revision, lastAppliedAt: new Date(),
      } });
      if (!changed.count) throw new QrEventError(409, "QR_EVENT_REVISION_CONFLICT");
    } else {
      await tx.qrEvent.create({ data: {
        id: imported.id, storeId: imported.storeId, name: imported.name,
        publicAppUrl: imported.publicAppUrl, publicApiUrl: imported.publicApiUrl,
        revision: imported.revision, isActive: imported.isActive,
        assignmentsJson: imported.assignments, isImported: true,
        lastAppliedRevision: imported.revision, lastAppliedAt: new Date(),
      } });
    }
    await tx.auditLog.create({ data: {
      storeId: imported.storeId, entityType: "qr_event", entityId: imported.id,
      action: "QR_EVENT_IMPORTED", actorProfileId, metaJson: { revision: imported.revision },
    } });
    return { event: await requireEvent(imported.id, tx), unchanged: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export function qrSyncTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function matchesQrSyncToken(token: string, expectedHash: string | null): boolean {
  if (!expectedHash || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const actual = Buffer.from(qrSyncTokenHash(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Event assignments never mutate global QR inventory or another event's assignments. */
export async function resolveQrEvent(eventId: string, publicCode: string) {
  const parsedId = qrEventIdSchema.safeParse(eventId);
  const parsedCode = qrPublicCodeSchema.safeParse(publicCode);
  if (!parsedId.success || !parsedCode.success) return null;
  const event = await db.qrEvent.findUnique({ where: { id: parsedId.data }, include: { store: { select: { slug: true, name: true } } } });
  if (!event) return null;
  const assignment = qrAssignmentsSchema.parse(event.assignmentsJson).find((row) => row.publicCode === parsedCode.data);
  if (!assignment) return null;
  const table = assignment.tableId ? await db.table.findFirst({ where: { id: assignment.tableId, storeId: event.storeId }, select: { id: true, label: true, isActive: true } }) : null;
  const isActive = event.isActive && assignment.isActive && (table?.isActive ?? !assignment.tableId);
  const redirectUrl = isActive && table ? `${event.publicAppUrl}/table/${table.id}?${new URLSearchParams({ storeSlug: event.store.slug })}` : null;
  return {
    eventId: event.id, publicCode: assignment.publicCode, isActive,
    storeId: event.storeId, storeSlug: event.store.slug, storeName: event.store.name,
    tableId: table?.id ?? null, tableLabel: table?.label ?? null, label: assignment.label,
    publicAppUrl: event.publicAppUrl, publicApiUrl: event.publicApiUrl, redirectUrl,
  };
}
