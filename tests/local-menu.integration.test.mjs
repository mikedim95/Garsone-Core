import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import Fastify from 'fastify';

// Only disposable local PostgreSQL is accepted; never run this against a venue.
const url = process.env.ORDER_RELIABILITY_TEST_DATABASE_URL;
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || new URL(url).pathname !== '/garsone_reliability_test') {
  throw new Error('Use the disposable local database from tests/run-order-reliability.mjs');
}
Object.assign(process.env, { NODE_ENV: 'test', DB_CONNECTION: 'default', DATABASE_URL: url, DIRECT_URL: url,
  JWT_SECRET: 'local-menu-fixture-secret-never-used-on-real-venues', LOCAL_ONLY: 'true', STORE_SLUG: 'menu-fixture', MQTT_DISABLED: 'true' });
const { db } = await import('../dist/db/index.js');
const { managerRoutes } = await import('../dist/routes/manager.js');
const { publicMenuBootstrapRoutes } = await import('../dist/routes/publicMenuBootstrap.js');
const { importNodeQrSnapshot } = await import('../dist/lib/nodeQrConfig.js');
const { signToken } = await import('../dist/lib/jwt.js');

test('local manager menu edits persist, refresh customer menus and survive QR sync', async () => {
  const store = await db.store.create({ data: { slug: 'menu-fixture', name: 'Local menu fixture', settingsJson: { printers: [] } } });
  const foreign = await db.store.create({ data: { slug: 'menu-foreign', name: 'Other venue' } });
  const app = Fastify();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Cloud HTTP is unavailable in this fixture'); };
  try {
    const profiles = await Promise.all([['MANAGER', store], ['WAITER', store], ['MANAGER', foreign]].map(([role, venue], i) =>
      db.profile.create({ data: { storeId: venue.id, role, email: `menu-${i}@fixture.test`, passwordHash: 'fixture-only' } })));
    const headers = i => ({ authorization: `Bearer ${signToken({ userId: profiles[i].id, email: profiles[i].email,
      role: profiles[i].role.toLowerCase(), storeId: profiles[i].storeId, storeSlug: i === 2 ? foreign.slug : store.slug })}` });
    const category = await db.category.create({ data: { storeId: store.id, slug: 'coffee', title: 'Coffee' } });
    const item = await db.item.create({ data: { storeId: store.id, categoryId: category.id, slug: 'coffee', title: 'Coffee',
      titleEn: 'Coffee', titleEl: 'Coffee', priceCents: 220, isAvailable: true, printerTopic: 'kitchen', imageUrl: '/offline-assets/coffee.jpg' } });
    await app.register(managerRoutes);
    await app.register(publicMenuBootstrapRoutes);
    const patch = (payload, auth = headers(0)) => app.inject({ method: 'PATCH', url: `/manager/items/${item.id}`, headers: auth, payload });
    const menu = () => app.inject({ url: '/public/menu-bootstrap?storeSlug=menu-fixture&lang=en' });
    const before = await menu();
    assert.equal(before.statusCode, 200, before.body);
    assert.equal(before.json().menu.items[0].priceCents, 220);
    for (const [auth, status] of [[{}, 401], [headers(1), 403], [headers(2), 404]]) {
      assert.equal((await patch({ priceCents: 999 }, auth)).statusCode, status);
    }
    assert.equal((await patch({ priceCents: -1 })).statusCode, 400);
    assert.equal((await patch({ printerTopic: 'unknown-printer' })).statusCode, 400);
    const changes = { titleEn: 'House coffee', titleEl: 'House coffee', descriptionEn: 'Freshly ground',
      categoryId: category.id, imageUrl: item.imageUrl, priceCents: 375, isAvailable: false };
    const saved = await patch(changes);
    assert.equal(saved.statusCode, 200, saved.body);
    const row = await db.item.findUniqueOrThrow({ where: { id: item.id } });
    for (const [key, value] of Object.entries(changes)) assert.equal(row[key], value, key);
    assert.equal(row.printerTopic, 'kitchen');
    const refreshed = await menu();
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.notEqual(refreshed.headers.etag, before.headers.etag);
    assert.equal(refreshed.json().menu.items.some(value => value.id === item.id), false, 'Unavailable items leave the customer menu immediately');
    await importNodeQrSnapshot({ schemaVersion: 1, sourceStoreId: '11111111-1111-4111-8111-111111111111',
      storeSlug: store.slug, tables: [], tiles: [] });
    // A new process reads committed data, independently of this API's caches.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {db}=await import('./dist/db/index.js');try{const i=await db.item.findUniqueOrThrow({where:{id:${JSON.stringify(item.id)}}});if(i.priceCents!==375||i.isAvailable!==false||i.titleEn!=='House coffee')throw Error('Menu edits were not durable');}finally{await db.$disconnect();}`],
      { env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal((await patch({ isAvailable: true, imageUrl: '/placeholder.svg' })).statusCode, 200);
    const publicItem = (await menu()).json().menu.items[0];
    assert.equal(publicItem.available, true);
    assert.equal(publicItem.priceCents, 375);
    assert.equal(publicItem.name, 'House coffee');
  } finally {
    globalThis.fetch = originalFetch;
    await app.close();
    await db.store.deleteMany({ where: { id: { in: [store.id, foreign.id] } } });
    await db.$disconnect();
  }
});
