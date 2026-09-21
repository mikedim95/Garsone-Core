import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

process.env.NODE_ENV = 'test';
process.env.DB_CONNECTION = 'default';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/test';
process.env.JWT_SECRET = 'http-security-test-only-secret-at-least-32-bytes';
process.env.MQTT_DISABLED = 'true';
process.env.LOCAL_ONLY = 'true';
process.env.FRONTEND_ORIGIN = 'http://pi.local:8080';
const storeId = '11111111-1111-4111-8111-111111111111';
const ownId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const store = { id: storeId, slug: 'noor', name: 'Noor', settingsJson: {} };
const profile = { id: ownId, email: 'manager@test.local', role: 'MANAGER', storeId, store };
let currentProfile = profile;
let mutations = 0;
const model = { findFirst: async ({ where }) => where.storeId === storeId && where.id === ownId ? { id: ownId, storeId } : null,
  update: async () => { mutations++; return { id: ownId }; } };
globalThis.prisma = { profile: { findUnique: async () => currentProfile, ...model },
  store: { findUnique: async () => store },
  item: model, category: model, modifier: model, modifierOption: model, order: model, table: model,
  cookType: model, waiterType: model };
const { registerHttpSecurity, isAllowedOrigin } = await import('../dist/lib/httpSecurity.js');
const { signToken, jwtSecret } = await import('../dist/lib/jwt.js');
const { managerRoutes } = await import('../dist/routes/manager.js');
const auth = { authorization: `Bearer ${signToken({ userId: ownId, email: profile.email, role: 'manager', storeId, storeSlug: 'noor' })}` };

test('only configured local browser origins can use the API', async () => {
  assert.equal(isAllowedOrigin('http://pi.local:8080'), true);
  assert.equal(isAllowedOrigin('https://evil.example'), false);
  assert.equal(isAllowedOrigin('http://pi.local:8080.evil.example'), false);
  assert.equal(isAllowedOrigin('null'), false);
  const app = Fastify();
  await registerHttpSecurity(app);
  app.post('/write', async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/write', headers: { origin: 'https://evil.example' } })).statusCode, 403);
    const allowed = await app.inject({ method: 'POST', url: '/write', headers: { origin: process.env.FRONTEND_ORIGIN } });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], process.env.FRONTEND_ORIGIN);
    assert.equal(allowed.headers['access-control-allow-credentials'], undefined);
    assert.equal(allowed.headers['x-content-type-options'], 'nosniff');
  } finally { await app.close(); }
});

test('login attempts are rate-limited independently of general traffic', async () => {
  const app = Fastify();
  await registerHttpSecurity(app);
  app.post('/auth/signin', async () => ({ ok: true }));
  try {
    for (let i = 0; i < 15; i++) assert.equal((await app.inject({ method: 'POST', url: '/auth/signin' })).statusCode, 200);
    const rejected = await app.inject({ method: 'POST', url: '/auth/signin', headers: { 'x-forwarded-for': '198.51.100.123' } });
    assert.equal(rejected.statusCode, 429);
    assert.ok(rejected.headers['retry-after']);
  } finally { await app.close(); }
});

test('manager resource and foreign-key IDs cannot cross store boundaries', async () => {
  const app = Fastify();
  await app.register(managerRoutes);
  try {
    for (const resource of ['items', 'categories', 'modifiers', 'modifier-options', 'orders', 'tables', 'waiters', 'cooks']) {
      const res = await app.inject({ method: 'DELETE', url: `/manager/${resource}/${otherId}`, headers: auth });
      assert.equal(res.statusCode, 404, `${resource}: ${res.body}`);
    }
    const link = await app.inject({ method: 'POST', url: '/manager/item-modifiers', headers: auth,
      payload: { itemId: ownId, modifierId: otherId, isRequired: false } });
    assert.equal(link.statusCode, 404);
    const category = await app.inject({ method: 'PATCH', url: `/manager/items/${ownId}`, headers: auth, payload: { categoryId: otherId } });
    assert.equal(category.statusCode, 404);
    assert.equal(mutations, 0);
    const own = await app.inject({ method: 'PATCH', url: `/manager/items/${ownId}`, headers: auth, payload: { priceCents: 42 } });
    assert.equal(own.statusCode, 200, own.body);
    assert.equal(mutations, 1);
    const query = await app.inject({ method: 'PATCH', url: `/manager/items/${ownId}?token=${auth.authorization.slice(7)}`, payload: { priceCents: 43 } });
    assert.equal(query.statusCode, 401);
    currentProfile = { ...profile, role: 'WAITER' };
    const revoked = await app.inject({ method: 'PATCH', url: `/manager/items/${ownId}`, headers: auth, payload: { priceCents: 43 } });
    assert.equal(revoked.statusCode, 401);
    assert.equal(mutations, 1);
  } finally { currentProfile = profile; await app.close(); }
});

test('missing or weak JWT configuration fails closed', () => {
  const saved = process.env.JWT_SECRET;
  try {
    delete process.env.JWT_SECRET;
    assert.throws(jwtSecret, /JWT_SECRET/);
    process.env.JWT_SECRET = 'your-secret-key';
    assert.throws(jwtSecret, /JWT_SECRET/);
  } finally { process.env.JWT_SECRET = saved; }
});
