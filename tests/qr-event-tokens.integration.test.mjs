import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';

const databaseUrl = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!databaseUrl || !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) || new URL(databaseUrl).pathname !== '/garsone_reliability_test') {
  throw new Error('Use the disposable local database from tests/run-order-reliability.mjs');
}
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: databaseUrl,
  DIRECT_URL: databaseUrl, LOCAL_ONLY: 'false', MQTT_DISABLED: 'true', JWT_SECRET: 'qr-public-token-fixture-secret-at-least-32-bytes' });
const { db } = await import('../dist/db/index.js');
const { signToken } = await import('../dist/lib/jwt.js');
const { qrEventRoutes } = await import('../dist/routes/qrEvents.js');
const { qrTileRoutes } = await import('../dist/routes/qrTiles.js');
const { exportQrEvent, importQrEventBundle, resolveQrToken } = await import('../dist/lib/qrEvents.js');

test('opaque QR tokens survive management and Pi import without exposing event IDs or changing online tiles', async t => {
  const suffix = randomUUID().slice(0, 8);
  const store = await db.store.create({ data: { slug: `token-fixture-${suffix}`, name: 'QR token fixture' } });
  const foreignStore = await db.store.create({ data: { slug: `token-other-${suffix}`, name: 'Other QR fixture' } });
  const app = Fastify();
  try {
    const table = await db.table.create({ data: { storeId: store.id, label: 'One' } });
    const secondTable = await db.table.create({ data: { storeId: store.id, label: 'Two' } });
    const foreignTable = await db.table.create({ data: { storeId: foreignStore.id, label: 'Foreign' } });
    const architect = await db.profile.create({ data: { storeId: store.id, email: `token-${suffix}@fixture.invalid`,
      globalKey: `token-${suffix}`, role: 'ARCHITECT', passwordHash: 'fixture-only', isVerified: true } });
    const headers = { authorization: `Bearer ${signToken({ userId: architect.id, email: architect.email,
      role: 'architect', storeId: store.id, storeSlug: store.slug })}` };
    const code = 'GT-QRTK-1234';
    const globalTile = await db.qRTile.create({ data: { publicCode: code, storeId: store.id, tableId: table.id, isActive: true } });
    const config = { name: 'First batch', publicAppUrl: 'http://192.0.2.25:8080', publicApiUrl: 'http://192.0.2.25:8080/api',
      assignments: [{ publicCode: code, tableId: table.id, label: 'One', isActive: true }] };
    await app.register(qrEventRoutes);
    await app.register(qrTileRoutes);
    const create = async body => {
      const response = await app.inject({ method: 'POST', url: `/admin/stores/${store.id}/qr-events`, headers, payload: body });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().event;
    };
    let first, second, exported;
    await t.test('admin create generates unrelated tokens for the same visible code in different events', async () => {
      first = await create(config);
      second = await create({ ...config, name: 'Second batch', assignments: [{ ...config.assignments[0], tableId: secondTable.id }] });
      const token = first.assignments[0].publicToken;
      assert.match(token, /^QT-[0-9A-F]{32}$/);
      assert.notEqual(token, second.assignments[0].publicToken);
      assert.equal((await resolveQrToken(token)).tableId, table.id);
      assert.equal((await resolveQrToken(second.assignments[0].publicToken)).tableId, secondTable.id);
      const response = await app.inject({ url: `/q/${token}`, headers: { accept: 'application/json' } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().tableId, table.id);
      assert.equal(Object.hasOwn(response.json(), 'eventId'), false);
      assert.ok(!response.body.includes(first.id));
      assert.equal(response.headers['referrer-policy'], 'no-referrer');
    });
    await t.test('saving assignments preserves tokens and saving a legacy event prepares its links', async () => {
      const response = await app.inject({ method: 'PATCH', url: `/admin/qr-events/${first.id}`, headers,
        payload: { expectedRevision: first.revision, assignments: [{ ...config.assignments[0], tableId: secondTable.id, label: 'Moved' }] } });
      assert.equal(response.statusCode, 200, response.body);
      const saved = response.json().event;
      assert.equal(saved.assignments[0].publicToken, first.assignments[0].publicToken);
      first = saved;
      assert.equal((await resolveQrToken(first.assignments[0].publicToken)).tableId, secondTable.id);
      const legacy = await db.qrEvent.create({ data: { storeId: store.id, name: 'Legacy', publicAppUrl: config.publicAppUrl,
        publicApiUrl: config.publicApiUrl, assignmentsJson: config.assignments } });
      const upgraded = await app.inject({ method: 'PATCH', url: `/admin/qr-events/${legacy.id}`, headers,
        payload: { expectedRevision: 1, name: 'Legacy' } });
      assert.equal(upgraded.statusCode, 200, upgraded.body);
      assert.match(upgraded.json().event.assignments[0].publicToken, /^QT-[0-9A-F]{32}$/);
      assert.equal(upgraded.json().event.revision, 2);
      const result = await app.inject({ url: `/admin/qr-events/${first.id}/export`, headers });
      assert.equal(result.statusCode, 200);
      exported = result.json().bundle;
      assert.equal(exported.schemaVersion, 2);
      assert.equal(exported.event.assignments[0].publicToken, first.assignments[0].publicToken);
    });
    await t.test('a separate Pi copy retains the exact token and supports idempotent versioned import', async () => {
      // Remove only this fixture event to model a separate database receiving its export.
      await db.qrEvent.delete({ where: { id: first.id } });
      process.env.LOCAL_ONLY = 'true';
      const imported = await importQrEventBundle(exported);
      assert.equal(imported.unchanged, false);
      assert.equal((await importQrEventBundle(exported)).unchanged, true);
      assert.equal((await resolveQrToken(first.assignments[0].publicToken)).tableId, secondTable.id);
      assert.equal(exportQrEvent(imported.event).event.assignments[0].publicToken, first.assignments[0].publicToken);
      const legacyBundle = structuredClone(exported);
      legacyBundle.schemaVersion = 1;
      legacyBundle.event.id = randomUUID();
      legacyBundle.event.assignments = config.assignments;
      const legacy = await importQrEventBundle(legacyBundle);
      assert.equal(exportQrEvent(legacy.event).schemaVersion, 1);
      const oldLink = await app.inject({ url: `/q/${code}?event=${legacy.event.id}`, headers: { accept: 'application/json' } });
      assert.equal(oldLink.statusCode, 200);
      assert.ok(!oldLink.body.includes(legacy.event.id));
      process.env.LOCAL_ONLY = 'false';
    });
    await t.test('ambiguous tokens, inactive and foreign tables cannot select a different event', async () => {
      const token = first.assignments[0].publicToken;
      const original = await db.qrEvent.findUniqueOrThrow({ where: { id: first.id } });
      const duplicate = await db.qrEvent.create({ data: { storeId: store.id, name: 'Duplicate import fixture',
        publicAppUrl: config.publicAppUrl, publicApiUrl: config.publicApiUrl, assignmentsJson: original.assignmentsJson, isActive: false } });
      assert.equal(await resolveQrToken(token), null, 'Even a disabled duplicate cannot be selected ambiguously');
      await db.qrEvent.delete({ where: { id: duplicate.id } });
      await db.table.update({ where: { id: secondTable.id }, data: { isActive: false } });
      assert.equal((await resolveQrToken(token)).redirectUrl, null);
      await db.table.update({ where: { id: secondTable.id }, data: { isActive: true } });
      await db.qrEvent.update({ where: { id: first.id }, data: { assignmentsJson: [{ ...original.assignmentsJson[0], tableId: foreignTable.id }] } });
      const invalid = await app.inject({ url: `/q/${token}`, headers: { accept: 'application/json' } });
      assert.equal(invalid.statusCode, 404);
      assert.ok(!invalid.body.includes(first.id));
      assert.deepEqual(await db.qRTile.findUnique({ where: { id: globalTile.id } }), globalTile);
      const online = await app.inject({ url: `/q/${code}`, headers: { accept: 'application/json' } });
      assert.equal(online.statusCode, 200);
      assert.equal(online.json().tableId, table.id);
    });
  } finally {
    await app.close();
    await db.auditLog.deleteMany({ where: { storeId: { in: [store.id, foreignStore.id] } } });
    await db.store.deleteMany({ where: { id: { in: [store.id, foreignStore.id] } } });
    await db.$disconnect();
  }
});
