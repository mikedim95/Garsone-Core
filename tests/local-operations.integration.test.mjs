import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import Fastify from 'fastify';

const url = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || new URL(url).pathname !== '/garsone_reliability_test') {
  throw new Error('Use the disposable local database from tests/run-order-reliability.mjs');
}
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'garsone-print-ops-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: url, DIRECT_URL: url,
  JWT_SECRET: 'ops-regression-tests-only-never-used-on-real-venues', LOCAL_ONLY: 'true', STORE_SLUG: 'ops-test',
  MQTT_DISABLED: 'true', LOCAL_PRINTING_ENABLED: 'true', LOCAL_PRINT_SPOOL: path.join(temp, 'spool'),
  LOCAL_PRINTER_ROUTES_FILE: path.join(temp, 'printers.json'), LOCAL_UPLOAD_DIR: temp,
  LOCAL_BACKUP_STATUS_FILE: path.join(temp, 'backup.json') });
const { db } = await import('../dist/db/index.js');
const { localOperationsRoutes } = await import('../dist/routes/localOperations.js');
const { startLocalPrinting, stopLocalPrinting } = await import('../dist/lib/localPrinting.js');
const { signToken } = await import('../dist/lib/jwt.js');
const { ensureOrderReliabilitySchema } = await import('../dist/db/ensureOrderReliabilitySchema.js');

test('local operations uses durable, tenant-scoped, idempotent staff actions', async t => {
  await ensureOrderReliabilitySchema();
  const store = await db.store.create({ data: { name: 'Disposable operations test', slug: 'ops-test' } });
  const foreign = await db.store.create({ data: { name: 'Other operations test', slug: 'ops-other-test' } });
  const topic = 'ops-test/orders/placed/printer_1';
  const profiles = await Promise.all([
    ['MANAGER', store], ['WAITER', store], ['ARCHITECT', store], ['MANAGER', foreign],
  ].map(([role, venue], i) => db.profile.create({ data: { storeId: venue.id, role, email: `test-${i}@ops.test`, displayName: role, passwordHash: 'unused-test-only' } })));
  const headers = index => ({ authorization: `Bearer ${signToken({ userId: profiles[index].id, email: profiles[index].email,
    role: profiles[index].role.toLowerCase(), storeId: profiles[index].storeId, storeSlug: index === 3 ? foreign.slug : store.slug })}` });
  const app = Fastify();
  await app.register(localOperationsRoutes);
  const get = (auth = headers(0)) => app.inject({ url: '/manager/local-operations', headers: auth });
  const post = (route, payload, auth = headers(0)) => app.inject({ method: 'POST', url: `/manager/local-operations/${route}`, headers: auth, payload });
  const uncertain = data => db.localPrintIntent.create({ data: { storeId: store.id, topic, payload: { tableLabel: 'T1', items: [{ title: 'Coffee', quantity: 1 }] },
    state: 'uncertain', startedAt: new Date(Date.now() - 60_000), error: 'Simulated interrupted write', ...data } });
  try {
    await fs.writeFile(process.env.LOCAL_PRINTER_ROUTES_FILE, JSON.stringify({ [topic]: { device: '/dev/rfcomm999' } }));
    for (const state of ['queued', 'uncertain']) {
      await fs.mkdir(path.join(temp, 'spool', state), { recursive: true });
      await fs.writeFile(path.join(temp, 'spool', state, `legacy-${state}.json`), JSON.stringify({ id: `legacy-${state}`, topic,
        route: { device: '/dev/rfcomm999' }, payload: { title: `Legacy ${state}` }, createdAt: new Date().toISOString(), error: state === 'uncertain' ? 'Old partial write' : undefined }));
    }
    await startLocalPrinting(db);
    stopLocalPrinting();
    await t.test('legacy spool imports once and preserves uncertain tickets through restart', async () => {
      const imported = await db.localPrintIntent.findMany({ where: { storeId: store.id } });
      assert.equal(imported.length, 2);
      assert.equal(imported.filter(job => job.state === 'uncertain').length, 1);
      const queued = imported.find(job => job.state === 'queued');
      await db.localPrintIntent.update({ where: { id: queued.id }, data: { state: 'delivered' } });
      // Simulate a crash after DB commit but before the source spool rename.
      await fs.copyFile(path.join(temp, 'spool/imported/queued-legacy-queued.json'), path.join(temp, 'spool/queued/legacy-queued.json'));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "const {db}=await import('./dist/db/index.js');const p=await import('./dist/lib/localPrinting.js');await p.startLocalPrinting(db);p.stopLocalPrinting();await db.$disconnect();"], { env: process.env, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(await db.localPrintIntent.count({ where: { storeId: store.id } }), 2);
      assert.equal((await db.localPrintIntent.findUnique({ where: { id: queued.id } })).state, 'delivered');
    });
    await t.test('manager and architect only, exact venue, local installation only', async () => {
      assert.equal((await get({})).statusCode, 401);
      assert.equal((await get(headers(1))).statusCode, 403);
      assert.equal((await get(headers(2))).statusCode, 200);
      assert.equal((await get(headers(3))).statusCode, 404);
      process.env.LOCAL_ONLY = 'false';
      assert.equal((await get()).statusCode, 404);
      process.env.LOCAL_ONLY = 'true';
    });
    await t.test('disabling output keeps unresolved tickets visible for staff review', async () => {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "const {db}=await import('./dist/db/index.js');const p=await import('./dist/lib/localPrinting.js');await p.startLocalPrinting(db);const s=await p.localPrintStatus('ops-test');console.log(JSON.stringify({enabled:s.enabled,pendingCount:s.pendingCount,states:s.jobs.map(j=>j.state)}));await db.$disconnect();"],
      { env: { ...process.env, LOCAL_PRINTING_ENABLED: 'false' }, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      const status = JSON.parse(child.stdout.trim().split('\n').at(-1));
      assert.equal(status.enabled, false);
      assert.equal(status.pendingCount, 1);
      assert.ok(status.states.includes('uncertain'));
    });
    await t.test('status reports device presence honestly and exposes only sanitized backup metadata', async () => {
      const at = new Date(Date.now() - 3600_000).toISOString();
      await fs.writeFile(process.env.LOCAL_BACKUP_STATUS_FILE, JSON.stringify({ source: 'deployment', lastSuccessfulAt: at, secret: 'must-not-appear' }));
      const response = await get();
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().system.database.ok, true);
      assert.equal(response.json().printing.printers[0].available, false);
      assert.deepEqual(response.json().backup, { source: 'deployment', lastSuccessfulAt: at });
      assert.ok(!response.body.includes('must-not-appear'));
      await fs.writeFile(process.env.LOCAL_BACKUP_STATUS_FILE, '{}');
      assert.equal((await get()).json().backup.lastSuccessfulAt, null);
    });
    await t.test('concurrent test-ticket retries create one durable job', async () => {
      const payload = { printerId: 'rfcomm999', requestId: randomUUID() };
      const responses = await Promise.all(Array.from({ length: 5 }, () => post('printers/test', payload)));
      assert.ok(responses.every(response => [200, 202].includes(response.statusCode)), responses.map(response => response.body).join('\n'));
      assert.equal(await db.localPrintIntent.count({ where: { id: payload.requestId } }), 1);
      assert.equal((await post('printers/test', { ...payload, printerId: '../rfcomm999' })).statusCode, 400);
      assert.equal((await post('printers/test', payload, headers(1))).statusCode, 403);
      assert.equal((await post('printers/test', payload, headers(2))).statusCode, 409);
    });
    await t.test('concurrent explicit reprints produce one labelled copy and an audit trail', async () => {
      const original = await uncertain();
      const responses = await Promise.all(Array.from({ length: 6 }, () => post(`jobs/${original.id}/resolve`, { action: 'reprint', requestId: randomUUID() })));
      assert.ok(responses.every(response => response.statusCode === 200), responses.map(response => response.body).join('\n'));
      assert.equal(new Set(responses.map(response => response.json().jobId)).size, 1);
      const copies = await db.localPrintIntent.findMany({ where: { reprintOfId: original.id } });
      assert.equal(copies.length, 1);
      assert.match(copies[0].payload.printReason, /REPRINT/);
      const resolved = await db.localPrintIntent.findUnique({ where: { id: original.id } });
      assert.equal(resolved.resolution, 'reprint');
      assert.equal(resolved.resolvedBy, profiles[0].id);
      assert.ok(resolved.resolvedAt);
      assert.equal((await post(`jobs/${original.id}/resolve`, { action: 'printed', requestId: randomUUID() })).statusCode, 409);
    });
    await t.test('confirmed paper needs no second ticket and is safe to acknowledge twice', async () => {
      const original = await uncertain();
      const action = { action: 'printed', requestId: randomUUID() };
      assert.equal((await post(`jobs/${original.id}/resolve`, action)).statusCode, 200);
      assert.equal((await post(`jobs/${original.id}/resolve`, action)).json().replayed, true);
      assert.equal(await db.localPrintIntent.count({ where: { reprintOfId: original.id } }), 0);
    });
    await t.test('a colliding request ID never resolves a second ticket without its reprint', async () => {
      const originals = await Promise.all([uncertain(), uncertain()]);
      const requestId = randomUUID();
      const responses = await Promise.all(originals.map(job => post(`jobs/${job.id}/resolve`, { action: 'reprint', requestId })));
      assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);
      assert.equal(await db.localPrintIntent.count({ where: { id: { in: originals.map(job => job.id) }, resolvedAt: { not: null } } }), 1);
      assert.equal(await db.localPrintIntent.count({ where: { reprintOfId: { in: originals.map(job => job.id) } } }), 1);
    });
    await t.test('active, queued, and foreign tickets cannot be reprinted through review controls', async () => {
      for (const [record, code] of [
        [await uncertain({ startedAt: new Date() }), 409],
        [await uncertain({ state: 'queued', startedAt: null }), 409],
        [await uncertain({ storeId: foreign.id, topic: 'ops-other-test/orders/placed/printer_1' }), 404],
      ]) assert.equal((await post(`jobs/${record.id}/resolve`, { action: 'reprint', requestId: randomUUID() })).statusCode, code);
    });
  } finally {
    stopLocalPrinting();
    await app.close();
    await db.profile.deleteMany({ where: { id: { in: profiles.map(profile => profile.id) } } });
    await db.store.deleteMany({ where: { id: { in: [store.id, foreign.id] } } });
    await db.$disconnect();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
