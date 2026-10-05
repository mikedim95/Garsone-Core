import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
const url = process.env.DATABASE_URL;
if (!url || !['db', 'localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Local database required');
const email = process.env.LOCAL_ADMIN_EMAIL;
const password = process.env.LOCAL_ADMIN_PASSWORD;
if (!email?.includes('@') || !password || password.length < 16) throw new Error('Set LOCAL_ADMIN_EMAIL and a random LOCAL_ADMIN_PASSWORD (16+ characters)');
const db = new PrismaClient();
try {
  const slug = process.env.STORE_SLUG || 'noor';
  const existing = await db.profile.findFirst({ where: { email }, include: { store: true } });
  if (existing) {
    if (existing.role !== 'ARCHITECT' || existing.store?.slug !== slug || !await bcrypt.compare(password, existing.passwordHash)) {
      throw new Error('Admin email already exists; password and permissions preserved');
    }
    console.log('Local administrator already configured; credentials preserved');
  } else {
    await db.$transaction(async tx => {
      let store = await tx.store.findUnique({ where: { slug } });
      if (!store && process.env.LOCAL_BOOTSTRAP_EMPTY === 'true') {
        if (await tx.store.count() || await tx.profile.count()) throw new Error('Empty bootstrap requires an empty database');
        store = await tx.store.create({ data: { slug, name: 'Local venue' } });
      }
      if (!store) throw new Error('Import a venue first, or explicitly enable LOCAL_BOOTSTRAP_EMPTY');
      await tx.profile.create({ data: { storeId: store.id, email, globalKey: email, role: 'ARCHITECT', displayName: 'Local Admin', passwordHash: await bcrypt.hash(password, 12), isVerified: true } });
    });
    console.log(`Created local administrator: ${email}`);
  }
} finally { await db.$disconnect(); }
