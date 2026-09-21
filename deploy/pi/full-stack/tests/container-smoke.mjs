import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// A development-only test dependency; it is not needed on the Pi.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const config = Object.fromEntries((await fs.readFile(path.join(here, '../.env.test'), 'utf8')).split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const base = 'http://localhost:18080';
const snapshot = JSON.parse(await fs.readFile(path.join(here, '../data/noor.local.json'), 'utf8'));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const external = [];
  await context.route('**/*', route => {
    if (!route.request().url().startsWith(base + '/')) { external.push(new URL(route.request().url()).hostname); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.locator('input[type=email]').fill(config.LOCAL_ADMIN_EMAIL);
  await page.locator('input[type=password]').fill(config.LOCAL_ADMIN_PASSWORD);
  await page.locator('button[type=submit]').click();
  await page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 30000 });
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('auth-storage')).state.token);
  assert.ok(token);
  const headers = { Authorization: 'Bearer ' + token, 'x-store-slug': 'noor' };
  const menuResponse = await context.request.get(base + '/api/menu', { headers });
  assert.equal(menuResponse.status(), 200);
  const menu = await menuResponse.json();
  assert.equal(menu.items.length, 54);
  const image = snapshot.rows.item.find(item => item.imageUrl?.startsWith('/uploads/')).imageUrl;
  assert.equal((await context.request.get(base + image)).status(), 200);
  assert.equal((await context.request.post(base + '/api/payment/viva/checkout-url', { data: {} })).status(), 503);
  const tile = snapshot.rows.qRTile.find(tile => tile.tableId && tile.isActive);
  const qr = await context.request.get(base + '/api/q/' + tile.publicCode, { headers: { Accept: 'application/json' } });
  assert.equal((await qr.json()).storeSlug, 'noor');
  await page.evaluate(async token => {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(location.origin.replace('http', 'ws') + '/api/events/ws?token=' + token);
      const timer = setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')); }, 5000);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); };
    });
  }, token);
  const item = snapshot.rows.item.find(item => item.isAvailable && !snapshot.rows.itemModifier.some(link => link.itemId === item.id && link.isRequired));
  const order = await context.request.post(base + '/api/orders', { headers, data: { tableId: tile.tableId, items: [{ itemId: item.id, quantity: 1 }], note: 'Local container verification' } });
  assert.ok(order.ok(), 'Local order creation returned ' + order.status() + ': ' + await order.text());
  await page.goto(base + '/q/' + tile.publicCode, { waitUntil: 'networkidle' });
  assert.equal(external.length, 0, 'Unexpected cloud requests: ' + external.join(', '));
  console.log('PASS: browser login, 54 Noor items, local image, QR resolution, WebSocket proxy, local order creation, and no cloud browser requests');
  const stores = await (await context.request.get(base + '/api/admin/stores', { headers })).json();
  const store = stores.stores.find(value => value.slug === 'noor');
  const created = await context.request.post(base + `/api/admin/stores/${store.id}/qr-events`, {
    headers, data: { name: 'Container event verification', publicAppUrl: base, publicApiUrl: base + '/api',
      assignments: [{ publicCode: tile.publicCode, tableId: tile.tableId, label: 'Noor test', isActive: true }] },
  });
  assert.equal(created.status(), 201, await created.text());
  const event = (await created.json()).event;
  await page.goto(base + '/GarsoneAdmin', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Per Store Setting', exact: true }).click();
  await page.getByRole('tab', { name: 'Event QR Codes', exact: true }).click();
  await page.getByText('Saved on this Pi', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Create pairing token', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Local customer app URL', { exact: true }).inputValue(), base);
  const printed = base + `/api/q/${tile.publicCode}?event=${event.id}`;
  const redirect = await context.request.get(printed, { headers: { Accept: 'text/html' }, maxRedirects: 0 });
  assert.equal(redirect.status(), 302);
  assert.equal(new URL(redirect.headers().location).origin, base);
  assert.equal(new URL(redirect.headers().location).pathname, '/table/' + tile.tableId);
  const guestContext = await browser.newContext({ serviceWorkers: 'block' });
  const guestExternal = [];
  await guestContext.route('**/*', route => {
    if (!route.request().url().startsWith(base + '/')) { guestExternal.push(new URL(route.request().url()).hostname); return route.abort(); }
    return route.continue();
  });
  const guestPage = await guestContext.newPage();
  await guestPage.goto(printed, { waitUntil: 'networkidle' });
  assert.equal(new URL(guestPage.url()).pathname, '/table/' + tile.tableId);
  const guestOrder = await guestContext.request.post(base + '/api/orders', {
    headers: { 'x-store-slug': 'noor' }, data: { tableId: tile.tableId, items: [{ itemId: item.id, quantity: 1 }], note: 'Offline event guest test' },
  });
  assert.ok(guestOrder.ok(), await guestOrder.text());
  assert.equal(guestExternal.length, 0, guestExternal.join(', '));
  const disabled = await context.request.patch(base + `/api/admin/qr-events/${event.id}`, {
    headers, data: { expectedRevision: event.revision, isActive: false },
  });
  assert.equal(disabled.status(), 200);
  assert.equal((await guestContext.request.get(printed, { headers: { Accept: 'application/json' } })).status(), 404);
  await guestContext.close();
  console.log('PASS: local event dashboard/readiness, event QR issuance, printed redirect, anonymous local menu/order without locality scan or cloud requests, and event deactivation');
} finally { await browser.close(); }
