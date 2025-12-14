// prisma/seed.ts
import {
  PrismaClient,
  Role,
  OrderStatus,
  TableVisitStatus,
  ShiftStatus,
  PaymentStatus, // <-- required if DB has paymentStatus enum
} from "@prisma/client";
import bcrypt from "bcrypt";
import crypto from "crypto";

const prisma = new PrismaClient();

/**
 * =========================
 * Seed knobs
 * =========================
 */
const DAYS_BACK = 60;

// Intent:
// - Everything PAID except: 10 CANCELLED total per store (spread across past days)
// - On the most recent day: 3 PLACED, 3 PREPARING, 3 SERVED (unpaid), rest PAID
const CANCELLED_TOTAL_PER_STORE = 10;
const LAST_DAY_PLACED = 3;
const LAST_DAY_PREPARING = 3;
const LAST_DAY_SERVED = 3;

// SEED_RESET=0 -> do not wipe. Default wipes.
const SEED_RESET = process.env.SEED_RESET !== "0";

/**
 * =========================
 * Lightweight progress bars
 * =========================
 */
function bar(label: string, current: number, total: number, width = 28) {
  const pct = total === 0 ? 1 : current / total;
  const filled = Math.round(width * pct);
  const empty = Math.max(0, width - filled);
  const p = Math.round(pct * 100);
  const line = `${label} [${"█".repeat(filled)}${" ".repeat(empty)}] ${String(
    p
  ).padStart(3)}% (${current}/${total})`;
  process.stdout.write("\r" + line);
  if (current >= total) process.stdout.write("\n");
}
function section(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

/**
 * =========================
 * Data config
 * =========================
 */
type StoreConfig = {
  slug: string;
  name: string;
  currencyCode: string;
  locale: string;
  profiles: { email: string; role: Role; displayName: string }[];
  categories: {
    slug: string;
    title: string;
    items: { slug: string; title: string; priceCents: number }[];
  }[];
};

const STORES: StoreConfig[] = [
  {
    slug: "downtown-espresso",
    name: "Downtown Espresso Bar",
    currencyCode: "EUR",
    locale: "en",
    profiles: [
      {
        email: "manager@downtown-espresso.local",
        role: Role.MANAGER,
        displayName: "Downtown Manager",
      },
      {
        email: "waiter1@downtown-espresso.local",
        role: Role.WAITER,
        displayName: "Alex Barista",
      },
      {
        email: "cook1@downtown-espresso.local",
        role: Role.COOK,
        displayName: "Kitchen Mike",
      },
    ],
    categories: [
      {
        slug: "espresso-bar",
        title: "Espresso Bar",
        items: [
          {
            slug: "single-espresso",
            title: "Single Espresso",
            priceCents: 220,
          },
          {
            slug: "double-espresso",
            title: "Double Espresso",
            priceCents: 280,
          },
          {
            slug: "freddo-espresso",
            title: "Freddo Espresso",
            priceCents: 320,
          },
        ],
      },
      {
        slug: "milk-coffees",
        title: "Milk Coffees",
        items: [
          {
            slug: "cappuccino-classic",
            title: "Cappuccino Classic",
            priceCents: 340,
          },
          { slug: "flat-white", title: "Flat White", priceCents: 380 },
        ],
      },
      {
        slug: "pastries",
        title: "Pastries",
        items: [
          {
            slug: "butter-croissant",
            title: "Butter Croissant",
            priceCents: 250,
          },
          {
            slug: "chocolate-croissant",
            title: "Chocolate Croissant",
            priceCents: 280,
          },
        ],
      },
    ],
  },
  {
    slug: "harbor-breeze-lounge",
    name: "Harbor Breeze Lounge",
    currencyCode: "EUR",
    locale: "en",
    profiles: [
      {
        email: "manager@harbor-breeze.local",
        role: Role.MANAGER,
        displayName: "Harbor Manager",
      },
      {
        email: "waiter1@harbor-breeze.local",
        role: Role.WAITER,
        displayName: "Maria Waiter",
      },
      {
        email: "cook1@harbor-breeze.local",
        role: Role.COOK,
        displayName: "Sea Chef",
      },
    ],
    categories: [
      {
        slug: "cocktails",
        title: "Signature Cocktails",
        items: [
          { slug: "harbor-mojito", title: "Harbor Mojito", priceCents: 800 },
          { slug: "sunset-spritz", title: "Sunset Spritz", priceCents: 850 },
        ],
      },
      {
        slug: "spirits",
        title: "Spirits",
        items: [
          { slug: "single-whisky", title: "Single Whisky", priceCents: 700 },
          { slug: "gin-tonic", title: "Gin & Tonic", priceCents: 750 },
        ],
      },
      {
        slug: "bar-snacks",
        title: "Bar Snacks",
        items: [
          { slug: "nachos", title: "Loaded Nachos", priceCents: 650 },
          { slug: "cheese-platter", title: "Cheese Platter", priceCents: 1200 },
        ],
      },
    ],
  },
  {
    slug: "acropolis-street-food",
    name: "Acropolis Street Food",
    currencyCode: "EUR",
    locale: "el",
    profiles: [
      {
        email: "manager@acropolis-street.local",
        role: Role.MANAGER,
        displayName: "Acropolis Manager",
      },
      {
        email: "waiter1@acropolis-street.local",
        role: Role.WAITER,
        displayName: "Giannis Waiter",
      },
      {
        email: "cook1@acropolis-street.local",
        role: Role.COOK,
        displayName: "Grill Master",
      },
    ],
    categories: [
      {
        slug: "souvas",
        title: "Souvlaki",
        items: [
          { slug: "pita-pork", title: "Pita Pork Souvlaki", priceCents: 350 },
          {
            slug: "pita-chicken",
            title: "Pita Chicken Souvlaki",
            priceCents: 380,
          },
        ],
      },
      {
        slug: "plates",
        title: "Plates",
        items: [
          { slug: "gyro-plate", title: "Gyro Plate", priceCents: 900 },
          { slug: "mixed-grill", title: "Mixed Grill", priceCents: 1400 },
        ],
      },
      {
        slug: "drinks",
        title: "Drinks",
        items: [
          { slug: "cola-can", title: "Cola Can", priceCents: 200 },
          { slug: "beer-draft", title: "Draft Beer", priceCents: 450 },
        ],
      },
    ],
  },
];

/**
 * =========================
 * Helpers
 * =========================
 */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randFromArray<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}
function randomDateOnDay(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(randInt(60, 60 * 23));
  d.setSeconds(randInt(0, 59));
  return d;
}
function publicCode(): string {
  return crypto.randomBytes(16).toString("hex"); // 32 chars
}
function sessionToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
}
async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/**
 * =========================
 * RESET (dev only)
 * =========================
 */
async function resetAll() {
  section("Resetting DB");
  const steps = [
    async () => prisma.orderItemOption.deleteMany(),
    async () => prisma.orderItem.deleteMany(),
    async () => prisma.order.deleteMany(),

    async () => prisma.itemModifier.deleteMany(),
    async () => prisma.modifierOption.deleteMany(),
    async () => prisma.modifier.deleteMany(),

    async () => prisma.item.deleteMany(),
    async () => prisma.category.deleteMany(),

    async () => prisma.waiterTable.deleteMany(),
    async () => prisma.waiterShift.deleteMany(),

    async () => prisma.tableVisit.deleteMany(),
    async () => prisma.qRTile.deleteMany(),
    async () => prisma.table.deleteMany(),

    async () => prisma.auditLog.deleteMany(),
    async () => prisma.profile.deleteMany(),

    async () => prisma.kitchenCounter.deleteMany(),
    async () => prisma.storeMeta.deleteMany(),
    async () => prisma.store.deleteMany(),
  ];

  for (let i = 0; i < steps.length; i++) {
    bar("reset", i, steps.length);
    await steps[i]();
  }
  bar("reset", steps.length, steps.length);
}

/**
 * =========================
 * GLOBAL ARCHITECT
 * Requires schema changes:
 * - Profile.storeId nullable (String?)
 * - Profile.globalKey unique (String? @unique)
 * - @@unique([storeId, email]) still present
 * =========================
 */
async function seedGlobalArchitect() {
  section("Seeding global architect");

  const email = "architect@dome.local";
  const passwordHash = await hashPassword("changeme");

  await prisma.profile.upsert({
    where: { globalKey: email },
    update: {
      storeId: null,
      email,
      role: Role.ARCHITECT,
      displayName: "Central Architect",
      passwordHash,
      isVerified: true,
    },
    create: {
      storeId: null,
      globalKey: email,
      email,
      role: Role.ARCHITECT,
      displayName: "Central Architect",
      passwordHash,
      isVerified: true,
    },
  });

  bar("architect", 1, 1);
}

/**
 * =========================
 * Order/payment invariants
 * =========================
 */
function derivePaymentStatus(status: OrderStatus): PaymentStatus {
  // Works with typical enum: PENDING | COMPLETED | CANCELLED
  // If your enum differs, adjust here.
  if (status === OrderStatus.PAID) return PaymentStatus.COMPLETED;
  if (status === OrderStatus.CANCELLED) return PaymentStatus.CANCELLED;
  return PaymentStatus.PENDING;
}

function derivePaymentTimestamps(
  status: OrderStatus,
  placedAt: Date
): { paidAt?: Date; cancelledAt?: Date } {
  if (status === OrderStatus.PAID) {
    return {
      paidAt: new Date(placedAt.getTime() + 1000 * 60 * randInt(3, 60)),
    };
  }
  if (status === OrderStatus.CANCELLED) {
    return {
      cancelledAt: new Date(placedAt.getTime() + 1000 * 60 * randInt(1, 20)),
    };
  }
  return {};
}

/**
 * =========================
 * Per-store seed
 * =========================
 */
async function seedStore(
  cfg: StoreConfig,
  storeIndex: number,
  storeTotal: number
) {
  section(`Store ${storeIndex + 1}/${storeTotal}: ${cfg.slug}`);

  // Store + meta
  const store = await prisma.store.upsert({
    where: { slug: cfg.slug },
    update: { name: cfg.name },
    create: { slug: cfg.slug, name: cfg.name, settingsJson: {} },
  });

  const storeId = store.id;

  await prisma.storeMeta.upsert({
    where: { storeId },
    update: { currencyCode: cfg.currencyCode, locale: cfg.locale },
    create: { storeId, currencyCode: cfg.currencyCode, locale: cfg.locale },
  });

  // Profiles (per-store)
  const storePasswordHash = await hashPassword("changeme");
  const waiterIds: string[] = [];

  for (let i = 0; i < cfg.profiles.length; i++) {
    const p = cfg.profiles[i];
    const created = await prisma.profile.upsert({
      where: { storeId_email: { storeId, email: p.email } },
      update: {
        role: p.role,
        displayName: p.displayName,
        passwordHash: storePasswordHash,
        isVerified: true,
      },
      create: {
        storeId,
        email: p.email,
        role: p.role,
        displayName: p.displayName,
        passwordHash: storePasswordHash,
        isVerified: true,
      },
    });
    if (p.role === Role.WAITER) waiterIds.push(created.id);
    bar("store:profiles", i + 1, cfg.profiles.length);
  }

  // Tables
  const tables = await Promise.all(
    Array.from({ length: 10 }).map((_, i) =>
      prisma.table.upsert({
        where: { storeId_label: { storeId, label: `T${i + 1}` } },
        update: { isActive: true },
        create: { storeId, label: `T${i + 1}`, isActive: true },
      })
    )
  );

  // WaiterTable mapping
  let wtCount = 0;
  const wtTotal = waiterIds.length * tables.length;
  for (const waiterId of waiterIds) {
    for (const t of tables) {
      await prisma.waiterTable.upsert({
        where: {
          storeId_waiterId_tableId: { storeId, waiterId, tableId: t.id },
        },
        update: {},
        create: { storeId, waiterId, tableId: t.id },
      });
      wtCount++;
      bar("store:waiterTables", wtCount, Math.max(1, wtTotal));
    }
  }

  // QRTiles: schema only has publicCode unique => easiest is wipe per store and re-create
  await prisma.qRTile.deleteMany({ where: { storeId } });
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    await prisma.qRTile.create({
      data: {
        storeId,
        tableId: t.id,
        publicCode: publicCode(),
        label: `Tile ${t.label}`,
        isActive: true,
      },
    });
    bar("store:qrTiles", i + 1, tables.length);
  }
  const tiles = await prisma.qRTile.findMany({ where: { storeId } });

  // Menu
  const allItems: { id: string; title: string; priceCents: number }[] = [];
  for (let ci = 0; ci < cfg.categories.length; ci++) {
    const cat = cfg.categories[ci];

    const category = await prisma.category.upsert({
      where: { storeId_slug: { storeId, slug: cat.slug } },
      update: { title: cat.title, titleEl: cat.title, titleEn: cat.title },
      create: {
        storeId,
        slug: cat.slug,
        title: cat.title,
        titleEl: cat.title,
        titleEn: cat.title,
        sortOrder: 0,
      },
    });

    for (const it of cat.items) {
      const created = await prisma.item.upsert({
        where: { storeId_slug: { storeId, slug: it.slug } },
        update: {
          categoryId: category.id,
          title: it.title,
          titleEl: it.title,
          titleEn: it.title,
          priceCents: it.priceCents,
          isAvailable: true,
        },
        create: {
          storeId,
          categoryId: category.id,
          slug: it.slug,
          title: it.title,
          titleEl: it.title,
          titleEn: it.title,
          priceCents: it.priceCents,
          isAvailable: true,
          sortOrder: 0,
        },
      });
      allItems.push({
        id: created.id,
        title: created.title,
        priceCents: created.priceCents,
      });
    }

    bar("store:categories", ci + 1, cfg.categories.length);
  }

  // Modifiers graph
  const extras = await prisma.modifier.upsert({
    where: { storeId_slug: { storeId, slug: "extras" } },
    update: {
      title: "Extras",
      titleEl: "Extras",
      titleEn: "Extras",
      minSelect: 0,
      maxSelect: 2,
      isAvailable: true,
    },
    create: {
      storeId,
      slug: "extras",
      title: "Extras",
      titleEl: "Extras",
      titleEn: "Extras",
      minSelect: 0,
      maxSelect: 2,
      isAvailable: true,
    },
  });

  const extraCheese = await prisma.modifierOption.upsert({
    where: {
      storeId_modifierId_slug: {
        storeId,
        modifierId: extras.id,
        slug: "extra-cheese",
      },
    },
    update: {
      title: "Extra cheese",
      titleEl: "Extra cheese",
      titleEn: "Extra cheese",
      priceDeltaCents: 100,
      sortOrder: 1,
    },
    create: {
      storeId,
      modifierId: extras.id,
      slug: "extra-cheese",
      title: "Extra cheese",
      titleEl: "Extra cheese",
      titleEn: "Extra cheese",
      priceDeltaCents: 100,
      sortOrder: 1,
    },
  });

  const extraSauce = await prisma.modifierOption.upsert({
    where: {
      storeId_modifierId_slug: {
        storeId,
        modifierId: extras.id,
        slug: "extra-sauce",
      },
    },
    update: {
      title: "Extra sauce",
      titleEl: "Extra sauce",
      titleEn: "Extra sauce",
      priceDeltaCents: 50,
      sortOrder: 2,
    },
    create: {
      storeId,
      modifierId: extras.id,
      slug: "extra-sauce",
      title: "Extra sauce",
      titleEl: "Extra sauce",
      titleEn: "Extra sauce",
      priceDeltaCents: 50,
      sortOrder: 2,
    },
  });

  const attachCount = Math.max(1, Math.floor(allItems.length / 2));
  const attachItems = [...allItems]
    .sort(() => Math.random() - 0.5)
    .slice(0, attachCount);
  for (let i = 0; i < attachItems.length; i++) {
    const it = attachItems[i];
    await prisma.itemModifier.upsert({
      where: {
        storeId_itemId_modifierId: {
          storeId,
          itemId: it.id,
          modifierId: extras.id,
        },
      },
      update: { isRequired: false },
      create: {
        storeId,
        itemId: it.id,
        modifierId: extras.id,
        isRequired: false,
      },
    });
    bar("store:itemModifiers", i + 1, attachItems.length);
  }

  // Waiter shift
  const now = new Date();
  if (waiterIds.length > 0) {
    await prisma.waiterShift.create({
      data: {
        storeId,
        waiterId: waiterIds[0],
        startedAt: new Date(now.getTime() - 1000 * 60 * 60 * 3),
        status: ShiftStatus.ACTIVE,
      },
    });
  }

  // TableVisits
  for (let i = 0; i < 2; i++) {
    const t = randFromArray(tables);
    const tile = tiles.find((x) => x.tableId === t.id)!;
    await prisma.tableVisit.create({
      data: {
        storeId,
        tableId: t.id,
        tileId: tile.id,
        sessionToken: sessionToken(),
        status: TableVisitStatus.OPEN,
        expiresAt: new Date(now.getTime() + 1000 * 60 * 60 * 8),
      },
    });
    bar("store:visits", i + 1, 2);
  }

  // Orders
  section(`Orders for ${cfg.slug}`);
  let cancelledLeft = CANCELLED_TOTAL_PER_STORE;
  let lastDayPlacedLeft = LAST_DAY_PLACED;
  let lastDayPreparingLeft = LAST_DAY_PREPARING;
  let lastDayServedLeft = LAST_DAY_SERVED;

  const approxTotalOrders = DAYS_BACK * 12;
  let createdOrders = 0;

  for (let d = 0; d < DAYS_BACK; d++) {
    const day = new Date(now);
    day.setDate(now.getDate() - d);
    const isLastDay = d === 0;

    const ordersToday = isLastDay
      ? Math.max(20, randInt(15, 30))
      : randInt(5, 20);

    for (let i = 0; i < ordersToday; i++) {
      const table = randFromArray(tables);
      const item = randFromArray(allItems);
      const qty = randInt(1, 3);

      let status: OrderStatus = OrderStatus.PAID;

      if (isLastDay) {
        if (lastDayPlacedLeft > 0) {
          status = OrderStatus.PLACED;
          lastDayPlacedLeft--;
        } else if (lastDayPreparingLeft > 0) {
          status = OrderStatus.PREPARING;
          lastDayPreparingLeft--;
        } else if (lastDayServedLeft > 0) {
          status = OrderStatus.SERVED;
          lastDayServedLeft--;
        } else {
          status = OrderStatus.PAID;
        }
      } else if (cancelledLeft > 0) {
        status = OrderStatus.CANCELLED;
        cancelledLeft--;
      } else {
        status = OrderStatus.PAID;
      }

      const placedAt = randomDateOnDay(day);

      const preparingAt =
        status === OrderStatus.PREPARING ||
        status === OrderStatus.SERVED ||
        status === OrderStatus.PAID
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(1, 10))
          : undefined;

      const servedAt =
        status === OrderStatus.SERVED || status === OrderStatus.PAID
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(10, 45))
          : undefined;

      const { paidAt, cancelledAt } = derivePaymentTimestamps(status, placedAt);
      const paymentStatus = derivePaymentStatus(status);

      const baseTotal = item.priceCents * qty;

      const canHaveExtras = attachItems.some((x) => x.id === item.id);
      const addExtra = canHaveExtras && Math.random() < 0.35;
      const chosenExtra = addExtra
        ? randFromArray([extraCheese, extraSauce])
        : undefined;

      const totalCents =
        baseTotal + (chosenExtra ? chosenExtra.priceDeltaCents : 0);

      const order = await prisma.order.create({
        data: {
          storeId,
          tableId: table.id,
          status,
          totalCents,
          placedAt,
          preparingAt: preparingAt ?? undefined,
          servedAt: servedAt ?? undefined,
          paidAt: paidAt ?? undefined,
          cancelledAt: cancelledAt ?? undefined,
          cancelReason:
            status === OrderStatus.CANCELLED
              ? randFromArray(["Customer left", "Out of stock", "Duplicate"])
              : undefined,

          // <-- FIX for your crash:
          paymentStatus,
        },
      });

      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          itemId: item.id,
          titleSnapshot: item.title,
          unitPriceCents: item.priceCents,
          quantity: qty,
        },
      });

      if (chosenExtra) {
        await prisma.orderItemOption.create({
          data: {
            orderItemId: orderItem.id,
            modifierId: extras.id,
            modifierOptionId: chosenExtra.id,
            titleSnapshot: chosenExtra.title,
            priceDeltaCents: chosenExtra.priceDeltaCents,
          },
        });
      }

      createdOrders++;
      bar(
        "orders",
        Math.min(createdOrders, approxTotalOrders),
        approxTotalOrders
      );
    }

    bar("days", d + 1, DAYS_BACK);
  }
}

/**
 * =========================
 * Main
 * =========================
 */
async function main() {
  section("Seed start");

  if (SEED_RESET) await resetAll();
  else section("SEED_RESET=0 (no wipe)");

  await seedGlobalArchitect();

  for (let i = 0; i < STORES.length; i++) {
    await seedStore(STORES[i], i, STORES.length);
    bar("stores", i + 1, STORES.length);
  }

  section("Seed done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
