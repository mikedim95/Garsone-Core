// prisma/seed.ts
<<<<<<< HEAD

import { PrismaClient, Role, OrderStatus } from "@prisma/client";
import bcrypt from "bcrypt";
=======
import {
  PrismaClient,
  Role,
  OrderStatus,
  PaymentStatus,
  TableVisitStatus,
  ShiftStatus,
} from "@prisma/client";
import bcrypt from "bcrypt";
import crypto from "crypto";
>>>>>>> stage

const prisma = new PrismaClient();
const DAYS_BACK = 60;

<<<<<<< HEAD
type StoreConfig = {
  slug: string;
  name: string;
  currencyCode: string;
  locale: string;
  profiles: {
    email: string;
    role: Role;
    displayName: string;
  }[];
  categories: {
    slug: string;
    title: string;
    items: {
      slug: string;
      title: string;
      priceCents: number;
    }[];
  }[];
};

=======
// =========================
// Seed knobs
// =========================
const DAYS_BACK = 60;

// Keep the same intent you used before:
// - Everything PAID except: 10 cancelled total per store (spread across the past)
// - On the most recent day: 3 placed, 3 preparing, 3 served (unpaid), rest paid
const CANCELLED_TOTAL_PER_STORE = 10;
const LAST_DAY_PLACED = 3;
const LAST_DAY_PREPARING = 3;
const LAST_DAY_SERVED = 3;

// Optional: set SEED_RESET=0 to avoid wiping (default wipes)
const SEED_RESET = process.env.SEED_RESET !== "0";

// =========================
// Data config
// =========================
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

>>>>>>> stage
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

<<<<<<< HEAD
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFromArray<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

function randomDateOnDay(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(randInt(60, 60 * 23)); // somewhere during the day
  return d;
}

=======
// =========================
// Helpers
// =========================
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
  // 32 chars, matches schema @db.VarChar(32)
  return crypto.randomBytes(16).toString("hex");
}
function sessionToken(): string {
  // 64 chars, matches schema @db.VarChar(64)
  return crypto.randomBytes(32).toString("hex");
}
>>>>>>> stage
async function hashPassword(): Promise<string> {
  return bcrypt.hash("changeme", 10);
}

<<<<<<< HEAD
async function seedStore(cfg: StoreConfig) {
  console.log(`\nSeeding store: ${cfg.slug}`);

  // Create store
  const store = await prisma.store.create({
    data: {
      slug: cfg.slug,
      name: cfg.name,
      settingsJson: {},
    },
  });

  const storeId = store.id;

  // StoreMeta
  await prisma.storeMeta.create({
    data: {
      storeId,
      currencyCode: cfg.currencyCode,
      locale: cfg.locale,
    },
  });

  // Profiles
  const passwordHash = await hashPassword();
  const waiterProfiles: { id: string }[] = [];
=======
async function resetAll() {
  // Order matters (FK constraints)
  await prisma.orderItemOption.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();

  await prisma.itemModifier.deleteMany();
  await prisma.modifierOption.deleteMany();
  await prisma.modifier.deleteMany();

  await prisma.item.deleteMany();
  await prisma.category.deleteMany();

  await prisma.waiterTable.deleteMany();
  await prisma.waiterShift.deleteMany();

  await prisma.tableVisit.deleteMany();
  await prisma.qRTile.deleteMany();
  await prisma.table.deleteMany();

  await prisma.auditLog.deleteMany();
  await prisma.profile.deleteMany();

  await prisma.kitchenCounter.deleteMany();
  await prisma.storeMeta.deleteMany();
  await prisma.store.deleteMany();
}

async function seedStore(cfg: StoreConfig) {
  console.log(`\nSeeding store: ${cfg.slug}`);

  const store = await prisma.store.create({
    data: { slug: cfg.slug, name: cfg.name, settingsJson: {} },
  });
  const storeId = store.id;

  await prisma.storeMeta.create({
    data: { storeId, currencyCode: cfg.currencyCode, locale: cfg.locale },
  });

  // Profiles
  const passwordHash = await hashPassword();
  const waiterIds: string[] = [];
>>>>>>> stage

  for (const p of cfg.profiles) {
    const created = await prisma.profile.create({
      data: {
        storeId,
        email: p.email,
        passwordHash,
        role: p.role,
        displayName: p.displayName,
<<<<<<< HEAD
      },
    });

    if (p.role === Role.WAITER) {
      waiterProfiles.push({ id: created.id });
    }
=======
        isVerified: true,
      },
    });
    if (p.role === Role.WAITER) waiterIds.push(created.id);
>>>>>>> stage
  }

  // Tables T1..T10
  const tables = await Promise.all(
    Array.from({ length: 10 }).map((_, i) =>
      prisma.table.create({
<<<<<<< HEAD
        data: {
          storeId,
          label: `T${i + 1}`,
=======
        data: { storeId, label: `T${i + 1}`, isActive: true },
      })
    )
  );

  // Assign waiter(s) to all tables
  for (const waiterId of waiterIds) {
    for (const table of tables) {
      await prisma.waiterTable.create({
        data: { storeId, waiterId, tableId: table.id },
      });
    }
  }

  // QR tiles (1 per table)
  const tiles = await Promise.all(
    tables.map((t) =>
      prisma.qRTile.create({
        data: {
          storeId,
          tableId: t.id,
          publicCode: publicCode(),
          label: `Tile ${t.label}`,
>>>>>>> stage
          isActive: true,
        },
      })
    )
  );

<<<<<<< HEAD
  // Link all waiters to all tables in this store
  for (const waiter of waiterProfiles) {
    for (const table of tables) {
      await prisma.waiterTable.create({
        data: {
          storeId,
          waiterId: waiter.id,
          tableId: table.id,
=======
  // Some OPEN table visits (so your QR flow has real sessions)
  // 2 per store, expiring in 8 hours
  const now = new Date();
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
  }

  // Menu: categories + items
  const allItems: { id: string; title: string; priceCents: number }[] = [];
  for (const cat of cfg.categories) {
    const category = await prisma.category.create({
      data: {
        storeId,
        slug: cat.slug,
        title: cat.title,
        sortOrder: 0,
        titleEl: cat.title,
        titleEn: cat.title,
      },
    });

    for (const it of cat.items) {
      const created = await prisma.item.create({
        data: {
          storeId,
          categoryId: category.id,
          slug: it.slug,
          title: it.title,
          titleEl: it.title,
          titleEn: it.title,
          priceCents: it.priceCents,
          isAvailable: true,
          sortOrder: 0,
>>>>>>> stage
        },
      });
      allItems.push({
        id: created.id,
        title: created.title,
        priceCents: created.priceCents,
      });
    }
  }

<<<<<<< HEAD
  // Categories + Items
  const allItems: {
    id: string;
    title: string;
    priceCents: number;
  }[] = [];

  for (const cat of cfg.categories) {
    const category = await prisma.category.create({
      data: {
        storeId,
        slug: cat.slug,
        title: cat.title,
        sortOrder: 0,
        titleEl: cat.title,
        titleEn: cat.title,
      },
    });

    for (const it of cat.items) {
      const created = await prisma.item.create({
        data: {
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
  }

  // Orders over last 60 days
  const now = new Date();

  let cancelledLeft = 10;
  let placedLeft = 3;
  let preparingLeft = 3;
  let servedLeft = 3;

  for (let d = 0; d < DAYS_BACK; d++) {
    const date = new Date(now);
    date.setDate(now.getDate() - d);
=======
  // Modifiers (minimal but complete graph: Modifier -> Options -> ItemModifier -> OrderItemOption)
  // 1) "Extras" (optional)
  const extras = await prisma.modifier.create({
    data: {
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

  const extraOptions = await Promise.all([
    prisma.modifierOption.create({
      data: {
        storeId,
        modifierId: extras.id,
        slug: "extra-cheese",
        title: "Extra cheese",
        titleEl: "Extra cheese",
        titleEn: "Extra cheese",
        priceDeltaCents: 100,
        sortOrder: 1,
      },
    }),
    prisma.modifierOption.create({
      data: {
        storeId,
        modifierId: extras.id,
        slug: "extra-sauce",
        title: "Extra sauce",
        titleEl: "Extra sauce",
        titleEn: "Extra sauce",
        priceDeltaCents: 50,
        sortOrder: 2,
      },
    }),
  ]);

  // Attach modifier to ~half items
  const attachCount = Math.max(1, Math.floor(allItems.length / 2));
  const shuffledItems = [...allItems]
    .sort(() => Math.random() - 0.5)
    .slice(0, attachCount);
  for (const it of shuffledItems) {
    await prisma.itemModifier.create({
      data: {
        storeId,
        itemId: it.id,
        modifierId: extras.id,
        isRequired: false,
      },
    });
  }

  // Waiter shift (so dashboards can show it)
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

  // Orders over last 60 days
  let cancelledLeft = CANCELLED_TOTAL_PER_STORE;
  let lastDayPlacedLeft = LAST_DAY_PLACED;
  let lastDayPreparingLeft = LAST_DAY_PREPARING;
  let lastDayServedLeft = LAST_DAY_SERVED;

  for (let d = 0; d < DAYS_BACK; d++) {
    const day = new Date(now);
    day.setDate(now.getDate() - d);
>>>>>>> stage
    const isLastDay = d === 0;

    const ordersToday = isLastDay
      ? Math.max(20, randInt(15, 30))
      : randInt(5, 20);

    for (let i = 0; i < ordersToday; i++) {
      const table = randFromArray(tables);
      const item = randFromArray(allItems);
      const qty = randInt(1, 3);

<<<<<<< HEAD
      let status: OrderStatus = OrderStatus.PAID;

      if (isLastDay) {
        if (placedLeft > 0) {
          status = OrderStatus.PLACED;
          placedLeft--;
        } else if (preparingLeft > 0) {
          status = OrderStatus.PREPARING;
          preparingLeft--;
        } else if (servedLeft > 0) {
          status = OrderStatus.SERVED;
          servedLeft--;
        } else {
          status = OrderStatus.PAID;
        }
      } else if (cancelledLeft > 0) {
        status = OrderStatus.CANCELLED;
        cancelledLeft--;
      } else {
        status = OrderStatus.PAID;
      }

      const placedAt = randomDateOnDay(date);
      const paidAt =
        status === OrderStatus.PAID
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(5, 60))
          : null;
      const cancelledAt =
        status === OrderStatus.CANCELLED
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(1, 30))
          : null;
      const servedAt =
        status === OrderStatus.SERVED
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(5, 40))
          : null;
      const preparingAt =
        status === OrderStatus.PREPARING
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(1, 10))
          : null;
=======
      // Default: paid historical orders
      let status: OrderStatus = OrderStatus.PAID;
      let paymentStatus: PaymentStatus = PaymentStatus.COMPLETED;

      if (isLastDay) {
        // Keep a few active/unpaid orders on "today"
        if (lastDayPlacedLeft > 0) {
          status = OrderStatus.PLACED;
          paymentStatus = PaymentStatus.PENDING;
          lastDayPlacedLeft--;
        } else if (lastDayPreparingLeft > 0) {
          status = OrderStatus.PREPARING;
          paymentStatus = PaymentStatus.PENDING;
          lastDayPreparingLeft--;
        } else if (lastDayServedLeft > 0) {
          status = OrderStatus.SERVED;
          paymentStatus = PaymentStatus.PENDING;
          lastDayServedLeft--;
        } else {
          status = OrderStatus.PAID;
          paymentStatus = PaymentStatus.COMPLETED;
        }
      } else if (cancelledLeft > 0) {
        status = OrderStatus.CANCELLED;
        paymentStatus = PaymentStatus.CANCELLED;
        cancelledLeft--;
      } else {
        status = OrderStatus.PAID;
        paymentStatus = PaymentStatus.COMPLETED;
      }

      const placedAt = randomDateOnDay(day);

      // Timestamps aligned to both order status + paymentStatus
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

      const paidAt =
        paymentStatus === PaymentStatus.COMPLETED
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(3, 60))
          : undefined;

      const cancelledAt =
        status === OrderStatus.CANCELLED
          ? new Date(placedAt.getTime() + 1000 * 60 * randInt(1, 20))
          : undefined;

      // Optional payment details
      const paymentProvider =
        paymentStatus === PaymentStatus.COMPLETED ? "VIVA" : undefined;
      const paymentId =
        paymentStatus === PaymentStatus.COMPLETED
          ? `pay_${crypto.randomBytes(8).toString("hex")}`
          : undefined;

      const baseTotal = item.priceCents * qty;

      // If item has the modifier attached, sometimes add 1 option
      const canHaveExtras = shuffledItems.some((x) => x.id === item.id);
      const addExtra = canHaveExtras && Math.random() < 0.35;
      const chosenExtra = addExtra ? randFromArray(extraOptions) : undefined;

      const totalCents =
        baseTotal + (chosenExtra ? chosenExtra.priceDeltaCents : 0);
>>>>>>> stage

      const order = await prisma.order.create({
        data: {
          storeId,
          tableId: table.id,
          status,
<<<<<<< HEAD
          totalCents: item.priceCents * qty,
          placedAt,
          paidAt: paidAt ?? undefined,
          cancelledAt: cancelledAt ?? undefined,
          servedAt: servedAt ?? undefined,
          preparingAt: preparingAt ?? undefined,
        },
      });

      await prisma.orderItem.create({
=======
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

          paymentStatus,
          paymentProvider: paymentProvider ?? undefined,
          paymentId: paymentId ?? undefined,
          paymentError:
            paymentStatus === PaymentStatus.FAILED
              ? "Simulated payment failure"
              : undefined,
        },
      });

      const orderItem = await prisma.orderItem.create({
>>>>>>> stage
        data: {
          orderId: order.id,
          itemId: item.id,
          titleSnapshot: item.title,
          unitPriceCents: item.priceCents,
          quantity: qty,
        },
      });
<<<<<<< HEAD
=======

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
>>>>>>> stage
    }
  }

  console.log(`Seeded store: ${cfg.slug}`);
}

async function main() {
  console.log("Starting seed...");

<<<<<<< HEAD
  for (const store of STORES) {
    await seedStore(store);
  }

=======
  if (SEED_RESET) {
    console.log("Resetting DB...");
    await resetAll();
  }

  for (const store of STORES) {
    await seedStore(store);
  }

>>>>>>> stage
  console.log("Seed completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
