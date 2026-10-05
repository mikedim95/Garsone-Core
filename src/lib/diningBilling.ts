import { createHash, randomBytes } from "node:crypto";
import { Prisma, OrderStatus, PaymentStatus } from "@prisma/client";
import { db } from "../db/index.js";

export class BillingError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export const billingRoles = ["waiter", "hybrid", "manager", "architect"];
export const visitTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const requestVisitToken = (request: any) => String(request.headers?.["x-table-visit"] || request.body?.visit || "").trim();

export async function requireGuestVisit(token: string, storeId?: string, visitId?: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new BillingError("VISIT_ACCESS_REQUIRED", 403);
  const session = await db.diningGuestSession.findUnique({ where: { tokenHash: visitTokenHash(token) }, include: { visit: true } });
  if (!session || (storeId && session.visit.storeId !== storeId) || (visitId && session.visitId !== visitId)) {
    throw new BillingError("VISIT_ACCESS_REQUIRED", 403);
  }
  if (session.visit.status === "CLOSED") throw new BillingError("VISIT_CLOSED", 410);
  return session.visit;
}

export async function lockDiningVisit(tx: Prisma.TransactionClient, visitId: string, storeId?: string) {
  await tx.$queryRaw`SELECT "id" FROM "dining_visits" WHERE "id" = ${visitId}::uuid FOR UPDATE`;
  const visit = await tx.diningVisit.findUnique({ where: { id: visitId } });
  if (!visit || (storeId && visit.storeId !== storeId)) throw new BillingError("VISIT_NOT_FOUND", 404);
  if (visit.status === "CLOSED") throw new BillingError("VISIT_CLOSED", 410);
  return visit;
}

export async function openDiningVisit(tx: Prisma.TransactionClient, storeId: string, tableId: string) {
  await tx.$queryRaw`SELECT "id" FROM "tables" WHERE "id" = ${tableId}::uuid FOR UPDATE`;
  const table = await tx.table.findFirst({ where: { id: tableId, storeId, isActive: true } });
  if (!table) throw new BillingError("TABLE_NOT_FOUND", 404);
  const existing = await tx.diningVisit.findUnique({ where: { activeTableId: tableId } });
  if (existing) {
    await tx.$queryRaw`SELECT "id" FROM "dining_visits" WHERE "id" = ${existing.id}::uuid FOR UPDATE`;
    const current = await tx.diningVisit.findUniqueOrThrow({ where: { id: existing.id } });
    if (current.status !== "CLOSED" && current.tableId === tableId && current.activeTableId === tableId) return current;
  }
  const meta = await tx.storeMeta.findUnique({ where: { storeId } });
  return tx.diningVisit.create({ data: { storeId, tableId, activeTableId: tableId, currencyCode: meta?.currencyCode || "EUR" } });
}

export async function joinDiningVisit(storeId: string, tableId: string, priorToken?: string) {
  if (priorToken) {
    const visit = await requireGuestVisit(priorToken, storeId);
    if (visit.tableId !== tableId) throw new BillingError("VISIT_MOVED", 409);
    return { visitId: visit.id, visitToken: priorToken };
  }
  return db.$transaction(async (tx) => {
    const visit = await openDiningVisit(tx, storeId, tableId);
    const visitToken = randomBytes(32).toString("hex");
    await tx.diningGuestSession.create({ data: { visitId: visit.id, tokenHash: visitTokenHash(visitToken) } });
    return { visitId: visit.id, visitToken };
  });
}

export const bumpDiningVisit = (tx: Prisma.TransactionClient, visitId: string) =>
  tx.diningVisit.update({ where: { id: visitId }, data: { revision: { increment: 1 } } });

export async function assertOrderFinanciallyMutable(tx: Prisma.TransactionClient, order: { id: string; diningVisitId?: string | null; status?: string; paymentStatus?: string }) {
  if (order.diningVisitId) await lockDiningVisit(tx, order.diningVisitId);
  if (order.status === "PAID" || order.paymentStatus === "COMPLETED" ||
    await tx.diningPaymentAllocation.count({ where: { orderItem: { orderId: order.id } } })) {
    throw new BillingError("PAYMENT_RECORDED_ORDER_LOCKED", 409);
  }
}

const visitInclude = {
  table: { select: { id: true, label: true } },
  orders: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }], include: { orderItems: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }], include: {
    orderItemOptions: true, item: { select: { categoryId: true, printerTopic: true, category: { select: { title: true } } } }, paymentAllocations: true,
  } } } },
  payments: { orderBy: { recordedAt: "asc" as const }, include: { allocations: true } },
};

export async function diningVisitSnapshot(client: Prisma.TransactionClient | typeof db, storeId: string, id: string, guest = false) {
  const visit = await client.diningVisit.findFirst({ where: { id, storeId }, include: visitInclude });
  if (!visit) throw new BillingError("VISIT_NOT_FOUND", 404);
  const items = visit.orders.filter((o) => o.status !== "CANCELLED").flatMap((order) => order.orderItems.map((line) => {
    const totalCents = line.unitPriceCents * line.quantity;
    const paidCents = line.paymentAllocations.reduce((sum, allocation) => sum + allocation.amountCents, 0);
    const outstandingCents = Math.max(0, totalCents - paidCents);
    return { orderItemId: line.id, orderId: order.id, title: line.titleSnapshot, quantity: line.quantity,
      unitPriceCents: line.unitPriceCents, totalCents, paidCents, outstandingCents,
      remainingQuantity: line.unitPriceCents > 0 ? Math.ceil(outstandingCents / line.unitPriceCents) : 0 };
  }));
  const totalCents = items.reduce((sum, item) => sum + item.totalCents, 0);
  const paidCents = visit.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const orders = visit.orders.map((order) => ({
    id: order.id, diningVisitId: visit.id, tableId: visit.tableId, tableLabel: visit.table.label,
    status: order.status, paymentStatus: order.paymentStatus, note: order.note, ticketNumber: order.ticketNumber,
    totalCents: order.totalCents, total: order.totalCents / 100, createdAt: order.createdAt,
    placedAt: order.placedAt, updatedAt: order.updatedAt, preparingAt: order.preparingAt, readyAt: order.readyAt,
    servedAt: order.servedAt, paidAt: order.paidAt, cancelledAt: order.cancelledAt, cancelReason: order.cancelReason,
    items: order.orderItems.map((line) => ({ id: line.id, itemId: line.itemId, title: line.titleSnapshot,
      quantity: line.quantity, unitPriceCents: line.unitPriceCents, unitPrice: line.unitPriceCents / 100,
      status: line.status, acceptedAt: line.acceptedAt, servedAt: line.servedAt,
      categoryId: line.item.categoryId, categoryTitle: line.item.category.title, printerTopic: line.item.printerTopic,
      modifiers: line.orderItemOptions.map((option) => ({ ...option, title: option.titleSnapshot, priceDelta: option.priceDeltaCents / 100 })),
    })),
  }));
  return { id: visit.id, tableId: visit.tableId, tableLabel: visit.table.label, status: visit.status,
    revision: visit.revision, currencyCode: visit.currencyCode, openedAt: visit.openedAt,
    closedAt: visit.closedAt, billRequestedAt: visit.billRequestedAt, totalCents, paidCents,
    outstandingCents: Math.max(0, totalCents - paidCents), orderCount: orders.length, orders, items,
    ...(!guest ? { payments: visit.payments.map((payment) => ({
      id: payment.id, requestId: payment.requestId, amountCents: payment.amountCents, method: payment.method,
      recordedAt: payment.recordedAt, recordedBy: payment.recordedBy,
      allocations: payment.allocations.map((a) => ({ orderItemId: a.orderItemId, amountCents: a.amountCents })),
    })) } : {}),
  };
}

function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export async function diningAction<T extends { requestId: string }>(storeId: string, kind: string, input: T,
  actorId: string | undefined, work: (tx: Prisma.TransactionClient) => Promise<{ visitId: string; paymentId?: string; [key: string]: unknown }>) {
  const hash = createHash("sha256").update(JSON.stringify(canonical({ kind, ...input }))).digest("hex");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${storeId}:${input.requestId}`}, 0))`;
    const previous = await tx.diningAction.findUnique({ where: { storeId_requestId: { storeId, requestId: input.requestId } } });
    if (previous) {
      if (previous.requestHash !== hash || previous.kind !== kind) throw new BillingError("REQUEST_ID_REUSED", 409);
      return { ...(previous.detail as { visitId: string; paymentId?: string }), replayed: true };
    }
    const detail = await work(tx);
    await tx.diningAction.create({ data: { storeId, visitId: detail.visitId, requestId: input.requestId, requestHash: hash,
      kind, actorId, detail: detail as Prisma.InputJsonObject } });
    return { ...detail, replayed: false };
  }, { timeout: 15_000 });
}

export function checkVisitRevision(visit: { revision: number }, expected: number) {
  if (visit.revision !== expected) throw new BillingError("BILL_CHANGED", 409);
}

export async function collectDiningPayment(storeId: string, actorId: string, input: {
  visitId: string; requestId: string; expectedRevision: number; method: "CASH" | "CARD";
  amountCents?: number; items?: Array<{ orderItemId: string; quantity: number }>;
}) {
  return diningAction(storeId, "PAYMENT", input, actorId, async (tx) => {
    const visit = await lockDiningVisit(tx, input.visitId, storeId);
    checkVisitRevision(visit, input.expectedRevision);
    const snapshot = await diningVisitSnapshot(tx, storeId, visit.id);
    const allocations: Array<{ orderItemId: string; amountCents: number }> = [];
    if (input.items) {
      const seen = new Set<string>();
      for (const choice of input.items) {
        const item = snapshot.items.find((line) => line.orderItemId === choice.orderItemId);
        if (!item || seen.has(choice.orderItemId) || choice.quantity > item.remainingQuantity || choice.quantity < 1) {
          throw new BillingError("INVALID_PAYMENT_ITEMS", 400);
        }
        seen.add(choice.orderItemId);
        const amountCents = Math.min(choice.quantity * item.unitPriceCents, item.outstandingCents);
        if (amountCents <= 0) throw new BillingError("INVALID_PAYMENT_ITEMS", 400);
        allocations.push({ orderItemId: item.orderItemId, amountCents });
      }
    } else {
      let remaining = input.amountCents || 0;
      if (remaining <= 0 || remaining > snapshot.outstandingCents) throw new BillingError("PAYMENT_EXCEEDS_BALANCE", 409);
      for (const item of snapshot.items) {
        const amountCents = Math.min(remaining, item.outstandingCents);
        if (amountCents > 0) allocations.push({ orderItemId: item.orderItemId, amountCents });
        remaining -= amountCents;
      }
    }
    const amountCents = allocations.reduce((sum, item) => sum + item.amountCents, 0);
    if (amountCents <= 0 || amountCents > snapshot.outstandingCents) throw new BillingError("PAYMENT_EXCEEDS_BALANCE", 409);
    const payment = await tx.diningPayment.create({ data: { storeId, visitId: visit.id, requestId: input.requestId,
      method: input.method, amountCents, recordedBy: actorId, allocations: { create: allocations } } });
    const after = await diningVisitSnapshot(tx, storeId, visit.id);
    for (const order of after.orders) {
      if (order.status === "CANCELLED") continue;
      const lines = after.items.filter((line) => line.orderId === order.id);
      if (order.paymentStatus !== "COMPLETED" && lines.length && lines.every((line) => line.outstandingCents === 0)) {
        // Fulfilment and payment are independent: prepayment does not mark food served.
        await tx.order.update({ where: { id: order.id }, data: { paymentStatus: PaymentStatus.COMPLETED, paidAt: payment.recordedAt } });
      }
    }
    await bumpDiningVisit(tx, visit.id);
    return { visitId: visit.id, paymentId: payment.id };
  });
}

export async function mutateDiningVisit(storeId: string, actorId: string | undefined, kind: "CLOSE" | "TRANSFER" | "ADOPT" | "BILL_REQUEST", input: {
  visitId: string; requestId: string; expectedRevision?: number; tableId?: string; orderIds?: string[];
}) {
  return diningAction(storeId, kind, input, actorId, async (tx) => {
    const visit = await lockDiningVisit(tx, input.visitId, storeId);
    if (input.expectedRevision !== undefined) checkVisitRevision(visit, input.expectedRevision);
    if (kind === "BILL_REQUEST") {
      if (visit.status !== "BILL_REQUESTED") await tx.diningVisit.update({ where: { id: visit.id }, data: {
        status: "BILL_REQUESTED", billRequestedAt: new Date(), revision: { increment: 1 },
      } });
    } else if (kind === "CLOSE") {
      const snapshot = await diningVisitSnapshot(tx, storeId, visit.id);
      if (snapshot.outstandingCents !== 0) throw new BillingError("BILL_NOT_SETTLED", 409);
      if (snapshot.orders.some((order) => !["SERVED", "PAID", "CANCELLED"].includes(order.status))) {
        throw new BillingError("VISIT_SERVICE_PENDING", 409);
      }
      await tx.diningVisit.update({ where: { id: visit.id }, data: { status: "CLOSED", activeTableId: null, closedAt: new Date(), revision: { increment: 1 } } });
    } else if (kind === "TRANSFER") {
      if (!input.tableId || input.tableId === visit.tableId) throw new BillingError("INVALID_TRANSFER", 400);
      // A table row lock serializes opening a new visit against this transfer.
      // A transfer never merges parties or their financial histories implicitly.
      await tx.$queryRaw`SELECT "id" FROM "tables" WHERE "id" = ${input.tableId}::uuid FOR UPDATE`;
      const target = await tx.table.findFirst({ where: { id: input.tableId, storeId, isActive: true } });
      if (!target) throw new BillingError("TABLE_NOT_FOUND", 404);
      const occupied = await tx.diningVisit.findUnique({ where: { activeTableId: input.tableId } });
      const legacy = await tx.order.count({ where: { storeId, tableId: input.tableId, diningVisitId: null,
        status: { notIn: [OrderStatus.CANCELLED, OrderStatus.PAID] }, paymentStatus: { not: PaymentStatus.COMPLETED } } });
      if (occupied || legacy) throw new BillingError("TABLE_OCCUPIED", 409);
      await tx.diningVisit.update({ where: { id: visit.id }, data: { tableId: input.tableId, activeTableId: input.tableId, revision: { increment: 1 } } });
      await tx.order.updateMany({ where: { diningVisitId: visit.id }, data: { tableId: input.tableId } });
      return { visitId: visit.id, fromTableId: visit.tableId, tableId: input.tableId };
    } else if (kind === "ADOPT") {
      const ids = [...new Set(input.orderIds || [])].sort();
      if (!ids.length) throw new BillingError("INVALID_LEGACY_ORDERS", 400);
      const orders = await tx.order.findMany({ where: { id: { in: ids }, storeId, tableId: visit.tableId, diningVisitId: null,
        status: { notIn: [OrderStatus.CANCELLED, OrderStatus.PAID] }, paymentStatus: { not: PaymentStatus.COMPLETED } } });
      if (orders.length !== ids.length) throw new BillingError("INVALID_LEGACY_ORDERS", 409);
      for (const order of orders) {
        const changed = await tx.order.updateMany({ where: { id: order.id, diningVisitId: null,
          status: { notIn: [OrderStatus.CANCELLED, OrderStatus.PAID] }, paymentStatus: { not: PaymentStatus.COMPLETED } }, data: { diningVisitId: visit.id } });
        if (changed.count !== 1) throw new BillingError("INVALID_LEGACY_ORDERS", 409);
      }
      await bumpDiningVisit(tx, visit.id);
      return { visitId: visit.id, orderIds: ids };
    }
    return { visitId: visit.id };
  });
}
