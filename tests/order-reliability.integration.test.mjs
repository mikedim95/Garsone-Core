import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import Fastify from "fastify";

// Run against the disposable Postgres created by run-order-reliability.mjs.
// Refuse all remote/ordinary database names: these tests intentionally create
// fault-injection triggers and schema fixtures, never real venue records.
const databaseUrl = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Use node tests/run-order-reliability.mjs to create an isolated test database");
const target = new URL(databaseUrl);
if (!["localhost", "127.0.0.1"].includes(target.hostname) || target.pathname !== "/garsone_reliability_test") {
  throw new Error("Order reliability tests require the isolated local garsone_reliability_test database");
}
process.env.NODE_ENV = "test";
process.env.DB_CONNECTION = "default";
process.env.DATABASE_URL = databaseUrl;
process.env.DIRECT_URL = databaseUrl;
process.env.STORE_SLUG = "reliability-test";
process.env.LOCAL_ONLY = "true";
process.env.LOCAL_PRINTING_ENABLED = "true";
process.env.MQTT_DISABLED = "true";
process.env.JWT_SECRET = "reliability-test-key-never-used-outside-disposable-tests";

const { db } = await import("../dist/db/index.js");
const { orderRoutes } = await import("../dist/routes/orders.js");
const { billingRoutes } = await import("../dist/routes/billing.js");
const { ensureOrderReliabilitySchema } = await import("../dist/db/ensureOrderReliabilitySchema.js");
const { signToken } = await import("../dist/lib/jwt.js");
const { orderSubmissionHash } = await import("../dist/lib/orderSubmission.js");
const { renderLocalTicket } = await import("../dist/lib/localPrinting.js");
const { invalidateStoreCache } = await import("../dist/lib/store.js");

test("order submission HTTP contract with real PostgreSQL concurrency and rollback", async (t) => {
  await ensureOrderReliabilitySchema();
  await ensureOrderReliabilitySchema(); // Startup after db push / a previous startup is additive.
  await db.order.deleteMany({ where: { store: { slug: { in: ["reliability-test", "other-reliability-test"] } } } });
  await db.store.deleteMany({ where: { slug: { in: ["reliability-test", "other-reliability-test"] } } });
  const store = await db.store.create({ data: { slug: "reliability-test", name: "Test", settingsJson: { printOnArrival: true } } });
  const otherStore = await db.store.create({ data: { slug: "other-reliability-test", name: "Other test" } });
  const table = await db.table.create({ data: { storeId: store.id, label: "T1" } });
  const otherTable = await db.table.create({ data: { storeId: store.id, label: "T2" } });
  const foreignTable = await db.table.create({ data: { storeId: otherStore.id, label: "Foreign" } });
  const category = await db.category.create({ data: { storeId: store.id, slug: "drinks", title: "Drinks", printerTopic: "bar" } });
  const item = await db.item.create({ data: { storeId: store.id, categoryId: category.id, slug: "coffee", title: "Coffee", priceCents: 300 } });
  const secondItem = await db.item.create({ data: { storeId: store.id, categoryId: category.id, slug: "tea", title: "Tea", priceCents: 200, printerTopic: "kitchen" } });
  const otherProfile = await db.profile.create({ data: {
    storeId: otherStore.id, email: "staff@other.test", passwordHash: "unused-test-password-hash", role: "MANAGER", displayName: "Other manager",
  } });
  const manager = await db.profile.create({ data: {
    storeId: store.id, email: "manager@reliability.test", passwordHash: "unused-test-password-hash", role: "MANAGER",
  } });
  const managerHeaders = { authorization: `Bearer ${signToken({ userId: manager.id, role: "manager", email: manager.email, storeId: store.id, storeSlug: store.slug })}` };
  const app = Fastify();
  await app.register(orderRoutes);
  await app.register(billingRoutes);
  const joined = await app.inject({ method: "POST", url: `/public/table/${table.id}/visit` });
  assert.equal(joined.statusCode, 200, joined.body);
  const guestHeaders = { "x-table-visit": joined.json().visitToken };
  const payload = (overrides = {}) => ({ tableId: table.id, submissionId: randomUUID(), items: [
    { itemId: item.id, quantity: 2 }, { itemId: secondItem.id, quantity: 1 },
  ], ...overrides });
  const submit = (body, headers = {}) => app.inject({ method: "POST", url: "/orders", payload: body, headers: { ...guestHeaders, ...headers } });
  const resolve = (id, tableId = table.id, headers = {}) => app.inject({ url: `/orders/submissions/${id}?tableId=${tableId}`, headers: { ...guestHeaders, ...headers } });
  const setArrival = async (enabled) => {
    await db.store.update({ where: { id: store.id }, data: { settingsJson: { printOnArrival: enabled } } });
    invalidateStoreCache(store.slug);
  };
  const injectOutboxFailure = async () => {
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION reliability_fail_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'note' = 'force-outbox-failure' THEN RAISE EXCEPTION 'test injected outbox failure'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER reliability_fail_intent BEFORE INSERT ON local_print_intents FOR EACH ROW EXECUTE FUNCTION reliability_fail_intent()`);
  };
  const removeOutboxFailure = async () => {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS reliability_fail_intent ON local_print_intents`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS reliability_fail_intent()`);
  };
  const prepare = (id, options = {}) => app.inject({ method: "PATCH", url: `/orders/${id}/status`, headers: managerHeaders, payload: { status: "PREPARING", ...options } });
  try {
    await t.test("populated legacy schema upgrades additively before guarded db push", async () => {
      const legacy = await db.order.create({ data: { storeId: store.id, tableId: table.id, note: "Preserved legacy order",
        orderItems: { create: { itemId: item.id, titleSnapshot: item.title, unitPriceCents: item.priceCents } },
      } });
      await db.$executeRawUnsafe('ALTER TABLE "order_items" DROP COLUMN "note"');
      await db.$executeRawUnsafe('DROP TABLE "local_print_intents"');
      await db.$executeRawUnsafe('ALTER TABLE "orders" DROP COLUMN "submissionId", DROP COLUMN "submissionHash"');
      const bootstrap = spawnSync(process.execPath, ["dist/db/ensureOrderReliabilitySchema.js"], { env: process.env, encoding: "utf8" });
      assert.equal(bootstrap.status, 0, bootstrap.stderr || bootstrap.stdout);
      const push = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { env: process.env, encoding: "utf8" });
      assert.equal(push.status, 0, push.stderr || push.stdout);
      const preserved = await db.order.findUnique({ where: { id: legacy.id } });
      assert.equal(preserved.note, "Preserved legacy order");
      assert.equal(preserved.submissionId, null);
      const legacyLine = await db.orderItem.findFirstOrThrow({ where: { orderId: legacy.id } });
      assert.equal(legacyLine.titleSnapshot, item.title);
      assert.equal(legacyLine.note, null);
      await db.order.delete({ where: { id: legacy.id } });
    });
    await t.test("simultaneous retries commit one order and one ticket per route", async () => {
      const body = payload();
      const responses = await Promise.all(Array.from({ length: 8 }, () => submit(body)));
      assert.equal(responses.filter((r) => r.statusCode === 201).length, 1, responses.map((r) => r.body).join("\n"));
      assert.equal(responses.filter((r) => r.statusCode === 200).length, 7);
      const ids = new Set(responses.map((r) => r.json().order.id));
      assert.equal(ids.size, 1);
      const orderId = [...ids][0];
      assert.equal(await db.order.count({ where: { storeId: store.id, submissionId: body.submissionId } }), 1);
      const intents = await db.localPrintIntent.findMany({ where: { orderId } });
      assert.equal(intents.length, 2);
      assert.deepEqual(intents.map((intent) => intent.topic).sort(), ["reliability-test/orders/placed/bar", "reliability-test/orders/placed/kitchen"]);
      for (const intent of intents) {
        assert.equal(intent.state, "queued");
        assert.equal(intent.payload.items.length, 1);
        assert.equal(intent.payload.orderId, orderId);
      }
      assert.equal(responses[0].json().order.totalCents, 800);
      assert.equal("submissionHash" in responses[0].json().order, false);
    });
    await t.test("individual comments persist separately, recover safely and reach grouped kitchen tickets", async () => {
      const body = payload({ items: [
        { itemId: item.id, quantity: 1, note: "  No sugar  " },
        { itemId: item.id, quantity: 2, note: "Extra hot" },
        { itemId: secondItem.id, quantity: 1, note: "No milk" },
      ] });
      const first = await submit(body);
      assert.equal(first.statusCode, 201, first.body);
      const order = first.json().order;
      assert.deepEqual(order.items.map((line) => [line.note, line.quantity]).sort(), [["Extra hot", 2], ["No milk", 1], ["No sugar", 1]]);
      assert.equal(order.totalCents, 1100);
      assert.equal(new Set(order.items.map((line) => line.id)).size, 3);
      const normalized = { ...body, items: body.items.map((line) => ({ ...line, note: line.note.trim() })).reverse() };
      const retry = await submit(normalized);
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(retry.json().order.id, order.id);
      assert.deepEqual((await resolve(body.submissionId)).json().order.items, order.items);
      const tableOrders = await app.inject({ url: `/public/table/${table.id}/orders`, headers: guestHeaders });
      assert.deepEqual(tableOrders.json().orders.find((entry) => entry.id === order.id).items, order.items);
      const bill = await app.inject({ url: `/public/visits/${order.diningVisitId}`, headers: guestHeaders });
      assert.equal(bill.statusCode, 200, bill.body);
      assert.deepEqual(bill.json().visit.orders.find((entry) => entry.id === order.id).items.map((line) => line.note).sort(), ["Extra hot", "No milk", "No sugar"]);
      assert.deepEqual(bill.json().visit.items.filter((line) => line.orderId === order.id).map((line) => line.note).sort(), ["Extra hot", "No milk", "No sugar"]);
      const intents = await db.localPrintIntent.findMany({ where: { orderId: order.id } });
      assert.equal(intents.length, 2);
      const bar = intents.find((intent) => intent.topic.endsWith("/bar"));
      assert.deepEqual(bar.payload.items.map((line) => line.note).sort(), ["Extra hot", "No sugar"]);
      const ticket = renderLocalTicket(bar.payload, { device: "unused-test-device", encoding: "utf8", width: 32 }).toString("utf8");
      assert.match(ticket, /1x Coffee\n  No sugar/);
      assert.match(ticket, /2x Coffee\n  Extra hot/);
      assert.doesNotMatch(ticket, /No milk/);
      const changed = await submit({ ...body, items: body.items.map((line, index) => index ? line : { ...line, note: "With sugar" }) });
      assert.equal(changed.statusCode, 409);
      assert.equal(changed.json().error, "IDEMPOTENCY_KEY_REUSED");
      assert.equal(await db.localPrintIntent.count({ where: { orderId: order.id } }), 2);
      assert.equal((await submit(payload({ items: [{ itemId: item.id, quantity: 1, note: "a".repeat(501) }] }))).statusCode, 400);
      const boundary = await submit(payload({ items: [{ itemId: item.id, quantity: 1, note: " " + "a".repeat(500) + " " }] }));
      assert.equal(boundary.statusCode, 201, boundary.body);
      assert.equal(boundary.json().order.items[0].note.length, 500);
    });
    await t.test("line edits and pending-order merge preserve different comments and print the changed instructions", async () => {
      const initial = (await submit(payload({ items: [
        { itemId: item.id, quantity: 1, note: "No sugar" },
        { itemId: item.id, quantity: 1, note: "Extra hot" },
      ] }))).json().order;
      const line = initial.items.find((entry) => entry.note === "No sugar");
      const patch = (url, body) => app.inject({ method: "PATCH", url, payload: body, headers: guestHeaders });
      let response = await patch(`/orders/${initial.id}/items/${line.id}`, { quantity: 2 });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().order.items.find((entry) => entry.id === line.id).note, "No sugar");
      response = await patch(`/orders/${initial.id}/items/${line.id}`, { quantity: 2, note: "  Less sugar  " });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().order.items.map((entry) => entry.note).sort(), ["Extra hot", "Less sugar"]);
      const changed = await db.localPrintIntent.findFirstOrThrow({ where: { orderId: initial.id }, orderBy: { createdAt: "desc" } });
      assert.equal(changed.payload.items[0].note, "Less sugar");
      assert.match(changed.payload.change.from, /No sugar/);
      assert.match(changed.payload.change.to, /Less sugar/);
      assert.match(renderLocalTicket(changed.payload, { device: "unused-test-device", encoding: "utf8" }).toString("utf8"), /Less sugar/);
      const snapshot = response.json().order;
      response = await patch(`/orders/${initial.id}/items/${line.id}`, { quantity: 2, note: "a".repeat(501) });
      assert.equal(response.statusCode, 400);
      assert.deepEqual((await db.orderItem.findUniqueOrThrow({ where: { id: line.id } })).note, "Less sugar");
      response = await patch(`/orders/${initial.id}`, { items: snapshot.items.map((entry) => ({ itemId: entry.itemId, quantity: entry.quantity, note: entry.note })) });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().order.items.map((entry) => entry.note).sort(), ["Extra hot", "Less sugar"]);
      const second = (await submit(payload({ items: [{ itemId: item.id, quantity: 1, note: "With ice" }] }))).json().order;
      const mergedItems = [...response.json().order.items, ...second.items].map((entry) => ({ itemId: entry.itemId, quantity: entry.quantity, note: entry.note }));
      response = await patch(`/public/table/${table.id}/orders/pending`, { orderIds: [initial.id, second.id], items: mergedItems });
      assert.equal(response.statusCode, 200, response.body);
      const merged = response.json().order;
      assert.equal(merged.items.length, 3);
      assert.deepEqual(merged.items.map((entry) => entry.note).sort(), ["Extra hot", "Less sugar", "With ice"]);
      const stored = await db.orderItem.findMany({ where: { orderId: merged.id } });
      assert.deepEqual(stored.map((entry) => entry.note).sort(), ["Extra hot", "Less sugar", "With ice"]);
      const clear = merged.items.find((entry) => entry.note === "With ice");
      response = await patch(`/orders/${merged.id}/items/${clear.id}`, { quantity: 1, note: "   " });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().order.items.find((entry) => entry.id === clear.id).note, null);
      const prepared = await prepare(merged.id, { printReceipt: true });
      assert.equal(prepared.statusCode, 200, prepared.body);
      assert.deepEqual(prepared.json().order.items.map((entry) => entry.note).filter(Boolean).sort(), ["Extra hot", "Less sugar"]);
    });
    await t.test("lost response is recoverable without resubmission, even after stock changes", async () => {
      const body = payload();
      const first = await submit(body);
      assert.equal(first.statusCode, 201);
      await db.item.update({ where: { id: item.id }, data: { isAvailable: false } });
      try {
        const recovered = await resolve(body.submissionId);
        assert.equal(recovered.statusCode, 200);
        assert.equal(recovered.json().order.id, first.json().order.id);
        assert.equal(recovered.headers["cache-control"], "no-store");
        const retry = await submit(body);
        assert.equal(retry.statusCode, 200);
        assert.equal(retry.json().replayed, true);
        assert.equal(retry.json().order.id, first.json().order.id);
      } finally { await db.item.update({ where: { id: item.id }, data: { isAvailable: true } }); }
    });
    await t.test("a reused key rejects changed quantities, note or table without side effects", async () => {
      const body = payload();
      assert.equal((await submit(body)).statusCode, 201);
      const before = await db.order.count();
      for (const changed of [
        { ...body, note: "Changed note" },
        { ...body, tableId: otherTable.id },
        { ...body, items: [{ itemId: item.id, quantity: 10 }] },
      ]) {
        const response = await submit(changed);
        assert.equal(response.statusCode, 409);
        assert.equal(response.json().error, changed.tableId !== table.id ? "VISIT_MOVED" : "IDEMPOTENCY_KEY_REUSED");
      }
      assert.equal(await db.order.count(), before);
    });
    await t.test("read-only recovery follows the authorized visit, enforces tenant boundaries and validates UUIDs", async () => {
      const body = payload();
      assert.equal((await submit(body)).statusCode, 201);
      const before = await db.order.count();
      assert.equal((await resolve(body.submissionId, otherTable.id)).statusCode, 200);
      assert.equal((await resolve(body.submissionId, table.id, { "x-store-slug": otherStore.slug })).statusCode, 403);
      const token = signToken({ userId: otherProfile.id, role: "manager", email: otherProfile.email, storeId: otherStore.id, storeSlug: otherStore.slug });
      assert.equal((await resolve(body.submissionId, table.id, { authorization: `Bearer ${token}`, "x-store-slug": store.slug })).statusCode, 404);
      assert.equal((await resolve(randomUUID())).statusCode, 404);
      assert.equal((await resolve("not-a-uuid")).statusCode, 400);
      assert.equal((await app.inject({ url: `/orders/submissions/${body.submissionId}`, headers: guestHeaders })).statusCode, 400);
      assert.equal((await submit(payload({ tableId: foreignTable.id }))).statusCode, 404);
      assert.equal(await db.order.count(), before);
    });
    await t.test("cloud direct checkout and committed retries need no tag approval", async () => {
      process.env.LOCAL_ONLY = "false";
      try {
        const body = payload();
        const responses = await Promise.all(Array.from({ length: 4 }, () => submit(body)));
        assert.equal(responses.filter((r) => r.statusCode === 201).length, 1);
        assert.equal(responses.filter((r) => r.statusCode === 200).length, 3);
        assert.equal(new Set(responses.map((r) => r.json().order.id)).size, 1);
        assert.equal((await submit(body)).statusCode, 200);
        assert.equal((await resolve(body.submissionId)).statusCode, 200);
        assert.equal((await submit(payload())).statusCode, 201);
      } finally { process.env.LOCAL_ONLY = "true"; }
    });
    await t.test("failed outbox insert rolls back direct order and items atomically", async () => {
      await injectOutboxFailure();
      process.env.LOCAL_ONLY = "false";
      try {
        const body = payload({ note: "force-outbox-failure" });
        const before = { orders: await db.order.count(), items: await db.orderItem.count(), intents: await db.localPrintIntent.count() };
        assert.equal((await submit(body)).statusCode, 500);
        assert.equal(await db.order.count({ where: { submissionId: body.submissionId } }), 0);
        assert.deepEqual({ orders: await db.order.count(), items: await db.orderItem.count(), intents: await db.localPrintIntent.count() }, before);
      } finally {
        process.env.LOCAL_ONLY = "true";
        await removeOutboxFailure();
      }
    });
    await t.test("preparing failure rolls back status and ticket allocation; concurrent retry prints once", async () => {
      await setArrival(false);
      try {
        const accepted = await submit(payload({ note: "force-outbox-failure" }));
        assert.equal(accepted.statusCode, 201);
        const id = accepted.json().order.id;
        assert.equal(await db.localPrintIntent.count({ where: { orderId: id } }), 0);
        await injectOutboxFailure();
        try {
          assert.equal((await prepare(id)).statusCode, 500);
          const original = await db.order.findUnique({ where: { id } });
          assert.equal(original.status, "PLACED");
          assert.equal(original.ticketNumber, null);
          assert.equal(await db.localPrintIntent.count({ where: { orderId: id } }), 0);
        } finally { await removeOutboxFailure(); }
        const retries = await Promise.all(Array.from({ length: 4 }, () => prepare(id)));
        assert.ok(retries.every((response) => response.statusCode === 200), retries.map((r) => r.body).join("\n"));
        assert.equal(new Set(retries.map((r) => r.json().order.ticketNumber)).size, 1);
        const intents = await db.localPrintIntent.findMany({ where: { orderId: id } });
        assert.equal(intents.length, 2);
        assert.ok(intents.every((intent) => intent.topic.includes("/preparing/") && intent.payload.ticketNumber > 0));
      } finally { await setArrival(true); }
    });
    await t.test("accept without paper stays silent and explicit accept-with-print is one durable transition", async () => {
      await setArrival(false);
      try {
        const id = (await submit(payload())).json().order.id;
        assert.equal((await prepare(id, { skipMqtt: true })).statusCode, 200);
        assert.equal(await db.localPrintIntent.count({ where: { orderId: id } }), 0);
        const responses = await Promise.all(Array.from({ length: 3 }, () => prepare(id, { printReceipt: true })));
        assert.ok(responses.every((response) => response.statusCode === 200));
        assert.equal(await db.localPrintIntent.count({ where: { orderId: id } }), 2);
      } finally { await setArrival(true); }
      const arrivalOrder = (await submit(payload())).json().order.id;
      assert.equal(await db.localPrintIntent.count({ where: { orderId: arrivalOrder } }), 2);
      assert.equal((await prepare(arrivalOrder, { printReceipt: true })).statusCode, 200);
      assert.equal((await prepare(arrivalOrder, { printReceipt: true })).statusCode, 200);
      assert.equal(await db.localPrintIntent.count({ where: { orderId: arrivalOrder } }), 4);
    });
    await t.test("every item-change route rolls back its edit if its required receipt cannot be persisted", async () => {
      await setArrival(false);
      const single = (await submit(payload({ note: "force-outbox-failure" }))).json().order;
      await setArrival(true);
      const full = (await submit(payload())).json().order;
      const pending = (await submit(payload())).json().order;
      await injectOutboxFailure();
      try {
        const beforeIntents = await db.localPrintIntent.count();
        const cases = [
          { order: single, url: `/orders/${single.id}/items/${single.items[0].id}`, body: { quantity: 3 } },
          { order: full, url: `/orders/${full.id}`, body: { note: "force-outbox-failure", items: [{ itemId: item.id, quantity: 3 }] } },
          { order: pending, url: `/public/table/${table.id}/orders/pending`, body: { orderIds: [pending.id], note: "force-outbox-failure", items: [{ itemId: item.id, quantity: 3 }] } },
        ];
        for (const entry of cases) {
          const response = await app.inject({ method: "PATCH", url: entry.url, payload: entry.body, headers: guestHeaders });
          assert.equal(response.statusCode, 500, response.body);
          const stored = await db.order.findUnique({ where: { id: entry.order.id }, include: { orderItems: true } });
          assert.equal(stored.totalCents, entry.order.totalCents);
          assert.equal(stored.note, entry.order.note);
          assert.deepEqual(stored.orderItems.map((i) => [i.id, i.quantity]).sort(), entry.order.items.map((i) => [i.id, i.quantity]).sort());
        }
        assert.equal(await db.localPrintIntent.count(), beforeIntents);
      } finally { await removeOutboxFailure(); }
    });
    await t.test("concurrent edits reject stale totals instead of overwriting a newer item change", async () => {
      const order = (await submit(payload())).json().order;
      const initialIntents = await db.localPrintIntent.count({ where: { orderId: order.id } });
      const responses = await Promise.all([3, 4].map((quantity) => app.inject({
        method: "PATCH", url: `/orders/${order.id}/items/${order.items[0].id}`, payload: { quantity }, headers: guestHeaders,
      })));
      assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
      const updated = await db.order.findUnique({ where: { id: order.id }, include: { orderItems: true } });
      assert.equal(updated.totalCents, updated.orderItems.reduce((total, row) => total + row.unitPriceCents * row.quantity, 0));
      assert.equal(await db.localPrintIntent.count({ where: { orderId: order.id } }), initialIntents + 1);
    });
    await t.test("explicit print action reports a queue failure instead of a premature success", async () => {
      await setArrival(false);
      const order = (await submit(payload({ note: "force-outbox-failure" }))).json().order;
      await setArrival(true);
      await injectOutboxFailure();
      try {
        const response = await app.inject({ method: "POST", url: `/orders/${order.id}/print`, headers: managerHeaders });
        assert.equal(response.statusCode, 500);
        assert.equal(await db.localPrintIntent.count({ where: { orderId: order.id } }), 0);
      } finally { await removeOutboxFailure(); }
      const retry = await app.inject({ method: "POST", url: `/orders/${order.id}/print`, headers: managerHeaders });
      assert.equal(retry.statusCode, 200);
      assert.equal(await db.localPrintIntent.count({ where: { orderId: order.id } }), 2);
    });
    await t.test("a live notification failure still returns the accepted order and retained tickets", async () => {
      const original = db.waiterTable.findMany;
      db.waiterTable.findMany = async () => { throw new Error("test simulated notification lookup outage"); };
      try {
        const response = await submit(payload());
        assert.equal(response.statusCode, 201);
        assert.equal(await db.localPrintIntent.count({ where: { orderId: response.json().order.id } }), 2);
      } finally { db.waiterTable.findMany = original; }
    });
    await t.test("header keys work, mismatched keys fail, and optional submission IDs remain compatible", async () => {
      const { submissionId, ...body } = payload();
      const first = await submit(body, { "idempotency-key": submissionId });
      assert.equal(first.statusCode, 201);
      assert.equal((await submit(body, { "idempotency-key": submissionId.toUpperCase() })).statusCode, 200);
      assert.equal((await submit({ ...body, submissionId }, { "idempotency-key": randomUUID() })).statusCode, 409);
      assert.equal((await submit(body, { "idempotency-key": "invalid" })).statusCode, 400);
      assert.equal((await submit(body)).statusCode, 201);
    });
    await t.test("equivalent modifier and cart ordering has a stable fingerprint", () => {
      const a = { tableId: table.id, items: [{ itemId: item.id, quantity: 1, modifiers: { b: ["2", "1", "2"], a: "3" } }, { itemId: secondItem.id, quantity: 2 }] };
      const b = { tableId: table.id, note: "", items: [{ itemId: secondItem.id, quantity: 2 }, { itemId: item.id, quantity: 1, modifiers: { a: ["3"], b: ["1", "2"] } }] };
      assert.equal(orderSubmissionHash(a), orderSubmissionHash(b));
      assert.notEqual(orderSubmissionHash(a), orderSubmissionHash({ ...a, note: "Different" }));
      assert.equal(orderSubmissionHash(a), orderSubmissionHash({ ...a, items: a.items.map((line) => ({ ...line, note: "   " })) }));
      assert.notEqual(orderSubmissionHash(a), orderSubmissionHash({ ...a, items: a.items.map((line) => ({ ...line, note: "No sugar" })) }));
    });
  } finally {
    await app.close();
    await db.profile.deleteMany({ where: { id: { in: [otherProfile.id, manager.id] } } });
    await db.order.deleteMany({ where: { storeId: { in: [store.id, otherStore.id] } } });
    await db.diningGuestSession.deleteMany({ where: { visit: { storeId: { in: [store.id, otherStore.id] } } } });
    await db.diningAction.deleteMany({ where: { storeId: { in: [store.id, otherStore.id] } } });
    await db.diningVisit.deleteMany({ where: { storeId: { in: [store.id, otherStore.id] } } });
    await db.store.deleteMany({ where: { id: { in: [store.id, otherStore.id] } } });
    await db.$disconnect();
  }
});
