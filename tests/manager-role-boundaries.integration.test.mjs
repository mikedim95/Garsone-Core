import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import bcrypt from 'bcrypt';

const url = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || new URL(url).pathname !== '/garsone_reliability_test') {
  throw new Error('Use the disposable local database from tests/run-order-reliability.mjs');
}
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: url, DIRECT_URL: url,
  JWT_SECRET: 'manager-role-boundaries-test-only', LOCAL_ONLY: 'true', MQTT_DISABLED: 'true', STORE_SLUG: 'manager-roles-test' });
const { db } = await import('../dist/db/index.js');
const { managerRoutes } = await import('../dist/routes/manager.js');
const { localOperationsRoutes } = await import('../dist/routes/localOperations.js');
const { qrTileRoutes } = await import('../dist/routes/qrTiles.js');
const { signToken } = await import('../dist/lib/jwt.js');

test('local Manager can edit staff, but never elevate or reset privileged accounts', async t => {
  const store = await db.store.create({ data: { slug: process.env.STORE_SLUG, name: 'Role boundary test' } });
  const foreign = await db.store.create({ data: { slug: `role-other-${randomUUID()}`, name: 'Another venue' } });
  const originalHash = await bcrypt.hash('original-test-password', 4);
  const profiles = {};
  for (const role of ['MANAGER', 'ARCHITECT', 'WAITER', 'COOK', 'HYBRID']) {
    profiles[role] = await db.profile.create({ data: { storeId: store.id, role, email: `${role.toLowerCase()}@role.test`,
      displayName: role, passwordHash: originalHash } });
  }
  const outside = await db.profile.create({ data: { storeId: foreign.id, role: 'WAITER', email: 'outside@role.test', displayName: 'Outside', passwordHash: originalHash } });
  const headers = role => ({ authorization: `Bearer ${signToken({ userId: profiles[role].id, email: profiles[role].email,
    role: role.toLowerCase(), storeId: store.id, storeSlug: store.slug })}` });
  const app = Fastify();
  await app.register(managerRoutes);
  await app.register(localOperationsRoutes);
  await app.register(qrTileRoutes);
  const request = (method, route, payload, role = 'MANAGER') => app.inject({ method, url: route, payload, headers: role ? headers(role) : {} });
  try {
    await t.test('anonymous and service staff cannot use Manager or Architect actions', async () => {
      for (const role of [null, 'WAITER', 'COOK', 'HYBRID', 'ARCHITECT']) {
        const expected = !role || role === 'ARCHITECT' ? 401 : 403;
        assert.equal((await request('GET', '/manager/waiters', undefined, role)).statusCode, expected);
        assert.equal((await request('POST', '/manager/local-operations/printers/test', { printerId: 'rfcomm0', requestId: randomUUID() }, role)).statusCode, expected);
      }
      assert.equal((await request('POST', '/admin/qr-tiles/bulk', { count: 1 })).statusCode, 403);
      assert.equal((await request('DELETE', `/admin/stores/${store.id}/history`, { confirmation: `DELETE HISTORY ${store.slug}` })).statusCode, 403);
    });
    await t.test('both staff editors reject privileged, wrong-staff-role and cross-venue targets', async () => {
      for (const [resource, protectedRoles] of [['waiters', ['MANAGER', 'ARCHITECT', 'COOK']], ['cooks', ['MANAGER', 'ARCHITECT', 'WAITER']]]) {
        for (const role of protectedRoles) {
          const before = await db.profile.findUniqueOrThrow({ where: { id: profiles[role].id } });
          assert.equal((await request('PATCH', `/manager/${resource}/${before.id}`, { email: 'changed@role.test', password: 'unauthorized-password', displayName: 'Changed' })).statusCode, 404);
          assert.equal((await request('DELETE', `/manager/${resource}/${before.id}`)).statusCode, 404);
          assert.deepEqual(await db.profile.findUniqueOrThrow({ where: { id: before.id } }), before);
        }
        assert.equal((await request('PATCH', `/manager/${resource}/${outside.id}`, { displayName: 'Changed' })).statusCode, 404);
      }
    });
    await t.test('authorized waiter, cook and hybrid changes persist without role escalation', async () => {
      for (const [resource, role] of [['waiters', 'WAITER'], ['cooks', 'COOK'], ['waiters', 'HYBRID'], ['cooks', 'HYBRID']]) {
        const response = await request('PATCH', `/manager/${resource}/${profiles[role].id}`, { displayName: `Edited ${role}`, password: 'updated-staff-password', role: 'ARCHITECT' });
        assert.equal(response.statusCode, 200, response.body);
        const saved = await db.profile.findUniqueOrThrow({ where: { id: profiles[role].id } });
        assert.equal(saved.role, role);
        assert.equal(saved.displayName, `Edited ${role}`);
        assert.equal(await bcrypt.compare('updated-staff-password', saved.passwordHash), true);
      }
    });
    await t.test('a concurrent promotion cannot turn a staff edit into a privileged password reset', async () => {
      const update = db.profile.update.bind(db.profile);
      for (const [resource, role] of [['waiters', 'WAITER'], ['cooks', 'COOK']]) {
        const target = profiles[role];
        const before = await db.profile.findUniqueOrThrow({ where: { id: target.id } });
        let promoted = false;
        db.profile.update = async args => {
          if (args.where.id === target.id && !promoted) {
            promoted = true;
            await update({ where: { id: target.id }, data: { role: 'MANAGER' } });
          }
          return update(args);
        };
        try {
          assert.equal((await request('PATCH', `/manager/${resource}/${target.id}`, { password: 'racing-password' })).statusCode, 404);
          const after = await db.profile.findUniqueOrThrow({ where: { id: target.id } });
          assert.equal(after.role, 'MANAGER');
          assert.equal(after.passwordHash, before.passwordHash);
        } finally {
          db.profile.update = update;
          await update({ where: { id: target.id }, data: { role } });
        }
      }
    });
    await t.test('removing either hybrid duty preserves the other authorized staff duty', async () => {
      assert.equal((await request('DELETE', `/manager/waiters/${profiles.HYBRID.id}`)).statusCode, 200);
      assert.equal((await db.profile.findUniqueOrThrow({ where: { id: profiles.HYBRID.id } })).role, 'COOK');
      await db.profile.update({ where: { id: profiles.HYBRID.id }, data: { role: 'HYBRID' } });
      assert.equal((await request('DELETE', `/manager/cooks/${profiles.HYBRID.id}`)).statusCode, 200);
      assert.equal((await db.profile.findUniqueOrThrow({ where: { id: profiles.HYBRID.id } })).role, 'WAITER');
    });
  } finally {
    await app.close();
    await db.profile.deleteMany({ where: { storeId: { in: [store.id, foreign.id] } } });
    await db.store.deleteMany({ where: { id: { in: [store.id, foreign.id] } } });
    await db.$disconnect();
  }
});
