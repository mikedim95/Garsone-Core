// prisma/seed.ts
import { PrismaClient, OrderStatus, ShiftStatus, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const STORE_SLUG = process.env.STORE_SLUG || "demo-cafe";

const DEFAULT_PASSWORD =
  process.env.DEFAULT_PASSWORD ||
  process.env.MANAGER_PASSWORD ||
  process.env.WAITER_PASSWORD ||
  "changeme";

const DAYS_BACK_ORDERS = 60; // ~2 months
const MIN_ORDERS_PER_DAY = 5;
const MAX_ORDERS_PER_DAY = 25;

// ---------- helpers ----------

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFromArray<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

function randomDateOnDay(day: Date): Date {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  const minutesOffset = randInt(0, 60 * 24 - 1);
  d.setMinutes(d.getMinutes() + minutesOffset);
  return d;
}

async function ensureProfile(
  storeId: string,
  email: string,
  role: Role,
  displayName: string,
  password?: string
) {
  const normalizedEmail = email.toLowerCase();

  const existing = await prisma.profile.findUnique({
    where: { email: normalizedEmail },
  });

  if (existing) return existing;

  const passwordHash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);

  return prisma.profile.create({
    data: {
      storeId,
      email: normalizedEmail,
      role,
      displayName,
      passwordHash,
    },
  });
}

async function seed() {
  console.log(`Seeding demo data for store slug: ${STORE_SLUG}`);

  const store = await prisma.store.findUnique({
    where: { slug: STORE_SLUG },
  });

  if (!store) {
    console.error(
      `No store found with slug "${STORE_SLUG}". Create it first or set STORE_SLUG.`
    );
    process.exit(1);
  }

  const storeId = store.id;
  console.log(`Seeding for store "${store.slug}" (${storeId})`);

  // ---------- PROFILES ----------
  const manager = await ensureProfile(
    storeId,
    process.env.MANAGER_EMAIL || "manager@demo.local",
    Role.MANAGER,
    "Demo Manager",
    process.env.MANAGER_PASSWORD
  );

  const waiter1 = await ensureProfile(
    storeId,
    process.env.WAITER_1_EMAIL || "waiter1@demo.local",
    Role.WAITER,
    "Waiter One",
    process.env.WAITER_1_PASSWORD
  );

  const waiter2 = await ensureProfile(
    storeId,
    process.env.WAITER_2_EMAIL || "waiter2@demo.local",
    Role.WAITER,
    "Waiter Two",
    process.env.WAITER_2_PASSWORD
  );

  const cook = await ensureProfile(
    storeId,
    process.env.COOK_EMAIL || "cook@demo.local",
    Role.COOK,
    "Demo Cook",
    process.env.COOK_PASSWORD
  );

  const architect = await ensureProfile(
    storeId,
    process.env.ARCHITECT_EMAIL || "architect@demo.local",
    Role.ARCHITECT,
    "Architect Admin",
    process.env.ARCHITECT_PASSWORD
  );

  console.log("Profiles ensured:", {
    manager: manager.email,
    waiter1: waiter1.email,
    waiter2: waiter2.email,
    cook: cook.email,
    architect: architect.email,
  });

  // ---------- CLEAR EXISTING DEMO DATA (ONLY ORDERS & WAITER DATA) ----------
  console.log(
    "Clearing existing demo orders and waiter data for this store..."
  );

  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.waiterTable.deleteMany({ where: { storeId } });
  await prisma.waiterShift.deleteMany({ where: { storeId } });

  // DO NOT touch categories/items/modifiers/etc → respect existing menu.

  // ---------- TABLES ----------
  console.log("Ensuring tables...");

  let tables = await prisma.table.findMany({
    where: { storeId },
    orderBy: { label: "asc" },
  });

  if (tables.length === 0) {
    const tableLabels = [
      "T1",
      "T2",
      "T3",
      "T4",
      "T5",
      "T6",
      "T7",
      "T8",
      "T9",
      "T10",
    ];

    tables = await Promise.all(
      tableLabels.map((label) =>
        prisma.table.create({
          data: {
            storeId,
            label,
            isActive: true,
          },
        })
      )
    );

    console.log(`Created ${tables.length} tables.`);
  } else {
    console.log(`Reusing ${tables.length} existing tables.`);
  }

  // ---------- ITEMS FROM EXISTING MENU ----------
  console.log("Fetching existing items for this store...");

  const items = await prisma.item.findMany({
    where: { storeId, isAvailable: true },
    orderBy: { title: "asc" },
  });

  if (items.length === 0) {
    console.error(
      "No items found for this store. Seed or import your menu items first."
    );
    process.exit(1);
  }

  console.log(`Found ${items.length} items.`);

  // ---------- MODIFIERS & OPTIONS FROM EXISTING DATA ----------
  console.log("Fetching modifiers and options...");

  const itemModifiers = await prisma.itemModifier.findMany({
    where: { storeId },
    include: { modifier: true },
  });

  const modifierOptions = await prisma.modifierOption.findMany({
    where: { storeId },
  });

  const modifierOptionsByModifierId: Record<
    string,
    { id: string; title: string; priceDeltaCents: number }[]
  > = modifierOptions.reduce((acc, opt) => {
    if (!acc[opt.modifierId]) acc[opt.modifierId] = [];
    acc[opt.modifierId].push({
      id: opt.id,
      title: opt.title,
      priceDeltaCents: opt.priceDeltaCents,
    });
    return acc;
  }, {} as Record<string, { id: string; title: string; priceDeltaCents: number }[]>);

  console.log("Modifiers and options loaded from DB.");

  // ---------- WAITER SHIFTS (last 60 days to match orders window) ----------
  console.log("Generating waiter shifts (last 60 days)...");

  const waiters = [waiter1, waiter2];
  const today = new Date();
  const daysForShifts = 60;

  for (let i = 0; i < daysForShifts; i++) {
    const day = new Date(today);
    day.setDate(today.getDate() - i);
    day.setHours(0, 0, 0, 0);

    for (const waiter of waiters) {
      const start = new Date(day);
      start.setHours(18, 0, 0, 0);

      const end = new Date(day);
      end.setDate(end.getDate() + 1);
      end.setHours(2, 0, 0, 0);

      await prisma.waiterShift.create({
        data: {
          storeId,
          waiterId: waiter.id,
          status: ShiftStatus.COMPLETED,
          startedAt: start,
          endedAt: end,
        },
      });
    }
  }

  console.log("Waiter shifts generated.");

  // ---------- ORDERS (ONLY PAID, LAST ~2 MONTHS) ----------
  console.log(
    `Generating ONLY PAID orders for the last ${DAYS_BACK_ORDERS} days (~2 months)...`
  );

  let globalTicketNumber = 1;
  const now = new Date();

  function getItemModifiersWithOptions(itemId: string) {
    return itemModifiers.filter((im) => im.itemId === itemId);
  }

  for (let daysAgo = 0; daysAgo < DAYS_BACK_ORDERS; daysAgo++) {
    const day = new Date();
    day.setDate(now.getDate() - daysAgo);

    const ordersCountToday = randInt(MIN_ORDERS_PER_DAY, MAX_ORDERS_PER_DAY);

    for (let i = 0; i < ordersCountToday; i++) {
      const table = randFromArray(tables);
      const placedAt = randomDateOnDay(day);

      const itemsCount = randInt(1, 5);

      type Line = {
        item: (typeof items)[number];
        quantity: number;
        basePrice: number;
        options: {
          modifierId: string;
          option: { id: string; title: string; priceDeltaCents: number };
        }[];
      };

      const lines: Line[] = [];

      for (let j = 0; j < itemsCount; j++) {
        const item = randFromArray(items);
        const quantity = randInt(1, 3);
        const basePrice = item.priceCents;

        const modsForItem = getItemModifiersWithOptions(item.id);
        const chosenOptions: Line["options"] = [];

        for (const im of modsForItem) {
          const opts = modifierOptionsByModifierId[im.modifierId] || [];
          if (!opts.length) continue;

          const required = im.isRequired || (im.modifier.minSelect ?? 0) > 0;

          let pickCount = 0;
          if (required) {
            pickCount = 1;
          } else {
            pickCount = Math.random() < 0.5 ? 0 : 1;
          }

          if (pickCount > 0) {
            const opt = randFromArray(opts);
            chosenOptions.push({
              modifierId: im.modifierId,
              option: opt,
            });
          }
        }

        lines.push({
          item,
          quantity,
          basePrice,
          options: chosenOptions,
        });
      }

      // compute total
      let totalCents = 0;
      for (const line of lines) {
        const optionTotal = line.options.reduce(
          (sum, o) => sum + o.option.priceDeltaCents,
          0
        );
        totalCents += (line.basePrice + optionTotal) * line.quantity;
      }

      // ONLY PAID ORDERS
      const status: OrderStatus = OrderStatus.PAID;

      // timestamps
      const prepOffsetMin = randInt(1, 10);
      const readyOffsetMin = prepOffsetMin + randInt(3, 15);
      const serveOffsetMin = readyOffsetMin + randInt(1, 10);
      const payOffsetMin = serveOffsetMin + randInt(0, 30);

      const preparingAt = new Date(
        placedAt.getTime() + prepOffsetMin * 60 * 1000
      );
      const readyAt = new Date(placedAt.getTime() + readyOffsetMin * 60 * 1000);
      const servedAt = new Date(
        placedAt.getTime() + serveOffsetMin * 60 * 1000
      );
      const paidAt = new Date(placedAt.getTime() + payOffsetMin * 60 * 1000);

      await prisma.order.create({
        data: {
          storeId,
          tableId: table.id,
          status,
          note: null,
          totalCents,
          placedAt,
          ticketNumber: globalTicketNumber++,
          cancelReason: null,
          servedAt,
          preparingAt,
          readyAt,
          paidAt,
          cancelledAt: null,
          orderItems: {
            create: lines.map((line) => ({
              itemId: line.item.id,
              titleSnapshot: line.item.title,
              unitPriceCents: line.basePrice,
              quantity: line.quantity,
              orderItemOptions: {
                create: line.options.map((o) => ({
                  modifierId: o.modifierId,
                  modifierOptionId: o.option.id,
                  titleSnapshot: o.option.title,
                  priceDeltaCents: o.option.priceDeltaCents,
                })),
              },
            })),
          },
        },
      });
    }

    if (daysAgo > 0 && daysAgo % 10 === 0) {
      console.log(`...generated orders up to ${daysAgo} days ago`);
    }
  }

  console.log("Finished generating PAID orders for last 2 months.");
}

async function main() {
  try {
    await seed();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("db:seed failed:", err);
  process.exit(1);
});
