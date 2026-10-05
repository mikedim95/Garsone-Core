// Compatibility entry point: local bootstrap creates staff; Architect lives online.
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { readFile } from 'node:fs/promises';

const url = process.env.DATABASE_URL;
if (!url || !['db', 'localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Local database required');
const roles = ['MANAGER', 'WAITER', 'COOK', 'HYBRID'];
const credentials = roles.map(role => ({ role,
  email: process.env[`LOCAL_${role}_EMAIL`] || (role === 'MANAGER' ? process.env.LOCAL_ADMIN_EMAIL : '') || `${role.toLowerCase()}@garsone.local`,
  password: process.env[`LOCAL_${role}_PASSWORD`] || (role === 'MANAGER' ? process.env.LOCAL_ADMIN_PASSWORD : ''),
}));
if (credentials.some(v => !v.email.includes('@') || !v.password || v.password.length < 16)) throw new Error('Set a local email and random password (16+ characters) for each staff role');
const menu = process.env.LOCAL_SEED_OFFLINE_MENU === 'true' ? JSON.parse(await readFile(new URL('./offline-menu.json', import.meta.url), 'utf8')) : null;
const db = new PrismaClient();
try {
  await db.$transaction(async tx => {
    const slug = process.env.STORE_SLUG || 'local';
    let store = await tx.store.findUnique({ where: { slug } });
    // Rename the initial blank venue in place, retaining its node and references.
    if (!store && process.env.LOCAL_MIGRATE_ARCHITECT === 'true') {
      const stores = await tx.store.findMany();
      if (stores.length !== 1 || stores[0].slug !== 'local') throw new Error('Expected the initial local venue');
      store = await tx.store.update({ where: { id: stores[0].id }, data: { slug, name: process.env.LOCAL_STORE_NAME || slug } });
    }
    if (!store && process.env.LOCAL_BOOTSTRAP_EMPTY === 'true') {
      if (await tx.store.count() || await tx.profile.count()) throw new Error('Empty bootstrap requires an empty database');
      store = await tx.store.create({ data: { slug, name: process.env.LOCAL_STORE_NAME || 'Local venue' } });
    }
    if (!store) throw new Error('Import a venue first, or explicitly enable LOCAL_BOOTSTRAP_EMPTY');
    const cookType = await tx.cookType.upsert({ where: { storeId_slug: { storeId: store.id, slug: 'kitchen' } }, create: { storeId: store.id, slug: 'kitchen', title: 'Kitchen', printerTopic: 'kitchen' }, update: {} });
    const waiterType = await tx.waiterType.upsert({ where: { storeId_slug: { storeId: store.id, slug: 'floor' } }, create: { storeId: store.id, slug: 'floor', title: 'Floor' }, update: {} });
    const architects = await tx.profile.findMany({ where: { role: 'ARCHITECT' } });
    if (architects.length) {
      if (process.env.LOCAL_MIGRATE_ARCHITECT !== 'true' || architects.length !== 1 || architects[0].storeId !== store.id) throw new Error('Explicit migration required for the initial local Architect');
      const manager = credentials[0];
      if (await tx.profile.count({ where: { storeId: store.id, role: 'MANAGER' } })) throw new Error('Manager already exists; existing accounts preserved');
      await tx.profile.update({ where: { id: architects[0].id }, data: { email: manager.email, globalKey: manager.email, role: 'MANAGER', displayName: 'Manager', passwordHash: await bcrypt.hash(manager.password, 12) } });
    }
    for (const credential of credentials) {
      const existing = await tx.profile.findMany({ where: { storeId: store.id, role: credential.role } });
      if (existing.length > 1) throw new Error(`More than one ${credential.role} account; existing accounts preserved`);
      if (existing.length) {
        if (existing[0].email !== credential.email || !await bcrypt.compare(credential.password, existing[0].passwordHash)) throw new Error(`${credential.role} already exists; credentials preserved`);
      } else {
        await tx.profile.create({ data: { storeId: store.id, email: credential.email, globalKey: credential.email, role: credential.role, displayName: credential.role[0] + credential.role.slice(1).toLowerCase(), passwordHash: await bcrypt.hash(credential.password, 12), isVerified: true,
          cookTypeId: ['COOK', 'HYBRID'].includes(credential.role) ? cookType.id : null, waiterTypeId: ['WAITER', 'HYBRID'].includes(credential.role) ? waiterType.id : null } });
      }
    }
    if (menu) {
      const categories = new Map();
      for (const row of menu.categories) {
        const slug = row.id.replace('offline-cat-', '');
        const category = await tx.category.upsert({ where: { storeId_slug: { storeId: store.id, slug } }, create: { storeId: store.id, slug, title: row.title, titleEn: row.titleEn, titleEl: row.titleEl, imageUrl: row.imageUrl, sortOrder: row.sortOrder }, update: {} });
        categories.set(row.id, category.id);
      }
      for (const [index, row] of menu.items.entries()) {
        const slug = row.id.replace('offline-item-', '');
        await tx.item.upsert({ where: { storeId_slug: { storeId: store.id, slug } }, create: { storeId: store.id, categoryId: categories.get(row.categoryId), slug, title: row.title, titleEn: row.titleEn, titleEl: row.titleEl, descriptionEn: row.descriptionEn, descriptionEl: row.descriptionEl, priceCents: row.priceCents, imageUrl: row.imageUrl, isAvailable: row.isAvailable, sortOrder: index, printerTopic: 'kitchen' }, update: {} });
      }
      const table = await tx.table.upsert({ where: { storeId_label: { storeId: store.id, label: 'Demo' } }, create: { storeId: store.id, label: 'Demo' }, update: {} });
      for (const profile of await tx.profile.findMany({ where: { storeId: store.id, role: { in: ['WAITER', 'HYBRID'] } } })) {
        await tx.waiterTable.upsert({ where: { storeId_waiterId_tableId: { storeId: store.id, waiterId: profile.id, tableId: table.id } }, create: { storeId: store.id, waiterId: profile.id, tableId: table.id }, update: {} });
      }
    }
    console.log(`Local venue ${store.slug}: one Manager, Waiter, Cook and Hybrid; no Architect`);
    if (menu) console.log(`Offline menu available: ${menu.categories.length} categories, ${menu.items.length} items and Demo table`);
  }, { timeout: 120_000 });
} finally { await db.$disconnect(); }
