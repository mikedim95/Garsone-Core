// prisma/store_onboard_seed.ts
//
// Usage:
//   1. Adjust NEW_STORE_CONFIG below.
//   2. Run: npx ts-node prisma/store_onboard_seed.ts
//      (or add npm script: "onboard:store": "ts-node prisma/store_onboard_seed.ts")
//
// What it does:
//   - Creates 1 Store + StoreMeta
//   - Creates 1 manager, 1 waiter, 1 cook
//   - Creates 10 tables (T1..T10)
//   - Creates 1 QRTile per table
//   - Assigns waiter to all tables
//   - Optionally seeds a demo menu + N days of orders using all OrderStatus values

import { PrismaClient, Role, OrderStatus } from "@prisma/client";
import bcrypt from "bcrypt";
import { randomBytes } from "crypto";
import { applyDbConnection } from "../src/db/config";

const { target: dbTarget, databaseUrl } = applyDbConnection();

try {
  const { hostname, pathname } = new URL(databaseUrl);
  const dbName = pathname?.replace("/", "") || "";
  console.log(
    `[store_onboard_seed] DB_CONNECTION=${dbTarget} -> ${hostname}${
      dbName ? `/${dbName}` : ""
    }`
  );
} catch {
  console.log(`[store_onboard_seed] DB_CONNECTION=${dbTarget}`);
}

const prisma = new PrismaClient();

// =====================
// CONFIG – FILL THESE
// =====================

const NEW_STORE_CONFIG = {
  slug: "random-test-store-from-seed", // MUST be unique
  name: "Random Test Store",
  currencyCode: "EUR",
  locale: "el",

  manager: {
    email: "manager@random-test-store.local",
    displayName: "Store Manager",
  },
  waiter: {
    email: "waiter@random-test-store.local",
    displayName: "Main Waiter",
  },
  cook: {
    email: "cook@random-test-store.local",
    displayName: "Head Cook",
  },
  cookType: {
    slug: "kitchen",
    title: "Kitchen",
    printerTopic: "printer_1",
  },
  waiterType: {
    slug: "floor",
    title: "Floor",
    printerTopic: "printer_1",
  },

  // All 3 profiles will use this password.
  defaultPassword: "changeme",
};

// Toggle this to also create demo menu + orders
const CREATE_DEMO_MENU_AND_ORDERS = true;

// How many days back to create sample orders (if enabled)
const DAYS_BACK = 60;
const DEMO_PRINTER_TOPIC =
  NEW_STORE_CONFIG.cookType.printerTopic || "printer_1";

// Simple demo menu used when CREATE_DEMO_MENU_AND_ORDERS === true.
const DEMO_MENU: {
  slug: string;
  title: string;
  titleEl: string;
  titleEn: string;
  printerTopic?: string;
  items: {
    slug: string;
    title: string;
    titleEl: string;
    titleEn: string;
    description?: string | null;
    descriptionEl?: string | null;
    descriptionEn?: string | null;
    priceCents: number;
    costCents?: number | null;
    imageUrl?: string | null;
  }[];
}[] = [
  {
    slug: "coffee",
    title: "Coffee",
    titleEl: "Καφές",
    titleEn: "Coffee",
    items: [
      {
        slug: "espresso-single",
        title: "Espresso Single",
        titleEl: "Εσπρέσο Μονός",
        titleEn: "Espresso Single",
        description: "Single espresso shot",
        descriptionEl: "Μονός εσπρέσο",
        descriptionEn: "Single espresso shot",
        priceCents: 250,
        costCents: 70,
        imageUrl: null,
      },
      {
        slug: "espresso-double",
        title: "Espresso Double",
        titleEl: "Εσπρέσο Διπλός",
        titleEn: "Espresso Double",
        description: "Double espresso shot",
        descriptionEl: "Διπλός εσπρέσο",
        descriptionEn: "Double espresso shot",
        priceCents: 300,
        costCents: 90,
        imageUrl: null,
      },
      {
        slug: "freddo-espresso",
        title: "Freddo Espresso",
        titleEl: "Φρέντο Εσπρέσο",
        titleEn: "Freddo Espresso",
        description: "Iced espresso over ice",
        descriptionEl: "Κρύος εσπρέσο με πάγο",
        descriptionEn: "Iced espresso over ice",
        priceCents: 350,
        costCents: 100,
        imageUrl: null,
      },
    ],
  },
  {
    slug: "cold-drinks",
    title: "Cold Drinks",
    titleEl: "Κρύα Ροφήματα",
    titleEn: "Cold Drinks",
    items: [
      {
        slug: "cola-330",
        title: "Cola 330ml",
        titleEl: "Κόλα 330ml",
        titleEn: "Cola 330ml",
        description: "Soft drink 330ml",
        descriptionEl: "Αναψυκτικό 330ml",
        descriptionEn: "Soft drink 330ml",
        priceCents: 250,
        costCents: 80,
        imageUrl: null,
      },
      {
        slug: "orange-juice",
        title: "Orange Juice",
        titleEl: "Χυμός Πορτοκάλι",
        titleEn: "Orange Juice",
        description: "Fresh orange juice (glass)",
        descriptionEl: "Φρεσκοστυμμένος χυμός πορτοκάλι",
        descriptionEn: "Fresh orange juice",
        priceCents: 400,
        costCents: 150,
        imageUrl: null,
      },
    ],
  },
  {
    slug: "snacks",
    title: "Snacks",
    titleEl: "Σνακ",
    titleEn: "Snacks",
    items: [
      {
        slug: "toast-ham-cheese",
        title: "Ham & Cheese Toast",
        titleEl: "Τοστ Ζαμπόν Τυρί",
        titleEn: "Ham & Cheese Toast",
        description: "Classic toast with ham and cheese",
        descriptionEl: "Κλασικό τοστ με ζαμπόν και τυρί",
        descriptionEn: "Classic toast with ham and cheese",
        priceCents: 350,
        costCents: 120,
        imageUrl: null,
      },
      {
        slug: "club-sandwich",
        title: "Club Sandwich",
        titleEl: "Κλαμπ Σάντουιτς",
        titleEn: "Club Sandwich",
        description: "Triple sandwich with fries",
        descriptionEl: "Τριπλό σάντουιτς με πατάτες",
        descriptionEn: "Triple sandwich with fries",
        priceCents: 750,
        costCents: 300,
        imageUrl: null,
      },
    ],
  },
];

// =====================
// HELPERS
// =====================

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFromArray<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeSlug(value: string) {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  return raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function normalizePrinterTopic(value?: string | null, fallback?: string | null) {
  const raw = (value || fallback || "").trim().toLowerCase();
  if (!raw) return null;
  const sanitized = raw
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
  return sanitized || null;
}

function randomTimeOnDay(base: Date): Date {
  const d = new Date(base);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(randInt(60, 60 * 23)); // somewhere during the day
  return d;
}

function randomPublicCode(): string {
  // 16 hex chars -> fits @db.VarChar(32) easily
  return randomBytes(8).toString("hex");
}

// =====================
// MAIN LOGIC
// =====================

async function onboardStore() {
  const cfg = NEW_STORE_CONFIG;

  if (!cfg.slug || !cfg.name) {
    throw new Error(
      "Please fill NEW_STORE_CONFIG.slug and NEW_STORE_CONFIG.name"
    );
  }

  console.log(`\nOnboarding new store: ${cfg.slug}`);

  const existing = await prisma.store.findUnique({
    where: { slug: cfg.slug },
  });

  if (existing) {
    throw new Error(
      `Store with slug "${cfg.slug}" already exists (id=${existing.id}).`
    );
  }

  // Store
  const store = await prisma.store.create({
    data: {
      slug: cfg.slug,
      name: cfg.name,
      settingsJson: { printers: [DEMO_PRINTER_TOPIC] },
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

  const cookTypeConfig = cfg.cookType;
  const cookTypeSlug = cookTypeConfig
    ? normalizeSlug(cookTypeConfig.slug || cookTypeConfig.title || "cook")
    : "";
  const cookType =
    cookTypeConfig && cookTypeSlug
      ? await prisma.cookType.create({
          data: {
            storeId,
            slug: cookTypeSlug,
            title: cookTypeConfig.title,
            printerTopic:
              normalizePrinterTopic(
                cookTypeConfig.printerTopic,
                cookTypeSlug
              ) ?? cookTypeSlug,
          },
        })
      : null;

  const waiterTypeConfig = cfg.waiterType;
  const waiterTypeSlug = waiterTypeConfig
    ? normalizeSlug(waiterTypeConfig.slug || waiterTypeConfig.title || "waiter")
    : "";
  const waiterType =
    waiterTypeConfig && waiterTypeSlug
      ? await prisma.waiterType.create({
          data: {
            storeId,
            slug: waiterTypeSlug,
            title: waiterTypeConfig.title,
            printerTopic:
              normalizePrinterTopic(
                waiterTypeConfig.printerTopic,
                waiterTypeSlug
              ) ?? waiterTypeSlug,
          },
        })
      : null;

  // Profiles (manager, waiter, cook)
  const passwordHash = await bcrypt.hash(cfg.defaultPassword, 10);

  const manager = await prisma.profile.create({
    data: {
      storeId,
      email: cfg.manager.email,
      passwordHash,
      role: Role.MANAGER,
      displayName: cfg.manager.displayName,
      isVerified: true,
    },
  });

  const waiter = await prisma.profile.create({
    data: {
      storeId,
      email: cfg.waiter.email,
      passwordHash,
      role: Role.WAITER,
      displayName: cfg.waiter.displayName,
      isVerified: true,
      waiterTypeId: waiterType?.id ?? null,
    },
  });

  const cook = await prisma.profile.create({
    data: {
      storeId,
      email: cfg.cook.email,
      passwordHash,
      role: Role.COOK,
      displayName: cfg.cook.displayName,
      isVerified: true,
      cookTypeId: cookType?.id ?? null,
    },
  });

  console.log("Created profiles:", {
    managerId: manager.id,
    waiterId: waiter.id,
    cookId: cook.id,
  });

  // Tables T1..T10
  const tables = await Promise.all(
    Array.from({ length: 10 }).map((_, i) =>
      prisma.table.create({
        data: {
          storeId,
          label: `T${i + 1}`,
          isActive: true,
        },
      })
    )
  );

  // QRTiles: one per table
  const qrTiles = await Promise.all(
    tables.map((table) =>
      prisma.qRTile.create({
        data: {
          storeId,
          tableId: table.id,
          publicCode: randomPublicCode(),
          label: `QR ${table.label}`,
          isActive: true,
        },
      })
    )
  );

  // Waiter-table assignments: waiter -> all tables
  for (const table of tables) {
    await prisma.waiterTable.create({
      data: {
        storeId,
        waiterId: waiter.id,
        tableId: table.id,
      },
    });
  }

  console.log(
    `Created ${tables.length} tables, ${qrTiles.length} QR tiles, and waiter assignments.`
  );

  if (!CREATE_DEMO_MENU_AND_ORDERS) {
    console.log("Skipping demo menu and orders (flag is false).");
    console.log(`Onboarding for store "${cfg.slug}" completed.`);
    return;
  }

  // Demo categories & items
  const allItems: { id: string; priceCents: number; title: string }[] = [];

  let sortOrder = 0;
  for (const cat of DEMO_MENU) {
    const categoryPrinterTopic = (
      normalizePrinterTopic(cat.printerTopic, DEMO_PRINTER_TOPIC || cat.slug) ||
      cat.slug
    ).slice(0, 255);
    const createdCat = await prisma.category.create({
      data: {
        storeId,
        slug: cat.slug,
        title: cat.title,
        sortOrder: sortOrder++,
        titleEl: cat.titleEl,
        titleEn: cat.titleEn,
        printerTopic: categoryPrinterTopic,
      },
    });

    for (const item of cat.items) {
      const createdItem = await prisma.item.create({
        data: {
          storeId,
          categoryId: createdCat.id,
          slug: item.slug,
          title: item.title,
          description: item.description ?? null,
          priceCents: item.priceCents,
          isAvailable: true,
          sortOrder: 0,
          imageUrl: item.imageUrl ?? null,
          costCents: item.costCents ?? null,
          descriptionEl: item.descriptionEl ?? null,
          descriptionEn: item.descriptionEn ?? null,
          titleEl: item.titleEl,
          titleEn: item.titleEn,
          printerTopic: categoryPrinterTopic,
        },
      });

      allItems.push({
        id: createdItem.id,
        priceCents: createdItem.priceCents,
        title: createdItem.title,
      });
    }
  }

  console.log(
    `Created demo menu: ${DEMO_MENU.length} categories, ${allItems.length} items.`
  );

  // Sample orders for last N days
  if (allItems.length === 0) {
    console.log("No items created; skipping orders seeding.");
  } else {
    const now = new Date();

    for (let d = 0; d < DAYS_BACK; d++) {
      const date = new Date(now);
      date.setDate(now.getDate() - d);
      const isLastDay = d === 0;

      const ordersToday = isLastDay
        ? Math.max(20, randInt(15, 30))
        : randInt(5, 20);

      for (let i = 0; i < ordersToday; i++) {
        const table = randFromArray(tables);
        const item = randFromArray(allItems);
        const qty = randInt(1, 3);

        // Default majority paid
        let status: OrderStatus = OrderStatus.PAID;

        if (isLastDay) {
          const roll = Math.random();
          if (roll < 0.05) status = OrderStatus.CANCELLED;
          else if (roll < 0.1) status = OrderStatus.PLACED;
          else if (roll < 0.15) status = OrderStatus.PREPARING;
          else if (roll < 0.2) status = OrderStatus.READY;
          else if (roll < 0.25) status = OrderStatus.SERVED;
          // else keep PAID
        } else {
          // Old days: mostly PAID with some CANCELLED
          if (Math.random() < 0.08) {
            status = OrderStatus.CANCELLED;
          }
        }

        const placedAt = randomTimeOnDay(date);

        // Build a plausible timeline:
        let preparingAt: Date | null = null;
        let readyAt: Date | null = null;
        let servedAt: Date | null = null;
        let paidAt: Date | null = null;
        let cancelledAt: Date | null = null;

        if (status === OrderStatus.CANCELLED) {
          // Cancel soon after placing
          cancelledAt = new Date(
            placedAt.getTime() + 1000 * 60 * randInt(1, 20)
          );
        } else {
          // Went at least to preparing
          preparingAt = new Date(
            placedAt.getTime() + 1000 * 60 * randInt(1, 10)
          );

          if (
            status === OrderStatus.READY ||
            status === OrderStatus.SERVED ||
            status === OrderStatus.PAID
          ) {
            readyAt = new Date(
              preparingAt.getTime() + 1000 * 60 * randInt(2, 15)
            );
          }

          if (status === OrderStatus.SERVED || status === OrderStatus.PAID) {
            servedAt = new Date(
              (readyAt ?? preparingAt).getTime() + 1000 * 60 * randInt(1, 10)
            );
          }

          if (status === OrderStatus.PAID) {
            paidAt = new Date(
              (servedAt ?? readyAt ?? preparingAt ?? placedAt).getTime() +
                1000 * 60 * randInt(1, 20)
            );
          }
        }

        const order = await prisma.order.create({
          data: {
            storeId,
            tableId: table.id,
            status,
            note: null,
            totalCents: item.priceCents * qty,
            placedAt,
            ticketNumber: i + 1,
            cancelledAt: cancelledAt ?? undefined,
            paidAt: paidAt ?? undefined,
            preparingAt: preparingAt ?? undefined,
            readyAt: readyAt ?? undefined,
            servedAt: servedAt ?? undefined,
          },
        });

        await prisma.orderItem.create({
          data: {
            orderId: order.id,
            itemId: item.id,
            titleSnapshot: item.title,
            unitPriceCents: item.priceCents,
            quantity: qty,
          },
        });
      }
    }

    console.log(`Created demo orders for last ${DAYS_BACK} days.`);
  }

  console.log(`Onboarding for store "${cfg.slug}" completed with demo data.`);
}

onboardStore()
  .catch((err) => {
    console.error("Error while onboarding store:");
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
