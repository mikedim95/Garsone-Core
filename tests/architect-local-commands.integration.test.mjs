import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';

const url = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || new URL(url).pathname !== '/garsone_reliability_test') throw Error('Disposable local database required');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'architect-command-test-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: url, DIRECT_URL: url,
  JWT_SECRET: 'architect-fixture-secret-never-used-in-production', MQTT_DISABLED: 'true', LOCAL_ONLY: 'true',
  LOCAL_CONTROL_SECRET: 'architect-local-control-fixture-never-used-in-production', STORE_SLUG: 'command-local', LOCAL_PRINTING_ENABLED: 'true', LOCAL_PRINT_SPOOL: path.join(temp, 'spool') });
const { db } = await import('../dist/db/index.js');
const { localArchitectCommandRoutes } = await import('../dist/routes/localArchitectCommands.js');
const { localOperationsRoutes } = await import('../dist/routes/localOperations.js');
const { qrTileRoutes } = await import('../dist/routes/qrTiles.js');
const { nodeAgentRoutes } = await import('../dist/routes/nodeAgents.js');
const { signToken } = await import('../dist/lib/jwt.js');
const commands = await import('../dist/lib/architectCommands.js');
const { ensureArchitectCommandSchema } = await import('../dist/db/ensureArchitectCommandSchema.js');
const { startLocalPrinting, stopLocalPrinting } = await import('../dist/lib/localPrinting.js');

test('Architect commands reach only the selected Pi with bounded delegated permissions and durable deduplication', async t => {
  await ensureArchitectCommandSchema();
  const sourceId = randomUUID(), nodeId = randomUUID(), actorId = randomUUID();
  const local = await db.store.create({ data: { slug: 'command-local', name: 'Local fixture', settingsJson: { nodeQrSync: { sourceStoreId: sourceId }, printers: ['printer_1'], orderingMode: 'qr' } } });
  const foreign = await db.store.create({ data: { slug: 'command-foreign', name: 'Foreign fixture' } });
  const localApp = Fastify(), cloudApp = Fastify();
  process.env.LOCAL_PRINTER_ROUTES_FILE = path.join(temp, 'routes.json');
  process.env.LOCAL_UPLOAD_DIR = temp;
  await fs.writeFile(process.env.LOCAL_PRINTER_ROUTES_FILE, JSON.stringify({ 'command-local/orders/placed/printer_1': { device: '/dev/rfcomm999' } }));
  await startLocalPrinting(db);
  stopLocalPrinting();
  await localApp.register(qrTileRoutes);
  await localApp.register(localOperationsRoutes);
  await localApp.register(localArchitectCommandRoutes);
  await cloudApp.register(nodeAgentRoutes);
  await cloudApp.register(qrTileRoutes);
  const base = operation => ({ type: 'LOCAL_ARCHITECT_COMMAND', requestId: randomUUID(), nodeId, storeId: sourceId,
    storeSlug: local.slug, actorId, role: 'architect', operation, payload: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const send = (body, headers = { 'x-local-control-secret': process.env.LOCAL_CONTROL_SECRET }) => localApp.inject({ method: 'POST', url: '/internal/architect/commands', headers, payload: body });
  const profiles = await Promise.all([['MANAGER', local], ['ARCHITECT', local], ['MANAGER', foreign]].map(([role, store], index) => db.profile.create({ data: {
    storeId: store.id, email: `command-${index}@fixture.test`, role, passwordHash: 'unused' } })));
  const auth = i => ({ authorization: `Bearer ${signToken({ userId: profiles[i].id, email: profiles[i].email, role: profiles[i].role.toLowerCase(), storeId: profiles[i].storeId, storeSlug: i === 2 ? foreign.slug : local.slug })}` });
  try {
    await t.test('secret, role, expiry and exact cloud/local venue binding are required; local Architect login remains forbidden', async () => {
      assert.equal((await send(base('snapshot'), {})).statusCode, 401);
      assert.equal((await send({ ...base('snapshot'), role: 'manager' })).statusCode, 400);
      assert.equal((await send({ ...base('snapshot'), operation: 'sql.execute' })).statusCode, 400);
      assert.equal((await send({ ...base('snapshot'), expiresAt: new Date(Date.now() - 100).toISOString() })).statusCode, 410);
      assert.equal((await send({ ...base('snapshot'), storeId: foreign.id })).statusCode, 409);
      assert.equal((await send({ ...base('snapshot'), storeSlug: foreign.slug })).statusCode, 409);
      assert.equal((await localApp.inject({ url: `/admin/stores/${local.id}/users`, headers: auth(1) })).statusCode, 401);
      assert.equal((await localApp.inject({ url: `/admin/stores/${local.id}/users`, headers: auth(0) })).statusCode, 403);
      assert.equal((await localApp.inject({ url: `/admin/stores/${local.id}/users`, headers: { 'x-local-control-secret': process.env.LOCAL_CONTROL_SECRET, 'x-delegated-role': 'architect' } })).statusCode, 401);
      const snapshot = await send(base('snapshot'));
      assert.equal(snapshot.statusCode, 200, snapshot.body);
      assert.equal(snapshot.json().result.store.id, local.id);
      assert.equal(snapshot.json().result.counts.usersCount, 1);
    });
    let createdId;
    await t.test('remote user CRUD changes the local DB and never stores password payloads', async () => {
      const command = { ...base('users.create'), payload: { email: 'remote-created@fixture.test', password: 'secret-only-in-transit', displayName: 'Local cook', role: 'COOK' } };
      const first = await send(command);
      assert.equal(first.json().statusCode, 201, first.body);
      createdId = first.json().result.user.id;
      assert.equal(first.json().result.user.storeId, local.id);
      assert.equal((await send(command)).json().result.user.id, createdId);
      assert.equal(await db.profile.count({ where: { email: command.payload.email } }), 1);
      const saved = await commands.commandRow(command.requestId);
      assert.ok(!JSON.stringify(saved).includes('secret-only-in-transit'));
      assert.ok(!JSON.stringify(saved).includes('password'));
      assert.equal((await send({ ...command, payload: { ...command.payload, password: 'different-secret' } })).statusCode, 409);
      const update = await send({ ...base('users.update'), payload: { userId: createdId, displayName: 'Changed locally', role: 'HYBRID' } });
      assert.equal(update.json().statusCode, 200, update.body);
      assert.equal((await db.profile.findUnique({ where: { id: createdId } })).role, 'HYBRID');
      assert.equal((await send({ ...base('users.update'), payload: { userId: profiles[2].id, displayName: 'Forbidden' } })).json().statusCode, 404);
      assert.equal((await send({ ...base('users.update'), payload: { userId: profiles[1].id, password: 'Forbidden' } })).json().statusCode, 404);
      assert.equal((await send({ ...base('users.create'), payload: { ...command.payload, role: 'ARCHITECT' } })).json().statusCode, 400);
      const listed = await send(base('users.list'));
      assert.equal(listed.json().result.users.some(user => user.id === createdId), true);
    });
    await t.test('unfinished durable mutations are never repeated after restart or transport replay', async () => {
      const command = { ...base('users.delete'), payload: { userId: createdId } };
      await commands.reserveCommand(command, commands.commandFingerprint(command, process.env.LOCAL_CONTROL_SECRET));
      const response = await send(command);
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, 'COMMAND_OUTCOME_UNCERTAIN');
      assert.ok(await db.profile.findUnique({ where: { id: createdId } }));
      const deleted = await send({ ...command, requestId: randomUUID() });
      assert.equal(deleted.json().statusCode, 200, deleted.body);
      assert.equal(await db.profile.findUnique({ where: { id: createdId } }), null);
    });
    await t.test('settings use existing validation, and print tests enter the durable direct queue exactly once', async () => {
      assert.equal((await send({ ...base('settings.orderingMode'), payload: { orderingMode: 'hybrid' } })).json().statusCode, 200);
      assert.equal((await db.store.findUnique({ where: { id: local.id } })).settingsJson.orderingMode, 'hybrid');
      const command = { ...base('printing.test'), payload: { printerId: 'rfcomm999' } };
      const test = await send(command);
      assert.equal(test.json().statusCode, 202, test.body);
      assert.equal(test.json().result.jobId, command.requestId);
      assert.equal((await send(command)).json().result.jobId, command.requestId);
      assert.equal(await db.localPrintIntent.count({ where: { id: command.requestId } }), 1);
      const job = await db.localPrintIntent.findUnique({ where: { id: command.requestId } });
      assert.equal(job.payload.opsActor, `architect:${actorId}`);
      const status = await send(base('printing.status'));
      assert.equal(status.json().statusCode, 200, status.body);
      assert.equal(status.json().result.system.database.ok, true);
      assert.equal(status.json().result.printing.printers[0].id, 'rfcomm999');
    });
    await t.test('history requires confirmation, records remote actor without a local Architect FK, and preserves dining history', async () => {
      assert.equal((await send({ ...base('history.purge'), payload: { confirmation: 'wrong' } })).json().statusCode, 400);
      const result = await send({ ...base('history.purge'), payload: { confirmation: `DELETE HISTORY ${local.slug}` } });
      assert.equal(result.json().statusCode, 200, result.body);
      const audit = await db.auditLog.findFirst({ where: { storeId: local.id, action: 'store.history_purged' } });
      assert.equal(audit.actorProfileId, null);
      assert.equal(audit.metaJson.remoteArchitectId, actorId);
      const table = await db.table.create({ data: { storeId: local.id, label: 'Financial history' } });
      await db.diningVisit.create({ data: { storeId: local.id, tableId: table.id, status: 'OPEN' } });
      const blocked = await send({ ...base('history.purge'), payload: { confirmation: `DELETE HISTORY ${local.slug}` } });
      assert.equal(blocked.json().statusCode, 409, blocked.body);
    });
    await t.test('cloud PI operations never silently mutate cloud when broker or node is unavailable', async () => {
      process.env.LOCAL_ONLY = 'false';
      const node = await db.nodeAgent.create({ data: { storeId: local.id, slug: 'main', displayName: 'Command node', tokenHash: createHash('sha256').update('fixture-node-token').digest('hex'), lastSeenAt: new Date(), configJson: { bootstrapNodeKey: 'fixture-key', mqttConfigToken: 'fixture-config-token' } } });
      await db.venueDeployment.create({ data: { storeId: local.id, nodeId: node.id, target: 'PI' } });
      const before = await db.profile.count({ where: { storeId: local.id } });
      const response = await cloudApp.inject({ method: 'POST', url: `/admin/stores/${local.id}/users`, headers: auth(1), payload: { email: 'must-not-exist@fixture.test', password: 'secret-irrelevant', displayName: 'No fallback', role: 'WAITER' } });
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(await db.profile.count({ where: { storeId: local.id } }), before);
      assert.equal((await cloudApp.inject({ method: 'PATCH', url: `/admin/stores/${local.id}/ordering-mode`, headers: auth(0), payload: { orderingMode: 'qr' } })).statusCode, 403);
      const anonymousCallback = await cloudApp.inject({ method: 'POST', url: '/node-agent/local-command-result', payload: {} });
      assert.equal(anonymousCallback.statusCode, 401);
      const requestId = randomUUID();
      let dispatched;
      const outcome = await commands.relayArchitectCommand(local.id, profiles[1].id, 'snapshot', {}, requestId, async command => {
        dispatched = command;
        const callback = await cloudApp.inject({ method: 'POST', url: '/node-agent/local-command-result', headers: { authorization: 'Bearer fixture-node-token' }, payload: {
          requestId: command.requestId, nodeId: command.nodeId, storeId: command.storeId, storeSlug: command.storeSlug, statusCode: 200, result: { source: 'PI', checkedAt: new Date().toISOString() } } });
        assert.equal(callback.statusCode, 200, callback.body);
      }, 200);
      assert.equal(outcome.result.source, 'PI');
      assert.equal(dispatched.role, 'architect');
      assert.equal((await commands.relayArchitectCommand(local.id, profiles[1].id, 'snapshot', {}, requestId, async () => assert.fail('Completed request must not dispatch again'), 1)).statusCode, 200);
      await assert.rejects(commands.relayArchitectCommand(local.id, profiles[1].id, 'snapshot', {}, randomUUID(), async () => {}, 1), error => error.code === 'LOCAL_COMMAND_TIMEOUT');
      const lostPublishId = randomUUID();
      await assert.rejects(commands.relayArchitectCommand(local.id, profiles[1].id, 'snapshot', {}, lostPublishId,
        async () => { throw new commands.LocalCommandError(503, 'LOCAL_PI_UNAVAILABLE'); }, 1));
      const recoveredPublish = await commands.relayArchitectCommand(local.id, profiles[1].id, 'snapshot', {}, lostPublishId, async command => {
        await commands.acceptArchitectResult({ ...node, store: local }, { requestId: command.requestId, nodeId: node.id,
          storeId: local.id, storeSlug: local.slug, statusCode: 200, result: { recovered: true } });
      }, 100);
      assert.equal(recoveredPublish.result.recovered, true);

      // Use the actual direct-print handler as the remote business mutation.
      // The first callback is lost after commit; same-ID retry must recover its
      // durable result while retaining exactly one printer intent in the DB.
      const lostCallbackId = randomUUID();
      const printPayload = { printerId: 'rfcomm999', requestId: lostCallbackId };
      let deliveries = 0;
      const printTransport = async command => {
        process.env.LOCAL_ONLY = 'true';
        let printed;
        try { printed = await localApp.inject({ method: 'POST', url: '/manager/local-operations/printers/test', headers: auth(0), payload: printPayload }); }
        finally { process.env.LOCAL_ONLY = 'false'; }
        assert.ok([200, 202].includes(printed.statusCode), printed.body);
        deliveries += 1;
        if (deliveries === 1) return; // Simulate lost authenticated callback.
        assert.equal(printed.json().replayed, true);
        await commands.acceptArchitectResult({ ...node, store: local }, { requestId: command.requestId, nodeId: node.id,
          storeId: local.id, storeSlug: local.slug, statusCode: printed.statusCode, result: printed.json() });
      };
      await assert.rejects(commands.relayArchitectCommand(local.id, profiles[1].id, 'printing.test', printPayload, lostCallbackId, printTransport, 1), error => error.code === 'LOCAL_COMMAND_TIMEOUT');
      const recoveredPrint = await commands.relayArchitectCommand(local.id, profiles[1].id, 'printing.test', printPayload, lostCallbackId, printTransport, 100);
      assert.equal(recoveredPrint.result.jobId, lostCallbackId);
      assert.equal(deliveries, 2);
      assert.equal(await db.localPrintIntent.count({ where: { id: lostCallbackId } }), 1);
      const lostLocalResponseId = randomUUID();
      const localTimeoutPayload = { printerId: 'rfcomm999', requestId: lostLocalResponseId };
      let localAttempts = 0;
      const localTimeoutTransport = async command => {
        process.env.LOCAL_ONLY = 'true';
        let printed;
        try { printed = await localApp.inject({ method: 'POST', url: '/manager/local-operations/printers/test', headers: auth(0), payload: localTimeoutPayload }); }
        finally { process.env.LOCAL_ONLY = 'false'; }
        localAttempts += 1;
        const first = localAttempts === 1;
        const ack = await commands.acceptArchitectResult({ ...node, store: local }, { requestId: command.requestId, nodeId: node.id,
          storeId: local.id, storeSlug: local.slug, statusCode: first ? 502 : printed.statusCode,
          result: first ? { error: 'LOCAL_COMMAND_UNAVAILABLE' } : printed.json() });
        if (first) {
          assert.equal(ack.retryable, true, 'A transport timeout cannot finalize a potentially committed mutation');
          assert.equal((await commands.commandRow(command.requestId)).state, 'pending');
        } else assert.equal(printed.json().replayed, true);
      };
      await assert.rejects(commands.relayArchitectCommand(local.id, profiles[1].id, 'printing.test', localTimeoutPayload, lostLocalResponseId, localTimeoutTransport, 1), error => error.code === 'LOCAL_COMMAND_TIMEOUT');
      const recoveredLocalTimeout = await commands.relayArchitectCommand(local.id, profiles[1].id, 'printing.test', localTimeoutPayload, lostLocalResponseId, localTimeoutTransport, 100);
      assert.equal(recoveredLocalTimeout.result.jobId, lostLocalResponseId);
      assert.equal(localAttempts, 2);
      assert.equal(await db.localPrintIntent.count({ where: { id: lostLocalResponseId } }), 1);
      const wrongNode = await cloudApp.inject({ method: 'POST', url: '/node-agent/local-command-result', headers: { authorization: 'Bearer fixture-node-token' }, payload: { requestId, nodeId: randomUUID(), storeId: local.id, storeSlug: local.slug, statusCode: 200, result: {} } });
      assert.equal(wrongNode.statusCode, 409);
      const pending = { ...base('snapshot'), requestId: randomUUID(), storeId: local.id, nodeId: node.id };
      await commands.reserveCommand(pending, commands.commandFingerprint(pending, process.env.JWT_SECRET));
      const transaction = db.$transaction.bind(db);
      // Change association after the initial read, before the result transaction.
      db.$transaction = async (...args) => {
        await db.venueDeployment.update({ where: { storeId: local.id }, data: { nodeId: null } });
        return transaction(...args);
      };
      try {
        await assert.rejects(commands.acceptArchitectResult({ ...node, store: local }, { requestId: pending.requestId,
          nodeId: node.id, storeId: local.id, storeSlug: local.slug, statusCode: 200, result: { wrong: 'must not commit' } }), error => error.code === 'COMMAND_SCOPE_MISMATCH');
        assert.equal((await commands.commandRow(pending.requestId)).state, 'pending');
      } finally {
        db.$transaction = transaction;
        await db.venueDeployment.update({ where: { storeId: local.id }, data: { nodeId: node.id } });
      }
      await db.venueDeployment.update({ where: { storeId: local.id }, data: { target: 'ONLINE' } });
      const staleCallback = await cloudApp.inject({ method: 'POST', url: '/node-agent/local-command-result', headers: { authorization: 'Bearer fixture-node-token' }, payload: { requestId, nodeId: node.id, storeId: local.id, storeSlug: local.slug, statusCode: 200, result: {} } });
      assert.equal(staleCallback.statusCode, 409);
      const cloud = await cloudApp.inject({ method: 'PATCH', url: `/admin/stores/${local.id}/ordering-mode`, headers: auth(1), payload: { orderingMode: 'qr' } });
      assert.equal(cloud.statusCode, 200, cloud.body);
    });
  } finally {
    await localApp.close(); await cloudApp.close();
    await db.$executeRaw`DELETE FROM architect_commands WHERE "storeId" IN (${sourceId}::uuid, ${local.id}::uuid)`;
    await db.diningVisit.deleteMany({ where: { storeId: local.id } });
    await db.auditLog.deleteMany({ where: { storeId: local.id } });
    await db.store.deleteMany({ where: { id: { in: [local.id, foreign.id] } } });
    await db.$disconnect(); await fs.rm(temp, { recursive: true, force: true });
  }
});
