// prisma/store_onboard_seed.ts
//
// Usage:
//   STORE_SLUG=noor STORE_NAME=Noor DEFAULT_PASSWORD=... npm run onboard:store
//
// What it does:
//   - Creates 1 Store + StoreMeta
//   - Creates 1 manager, 1 waiter, 1 cook
//   - Creates 10 tables (T1..T10)
//   - Assigns waiter to all tables
//   - Does NOT create QR tiles (architect dashboard generates them)
//   - Optionally seeds demo menu + orders when CREATE_DEMO_MENU_AND_ORDERS=true

import { PrismaClient, Role, OrderStatus } from "@prisma/client";
import bcrypt from "bcrypt";
import "dotenv/config";
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

function env(name: string, fallback = ""): string {
  return (process.env[name] ?? fallback).trim();
}

// =====================
// CONFIG – FILL THESE
// =====================

const NEW_STORE_CONFIG = {
  slug: env("STORE_SLUG", "noor"), // MUST be unique
  name: env("STORE_NAME", "Noor"),
  currencyCode: env("STORE_CURRENCY", "EUR"),
  locale: env("STORE_LOCALE", "el"),

  manager: {
    email: env("MANAGER_EMAIL", "manager@noor.local"),
    displayName: env("MANAGER_NAME", "Noor Manager"),
  },
  waiter: {
    email: env("WAITER_EMAIL", "waiter@noor.local"),
    displayName: env("WAITER_NAME", "Noor Waiter"),
  },
  cook: {
    email: env("COOK_EMAIL", "cook@noor.local"),
    displayName: env("COOK_NAME", "Noor Cook"),
  },
  cookType: {
    slug: env("COOK_TYPE_SLUG", "kitchen"),
    title: env("COOK_TYPE_TITLE", "Kitchen"),
    printerTopic: env("PRINTER_TOPIC", "printer_1"),
  },
  waiterType: {
    slug: env("WAITER_TYPE_SLUG", "floor"),
    title: env("WAITER_TYPE_TITLE", "Floor"),
    printerTopic: env("PRINTER_TOPIC", "printer_1"),
  },

  // All 3 profiles will use this password.
  defaultPassword: env("DEFAULT_PASSWORD"),
};

// Toggle this to also create demo menu + orders
const CREATE_DEMO_MENU_AND_ORDERS =
  env("CREATE_DEMO_MENU_AND_ORDERS", "false").toLowerCase() === "true";

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
    subcategoryEn?: string | null;
    subcategoryEl?: string | null;
    description?: string | null;
    descriptionEl?: string | null;
    descriptionEn?: string | null;
    priceCents: number;
    costCents?: number | null;
    imageUrl?: string | null;
  }[];
}[] = [
  {
    slug: "souvlaki",
    title: "Souvlaki",
    titleEl: "Σουβλάκι",
    titleEn: "Souvlaki",
    printerTopic: "printer_1",
    items: [
      {
        slug: "pita-pork",
        title: "Pita Pork",
        titleEl: "Πίτα Χοιρινό",
        titleEn: "Pita Pork",
        subcategoryEn: "Pita Wraps",
        subcategoryEl: "Τυλιχτά Πίτας",
        description: "Pita wrap with pork gyro, fries, onion and tzatziki.",
        descriptionEl: "Τυλιχτή πίτα με χοιρινό γύρο, πατάτες, κρεμμύδι και τζατζίκι.",
        descriptionEn: "Pita wrap with pork gyro, fries, onion and tzatziki.",
        priceCents: 350,
        costCents: 120,
        imageUrl:
          "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/souvlaki/pita-pork.jpg",
      },
      {
        slug: "pita-chicken",
        title: "Pita Chicken",
        titleEl: "Πίτα Κοτόπουλο",
        titleEn: "Pita Chicken",
        subcategoryEn: "Pita Wraps",
        subcategoryEl: "Τυλιχτά Πίτας",
        description: "Pita wrap with chicken gyro, fries, tomato and tzatziki.",
        descriptionEl: "Τυλιχτή πίτα με γύρο κοτόπουλο, πατάτες, ντομάτα και τζατζίκι.",
        descriptionEn: "Pita wrap with chicken gyro, fries, tomato and tzatziki.",
        priceCents: 380,
        costCents: 130,
        imageUrl:
          "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/souvlaki/pita-chicken.jpg",
      },
    ],
  },
  {
    slug: "plates",
    title: "Plates",
    titleEl: "Μερίδες",
    titleEn: "Plates",
    printerTopic: "printer_1",
    items: [
      {
        slug: "gyro-plate",
        title: "Gyro Plate",
        titleEl: "Μερίδα Γύρος",
        titleEn: "Gyro Plate",
        subcategoryEn: "Grill Plates",
        subcategoryEl: "Μερίδες Σχάρας",
        description: "Gyro plate with fries, pita, onion and tzatziki.",
        descriptionEl: "Μερίδα γύρου με πατάτες, πίτα, κρεμμύδι και τζατζίκι.",
        descriptionEn: "Gyro plate with fries, pita, onion and tzatziki.",
        priceCents: 900,
        costCents: 320,
        imageUrl:
          "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/plates/gyro-plate.jpg",
      },
      {
        slug: "mixed-grill",
        title: "Mixed Grill",
        titleEl: "Ποικιλία Σχάρας",
        titleEn: "Mixed Grill",
        subcategoryEn: "Grill Plates",
        subcategoryEl: "Μερίδες Σχάρας",
        description: "Mixed grill selection with pita, fries and sauces.",
        descriptionEl: "Ποικιλία σχάρας με πίτα, πατάτες και σάλτσες.",
        descriptionEn: "Mixed grill selection with pita, fries and sauces.",
        priceCents: 1400,
        costCents: 520,
        imageUrl:
          "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/plates/mixed-grill.jpg",
      },
    ],
  },
  {
    slug: "drinks",
    title: "Drinks",
    titleEl: "Ποτά",
    titleEn: "Drinks",
    printerTopic: "printer_1",
    items: [
      {
        slug: "cola",
        title: "Cola",
        titleEl: "Κόλα",
        titleEn: "Cola",
        subcategoryEn: "Cold Drinks",
        subcategoryEl: "Κρύα Ροφήματα",
        description: "Soft drink served cold.",
        descriptionEl: "Αναψυκτικό σερβιρισμένο παγωμένο.",
        descriptionEn: "Soft drink served cold.",
        priceCents: 200,
        costCents: 70,
        imageUrl:
          "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/drinks/cola.jpg",
      },
      {
        slug: "beer",
        title: "Beer",
        titleEl: "Μπίρα",
        titleEn: "Beer",
        subcategoryEn: "Cold Drinks",
        subcategoryEl: "Κρύα Ροφήματα",
        description: "Draft beer served chilled.",
        descriptionEl: "Μπύρα βαρελίσια παγωμένη.",
        descriptionEn: "Draft beer served chilled.",
        priceCents: 450,
        costCents: 160,
        imageUrl:
          "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/drinks/beer.jpg",
      },
    ],
  },
  {
    slug: "shisha",
    title: "Shisha",
    titleEl: "Ναργιλές",
    titleEn: "Shisha",
    printerTopic: "printer_1",
    items: [
      {
        slug: "shisha-double-apple",
        title: "Double Apple Shisha",
        titleEl: "Ναργιλές Διπλό Μήλο",
        titleEn: "Double Apple Shisha",
        subcategoryEn: "Sweet",
        subcategoryEl: "Γλυκές Γεύσεις",
        description: "Classic double apple flavor.",
        descriptionEl: "Κλασική γεύση διπλό μήλο.",
        descriptionEn: "Classic double apple flavor.",
        priceCents: 1800,
        costCents: 650,
        imageUrl: null,
      },
      {
        slug: "shisha-blueberry-mint",
        title: "Blueberry Mint Shisha",
        titleEl: "Ναργιλές Μύρτιλο Μέντα",
        titleEn: "Blueberry Mint Shisha",
        subcategoryEn: "Sweet",
        subcategoryEl: "Γλυκές Γεύσεις",
        description: "Blueberry with a cool mint finish.",
        descriptionEl: "Μύρτιλο με δροσερή επίγευση μέντας.",
        descriptionEn: "Blueberry with a cool mint finish.",
        priceCents: 1900,
        costCents: 680,
        imageUrl: null,
      },
      {
        slug: "shisha-lemon-mint",
        title: "Lemon Mint Shisha",
        titleEl: "Ναργιλές Λεμόνι Μέντα",
        titleEn: "Lemon Mint Shisha",
        subcategoryEn: "Sour",
        subcategoryEl: "Ξινές Γεύσεις",
        description: "Fresh lemon balanced with mint.",
        descriptionEl: "Φρέσκο λεμόνι ισορροπημένο με μέντα.",
        descriptionEn: "Fresh lemon balanced with mint.",
        priceCents: 1850,
        costCents: 660,
        imageUrl: null,
      },
      {
        slug: "shisha-grapefruit",
        title: "Grapefruit Shisha",
        titleEl: "Ναργιλές Γκρέιπφρουτ",
        titleEn: "Grapefruit Shisha",
        subcategoryEn: "Sour",
        subcategoryEl: "Ξινές Γεύσεις",
        description: "Bright grapefruit citrus blend.",
        descriptionEl: "Έντονο εσπεριδοειδές χαρμάνι γκρέιπφρουτ.",
        descriptionEn: "Bright grapefruit citrus blend.",
        priceCents: 1850,
        costCents: 660,
        imageUrl: null,
      },
      {
        slug: "shisha-watermelon-lemon",
        title: "Watermelon Lemon Shisha",
        titleEl: "Ναργιλές Καρπούζι Λεμόνι",
        titleEn: "Watermelon Lemon Shisha",
        subcategoryEn: "Sweet-Sour",
        subcategoryEl: "Γλυκόξινες Γεύσεις",
        description: "Juicy watermelon with lemon zest.",
        descriptionEl: "Ζουμερό καρπούζι με ξύσμα λεμονιού.",
        descriptionEn: "Juicy watermelon with lemon zest.",
        priceCents: 1950,
        costCents: 700,
        imageUrl: null,
      },
      {
        slug: "shisha-passion-lime",
        title: "Passion Lime Shisha",
        titleEl: "Ναργιλές Passion Lime",
        titleEn: "Passion Lime Shisha",
        subcategoryEn: "Sweet-Sour",
        subcategoryEl: "Γλυκόξινες Γεύσεις",
        description: "Passion fruit with lively lime notes.",
        descriptionEl: "Passion fruit με ζωηρές νότες λάιμ.",
        descriptionEn: "Passion fruit with lively lime notes.",
        priceCents: 1950,
        costCents: 700,
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
  if (!cfg.defaultPassword) {
    throw new Error("Set DEFAULT_PASSWORD before onboarding a real store.");
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
    `Created ${tables.length} tables and waiter assignments.`
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
          descriptionEl: item.descriptionEl ?? null,
          descriptionEn: item.descriptionEn ?? null,
          titleEl: item.titleEl,
          titleEn: item.titleEn,
          subcategoryEn: item.subcategoryEn ?? null,
          subcategoryEl: item.subcategoryEl ?? null,
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
