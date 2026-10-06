import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';

// This test is permitted only against the runner's disposable loopback database.
const url = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || new URL(url).pathname !== '/garsone_reliability_test') {
  throw new Error('Use the disposable local database from tests/run-order-reliability.mjs');
}
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: url, DIRECT_URL: url,
  JWT_SECRET: 'qr-observation-fixture-only-secret', MQTT_DISABLED: 'true' });
const { db } = await import('../dist/db/index.js');
const { localQrConfigRoutes } = await import('../dist/routes/localQrConfig.js');
const { nodeAgentRoutes } = await import('../dist/routes/nodeAgents.js');
const { qrTileRoutes } = await import('../dist/routes/qrTiles.js');
const { signToken } = await import('../dist/lib/jwt.js');
const { qrAssignmentsSchema } = await import('../dist/lib/nodeQrAssignments.js');
const { importNodeQrSnapshot } = await import('../dist/lib/nodeQrConfig.js');
const codeA = 'GT-AAAA-1111', codeB = 'GT-BBBB-2222', codeC = 'GT-CCCC-3333';

test('Pi assignment observations preserve local ownership and reach only the associated online venue', async t => {
  const local = await db.store.create({ data: { slug: 'qr-local-fixture', name: 'Local QR fixture' } });
  const online = await db.store.create({ data: { slug: 'qr-online-fixture', name: 'Online QR fixture' } });
  const foreign = await db.store.create({ data: { slug: 'qr-foreign-fixture', name: 'Foreign QR fixture' } });
  const localApp = Fastify(), onlineApp = Fastify();
  const secret = 'fixture-local-qr-secret-at-least-thirty-two-characters';
  try {
    await localApp.register(localQrConfigRoutes);
    await localApp.register(qrTileRoutes);
    await onlineApp.register(nodeAgentRoutes);
    await onlineApp.register(qrTileRoutes);
    process.env.LOCAL_ONLY = 'true';
    process.env.STORE_SLUG = local.slug;
    process.env.LOCAL_QR_SYNC_SECRET = secret;
    const localTable = await db.table.create({ data: { storeId: local.id, label: 'Demo' } });
    const movedTable = await db.table.create({ data: { storeId: local.id, label: 'Terrace' } });
    const sourceTableId = randomUUID();
    const snapshot = { schemaVersion: 1, sourceStoreId: online.id, storeSlug: local.slug,
      tables: [{ id: sourceTableId, label: 'Demo', isActive: true }],
      tiles: [{ publicCode: codeA, label: null, tableId: sourceTableId, isActive: true }] };
    const sync = async value => {
      const response = await localApp.inject({ method: 'POST', url: '/internal/qr-config', headers: { 'x-local-qr-secret': secret }, payload: value });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    await t.test('new cloud codes initialize local assignments; unchanged imports report local moves and unassignments', async () => {
      const first = await sync(snapshot);
      assert.equal(first.assignments.sourceStoreId, online.id);
      assert.equal(first.assignments.tiles[0].tableId, localTable.id, 'Initialization reuses the local table with the matching label');
      await db.qRTile.update({ where: { publicCode: codeA }, data: { tableId: movedTable.id } });
      const moved = await sync(snapshot);
      assert.equal(moved.unchanged, true);
      assert.equal(moved.assignments.tiles[0].tableId, movedTable.id);
      assert.equal(moved.assignments.tiles[0].tableLabel, 'Terrace');
      await db.qRTile.update({ where: { publicCode: codeA }, data: { tableId: null } });
      assert.equal((await sync(snapshot)).assignments.tiles[0].tableId, null);
    });
    await t.test('inventory changes retain local nulls, moved assignments and renamed/inactive tables', async () => {
      await db.table.update({ where: { id: localTable.id }, data: { label: 'Renamed locally', isActive: false } });
      const added = { ...snapshot, tiles: [...snapshot.tiles, { publicCode: codeB, label: 'New inventory', tableId: sourceTableId, isActive: true }] };
      const report = await sync(added);
      assert.equal(report.assignments.tiles.find(tile => tile.publicCode === codeA).tableId, null, 'A local unassignment remains authoritative');
      assert.equal(report.assignments.tiles.find(tile => tile.publicCode === codeB).tableId, localTable.id, 'The saved source-to-local mapping initializes only the new code');
      const preserved = await db.table.findUniqueOrThrow({ where: { id: localTable.id } });
      assert.equal(preserved.label, 'Renamed locally');
      assert.equal(preserved.isActive, false);
      await db.qRTile.update({ where: { publicCode: codeA }, data: { tableId: movedTable.id } });
      const changed = await sync({ ...added, tiles: added.tiles.map(tile => ({ ...tile, label: 'Cloud inventory label changed' })) });
      assert.equal(changed.assignments.tiles.find(tile => tile.publicCode === codeA).tableId, movedTable.id);
      const occupied = await sync({ ...added, tiles: [...added.tiles, { publicCode: codeC, tableId: sourceTableId, label: null, isActive: true }] });
      assert.equal(occupied.assignments.tiles.find(tile => tile.publicCode === codeC).tableId, null, 'New inventory never steals an occupied local table');
      const removed = await sync({ ...snapshot, tiles: [] });
      assert.deepEqual(removed.assignments.tiles, []);
      assert.equal((await db.qRTile.findUniqueOrThrow({ where: { publicCode: codeA } })).isActive, false, 'Cloud removal deactivates previously provisioned codes');
      await sync({ ...snapshot, tiles: snapshot.tiles.map(tile => ({ ...tile, tableId: null })) });
      assert.equal((await db.qRTile.findUniqueOrThrow({ where: { publicCode: codeA } })).tableId, movedTable.id);
    });
    await t.test('an assignment made after the inventory read is never written back by sync', async () => {
      await db.qRTile.update({ where: { publicCode: codeB }, data: { tableId: null } });
      const originalTransaction = db.$transaction.bind(db);
      let observed = false;
      db.$transaction = (callback, options) => originalTransaction(async tx => {
        const tileDelegate = new Proxy(tx.qRTile, { get(target, key) {
          if (key === 'upsert') return async args => {
            assert.equal(Object.hasOwn(args.update, 'tableId'), false, 'Inventory updates must omit the assignment column');
            observed = true;
            await tx.qRTile.update({ where: { publicCode: codeA }, data: { tableId: localTable.id } });
            return target.upsert(args);
          };
          return Reflect.get(target, key);
        } });
        return callback(new Proxy(tx, { get(target, key) { return key === 'qRTile' ? tileDelegate : Reflect.get(target, key); } }));
      }, options);
      try {
        const response = await importNodeQrSnapshot({ ...snapshot, tiles: snapshot.tiles.map(tile => ({ ...tile, label: 'Concurrent edit fixture' })) });
        assert.equal(observed, true);
        assert.equal(response.assignments.tiles[0].tableId, localTable.id);
      } finally { db.$transaction = originalTransaction; }
    });
    await t.test('local Manager always reads its authoritative tables even with imported Pi deployment metadata', async () => {
      await db.venueDeployment.create({ data: { storeId: local.id, target: 'PI', localUrl: 'http://192.0.2.25:8080' } });
      const manager = await db.profile.create({ data: { storeId: local.id, role: 'MANAGER', email: 'qr-local-manager@fixture.test', passwordHash: 'fixture-only' } });
      const headers = { authorization: `Bearer ${signToken({ userId: manager.id, email: manager.email, role: 'manager', storeId: local.id, storeSlug: local.slug })}` };
      const response = await localApp.inject({ url: `/admin/stores/${local.id}/qr-tiles`, headers });
      assert.equal(response.statusCode, 200, response.body);
      const tile = response.json().tiles.find(tile => tile.publicCode === codeA);
      assert.equal(tile.tableId, localTable.id);
      assert.equal(tile.tableLabel, 'Renamed locally');
      assert.equal(tile.assignmentSource, 'ONLINE', 'The direct-database branch must be used locally');
    });

    // Local and hosted databases normally share the slug but are independent.
    // This disposable database uses distinct slugs and transfers only the report.
    const localReport = (await sync(snapshot)).assignments;
    await db.qRTile.deleteMany({ where: { storeId: local.id } });
    await db.qRTile.createMany({ data: [codeA, codeB].map(publicCode => ({ storeId: online.id, publicCode })) });
    await db.qRTile.create({ data: { storeId: foreign.id, publicCode: codeC } });
    const nodeToken = 'fixture-node-only-token', otherToken = 'fixture-other-node-token';
    const node = await db.nodeAgent.create({ data: { storeId: online.id, slug: 'main', displayName: 'Main Pi',
      tokenHash: createHash('sha256').update(nodeToken).digest('hex'), configJson: { mqttPass: 'fixture-never-expose', preserved: 'yes' } } });
    const other = await db.nodeAgent.create({ data: { storeId: online.id, slug: 'other', displayName: 'Other Pi',
      tokenHash: createHash('sha256').update(otherToken).digest('hex') } });
    await db.venueDeployment.create({ data: { storeId: online.id, nodeId: node.id, target: 'PI', localUrl: 'http://192.0.2.25:8080' } });
    const architect = await db.profile.create({ data: { storeId: online.id, role: 'ARCHITECT', email: 'qr-architect@fixture.test', passwordHash: 'fixture-only' } });
    const headers = { authorization: `Bearer ${signToken({ userId: architect.id, email: architect.email, role: 'architect', storeId: online.id, storeSlug: online.slug })}` };
    process.env.LOCAL_ONLY = 'false';
    const report = { ...localReport, storeSlug: online.slug };
    const status = (qrAssignments, token = nodeToken, extra = {}) => onlineApp.inject({ method: 'POST', url: '/node-agent/status',
      headers: { authorization: `Bearer ${token}` }, payload: { status: 'ONLINE', meta: { ...(qrAssignments === undefined ? {} : { qrAssignments }), ...extra } } });
    const tiles = async () => {
      const response = await onlineApp.inject({ url: `/admin/stores/${online.id}/qr-tiles`, headers });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.body.includes('fixture-never-expose'), false);
      return response.json().tiles;
    };
    await t.test('Architect reads explicit pending then last-reported local assignments without cloud operational writes', async () => {
      assert((await tiles()).every(tile => tile.assignmentSource === 'PI_PENDING' && tile.tableId === null));
      assert.equal((await status(report)).statusCode, 200);
      const view = (await tiles()).find(tile => tile.publicCode === codeA);
      assert.equal(view.assignmentSource, 'PI');
      assert.equal(view.tableId, localTable.id);
      assert.equal(view.tableLabel, 'Renamed locally');
      assert(Number.isFinite(Date.parse(view.assignmentReportedAt)));
      assert.equal(view.publicUrl, `http://192.0.2.25:8080/q/${codeA}`);
      assert.equal((await tiles()).find(tile => tile.publicCode === codeB).assignmentSource, 'PI_PENDING');
      assert.equal((await db.qRTile.findUniqueOrThrow({ where: { publicCode: codeA } })).tableId, null, 'Observed local IDs must never become hosted foreign keys');
      assert.equal(await db.table.count({ where: { storeId: online.id } }), 0);
      const desired = await onlineApp.inject({ url: '/node-agent/qr-config', headers: { authorization: `Bearer ${nodeToken}` } });
      assert.equal(desired.json().tiles.find(tile => tile.publicCode === codeA).tableId, null, 'Reported assignments never feed back into desired configuration');
    });
    await t.test('invalid, foreign and non-associated reports retain the last observation and healthy heartbeat', async () => {
      const before = (await db.nodeAgent.findUniqueOrThrow({ where: { id: node.id } })).configJson.localQrReport;
      const badReports = [{ ...report, sourceStoreId: foreign.id }, { ...report, storeSlug: foreign.slug },
        { ...report, tiles: [...report.tiles, { ...report.tiles[0], publicCode: codeC }] },
        { ...report, tiles: [report.tiles[0], report.tiles[0]] }, { ...report, profiles: [] }];
      for (const value of badReports) assert.equal((await status(value)).statusCode, 200);
      assert.equal((await status(report, otherToken)).statusCode, 200);
      assert.equal((await status(undefined)).statusCode, 200, 'Failed/old node sync can omit the observation');
      assert.deepEqual((await db.nodeAgent.findUniqueOrThrow({ where: { id: node.id } })).configJson.localQrReport, before);
      assert.equal((await db.nodeAgent.findUniqueOrThrow({ where: { id: other.id } })).configJson?.localQrReport, undefined);
      assert.equal((await status(report, 'invalid-token')).statusCode, 401);
      assert.equal(qrAssignmentsSchema.safeParse({ ...report, tiles: Array(5001).fill(report.tiles[0]) }).success, false);
      const concurrent = await Promise.all([status(report), status(undefined, nodeToken, { type: 'config_ack', applied: true })]);
      for (const response of concurrent) assert.equal(response.statusCode, 200, response.body);
      const config = (await db.nodeAgent.findUniqueOrThrow({ where: { id: node.id } })).configJson;
      assert.equal(config.preserved, 'yes');
      assert.equal(config.localQrReport.tiles[0].tableId, localTable.id);
      assert.equal(config.lastConfigAck.applied, true);
    });
    await t.test('local unassignment, missing report codes, node replacement and online mode have distinct meanings', async () => {
      assert.equal((await status({ ...report, tiles: report.tiles.map(tile => ({ ...tile, tableId: null, tableLabel: null })) })).statusCode, 200);
      const unassigned = (await tiles()).find(tile => tile.publicCode === codeA);
      assert.equal(unassigned.assignmentSource, 'PI');
      assert.equal(unassigned.tableId, null);
      await db.venueDeployment.update({ where: { storeId: online.id }, data: { nodeId: other.id } });
      assert((await tiles()).every(tile => tile.assignmentSource === 'PI_PENDING'));
      await db.venueDeployment.update({ where: { storeId: online.id }, data: { target: 'ONLINE' } });
      assert((await tiles()).every(tile => tile.assignmentSource === 'ONLINE' && tile.tableId === null));
    });
  } finally {
    await localApp.close(); await onlineApp.close();
    await db.store.deleteMany({ where: { id: { in: [local.id, online.id, foreign.id] } } });
    await db.$disconnect();
    delete process.env.LOCAL_ONLY; delete process.env.LOCAL_QR_SYNC_SECRET; delete process.env.STORE_SLUG;
  }
});
