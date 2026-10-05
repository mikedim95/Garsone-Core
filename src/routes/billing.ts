import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware, optionalAuthMiddleware, requireRole } from "../middleware/auth.js";
import { ensureStore, STORE_SLUG } from "../lib/store.js";
import { emitRealtime, closeGuestVisitSockets } from "../lib/realtime.js";
import { BillingError, billingRoles, requireGuestVisit, requestVisitToken, joinDiningVisit,
  diningVisitSnapshot, collectDiningPayment, mutateDiningVisit, diningAction, openDiningVisit } from "../lib/diningBilling.js";

export function sendBillingError(error: unknown, reply: FastifyReply) {
  if (error instanceof BillingError) return reply.code(error.status).send({ error: error.code });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: "INVALID_BILLING_REQUEST", details: error.errors });
  throw error;
}

export async function publishBillingUpdate(storeSlug: string, visitId: string) {
  const visit = await db.diningVisit.findUnique({ where: { id: visitId } });
  if (!visit) return;
  const payload = { visitId, tableId: visit.tableId, status: visit.status, ts: new Date().toISOString() };
  emitRealtime(`${storeSlug}/billing/updated`, payload, { roles: ["waiter", "hybrid", "manager", "architect"] });
  emitRealtime(`${storeSlug}/visits/updated`, payload, { anonymousOnly: true, visitId });
  if (visit.status === "CLOSED") closeGuestVisitSockets(visitId);
}

// Apply within the orders plugin, including public reads. Supplying a bogus
// Authorization header never bypasses guest capability checks.
export async function guestOrdersGuard(request: any, reply: FastifyReply) {
  const route = request.routeOptions.url;
  const guarded = ["/orders", "/orders/submissions/:submissionId", "/orders/:id", "/orders/:id/items/:itemId",
    "/public/table/:id/orders/pending", "/public/table/:id/orders", "/public/orders/:id/summary", "/call-waiter"];
  if (!guarded.includes(route) || (route === "/orders" && request.method !== "POST") || (route === "/orders/:id" && request.method !== "PATCH")) return;
  try {
    await optionalAuthMiddleware(request, reply);
    if (reply.sent) return;
    if (request.user?.role && request.user.role !== "guest") return;
    const store = await ensureStore(request);
    const tableId = request.body?.tableId || (route.includes("/table/") ? request.params?.id : undefined);
    if (tableId && z.string().uuid().safeParse(tableId).success) {
      const table = await db.table.findFirst({ where: { id: tableId, storeId: store.id } });
      if (!table) return reply.code(404).send({ error: "Table not found" });
    }
    const visit = await requireGuestVisit(requestVisitToken(request), store.id);
    if (tableId && visit.tableId !== tableId) throw new BillingError("VISIT_MOVED", 409);
    request.diningVisit = visit;
    if (route === "/orders/:id" || route === "/orders/:id/items/:itemId" || route === "/public/orders/:id/summary") {
      const order = await db.order.findFirst({ where: { id: request.params.id, storeId: store.id, diningVisitId: visit.id } });
      if (!order) throw new BillingError("Order not found", 404);
    }
    reply.header("Cache-Control", "no-store");
  } catch (error) { return sendBillingError(error, reply); }
}

export async function billingRoutes(fastify: FastifyInstance) {
  const staff = [authMiddleware, requireRole(billingRoles)];
  const idParams = z.object({ id: z.string().uuid() });
  const requestSchema = z.object({ requestId: z.string().uuid() });
  const mutationSchema = requestSchema.extend({ expectedRevision: z.number().int().positive() });
  const replyAction = async (request: any, reply: FastifyReply, store: any, result: any) => {
    const visit = await diningVisitSnapshot(db, store.id, result.visitId);
    const payment = result.paymentId ? visit.payments?.find((p) => p.id === result.paymentId) : undefined;
    // The ledger commit remains successful if a client notification fails.
    try { await publishBillingUpdate(store.slug, result.visitId); } catch (error) { request.log.warn({ err: error }, "Billing notification failed"); }
    return reply.code(result.replayed ? 200 : 201).send({ visit, ...(payment ? { payment } : {}), replayed: result.replayed });
  };
  fastify.addHook("onSend", async (_request, reply, payload) => { reply.header("Cache-Control", "no-store"); return payload; });

  fastify.post("/public/table/:id/visit", async (request, reply) => {
    try {
      const { id } = idParams.parse(request.params);
      const store = await ensureStore(request);
      const joined = await joinDiningVisit(store.id, id, requestVisitToken(request));
      return reply.send({ visit: await diningVisitSnapshot(db, store.id, joined.visitId, true), visitToken: joined.visitToken });
    } catch (error) { return sendBillingError(error, reply); }
  });
  fastify.get("/public/visits/:id", async (request, reply) => {
    try {
      const { id } = idParams.parse(request.params);
      const store = await ensureStore(request);
      await requireGuestVisit(requestVisitToken(request), store.id, id);
      return reply.send({ visit: await diningVisitSnapshot(db, store.id, id, true) });
    } catch (error) { return sendBillingError(error, reply); }
  });
  fastify.post("/public/visits/:id/bill-request", async (request, reply) => {
    try {
      const { id } = idParams.parse(request.params);
      const body = requestSchema.parse(request.body);
      const store = await ensureStore(request);
      await requireGuestVisit(requestVisitToken(request), store.id, id);
      const result = await mutateDiningVisit(store.id, undefined, "BILL_REQUEST", { ...body, visitId: id });
      try { await publishBillingUpdate(store.slug, id); } catch {}
      return reply.send({ visit: await diningVisitSnapshot(db, store.id, id, true), replayed: result.replayed });
    } catch (error) { return sendBillingError(error, reply); }
  });
  fastify.get("/billing/visits", { preHandler: staff }, async (request, reply) => {
    const store = await ensureStore(request);
    const closed = (request.query as any)?.status === "closed";
    const visits = await db.diningVisit.findMany({ where: { storeId: store.id, status: closed ? "CLOSED" : { not: "CLOSED" } }, orderBy: { openedAt: "desc" }, take: 200 });
    const snapshots = await Promise.all(visits.map((visit) => diningVisitSnapshot(db, store.id, visit.id)));
    const legacyOrders = await db.order.findMany({ where: { storeId: store.id, diningVisitId: null },
      orderBy: { createdAt: "desc" }, take: 500, include: { table: { select: { label: true } } } });
    const meta = await db.storeMeta.findUnique({ where: { storeId: store.id } });
    return reply.send({ currencyCode: meta?.currencyCode || "EUR", visits: snapshots.map(({ orders, items, payments, ...summary }) => summary),
      legacyOrders: legacyOrders.map((o) => ({ id: o.id, tableId: o.tableId, tableLabel: o.table.label, status: o.status,
        totalCents: o.totalCents, createdAt: o.createdAt, paidAt: o.paidAt, paymentStatus: o.paymentStatus })) });
  });
  fastify.post("/billing/visits", { preHandler: staff }, async (request, reply) => {
    try {
      const body = requestSchema.extend({ tableId: z.string().uuid() }).parse(request.body);
      const store = await ensureStore(request);
      const result = await diningAction(store.id, "OPEN", body, (request as any).user.userId, async (tx) => ({ visitId: (await openDiningVisit(tx, store.id, body.tableId)).id }));
      return replyAction(request, reply, store, result);
    } catch (error) { return sendBillingError(error, reply); }
  });
  fastify.get("/billing/visits/:id", { preHandler: staff }, async (request, reply) => {
    try {
      const { id } = idParams.parse(request.params);
      const store = await ensureStore(request);
      return reply.send({ visit: await diningVisitSnapshot(db, store.id, id) });
    } catch (error) { return sendBillingError(error, reply); }
  });
  fastify.post("/billing/visits/:id/payments", { preHandler: staff }, async (request, reply) => {
    try {
      const { id } = idParams.parse(request.params);
      const body = mutationSchema.extend({ method: z.enum(["CASH", "CARD"]), amountCents: z.number().int().positive().max(2147483647).optional(),
        items: z.array(z.object({ orderItemId: z.string().uuid(), quantity: z.number().int().positive().max(999) })).min(1).max(100).optional(),
      }).refine((value) => (value.amountCents !== undefined) !== (value.items !== undefined)).parse(request.body);
      const store = await ensureStore(request);
      const result = await collectDiningPayment(store.id, (request as any).user.userId, { ...body, visitId: id });
      return replyAction(request, reply, store, result);
    } catch (error) { return sendBillingError(error, reply); }
  });
  fastify.get("/billing/payments/:requestId", { preHandler: staff }, async (request, reply) => {
    try {
      const { requestId } = requestSchema.parse(request.params);
      const store = await ensureStore(request);
      const payment = await db.diningPayment.findUnique({ where: { storeId_requestId: { storeId: store.id, requestId } }, include: { allocations: true } });
      if (!payment) throw new BillingError("PAYMENT_NOT_FOUND", 404);
      const visit = await diningVisitSnapshot(db, store.id, payment.visitId);
      return reply.send({ payment: visit.payments?.find((p) => p.id === payment.id), visit });
    } catch (error) { return sendBillingError(error, reply); }
  });
  for (const [suffix, kind] of [["close", "CLOSE"], ["transfer", "TRANSFER"], ["adopt", "ADOPT"]] as const) {
    fastify.post(`/billing/visits/:id/${suffix}`, { preHandler: staff }, async (request, reply) => {
      try {
        const { id } = idParams.parse(request.params);
        const schema = kind === "TRANSFER" ? mutationSchema.extend({ tableId: z.string().uuid() }) : kind === "ADOPT" ? mutationSchema.extend({ orderIds: z.array(z.string().uuid()).min(1).max(100) }) : mutationSchema;
        const body = schema.parse(request.body);
        const store = await ensureStore(request);
        const result = await mutateDiningVisit(store.id, (request as any).user.userId, kind, { ...body, visitId: id });
        return replyAction(request, reply, store, result);
      } catch (error) { return sendBillingError(error, reply); }
    });
  }
  fastify.get("/manager/billing/summary", { preHandler: [authMiddleware, requireRole(["manager", "architect"])] }, async (request, reply) => {
    try {
      const query = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).parse(request.query);
      const from = new Date(query.from), to = new Date(query.to);
      if (to <= from || to.getTime() - from.getTime() > 367 * 86400000) throw new BillingError("INVALID_REPORT_PERIOD", 400);
      const store = await ensureStore(request);
      const currencyCode = (await db.storeMeta.findUnique({ where: { storeId: store.id } }))?.currencyCode || "EUR";
      const [sales, payments, visits, legacy] = await Promise.all([
        db.order.aggregate({ where: { storeId: store.id, status: { not: "CANCELLED" }, createdAt: { gte: from, lt: to } }, _sum: { totalCents: true } }),
        db.diningPayment.findMany({ where: { storeId: store.id, recordedAt: { gte: from, lt: to } }, select: { amountCents: true, method: true, visit: { select: { currencyCode: true } } } }),
        db.diningVisit.findMany({ where: { storeId: store.id, status: { not: "CLOSED" } }, select: { id: true } }),
        db.order.aggregate({ where: { storeId: store.id, diningVisitId: null, status: "PAID", OR: [{ paidAt: { gte: from, lt: to } }, { paidAt: null, createdAt: { gte: from, lt: to } }] }, _sum: { totalCents: true } }),
      ]);
      const snapshots = await Promise.all(visits.map((visit) => diningVisitSnapshot(db, store.id, visit.id)));
      const foreignSales = await db.order.count({ where: { storeId: store.id, status: { not: "CANCELLED" }, createdAt: { gte: from, lt: to }, diningVisit: { currencyCode: { not: currencyCode } } } });
      if (foreignSales || payments.some((p) => p.visit.currencyCode !== currencyCode) || snapshots.some((v) => v.currencyCode !== currencyCode)) throw new BillingError("MIXED_BILLING_CURRENCIES", 409);
      return reply.send({ currencyCode, salesCents: sales._sum.totalCents || 0, collectedCents: payments.reduce((s, p) => s + p.amountCents, 0),
        outstandingCents: snapshots.reduce((s, v) => s + v.outstandingCents, 0), legacyPaidCents: legacy._sum.totalCents || 0,
        paymentCount: payments.length, cashCents: payments.filter((p) => p.method === "CASH").reduce((s, p) => s + p.amountCents, 0),
        cardCents: payments.filter((p) => p.method === "CARD").reduce((s, p) => s + p.amountCents, 0), asOf: new Date().toISOString() });
    } catch (error) { return sendBillingError(error, reply); }
  });
}
