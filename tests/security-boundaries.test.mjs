import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import Fastify from 'fastify';
import { WebSocket } from 'ws';

// No production connection or records are used. Route authorization is exercised
// against an in-memory Prisma boundary; realtime uses actual loopback sockets.
process.env.NODE_ENV = 'test';
process.env.DB_CONNECTION = 'default';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'security-regression-test-key-at-least-32-characters';
process.env.STORE_SLUG = 'noor';
process.env.LOCAL_ONLY = 'false';
process.env.MQTT_DISABLED = 'true';

const storeA = { id: '11111111-1111-4111-8111-111111111111', slug: 'noor', name: 'Noor', settingsJson: {} };
const storeB = { id: '22222222-2222-4222-8222-222222222222', slug: 'other', name: 'Other', settingsJson: {} };
const tableA = '33333333-3333-4333-8333-333333333333';
const tableB = '44444444-4444-4444-8444-444444444444';
const tileId = '55555555-5555-4555-8555-555555555555';
const profileA = { id: '66666666-6666-4666-8666-666666666666', email: 'manager@noor.test', role: 'MANAGER', storeId: storeA.id, store: storeA };
const profileB = { id: '77777777-7777-4777-8777-777777777777', email: 'manager@other.test', role: 'MANAGER', storeId: storeB.id, store: storeB };
let storeCreateCalls = 0;
let tileUpdateCalls = 0;
let tableLookupEnabled = false;
const fakeDb = {
  profile: { findUnique: async ({ where }) => [profileA, profileB].find(p => p.id === where.id) || null },
  store: {
    findUnique: async ({ where }) => [storeA, storeB].find(s => s.id === where.id || s.slug === where.slug) || null,
    findMany: async ({ where }) => [storeA, storeB].filter(s => !where?.id || s.id === where.id),
    create: async () => { storeCreateCalls++; throw new Error('Unexpected public provisioning'); },
  },
  table: { findFirst: async ({ where }) => tableLookupEnabled &&
    ((where.id === tableA && where.store?.slug === 'noor') || (where.id === tableB && where.store?.slug === 'other'))
    ? { id: where.id } : null },
  qRTile: {
    findUnique: async () => ({ id: tileId, storeId: storeB.id }),
    update: async () => { tileUpdateCalls++; throw new Error('Cross-store mutation'); },
  },
};
globalThis.prisma = fakeDb;

const { signToken } = await import('../dist/lib/jwt.js');
const { ensureStore } = await import('../dist/lib/store.js');
const { qrTileRoutes } = await import('../dist/routes/qrTiles.js');
const { orderRoutes } = await import('../dist/routes/orders.js');
const { eventsRoutes } = await import('../dist/routes/events.js');
const { managerRoutes } = await import('../dist/routes/manager.js');
const { customerPushRoutes } = await import('../dist/routes/customerPush.js');
const { decodeRasterImage, isPublicImageUrl } = await import('../dist/lib/imageUpload.js');
const { isAllowedPushEndpoint } = await import('../dist/lib/pushEndpoint.js');
const { emitRealtime, setupRealtimeGateway } = await import('../dist/lib/realtime.js');
const tokenFor = profile => signToken({ userId: profile.id, email: profile.email, role: 'manager', storeId: profile.storeId, storeSlug: profile.store.slug });
const authA = { authorization: `Bearer ${tokenFor(profileA)}` };

test('unknown store lookup never provisions a public tenant', async () => {
  await assert.rejects(ensureStore('unknown-untrusted-header'), /STORE_NOT_FOUND/);
  assert.equal(storeCreateCalls, 0);
});

test('manager store and QR routes enforce tenant ownership before mutations', async () => {
  const app = Fastify();
  await app.register(qrTileRoutes);
  try {
    const listing = await app.inject({ url: '/admin/stores', headers: authA });
    assert.equal(listing.statusCode, 200);
    assert.deepEqual(listing.json().stores.map(s => s.id), [storeA.id]);
    const crossStore = await app.inject({ method: 'PATCH', url: `/admin/stores/${storeB.id}/ordering-mode`, headers: authA, payload: { orderingMode: 'qr' } });
    assert.equal(crossStore.statusCode, 403);
    const crossTile = await app.inject({ method: 'PATCH', url: `/admin/qr-tiles/${tileId}`, headers: authA, payload: { isActive: false } });
    assert.equal(crossTile.statusCode, 404);
    const deleteTile = await app.inject({ method: 'DELETE', url: `/admin/qr-tiles/${tileId}`, headers: authA });
    assert.equal(deleteTile.statusCode, 404);
    assert.equal(tileUpdateCalls, 0);
  } finally { await app.close(); }
});

test('public order creation cannot bypass approval with paymentSessionId or Noor name', async () => {
  const app = Fastify();
  await app.register(orderRoutes);
  const payload = { tableId: tableA, items: [{ itemId: tileId, quantity: 1 }], paymentSessionId: 'forged-payment-session' };
  try {
    const benchmark = await app.inject({ url: '/orders-benchmark', headers: { 'x-store-slug': 'noor' } });
    assert.equal(benchmark.statusCode, 401);
    const cloud = await app.inject({ method: 'POST', url: '/orders', headers: { 'x-store-slug': 'noor' }, payload });
    assert.equal(cloud.statusCode, 403);
    assert.equal(cloud.json().error, 'LOCALITY_APPROVAL_REQUIRED');
    process.env.LOCAL_ONLY = 'true';
    const local = await app.inject({ method: 'POST', url: '/orders', headers: { 'x-store-slug': 'noor' }, payload });
    assert.equal(local.statusCode, 404); // Reaches table lookup: explicit local-mode policy.
    assert.equal(local.json().error, 'Table not found');
    const other = await app.inject({ method: 'POST', url: '/orders', headers: { 'x-store-slug': 'other' }, payload });
    assert.equal(other.statusCode, 403); // Local exception is only this Pi's venue.
  } finally { process.env.LOCAL_ONLY = 'false'; await app.close(); }
});

test('browser event publishing cannot forge order or node events', async () => {
  const app = Fastify();
  await app.register(eventsRoutes);
  try {
    for (const topic of ['other/orders/paid', 'noor/orders/paid', 'garsone/nodes/test/config']) {
      const response = await app.inject({ method: 'POST', url: '/events/publish', headers: authA, payload: { topic, payload: { malicious: true } } });
      assert.equal(response.statusCode, 403);
    }
    const safe = await app.inject({ method: 'POST', url: '/events/publish', headers: authA, payload: { topic: 'noor/client/refresh' } });
    assert.equal(safe.statusCode, 200);
  } finally { await app.close(); }
});

test('WebSockets isolate stores and tables, suppress node secrets and guest order details', async () => {
  const app = Fastify();
  setupRealtimeGateway(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  tableLookupEnabled = true;
  const address = app.server.address();
  const base = `ws://127.0.0.1:${address.port}/events/ws`;
  const sockets = [];
  const open = async query => {
    const ws = new WebSocket(`${base}${query}`);
    sockets.push(ws);
    const messages = [];
    ws.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    return messages;
  };
  try {
    const managerA = await open(`?token=${tokenFor(profileA)}`);
    const managerB = await open(`?token=${tokenFor(profileB)}`);
    const anonymous = await open('');
    const guestA = await open(`?storeSlug=noor&tableId=${tableA}`);
    const guestB = await open(`?storeSlug=other&tableId=${tableB}`);
    const rejectedOrigin = new WebSocket(base, { origin: 'https://untrusted.invalid' });
    sockets.push(rejectedOrigin);
    await assert.rejects(once(rejectedOrigin, 'open'));
    profileB.role = 'WAITER';
    const revoked = new WebSocket(`${base}?token=${tokenFor(profileB)}`);
    sockets.push(revoked);
    try { await assert.rejects(once(revoked, 'open')); }
    finally { profileB.role = 'MANAGER'; }
    emitRealtime('noor/orders/placed', { orderId: 'staff-order', tableId: tableA, note: 'private' }, { roles: ['manager'] });
    emitRealtime('garsone/nodes/test/config', { nodeToken: 'must-never-reach-browser', config: { wifiPassword: 'private' } });
    emitRealtime('noor/orders/paid', { orderId: 'guest-order', tableId: tableA, status: 'PAID', note: 'private', items: ['private'], order: { secret: true } }, { anonymousOnly: true });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(managerA.length, 1);
    assert.equal(managerB.length, 0);
    assert.equal(anonymous.length, 0);
    assert.equal(guestB.length, 0);
    assert.deepEqual(guestA, [{ topic: 'noor/orders/paid', payload: { orderId: 'guest-order', tableId: tableA, status: 'PAID' } }]);
  } finally {
    for (const ws of sockets) ws.terminate();
    await app.close();
    tableLookupEnabled = false;
  }
});

test('uploads reject active content disguised as images and media responses sandbox legacy content', async () => {
  const app = Fastify();
  await app.register(managerRoutes);
  const previousFetch = globalThis.fetch;
  const envNames = ['R2_S3_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const oldEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  try {
    const rejection = await app.inject({ method: 'POST', url: '/manager/uploads/image', headers: authA,
      payload: { fileName: 'innocent.png', mimeType: 'image/png', base64: Buffer.from(svg).toString('base64') } });
    assert.equal(rejection.statusCode, 400);
    assert.match(rejection.json().error, /PNG, JPEG, GIF or WebP/);
    process.env.R2_S3_ENDPOINT = 'https://storage.test.invalid';
    process.env.R2_BUCKET = 'test';
    process.env.R2_ACCESS_KEY_ID = 'test';
    process.env.R2_SECRET_ACCESS_KEY = 'test';
    globalThis.fetch = async () => new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
    const media = await app.inject({ url: '/media/test/legacy.svg' });
    assert.equal(media.statusCode, 200);
    assert.equal(media.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(media.headers['x-content-type-options'], 'nosniff');
    const image = decodeRasterImage('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=');
    assert.equal(image.mimeType, 'image/png');
    assert.equal(image.extension, 'png');
    assert.equal(isPublicImageUrl('/uploads/noor/menu/photo.png'), true);
    assert.equal(isPublicImageUrl('/uploads/../../secrets'), false);
    assert.equal(isPublicImageUrl('javascript:alert(1)'), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of envNames) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
    await app.close();
  }
});

test('push subscriptions cannot target private hosts, URL parser tricks or untrusted services', async () => {
  const app = Fastify();
  await app.register(customerPushRoutes);
  const denied = ['https://127.0.0.1/private', 'https://169.254.169.254/metadata', 'https://[::1]/private',
    'http://fcm.googleapis.com/path', 'https://fcm.googleapis.com:8443/path', 'https://user:secret@fcm.googleapis.com/path',
    'https://fcm.googleapis.com.attacker.invalid/path', 'https://fcm.googleapis.com\\@attacker.invalid/path'];
  try {
    for (const endpoint of denied) {
      assert.equal(isAllowedPushEndpoint(endpoint), false, endpoint);
      const response = await app.inject({ method: 'POST', url: '/public/push/subscriptions',
        payload: { tableId: tableA, subscription: { endpoint, keys: { p256dh: 'test', auth: 'test' } } } });
      assert.equal(response.statusCode, 400, endpoint);
    }
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/test', 'https://updates.push.services.mozilla.com/wpush/v2/test', 'https://web.push.apple.com/test']) {
      assert.equal(isAllowedPushEndpoint(endpoint), true);
    }
    process.env.LOCAL_ONLY = 'true';
    assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/test'), false);
  } finally { process.env.LOCAL_ONLY = 'false'; await app.close(); }
});
