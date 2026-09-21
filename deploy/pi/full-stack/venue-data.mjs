#!/usr/bin/env node
// Run from Core (local dependencies or inside its container). Never loads .env.
import { PrismaClient, Prisma } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const command = process.argv[2];
const destination = path.resolve(process.argv[3] || 'data/noor.json');
const slug = 'noor';
// Parent tables precede dependants. Deployment state and push subscriptions are
// intentionally excluded: a new local installation has its own runtime identity.
const models = ['storeMeta', 'category', 'cookType', 'waiterType', 'modifier', 'modifierOption', 'item', 'itemModifier', 'table', 'profile', 'qRTile', 'tableVisit', 'localityApproval', 'order', 'orderItem', 'orderItemOption', 'kitchenCounter', 'kitchenTicketSeq', 'waiterShift', 'waiterTable', 'auditLog'];
let db;

async function exportVenue() {
  let url = process.env.SOURCE_DATABASE_URL;
  if (!url && process.env.RENDER_API_KEY) {
    const response = await fetch('https://api.render.com/v1/postgres/dpg-d8fkc9navr4c73ejpjug-a/connection-info', {
      headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
    });
    if (!response.ok) throw new Error(`Render connection-info: HTTP ${response.status}`);
    url = (await response.json()).externalConnectionString;
  }
  if (!url) throw new Error('Set SOURCE_DATABASE_URL (or RENDER_API_KEY on the preparation laptop).');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1', 'db'].includes(parsed.hostname)) parsed.searchParams.set('sslmode', 'require');
  parsed.searchParams.set('connect_timeout', '15');
  db = new PrismaClient({ datasources: { db: { url: parsed.toString() } } });
  const snapshot = await db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    const store = await tx.store.findUniqueOrThrow({ where: { slug } });
    const rows = {};
    for (const model of models) {
      const where = model === 'orderItem' ? { order: { storeId: store.id } }
        : model === 'orderItemOption' ? { orderItem: { order: { storeId: store.id } } }
        : { storeId: store.id };
      rows[model] = await tx[model].findMany({ where });
    }
    // Historical audit actors can be global staff, retain only necessary profiles.
    const actorIds = rows.auditLog.map(row => row.actorProfileId).filter(Boolean);
    const existing = new Set(rows.profile.map(row => row.id));
    const extra = await tx.profile.findMany({ where: { id: { in: actorIds.filter(id => !existing.has(id)) } } });
    rows.profile.push(...extra.map(row => ({ ...row, storeId: store.id, cookTypeId: null, waiterTypeId: null })));
    return { version: 1, exportedAt: new Date().toISOString(), sourceHost: parsed.hostname, store, rows };
  }, { isolationLevel: 'RepeatableRead', timeout: 180_000 });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ file: destination, venue: snapshot.store.slug, counts: Object.fromEntries(Object.entries(snapshot.rows).map(([key, rows]) => [key, rows.length])) }, null, 2));
}

async function localizeAssets() {
  const snapshot = JSON.parse(await fs.readFile(destination, 'utf8'));
  const assetDir = path.join(path.dirname(destination), 'uploads', 'venue-import');
  await fs.mkdir(assetDir, { recursive: true });
  const cache = new Map();
  async function walk(value) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) {
      // Image URLs only; never download payment links, webhooks or profile links.
      if (!/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(value) && !/\/storage\/v1\/object\//.test(value)) return value;
      if (cache.has(value)) return cache.get(value);
      const response = await fetch(value, { signal: AbortSignal.timeout(30000) });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error(`Asset download failed (${response.status}): ${new URL(value).hostname}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 20 * 1024 * 1024) throw new Error('Asset exceeds 20 MB');
      const extension = ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg' })[response.headers.get('content-type').split(';')[0]];
      if (!extension) throw new Error('Unsupported image content type');
      const name = createHash('sha256').update(bytes).digest('hex') + extension;
      await fs.writeFile(path.join(assetDir, name), bytes);
      const local = `/uploads/venue-import/${name}`;
      cache.set(value, local);
      return local;
    }
    if (Array.isArray(value)) return Promise.all(value.map(walk));
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = await walk(value[key]);
    }
    return value;
  }
  // Only mutable display configuration and catalogue rows contain menu imagery.
  snapshot.store.settingsJson = await walk(snapshot.store.settingsJson);
  for (const model of ['category', 'item']) snapshot.rows[model] = await walk(snapshot.rows[model]);
  const localFile = destination.replace(/\.json$/, '') + '.local.json';
  await fs.writeFile(localFile, JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(`Saved ${cache.size} local images and ${localFile}`);
}

function hydrate(model, row) {
  const schema = Prisma.dmmf.datamodel.models.find(item => item.name.toLowerCase() === model.toLowerCase());
  const result = { ...row };
  for (const field of schema.fields) {
    if (field.type === 'DateTime' && result[field.name]) result[field.name] = new Date(result[field.name]);
    if (field.type === 'Json' && result[field.name] === null) result[field.name] = Prisma.DbNull;
  }
  return result;
}

async function importVenue() {
  if (process.env.ALLOW_LOCAL_VENUE_IMPORT !== 'noor') throw new Error('Set ALLOW_LOCAL_VENUE_IMPORT=noor to import into an empty local DB.');
  const url = process.env.DATABASE_URL;
  if (!url || !['db', '127.0.0.1', 'localhost'].includes(new URL(url).hostname)) throw new Error('Import target must be local db/localhost.');
  const snapshot = JSON.parse(await fs.readFile(destination, 'utf8'));
  if (snapshot.version !== 1 || snapshot.store?.slug !== slug) throw new Error('Not a Noor snapshot');
  db = new PrismaClient({ datasources: { db: { url } } });
  const uploads = path.join(path.dirname(destination), 'uploads');
  if (await fs.stat(uploads).then(() => true, () => false)) {
    await fs.cp(uploads, process.env.LOCAL_UPLOAD_DIR || '/app/uploads', { recursive: true, force: false });
  }
  await db.$transaction(async tx => {
    if (await tx.store.count() || await tx.profile.count()) throw new Error('Refusing to overwrite a populated database. Restore into a new empty volume.');
    const store = hydrate('store', snapshot.store);
    if (store.settingsJson && typeof store.settingsJson === 'object') delete store.settingsJson.venueDeployment;
    await tx.store.create({ data: store });
    for (const model of models) {
      for (const row of snapshot.rows[model] || []) await tx[model].create({ data: hydrate(model, row) });
    }
  }, { timeout: 180_000 });
  console.log('Imported Noor into the empty local database. Existing staff password hashes were preserved.');
}

try {
  if (command === 'export') await exportVenue();
  else if (command === 'assets') await localizeAssets();
  else if (command === 'import') await importVenue();
  else throw new Error('Usage: node venue-data.mjs {export|assets|import} path/to/noor.json');
} catch (error) {
  // Prisma connection errors can include connection details: report only class/code.
  console.error(error.constructor.name.startsWith('Prisma') ? `Database operation failed (${error.code || error.constructor.name})` : error.message);
  process.exitCode = 1;
} finally { await db?.$disconnect(); }
