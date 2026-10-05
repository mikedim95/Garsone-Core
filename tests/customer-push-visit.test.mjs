import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import webPush from 'web-push';

const keys = webPush.generateVAPIDKeys();
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  LOCAL_ONLY: 'false', STORE_SLUG: 'push-test', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
const store = { id: '11111111-1111-4111-8111-111111111111', slug: 'push-test', name: 'Test', settingsJson: {} };
const tableId = '22222222-2222-4222-8222-222222222222';
const token = 'ab'.repeat(32);
const visit = { id: '33333333-3333-4333-8333-333333333333', storeId: store.id, tableId, status: 'OPEN' };
const order = { id: '44444444-4444-4444-8444-444444444444', storeId: store.id, tableId, diningVisitId: visit.id, status: 'READY' };
const sent = [], subscriptions = [];
let lastSubscriptionQuery;
globalThis.prisma = {
  store: { findUnique: async () => store },
  table: { findFirst: async ({ where }) => where.id === tableId ? { id: tableId } : null },
  diningGuestSession: { findUnique: async ({ where }) => where.tokenHash === createHash('sha256').update(token).digest('hex') ? { visitId: visit.id, visit } : null },
  order: { findFirst: async ({ where, select }) => where.id === order.id && (!where.diningVisitId || where.diningVisitId === order.diningVisitId)
    ? (select.diningVisit ? { diningVisit: order.diningVisitId ? visit : null } : { id: order.id }) : null },
  customerPushSubscription: {
    upsert: async ({ create }) => { subscriptions.push(create); return create; },
    findMany: async ({ where }) => { lastSubscriptionQuery = where; return subscriptions.filter(row => row.storeId === where.storeId && row.orderId === where.orderId); },
    deleteMany: async () => ({ count: 0 }),
  },
};
webPush.sendNotification = async (_subscription, payload) => { sent.push(JSON.parse(payload)); return { statusCode: 201 }; };
const { customerPushRoutes } = await import('../dist/routes/customerPush.js');
const { notifyCustomerOrderStatus } = await import('../dist/lib/customerPush.js');

test('push registration and delivery cannot escape the current customer visit', async () => {
  const app = Fastify();
  await app.register(customerPushRoutes);
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/isolated-test', keys: { p256dh: 'test-public-key', auth: 'test-auth' } };
  const register = (payload, visitToken = token) => app.inject({ method: 'POST', url: '/public/push/subscriptions',
    headers: { 'x-table-visit': visitToken }, payload });
  try {
    const payload = { tableId, orderId: order.id, subscription };
    assert.equal((await register(payload, '')).statusCode, 403);
    assert.equal((await register({ tableId, subscription })).statusCode, 400, 'table-wide registrations are refused');
    assert.equal((await register({ ...payload, orderId: '55555555-5555-4555-8555-555555555555' })).statusCode, 404);
    assert.equal(subscriptions.length, 0);
    assert.equal((await register(payload)).statusCode, 200);
    subscriptions.push({ ...subscriptions[0], orderId: null, endpoint: 'https://fcm.googleapis.com/fcm/send/old-table-visitor' });
    await notifyCustomerOrderStatus({ order, storeSlug: store.slug });
    assert.equal(sent.length, 1);
    assert.deepEqual(lastSubscriptionQuery, { storeId: store.id, orderId: order.id });
    visit.status = 'CLOSED';
    assert.equal((await register(payload)).statusCode, 410);
    await notifyCustomerOrderStatus({ order, storeSlug: store.slug });
    assert.equal(sent.length, 1, 'closed visits receive no further status notification');
    visit.status = 'OPEN';
    order.diningVisitId = null;
    await notifyCustomerOrderStatus({ order, storeSlug: store.slug });
    assert.equal(sent.length, 1, 'legacy table subscriptions cannot observe a new party');
  } finally { await app.close(); }
});
