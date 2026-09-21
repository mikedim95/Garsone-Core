import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
const url = process.env.DATABASE_URL;
if (!url || !['db', 'localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Local database required');
const email = process.env.LOCAL_ADMIN_EMAIL;
const password = process.env.LOCAL_ADMIN_PASSWORD;
if (!email?.includes('@') || !password || password.length < 16) throw new Error('Set LOCAL_ADMIN_EMAIL and a random LOCAL_ADMIN_PASSWORD (16+ characters)');
const db = new PrismaClient();
try {
  const store = await db.store.findUniqueOrThrow({ where: { slug: 'noor' } });
  if (await db.profile.findFirst({ where: { email } })) throw new Error('Admin email already exists; password preserved');
  await db.profile.create({ data: { storeId: store.id, email, globalKey: email, role: 'ARCHITECT', displayName: 'Noor Local Admin', passwordHash: await bcrypt.hash(password, 12), isVerified: true } });
  console.log(`Created local Noor administrator: ${email}`);
} finally { await db.$disconnect(); }
