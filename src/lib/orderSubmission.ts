import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

export class SubmissionConflictError extends Error {
  constructor() { super("IDEMPOTENCY_KEY_REUSED"); }
}

export function readSubmissionId(bodyId: string | undefined, header: unknown): string | undefined {
  const headerId = header === undefined ? undefined : z.string().uuid().parse(header);
  if (bodyId && headerId && bodyId.toLowerCase() !== headerId.toLowerCase()) {
    throw new SubmissionConflictError();
  }
  return (bodyId || headerId)?.toLowerCase();
}

type SubmissionPayload = {
  tableId: string;
  note?: string;
  items: Array<{ itemId: string; quantity: number; modifiers?: Record<string, string | string[]> }>;
};

/** Only the order's business intent belongs in this fingerprint. Locality
 * approvals and visit tokens can expire after a successful commit, and must not
 * prevent a phone from recovering that already accepted order. */
export function orderSubmissionHash(payload: SubmissionPayload): string {
  const items = payload.items.map((item) => ({
    itemId: item.itemId.toLowerCase(),
    quantity: item.quantity,
    modifiers: Object.fromEntries(Object.entries(item.modifiers || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, [...new Set((Array.isArray(value) ? value : [value]).filter(Boolean))].sort()])),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify({
    tableId: payload.tableId.toLowerCase(), note: payload.note || "", items,
  })).digest("hex");
}

export function assertSubmissionMatches(existing: { submissionHash: string | null }, hash: string) {
  if (existing.submissionHash !== hash) throw new SubmissionConflictError();
}

/** Held until commit/rollback, across every Core process. Hash collisions only
 * serialize unrelated requests; the unique DB key remains the authority. */
export async function lockOrderSubmission(tx: Prisma.TransactionClient, storeId: string, submissionId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${storeId}:${submissionId}`}, 0))`;
}
