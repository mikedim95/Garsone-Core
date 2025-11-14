import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const STORE_SLUG = process.env.STORE_SLUG || 'demo-cafe';
  const store = await prisma.store.findUnique({ where: { slug: STORE_SLUG } });
  if (!store) {
    throw new Error(`Store with slug ${STORE_SLUG} not found. Run your initial seed first.`);
  }

  // Ensure a cook user exists
  const cookEmail = process.env.SEED_COOK_EMAIL || 'cook@demo.local';
  const cookPassword = process.env.SEED_COOK_PASSWORD || 'changeme';

  const existing = await prisma.profile.findFirst({ where: { storeId: store.id, email: cookEmail } });
  if (!existing) {
    const passwordHash = await bcrypt.hash(cookPassword, 10);
    await prisma.profile.create({
      data: {
        storeId: store.id,
        email: cookEmail.toLowerCase(),
        passwordHash,
        role: Role.COOK,
        displayName: 'Cook',
      },
    });
    console.log(`Seeded cook user ${cookEmail} (role=COOK)`);
  } else if (existing.role !== Role.COOK) {
    await prisma.profile.update({ where: { id: existing.id }, data: { role: Role.COOK } });
    console.log(`Updated existing user ${cookEmail} to role COOK`);
  } else {
    console.log(`Cook user ${cookEmail} already present.`);
  }

  // Ensure a demo waiter -> tables assignment for quick testing
  const waiters = await prisma.profile.findMany({ where: { storeId: store.id, role: Role.WAITER } });
  const tables = await prisma.table.findMany({ where: { storeId: store.id, isActive: true } });
  if (waiters.length && tables.length) {
    const primaryWaiter = waiters.find(w => w.email.toLowerCase() === 'waiter1@demo.local') || waiters[0];
    for (const table of tables) {
      await prisma.waiterTable.upsert({
        where: { storeId_waiterId_tableId: { storeId: store.id, waiterId: primaryWaiter.id, tableId: table.id } },
        update: {},
        create: { storeId: store.id, waiterId: primaryWaiter.id, tableId: table.id },
      });
    }
    console.log(`Assigned waiter ${primaryWaiter.email} to ${tables.length} active tables.`);
  } else {
    console.log('No waiters or tables found to assign. Skipping assignments.');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
