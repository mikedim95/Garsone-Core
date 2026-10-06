import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';

const url = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || new URL(url).pathname !== '/garsone_reliability_test') {
  throw new Error('Use the disposable local database from tests/run-order-reliability.mjs');
}
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: url, DIRECT_URL: url,
  JWT_SECRET: 'local-stack-claim-fixture-only-secret', MQTT_DISABLED: 'true', LOCAL_ONLY: 'false',
  EMQX_URL: 'mqtts://fixture.invalid:8883', EMQX_USERNAME: 'fixture', EMQX_PASSWORD: 'fixture-only' });
const { db } = await import('../dist/db/index.js');
const { nodeAgentRoutes, buildAgentConfig } = await import('../dist/routes/nodeAgents.js');
const { qrTileRoutes } = await import('../dist/routes/qrTiles.js');
const { signToken } = await import('../dist/lib/jwt.js');

test('Architect claim adopts existing full-local stacks without requesting deployment or importing venue data', async t => {
  const stores = [], pendingIds = [];
  const app = Fastify();
  const makeStore = async (suffix, extra = {}) => {
    const store = await db.store.create({ data: { slug: `claim-fixture-${suffix}`, name: `Claim fixture ${suffix}`, ...extra } });
    stores.push(store.id);
    return store;
  };
  try {
    await app.register(nodeAgentRoutes);
    await app.register(qrTileRoutes);
    const adminStore = await makeStore('admin');
    const architect = await db.profile.create({ data: { storeId: adminStore.id, role: 'ARCHITECT', email: 'claim-architect@fixture.test', passwordHash: 'fixture-only' } });
    const headers = { authorization: `Bearer ${signToken({ userId: architect.id, email: architect.email, role: 'architect', storeId: adminStore.id, storeSlug: adminStore.slug })}` };
    const metadata = store => ({ deploymentMode: 'COMPOSE', localStack: { schemaVersion: 1, storeSlug: store.slug,
      localUrl: 'http://192.0.2.77:8085', frontendPort: 8085, corePort: 8790 } });
    const register = async bootstrap => {
      const response = await app.inject({ method: 'POST', url: '/node-agent/bootstrap/register', payload: {
        nodeKey: `fixture-${randomUUID()}`, pairingSecret: `fixture-pairing-${randomUUID()}`, localHostname: `pi-${randomUUID().slice(0, 8)}`, bootstrap,
      } });
      assert.equal(response.statusCode, 200, response.body);
      const pendingId = response.json().pendingNode.id;
      pendingIds.push(pendingId);
      return pendingId;
    };
    const claim = (id, store) => app.inject({ method: 'POST', url: `/admin/pending-nodes/${id}/claim`, headers, payload: { storeId: store.id } });
    const installTestToken = async nodeId => {
      const token = `fixture-token-${randomUUID()}`;
      await db.nodeAgent.update({ where: { id: nodeId }, data: { tokenHash: createHash('sha256').update(token).digest('hex') } });
      return { authorization: `Bearer ${token}` };
    };
    for (const preRead of [false, true]) {
      await t.test(`fresh full stack is adopted${preRead ? ' after viewing the default deployment tab' : ''}`, async () => {
        const store = await makeStore(preRead ? 'read-first' : 'new');
        if (preRead) assert.equal((await app.inject({ url: `/admin/stores/${store.id}/deployment`, headers })).statusCode, 200);
        const id = await register(metadata(store));
        const response = await claim(id, store);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().localDeployment.status, 'adopted');
        assert.equal(response.json().token, null, 'The one-time node token is delivered over MQTT, never returned to a browser');
        const node = await db.nodeAgent.findUniqueOrThrow({ where: { id: response.json().node.id } });
        const deployment = await db.venueDeployment.findUniqueOrThrow({ where: { storeId: store.id } });
        assert.equal(deployment.nodeId, node.id);
        assert.equal(deployment.target, 'PI');
        assert.equal(deployment.desiredState, 'RUNNING');
        assert.equal(deployment.status, 'PENDING', 'Claim cannot assert service health before the Pi reports it');
        assert.equal(deployment.autoUpdate, false);
        assert.equal(deployment.localUrl, 'http://192.0.2.77:8085');
        assert.equal(deployment.apiUrl, 'http://192.0.2.77:8085/api');
        assert.equal(deployment.frontendPort, 8085);
        assert.equal(deployment.corePort, 8790);
        assert.equal(deployment.version, 0);
        assert.equal(deployment.dataSyncVersion, 0);
        assert.equal(deployment.appliedDataSyncVersion, 0);
        assert.equal(deployment.requestedAt, null);
        assert.equal(await db.table.count({ where: { storeId: store.id } }), 0);
        const agentConfig = await buildAgentConfig(node, store);
        assert.equal(agentConfig.deployment.target, 'PI');
        assert.equal(agentConfig.deployment.dataSyncVersion, 0);
        assert.deepEqual(node.configJson.localStack, metadata(store).localStack);
        const events = await db.venueDeploymentEvent.findMany({ where: { storeId: store.id } });
        assert.deepEqual(events.map(event => event.eventType), ['ADOPT_LOCAL_STACK']);
        assert.equal((await claim(id, store)).statusCode, 409, 'Claim is still a one-time action');
        assert.equal(await db.nodeAgent.count({ where: { storeId: store.id } }), 1);

        const publicCode = preRead ? 'GT-C1AM-1111' : 'GT-C1AM-2222';
        await db.qRTile.create({ data: { storeId: store.id, publicCode } });
        const nodeHeaders = await installTestToken(node.id);
        const configResponse = await app.inject({ url: '/node-agent/qr-config', headers: nodeHeaders });
        assert.equal(configResponse.json().sourceStoreId, store.id);
        const tableId = randomUUID();
        const heartbeat = await app.inject({ method: 'POST', url: '/node-agent/status', headers: nodeHeaders, payload: {
          status: 'ONLINE', version: node.desiredConfigVersion, meta: {
            qrAssignments: { schemaVersion: 1, sourceStoreId: configResponse.json().sourceStoreId, storeSlug: store.slug,
              tiles: [{ publicCode, tableId, tableLabel: 'Local table', isActive: true }] },
            deployment: { version: 0, status: 'RUNNING', message: 'Existing services are healthy', localUrl: deployment.localUrl, apiUrl: deployment.apiUrl,
              services: { database: { status: 'RUNNING' }, backend: { status: 'RUNNING' }, frontend: { status: 'RUNNING' } } },
          },
        } });
        assert.equal(heartbeat.statusCode, 200, heartbeat.body);
        const tileResponse = await app.inject({ url: `/admin/stores/${store.id}/qr-tiles`, headers });
        const tile = tileResponse.json().tiles[0];
        assert.equal(tile.assignmentSource, 'PI');
        assert.equal(tile.tableId, tableId);
        assert.equal(tile.publicUrl, `${deployment.localUrl}/q/${publicCode}`);
        assert.equal((await db.venueDeployment.findUniqueOrThrow({ where: { storeId: store.id } })).status, 'RUNNING');
        const beforeRead = await db.nodeAgent.findUniqueOrThrow({ where: { id: node.id } });
        const inspected = await app.inject({ url: '/node-agent/local-stack-status', headers: nodeHeaders });
        assert.equal(inspected.statusCode, 200, inspected.body);
        assert.deepEqual(Object.keys(inspected.json()).sort(), ['nodeId', 'storeId', 'storeSlug', 'target', 'associatedNodeId', 'localUrl', 'qrAssignmentReportedAt'].sort());
        assert.equal(inspected.json().associatedNodeId, node.id);
        assert.equal(inspected.json().target, 'PI');
        assert.equal(inspected.json().localUrl, deployment.localUrl);
        assert(Number.isFinite(Date.parse(inspected.json().qrAssignmentReportedAt)));
        assert.deepEqual(await db.nodeAgent.findUniqueOrThrow({ where: { id: node.id } }), beforeRead, 'Read-only inspection does not refresh lastSeenAt or modify node configuration');
        assert.equal((await app.inject({ url: '/node-agent/local-stack-status' })).statusCode, 401);
      });
    }
    await t.test('wrong venue and malformed full-stack metadata fail before creating or changing a node', async () => {
      const store = await makeStore('invalid');
      const valid = metadata(store);
      for (const localStack of [
        { ...valid.localStack, storeSlug: 'another-venue' },
        { ...valid.localStack, localUrl: 'http://user:secret@pi:8085' },
        { ...valid.localStack, localUrl: 'http://pi:8085/path' },
        { ...valid.localStack, localUrl: 'javascript:alert(1)' },
        { ...valid.localStack, frontendPort: 8080 },
        { ...valid.localStack, corePort: 0 },
        { ...valid.localStack, schemaVersion: 2 },
        { ...valid.localStack, credentials: 'must not be part of this contract' },
      ]) {
        const id = await register({ ...valid, localStack });
        const response = await claim(id, store);
        assert.equal(response.statusCode, localStack.storeSlug === 'another-venue' ? 409 : 400, response.body);
        assert.equal(await db.nodeAgent.count({ where: { storeId: store.id } }), 0);
        assert.equal(await db.venueDeployment.count({ where: { storeId: store.id } }), 0);
        assert.equal((await db.pendingNodeAgent.findUniqueOrThrow({ where: { id } })).status, 'PENDING');
      }
    });
    await t.test('classic printer-node claims keep their existing online behavior', async () => {
      const store = await makeStore('classic');
      const id = await register({ deploymentMode: 'AGENT' });
      const response = await claim(id, store);
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().localDeployment.status, 'not_applicable');
      assert.equal(await db.venueDeployment.count({ where: { storeId: store.id } }), 0);
      const node = await db.nodeAgent.findUniqueOrThrow({ where: { id: response.json().node.id } });
      assert.equal((await buildAgentConfig(node, store)).deployment.target, 'ONLINE');
      const nodeHeaders = await installTestToken(node.id);
      const inspected = await app.inject({ url: '/node-agent/local-stack-status', headers: nodeHeaders });
      assert.equal(inspected.json().target, 'ONLINE');
      assert.equal(inspected.json().associatedNodeId, null);
      assert.equal(inspected.json().qrAssignmentReportedAt, null);
      assert.equal(await db.venueDeployment.count({ where: { storeId: store.id } }), 0, 'Inspection never creates a deployment');
    });
    await t.test('a late heartbeat cannot overwrite a concurrent Pi selection or applied release/data-sync version', async () => {
      const store = await makeStore('status-race');
      const node = await db.nodeAgent.create({ data: { storeId: store.id, slug: 'source', displayName: 'Source Pi', tokenHash: 'fixture-source-node' } });
      const replacement = await db.nodeAgent.create({ data: { storeId: store.id, slug: 'replacement', displayName: 'Replacement Pi', tokenHash: 'fixture-replacement-node' } });
      const deployment = await db.venueDeployment.create({ data: { storeId: store.id, nodeId: node.id, target: 'PI' } });
      const nodeHeaders = await installTestToken(node.id);
      for (const changed of [{ nodeId: replacement.id }, { appliedVersion: 9 }, { appliedDataSyncVersion: 9 }]) {
        await db.venueDeployment.update({ where: { id: deployment.id }, data: { nodeId: node.id, appliedVersion: 0, appliedDataSyncVersion: 0, localUrl: 'http://original-pi:8080' } });
        const updateMany = db.venueDeployment.updateMany.bind(db.venueDeployment);
        let intercepted = false;
        db.venueDeployment.updateMany = async args => {
          if (args.where?.id === deployment.id && args.where?.appliedVersion) {
            intercepted = true;
            await db.venueDeployment.update({ where: { id: deployment.id }, data: { ...changed, localUrl: 'http://new-choice:8080' } });
          }
          return updateMany(args);
        };
        try {
          const response = await app.inject({ method: 'POST', url: '/node-agent/status', headers: nodeHeaders,
            payload: { status: 'ONLINE', meta: { deployment: { version: 1, appliedDataSyncVersion: 1, status: 'RUNNING', localUrl: 'http://stale-report:8080' } } } });
          assert.equal(response.statusCode, 200, response.body);
          assert.equal(intercepted, true);
          const saved = await db.venueDeployment.findUniqueOrThrow({ where: { id: deployment.id } });
          assert.equal(saved.localUrl, 'http://new-choice:8080');
          for (const [key, value] of Object.entries(changed)) assert.equal(saved[key], value);
          assert.equal(await db.venueDeploymentEvent.count({ where: { storeId: store.id, eventType: 'NODE_REPORT' } }), 0);
        } finally { db.venueDeployment.updateMany = updateMany; }
      }
    });
    await t.test('explicit online choice, legacy settings and an associated Pi are preserved', async () => {
      for (const choice of ['online', 'legacy', 'associated']) {
        const store = await makeStore(choice, choice === 'legacy' ? { settingsJson: { venueDeployment: { target: 'ONLINE', desiredState: 'STOPPED' } } } : {});
        let previous = null;
        if (choice !== 'legacy') {
          const existingNode = choice === 'associated' ? await db.nodeAgent.create({ data: { storeId: store.id, slug: 'existing', displayName: 'Existing Pi', tokenHash: 'fixture-old-node' } }) : null;
          previous = await db.venueDeployment.create({ data: { storeId: store.id, nodeId: existingNode?.id, target: choice === 'associated' ? 'PI' : 'ONLINE',
            desiredState: choice === 'associated' ? 'RUNNING' : 'STOPPED', version: 3, dataSyncVersion: 1, localUrl: 'http://192.0.2.88:8080',
            requestedAt: new Date(), message: 'Explicit prior choice' } });
        }
        const id = await register(metadata(store));
        const response = await claim(id, store);
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(response.json().localDeployment.status, 'preserved');
        assert.match(response.json().localDeployment.message, /review/i);
        assert.deepEqual(await db.venueDeployment.findUnique({ where: { storeId: store.id } }), previous);
        assert.equal(await db.venueDeploymentEvent.count({ where: { storeId: store.id, eventType: 'ADOPT_LOCAL_STACK' } }), 0);
        if (choice === 'associated') {
          const nodeHeaders = await installTestToken(response.json().node.id);
          const heartbeat = await app.inject({ method: 'POST', url: '/node-agent/status', headers: nodeHeaders,
            payload: { status: 'ONLINE', meta: { deployment: { version: 99, status: 'RUNNING', localUrl: 'http://wrong-pi:9999' } } } });
          assert.equal(heartbeat.statusCode, 200, heartbeat.body);
          assert.deepEqual(await db.venueDeployment.findUnique({ where: { storeId: store.id } }), previous, 'Another node cannot steal the associated Pi or its status');
        }
      }
    });
  } finally {
    await app.close();
    await db.pendingNodeAgent.deleteMany({ where: { id: { in: pendingIds } } });
    await db.store.deleteMany({ where: { id: { in: stores } } });
    await db.$disconnect();
    delete process.env.LOCAL_ONLY;
  }
});
