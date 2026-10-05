import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import Fastify from "fastify";
import { WebSocket } from "ws";

const databaseUrl = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Run tests/run-order-reliability.mjs with its disposable database");
const target = new URL(databaseUrl);
if (target.hostname !== "127.0.0.1" || target.pathname !== "/garsone_reliability_test") throw new Error("Refusing non-isolated database");
Object.assign(process.env, { NODE_ENV: "test", DB_CONNECTION: "default", DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl,
  STORE_SLUG: "billing-test", LOCAL_ONLY: "true", LOCAL_PRINTING_ENABLED: "false", MQTT_DISABLED: "true",
  JWT_SECRET: "billing-test-key-never-used-outside-disposable-test-db" });
const { db } = await import("../dist/db/index.js");
const { billingRoutes } = await import("../dist/routes/billing.js");
const { orderRoutes } = await import("../dist/routes/orders.js");
const { managerRoutes } = await import("../dist/routes/manager.js");
const { setupRealtimeGateway } = await import("../dist/lib/realtime.js");
const { signToken } = await import("../dist/lib/jwt.js");
const { ensureDiningBillingSchema } = await import("../dist/db/ensureDiningBillingSchema.js");

test("persistent visits, split payments and guest isolation with real PostgreSQL", async (t) => {
  const store = await db.store.create({ data: { slug: "billing-test", name: "Billing test" } });
  const foreign = await db.store.create({ data: { slug: "billing-foreign", name: "Other venue" } });
  await db.storeMeta.create({ data: { storeId: store.id, currencyCode: "EUR", locale: "en" } });
  const tables = await Promise.all(["One", "Two", "Occupied", "Legacy"].map((label) => db.table.create({ data: { storeId: store.id, label } })));
  const foreignTable = await db.table.create({ data: { storeId: foreign.id, label: "Foreign" } });
  const profiles = await Promise.all(["MANAGER", "WAITER", "COOK"].map((role) => db.profile.create({ data: {
    storeId: store.id, email: `${role}@billing.test`, passwordHash: "unused", role,
  } })));
  const foreignManager = await db.profile.create({ data: { storeId: foreign.id, email: "manager@foreign.test", passwordHash: "unused", role: "MANAGER" } });
  const auth = (profile, venue = store) => ({ authorization: `Bearer ${signToken({ userId: profile.id, email: profile.email,
    role: profile.role.toLowerCase(), storeId: venue.id, storeSlug: venue.slug })}` });
  const manager = auth(profiles[0]), waiter = auth(profiles[1]), cook = auth(profiles[2]);
  const category = await db.category.create({ data: { storeId: store.id, slug: "drinks", title: "Drinks" } });
  const coffee = await db.item.create({ data: { storeId: store.id, categoryId: category.id, slug: "coffee", title: "Coffee", priceCents: 300 } });
  const tea = await db.item.create({ data: { storeId: store.id, categoryId: category.id, slug: "tea", title: "Tea", priceCents: 200 } });
  const legacy = await db.order.create({ data: { storeId: store.id, tableId: tables[3].id, status: "SERVED", totalCents: 300,
    orderItems: { create: [{ itemId: coffee.id, titleSnapshot: "Legacy coffee", unitPriceCents: 300, quantity: 1 }] } } });
  const historicalPaid = await db.order.create({ data: { storeId: store.id, tableId: tables[0].id, status: "PAID", totalCents: 500, paidAt: new Date() } });
  const app = Fastify();
  setupRealtimeGateway(app);
  await app.register(billingRoutes);
  await app.register(orderRoutes);
  await app.register(managerRoutes);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = app.server.address().port;
  const json = async (response, expected = 200) => { assert.equal(response.statusCode, expected, response.body); return response.json(); };
  const join = (tableId = tables[0].id, headers = {}) => app.inject({ method: "POST", url: `/public/table/${tableId}/visit`, payload: {}, headers });
  let visit, token, firstOrder;
  const firstSubmissionId = randomUUID();
  const sockets = [];
  const guestHeaders = () => ({ "x-table-visit": token });
  const detail = async () => (await json(await app.inject({ url: `/billing/visits/${visit.id}`, headers: manager }))).visit;
  const payment = (body, headers = manager) => app.inject({ method: "POST", url: `/billing/visits/${visit.id}/payments`, headers, payload: body });
  const status = (id, value) => app.inject({ method: "PATCH", url: `/orders/${id}/status`, headers: manager, payload: { status: value } });
  const order = (tableId, items = [{ itemId: coffee.id, quantity: 2 }, { itemId: tea.id, quantity: 1 }], extra = {}) => app.inject({
    method: "POST", url: "/orders", headers: guestHeaders(), payload: { tableId, items, submissionId: randomUUID(), ...extra },
  });
  const mutation = (suffix, body) => app.inject({ method: "POST", url: `/billing/visits/${visit.id}/${suffix}`, headers: manager, payload: body });
  try {
    await t.test("additive bootstrap upgrades populated legacy orders and remains db-push compatible", async () => {
      await db.$executeRawUnsafe('DROP TABLE dining_actions, dining_payment_allocations, dining_payments, dining_guest_sessions, dining_visits CASCADE');
      await db.$executeRawUnsafe('ALTER TABLE orders DROP COLUMN "diningVisitId"');
      await ensureDiningBillingSchema();
      await ensureDiningBillingSchema();
      const push = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { env: process.env, encoding: "utf8" });
      assert.equal(push.status, 0, push.stderr || push.stdout);
      assert.equal((await db.order.findUnique({ where: { id: historicalPaid.id } })).status, "PAID");
      assert.equal((await db.order.findUnique({ where: { id: legacy.id } })).diningVisitId, null);
    });
    await t.test("concurrent QR joins create one current visit and do not expose previous parties", async () => {
      const joins = await Promise.all(Array.from({ length: 4 }, () => join()));
      const values = await Promise.all(joins.map((result) => json(result)));
      assert.equal(new Set(values.map((value) => value.visit.id)).size, 1);
      assert.equal(new Set(values.map((value) => value.visitToken)).size, 4);
      ({ visit, visitToken: token } = values[0]);
      assert.equal(visit.orderCount, 0);
      assert.match(token, /^[a-f0-9]{64}$/);
      assert.equal((await app.inject({ url: `/public/table/${tables[0].id}/orders` })).statusCode, 403);
      const hidden = await json(await app.inject({ url: `/public/table/${tables[0].id}/orders`, headers: guestHeaders() }));
      assert.deepEqual(hidden.orders, []);
      assert.equal((await app.inject({ url: `/public/orders/${historicalPaid.id}/summary`, headers: guestHeaders() })).statusCode, 404);
      const bogusStaff = await app.inject({ url: `/public/table/${tables[0].id}/orders`, headers: { authorization: "Bearer forged" } });
      assert.equal(bogusStaff.statusCode, 401);
    });
    await t.test("rounds attach to the current visit and the bill request persists across clients", async () => {
      firstOrder = (await json(await order(tables[0].id, undefined, { submissionId: firstSubmissionId }), 201)).order;
      assert.equal(firstOrder.diningVisitId, visit.id);
      const requestId = randomUUID();
      const request = () => app.inject({ method: "POST", url: `/public/visits/${visit.id}/bill-request`, headers: guestHeaders(), payload: { requestId } });
      const requested = await json(await request());
      assert.equal(requested.visit.status, "BILL_REQUESTED");
      assert.equal(requested.visit.totalCents, 800);
      assert.equal((await json(await request())).replayed, true);
      assert.equal((await detail()).billRequestedAt, requested.visit.billRequestedAt);
    });
    await t.test("cashier roles and venue ownership are enforced on every billing operation", async () => {
      const state = await detail();
      const body = { requestId: randomUUID(), expectedRevision: state.revision, method: "CASH", amountCents: 100 };
      assert.equal((await payment(body, {})).statusCode, 401);
      assert.equal((await payment(body, cook)).statusCode, 403);
      assert.equal((await payment(body, auth(foreignManager, foreign))).statusCode, 404);
      assert.equal((await app.inject({ url: `/public/visits/${visit.id}`, headers: { ...guestHeaders(), "x-store-slug": foreign.slug } })).statusCode, 403);
      assert.equal((await app.inject({ method: "PATCH", url: `/orders/${firstOrder.id}`, headers: {}, payload: { note: "forged" } })).statusCode, 403);
      assert.equal((await status(firstOrder.id, "PAID")).json().error, "BILLING_PAYMENT_REQUIRED");
    });
    await t.test("concurrent payment retries collect once and recover after a lost response", async () => {
      const state = await detail();
      const body = { requestId: randomUUID(), expectedRevision: state.revision, method: "CASH", amountCents: 100 };
      const responses = await Promise.all(Array.from({ length: 4 }, () => payment(body, waiter)));
      assert.equal(responses.filter((response) => response.statusCode === 201).length, 1);
      assert.equal(responses.filter((response) => response.statusCode === 200).length, 3);
      assert.equal(new Set(responses.map((response) => response.json().payment.id)).size, 1);
      assert.equal((await detail()).outstandingCents, 700);
      const recovered = await json(await app.inject({ url: `/billing/payments/${body.requestId}`, headers: waiter }));
      assert.equal(recovered.payment.amountCents, 100);
      assert.equal((await payment({ ...body, amountCents: 101 })).json().error, "REQUEST_ID_REUSED");
      const stored = await db.order.findUnique({ where: { id: firstOrder.id } });
      assert.equal(stored.paymentStatus, "PENDING");
      assert.equal(stored.status, "PLACED");
    });
    await t.test("partial credits and item quantity splits never overpay or count an item twice", async () => {
      const state = await detail();
      const line = state.items.find((item) => item.paidCents === 100);
      assert.equal(line.outstandingCents, line.totalCents - 100);
      assert.equal(line.remainingQuantity, Math.ceil(line.outstandingCents / line.unitPriceCents));
      const bad = await payment({ requestId: randomUUID(), expectedRevision: state.revision, method: "CARD", items: [{ orderItemId: line.orderItemId, quantity: line.remainingQuantity + 1 }] });
      assert.equal(bad.json().error, "INVALID_PAYMENT_ITEMS");
      const settled = await json(await payment({ requestId: randomUUID(), expectedRevision: state.revision, method: "CARD", items: [{ orderItemId: line.orderItemId, quantity: line.remainingQuantity }] }), 201);
      assert.equal(settled.payment.amountCents, line.outstandingCents);
      assert.equal(settled.visit.outstandingCents, state.outstandingCents - line.outstandingCents);
      const repeatedLine = await payment({ requestId: randomUUID(), expectedRevision: settled.visit.revision, method: "CARD", items: [{ orderItemId: line.orderItemId, quantity: 1 }] });
      assert.equal(repeatedLine.statusCode, 400);
    });
    await t.test("failed payment allocation rolls back the receipt, action, revision and order payment status", async () => {
      const state = await detail();
      const requestId = randomUUID();
      const before = await db.diningPayment.count({ where: { visitId: visit.id } });
      await db.$executeRawUnsafe(`CREATE FUNCTION billing_fail_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test payment allocation failure'; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER billing_fail_allocation BEFORE INSERT ON dining_payment_allocations FOR EACH ROW EXECUTE FUNCTION billing_fail_allocation()`);
      try {
        const response = await payment({ requestId, expectedRevision: state.revision, method: "CASH", amountCents: 47 });
        assert.equal(response.statusCode, 500);
        assert.equal(await db.diningPayment.count({ where: { visitId: visit.id } }), before);
        assert.equal(await db.diningAction.count({ where: { requestId } }), 0);
        assert.equal((await detail()).revision, state.revision);
        assert.equal((await detail()).outstandingCents, state.outstandingCents);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER billing_fail_allocation ON dining_payment_allocations');
        await db.$executeRawUnsafe('DROP FUNCTION billing_fail_allocation()');
      }
    });
    await t.test("two cashiers cannot record against the same stale balance revision", async () => {
      const state = await detail();
      const responses = await Promise.all([50, 60].map((amountCents) => payment({ requestId: randomUUID(), expectedRevision: state.revision, method: "CASH", amountCents })));
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
      assert.equal(responses.find((response) => response.statusCode === 409).json().error, "BILL_CHANGED");
      const after = await detail();
      const dueLine = after.items.find((line) => line.outstandingCents > 0);
      const final = await json(await payment({ requestId: randomUUID(), expectedRevision: after.revision, method: "CARD", items: [{ orderItemId: dueLine.orderItemId, quantity: dueLine.remainingQuantity }] }), 201);
      assert.equal(final.payment.amountCents, after.outstandingCents);
      assert.equal(final.visit.outstandingCents, 0);
    });
    await t.test("recorded money locks destructive edits while service may advance normally", async () => {
      const original = await db.order.findUnique({ where: { id: firstOrder.id } });
      for (const req of [
        { method: "PATCH", url: `/orders/${firstOrder.id}`, payload: { note: "tamper" }, headers: guestHeaders() },
        { method: "PATCH", url: `/orders/${firstOrder.id}/status`, payload: { status: "CANCELLED" }, headers: manager },
        { method: "DELETE", url: `/manager/orders/${firstOrder.id}`, headers: manager },
        { method: "PATCH", url: `/manager/orders/${firstOrder.id}/cancel`, headers: manager },
      ]) assert.equal((await app.inject(req)).statusCode, 409);
      assert.equal((await mutation("close", { requestId: randomUUID(), expectedRevision: (await detail()).revision })).json().error, "VISIT_SERVICE_PENDING");
      assert.equal((await status(firstOrder.id, "SERVED")).statusCode, 200);
      const served = await db.order.findUnique({ where: { id: firstOrder.id } });
      assert.equal(served.paymentStatus, "COMPLETED");
      assert.equal(served.paidAt.toISOString(), original.paidAt.toISOString());
      assert.equal((await status(firstOrder.id, "PLACED")).statusCode, 409);
      const second = (await json(await order(tables[0].id, [{ itemId: tea.id, quantity: 1 }]), 201)).order;
      const state = await detail();
      assert.equal(state.orderCount, 2);
      assert.equal(state.totalCents, 1000);
      await json(await payment({ requestId: randomUUID(), expectedRevision: state.revision, method: "CASH", amountCents: 200 }), 201);
      assert.equal((await db.order.findUnique({ where: { id: firstOrder.id } })).paidAt.toISOString(), original.paidAt.toISOString());
      assert.equal((await status(second.id, "SERVED")).statusCode, 200);
    });
    await t.test("transfer retains the same visit and payment history without merging occupied tables", async () => {
      await json(await join(tables[2].id));
      const state = await detail();
      assert.equal((await mutation("transfer", { requestId: randomUUID(), expectedRevision: state.revision, tableId: tables[2].id })).json().error, "TABLE_OCCUPIED");
      assert.equal((await mutation("transfer", { requestId: randomUUID(), expectedRevision: state.revision, tableId: tables[3].id })).json().error, "TABLE_OCCUPIED");
      assert.equal((await mutation("transfer", { requestId: randomUUID(), expectedRevision: state.revision, tableId: foreignTable.id })).statusCode, 404);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/events/ws?storeSlug=${store.slug}&tableId=${tables[0].id}&visit=${token}`);
      sockets.push(ws);
      await once(ws, "open");
      const observed = [];
      ws.on("message", (data) => observed.push(JSON.parse(String(data))));
      const request = { requestId: randomUUID(), expectedRevision: state.revision, tableId: tables[1].id };
      const moved = await json(await mutation("transfer", request), 201);
      assert.equal(moved.visit.tableId, tables[1].id);
      assert.equal(moved.visit.paidCents, 1000);
      assert.equal((await json(await mutation("transfer", request))).replayed, true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.ok(observed.some((event) => event.topic.endsWith("/visits/updated") && event.payload.visitId === visit.id && event.payload.tableId === tables[1].id));
      ws.close();
      assert.equal((await json(await app.inject({ url: `/public/visits/${visit.id}`, headers: guestHeaders() }))).visit.tableId, tables[1].id);
      assert.equal((await app.inject({ url: `/public/table/${tables[0].id}/orders`, headers: guestHeaders() })).json().error, "VISIT_MOVED");
      const receipt = await json(await app.inject({ url: `/orders/submissions/${firstSubmissionId}?tableId=${tables[0].id}`, headers: guestHeaders() }));
      assert.equal(receipt.order.id, firstOrder.id);
      const unknownAttempt = randomUUID();
      assert.equal((await order(tables[0].id, undefined, { submissionId: unknownAttempt })).json().error, "VISIT_MOVED");
      assert.equal((await app.inject({ url: `/orders/submissions/${unknownAttempt}?tableId=${tables[0].id}`, headers: guestHeaders() })).statusCode, 404);
    });
    await t.test("closing revokes old guest access and a new party never inherits old orders", async () => {
      const state = await detail();
      const body = { requestId: randomUUID(), expectedRevision: state.revision };
      await json(await mutation("close", body), 201);
      assert.equal((await json(await mutation("close", body))).replayed, true);
      assert.equal((await app.inject({ url: `/public/visits/${visit.id}`, headers: guestHeaders() })).statusCode, 410);
      assert.equal((await join(tables[1].id, guestHeaders())).statusCode, 410);
      assert.equal((await order(tables[1].id)).statusCode, 410);
      const newParty = await json(await join(tables[1].id));
      assert.notEqual(newParty.visit.id, visit.id);
      assert.equal(newParty.visit.totalCents, 0);
      assert.equal(newParty.visit.orderCount, 0);
      const history = await app.inject({ url: `/public/orders/${firstOrder.id}/summary`, headers: { "x-table-visit": newParty.visitToken } });
      assert.equal(history.statusCode, 404);
    });
    await t.test("legacy orders need explicit adoption and paid legacy records never become new cash receipts", async () => {
      const opened = await json(await app.inject({ method: "POST", url: "/billing/visits", headers: manager,
        payload: { requestId: randomUUID(), tableId: tables[3].id } }), 201);
      const request = { requestId: randomUUID(), expectedRevision: opened.visit.revision, orderIds: [legacy.id] };
      const url = `/billing/visits/${opened.visit.id}/adopt`;
      const adopted = await json(await app.inject({ method: "POST", url, headers: manager, payload: request }), 201);
      assert.equal(adopted.visit.outstandingCents, 300);
      assert.equal(adopted.visit.paidCents, 0);
      assert.equal((await json(await app.inject({ method: "POST", url, headers: manager, payload: request }))).replayed, true);
      const denyPaid = await app.inject({ method: "POST", url, headers: manager,
        payload: { requestId: randomUUID(), expectedRevision: adopted.visit.revision, orderIds: [historicalPaid.id] } });
      assert.equal(denyPaid.statusCode, 409);
      const summary = await json(await app.inject({ url: `/manager/billing/summary?from=${encodeURIComponent(new Date(Date.now() - 60000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`, headers: manager }));
      assert.equal(summary.collectedCents, 1000);
      assert.equal(summary.cashCents + summary.cardCents, 1000);
      assert.equal(summary.legacyPaidCents, 500);
      assert.equal(summary.outstandingCents, 300);
      assert.equal(summary.currencyCode, "EUR");
      assert.equal((await app.inject({ method: "PATCH", url: `/manager/tables/${tables[3].id}`, headers: manager, payload: { isActive: false } })).json().error, "TABLE_HAS_OPEN_VISIT");
    });
    await t.test("a QR join racing a transfer cannot acquire the party that moved away", async () => {
      const source = await db.table.create({ data: { storeId: store.id, label: "Race source" } });
      const destination = await db.table.create({ data: { storeId: store.id, label: "Race destination" } });
      const party = await json(await join(source.id));
      let release, announce;
      const ready = new Promise((resolve) => { announce = resolve; });
      const hold = new Promise((resolve) => { release = resolve; });
      const moving = db.$transaction(async (tx) => {
        await tx.diningVisit.update({ where: { id: party.visit.id }, data: { tableId: destination.id, activeTableId: destination.id } });
        announce();
        await hold;
      }, { timeout: 10000 });
      await ready;
      const entering = join(source.id);
      let waiting = false;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await db.$queryRaw`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
          if (row.count > 0) { waiting = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally { release(); }
      await moving;
      assert.equal(waiting, true, "join must have reached the contested database lock");
      const newcomer = await json(await entering);
      assert.equal(newcomer.visit.tableId, source.id);
      assert.notEqual(newcomer.visit.id, party.visit.id);
      assert.equal(newcomer.visit.orderCount, 0);
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await db.diningPaymentAllocation.deleteMany({ where: { payment: { storeId: store.id } } });
    await db.diningPayment.deleteMany({ where: { storeId: store.id } });
    await db.diningAction.deleteMany({ where: { storeId: store.id } });
    await db.order.deleteMany({ where: { storeId: store.id } });
    await db.diningVisit.deleteMany({ where: { storeId: store.id } });
    await db.profile.deleteMany({ where: { id: { in: [...profiles.map((p) => p.id), foreignManager.id] } } });
    await db.store.deleteMany({ where: { id: { in: [store.id, foreign.id] } } });
    await db.$disconnect();
  }
});
