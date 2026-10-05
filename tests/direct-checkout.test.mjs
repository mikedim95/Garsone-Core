import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

// Exercise real order handlers with synthetic storage; never connect to a venue.
process.env.NODE_ENV = 'test';
process.env.DB_CONNECTION = 'default';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'direct-checkout-test-secret-at-least-32-characters';
process.env.STORE_SLUG = 'checkout-test';
process.env.MQTT_DISABLED = 'true';
process.env.LOCAL_ONLY = 'false';

const storeId = '11111111-1111-4111-8111-111111111111';
const tableId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const orderId = '55555555-5555-4555-8555-555555555555';
const store = { id: storeId, slug: 'checkout-test', name: 'Test Venue', settingsJson: {} };
const table = { id: tableId, storeId, label: '1', isActive: true };
const item = { id: itemId, storeId, title: 'Tea', priceCents: 500, isAvailable: true, itemModifiers: [] };
const writes = [];
const fakeDb = {
  store: { findUnique: async ({ where }) => where.slug === store.slug ? store : { ...store, id: otherId, slug: 'other' } },
  table: { findFirst: async ({ where }) => where.id === tableId && where.storeId === storeId ? table : null },
  item: { findMany: async ({ where }) => where.storeId === storeId && where.id.in.includes(itemId) && item.isAvailable ? [item] : [] },
  waiterTable: { findMany: async () => [] },
  order: {
    findFirst: async () => null,
    create: async ({ data }) => {
      writes.push(data);
      return {
        ...data, id: orderId, table, createdAt: new Date(), paymentStatus: 'PENDING',
        orderItems: data.orderItems.create.map((line, index) => ({
          ...line, id: `line-${index}`, itemId: line.item.connect.id, status: 'PLACED',
          item, orderItemOptions: line.orderItemOptions.create,
        })),
      };
    },
  },
  $transaction: async callback => callback(fakeDb),
};
globalThis.prisma = fakeDb;
const { orderRoutes } = await import('../dist/routes/orders.js');
const app = Fastify();
await app.register(orderRoutes);
const headers = { 'x-store-slug': store.slug };
const payload = { tableId, items: [{ itemId, quantity: 2, modifiers: '{}' }], note: 'Two cups please.' };

test('direct checkout creates unpaid orders in cloud and local modes without approval', async () => {
  for (const localMode of ['false', 'true']) {
    process.env.LOCAL_ONLY = localMode;
    const response = await app.inject({ method: 'POST', url: '/orders', headers, payload });
    assert.equal(response.statusCode, 201, response.body);
    const order = response.json().order;
    assert.equal(order.id, orderId);
    assert.equal(order.tableId, tableId);
    assert.equal(order.status, 'PLACED');
    assert.equal(order.paymentStatus, 'PENDING');
    assert.equal(order.totalCents, 1000);
    assert.equal(order.note, payload.note);
    assert.equal(order.items[0].quantity, 2);
  }
  process.env.LOCAL_ONLY = 'false';
});

test('legacy checkout fields do not mark an order as paid or require an approval', async () => {
  const response = await app.inject({ method: 'POST', url: '/orders', headers, payload: {
    ...payload, paymentSessionId: 'old-session', paymentStatus: 'PAID', totalCents: 1,
    localityApprovalToken: 'expired-token', localitySessionId: 'old-session',
  } });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().order.paymentStatus, 'PENDING');
  assert.equal(response.json().order.totalCents, 1000);
  assert.equal(writes.at(-1).paymentStatus, undefined);
});

test('direct checkout rejects missing and cross-store tables before writing', async () => {
  const before = writes.length;
  for (const request of [
    { headers, payload: { ...payload, tableId: otherId } },
    { headers: { 'x-store-slug': 'other' }, payload },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/orders', ...request });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error, 'Table not found');
  }
  assert.equal(writes.length, before);
});

test('cart validation still rejects empty carts, quantities, unavailable items and invalid options', async () => {
  const before = writes.length;
  for (const items of [[], [{ itemId, quantity: 0 }], [{ itemId, quantity: 1000 }],
    [{ itemId: otherId, quantity: 1 }], [{ itemId, quantity: 1, modifiers: '{"unknown":"option"}' }]]) {
    const response = await app.inject({ method: 'POST', url: '/orders', headers, payload: { ...payload, items } });
    assert.equal(response.statusCode, 400, response.body);
  }
  item.isAvailable = false;
  const unavailable = await app.inject({ method: 'POST', url: '/orders', headers, payload });
  item.isAvailable = true;
  assert.equal(unavailable.statusCode, 400, unavailable.body);
  assert.equal(writes.length, before);
});

test('guest edits reach order validation without a tag approval', async () => {
  for (const request of [
    { method: 'PATCH', url: `/orders/${orderId}`, payload },
    { method: 'PATCH', url: `/orders/${orderId}/items/${itemId}`, payload: { quantity: 1 } },
  ]) {
    const response = await app.inject({ ...request, headers });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error, 'Order not found');
  }
});

test('Viva checkout route is no longer available', async () => {
  const response = await app.inject({ method: 'POST', url: '/payment/viva/checkout-url', payload: {} });
  assert.equal(response.statusCode, 404);
});

test.after(async () => { await app.close(); });
