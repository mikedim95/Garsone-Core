import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import bcrypt from 'bcrypt';
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  JWT_SECRET: 'local-architect-regression-key-at-least-32-characters' });
const store = { id: '11111111-1111-4111-8111-111111111111', slug: 'habibi', settingsJson: {} };
const profile = { id: '22222222-2222-4222-8222-222222222222', email: 'architect@test.local', storeId: store.id,
  role: 'ARCHITECT', store, passwordHash: await bcrypt.hash('test-password-only', 4) };
globalThis.prisma = { profile: { findFirst: async () => profile, findUnique: async () => profile }, store: { findUnique: async () => store } };
const { authRoutes } = await import('../dist/routes/auth.js');
const { authMiddleware } = await import('../dist/middleware/auth.js');
const { signToken } = await import('../dist/lib/jwt.js');
test('Architect login and existing sessions work online and are rejected locally; manager remains local', async () => {
  const app = Fastify(); await app.register(authRoutes);
  app.get('/protected', { preHandler: authMiddleware }, async () => ({ ok: true }));
  const login = () => app.inject({ method: 'POST', url: '/auth/signin', payload: { email: profile.email, password: 'test-password-only' } });
  const token = signToken({ userId: profile.id, email: profile.email, role: 'architect', storeId: store.id, storeSlug: store.slug });
  try {
    process.env.LOCAL_ONLY = 'false';
    assert.equal((await login()).statusCode, 200);
    assert.equal((await app.inject({ url: '/protected', headers: { authorization: 'Bearer ' + token } })).statusCode, 200);
    process.env.LOCAL_ONLY = 'true';
    assert.equal((await login()).statusCode, 403);
    assert.equal((await app.inject({ url: '/protected', headers: { authorization: 'Bearer ' + token } })).statusCode, 401);
    profile.role = 'MANAGER';
    const manager = await login(); assert.equal(manager.statusCode, 200); assert.equal(manager.json().user.role, 'manager');
    assert.equal((await app.inject({ url: '/protected', headers: { authorization: 'Bearer ' + manager.json().accessToken } })).statusCode, 200);
  } finally { delete process.env.LOCAL_ONLY; await app.close(); }
});
