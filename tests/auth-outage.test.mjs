import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Prisma } from '@prisma/client';

Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
  JWT_SECRET: 'session-outage-regression-key-for-isolated-tests-only' });
let unavailable = true;
let calls = 0;
const profile = { id: '11111111-1111-4111-8111-111111111111', storeId: '22222222-2222-4222-8222-222222222222',
  email: 'manager@test.local', role: 'MANAGER', store: { slug: 'noor' } };
globalThis.prisma = { profile: { findUnique: async () => {
  calls++;
  if (unavailable) throw new Prisma.PrismaClientInitializationError('Simulated database outage', '6.19.0', 'P1001');
  return profile;
} } };
const { authMiddleware } = await import('../dist/middleware/auth.js');
const { signToken } = await import('../dist/lib/jwt.js');

test('database outage preserves valid login semantics without granting access', async () => {
  const app = Fastify();
  app.get('/protected', { preHandler: authMiddleware }, async () => ({ ok: true }));
  const headers = { authorization: `Bearer ${signToken({ userId: profile.id, storeId: profile.storeId, storeSlug: 'noor', email: profile.email, role: 'manager' })}` };
  try {
    const response = await app.inject({ url: '/protected', headers });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '5');
    assert.equal(response.json().error, 'SESSION_SERVICE_UNAVAILABLE');
    const before = calls;
    assert.equal((await app.inject({ url: '/protected', headers: { authorization: 'Bearer invalid' } })).statusCode, 401);
    assert.equal(calls, before, 'invalid credentials do not reach database');
    unavailable = false;
    assert.equal((await app.inject({ url: '/protected', headers })).statusCode, 200, 'same valid token recovers');
    profile.role = 'WAITER';
    assert.equal((await app.inject({ url: '/protected', headers })).statusCode, 401, 'revoked permissions remain rejected');
  } finally { await app.close(); }
});
