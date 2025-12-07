// prisma/seed.ts
import { PrismaClient, OrderStatus, ShiftStatus, Role } from "@prisma/client";
import bcrypt from "bcrypt";
import { applyDbConnection } from "../src/db/config";

const { target: dbTarget, databaseUrl } = applyDbConnection();
const prisma = new PrismaClient();

const STORE_SLUG = (process.env.STORE_SLUG || "default-store").trim();

const DEFAULT_PASSWORD =
  process.env.DEFAULT_PASSWORD ||
  process.env.MANAGER_PASSWORD ||
  process.env.WAITER_PASSWORD ||
  "changeme";

const DAYS_BACK_ORDERS = 60; // ~2 months
const MIN_ORDERS_PER_DAY = 5;
const MAX_ORDERS_PER_DAY = 25;

try {
  const { hostname, pathname } = new URL(databaseUrl);
  const dbName = pathname?.replace("/", "") || "";
  console.log(
    `[seed] DB_CONNECTION=${dbTarget} -> ${hostname}${
      dbName ? `/${dbName}` : ""
    }`
  );
} catch {
  console.log(`[seed] DB_CONNECTION=${dbTarget}`);
}

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

// ---------- DEMO MENU CONFIG ----------

const IMAGE_BASE =
  "https://oupwquepcjydgevdfnlm.supabase.co/storage/v1/object/public/assets/sample-menu/";

const imageUrlBySlug: Record<string, string> = {
  "espresso-martini": IMAGE_BASE + "Espresso%20Martini.jpg",
  "club-sandwich": IMAGE_BASE + "Club%20Sandwich.jpg",
  "aperol-spritz": IMAGE_BASE + "Aperol%20Spritz.jpg",
  fries: IMAGE_BASE + "Fries.jpg",
  "bottled-water": IMAGE_BASE + "Bottled%20Water.jpg",
  espresso: IMAGE_BASE + "espresso.jpg",
  "double-espresso": IMAGE_BASE + "espresso.jpg",
  brownie: IMAGE_BASE + "Chocolate%20Brownie.jpg",
  latte: IMAGE_BASE + "Latte.jpg",
  "ice-cream": IMAGE_BASE + "Ice%20Cream.jpg",
  cappuccino: IMAGE_BASE + "Cup-Of-Creamy-Coffee.png",
  "soft-drink": IMAGE_BASE + "Soft%20Drink.jpg",
  mojito: IMAGE_BASE + "Mojito.jpg",
  "freddo-espresso": IMAGE_BASE + "Freddo%20Espresso.jpg",
  beer: IMAGE_BASE + "Draft%20Beer.jpg",
  "freddo-cappuccino": IMAGE_BASE + "Fresso%20Cappuccino.jpg",
  cheesecake: IMAGE_BASE + "Cheese%20Cake.jpg",
  nachos: IMAGE_BASE + "Nachos.jpg",
};

type DemoItemConfig = {
  slug: string;
  titleEn: string;
  titleEl: string;
  descriptionEn?: string;
  descriptionEl?: string;
  priceCents: number;
  costCents?: number;
};

type DemoCategoryConfig = {
  slug: string;
  titleEn: string;
  titleEl: string;
  sortOrder: number;
  items: DemoItemConfig[];
};

const demoMenu: DemoCategoryConfig[] = [
  {
    slug: "coffee-hot",
    titleEn: "Hot Coffee",
    titleEl: "Ζεστός καφές",
    sortOrder: 1,
    items: [
      {
        slug: "espresso",
        titleEn: "Espresso",
        titleEl: "Εσπρέσο",
        descriptionEn: "Single shot espresso.",
        descriptionEl: "Μονός εσπρέσο.",
        priceCents: 250,
        costCents: 90,
      },
      {
        slug: "double-espresso",
        titleEn: "Double Espresso",
        titleEl: "Διπλός εσπρέσο",
        descriptionEn: "Double shot espresso.",
        descriptionEl: "Διπλός εσπρέσο.",
        priceCents: 320,
        costCents: 120,
      },
      {
        slug: "cappuccino",
        titleEn: "Cappuccino",
        titleEl: "Καπουτσίνο",
        descriptionEn: "Espresso with steamed milk and foam.",
        descriptionEl: "Εσπρέσο με αφρόγαλα.",
        priceCents: 350,
        costCents: 140,
      },
      {
        slug: "latte",
        titleEn: "Latte",
        titleEl: "Λάτε",
        descriptionEn: "Espresso with extra steamed milk.",
        descriptionEl: "Εσπρέσο με περισσότερο γάλα.",
        priceCents: 380,
        costCents: 150,
      },
    ],
  },
  {
    slug: "coffee-cold",
    titleEn: "Iced Coffee",
    titleEl: "Κρύος καφές",
    sortOrder: 2,
    items: [
      {
        slug: "freddo-espresso",
        titleEn: "Freddo Espresso",
        titleEl: "Φρέντο εσπρέσο",
        descriptionEn: "Double espresso shaken with ice.",
        descriptionEl: "Διπλός εσπρέσο χτυπημένος με πάγο.",
        priceCents: 340,
        costCents: 130,
      },
      {
        slug: "freddo-cappuccino",
        titleEn: "Freddo Cappuccino",
        titleEl: "Φρέντο καπουτσίνο",
        descriptionEn: "Iced espresso with cold milk foam.",
        descriptionEl: "Κρύος εσπρέσο με κρύο αφρόγαλα.",
        priceCents: 380,
        costCents: 150,
      },
    ],
  },
  {
    slug: "drinks-soft",
    titleEn: "Soft Drinks & Water",
    titleEl: "Αναψυκτικά & Νερό",
    sortOrder: 3,
    items: [
      {
        slug: "soft-drink",
        titleEn: "Soft Drink",
        titleEl: "Αναψυκτικό",
        descriptionEn: "Assorted sodas.",
        descriptionEl: "Διάφορα αναψυκτικά.",
        priceCents: 250,
        costCents: 80,
      },
      {
        slug: "bottled-water",
        titleEn: "Bottled Water",
        titleEl: "Εμφιαλωμένο νερό",
        descriptionEn: "Still mineral water.",
        descriptionEl: "Εμφιαλωμένο νερό.",
        priceCents: 100,
        costCents: 30,
      },
      {
        slug: "beer",
        titleEn: "Draft Beer",
        titleEl: "Μπύρα βαρελίσια",
        descriptionEn: "Cold draft beer.",
        descriptionEl: "Κρύα βαρελίσια μπύρα.",
        priceCents: 450,
        costCents: 200,
      },
    ],
  },
  {
    slug: "cocktails",
    titleEn: "Cocktails",
    titleEl: "Κοκτέιλ",
    sortOrder: 4,
    items: [
      {
        slug: "espresso-martini",
        titleEn: "Espresso Martini",
        titleEl: "Εσπρέσο μαρτίνι",
        descriptionEn: "Vodka, espresso, coffee liqueur.",
        descriptionEl: "Βότκα, εσπρέσο, λικέρ καφέ.",
        priceCents: 850,
        costCents: 320,
      },
      {
        slug: "aperol-spritz",
        titleEn: "Aperol Spritz",
        titleEl: "Άπερολ σπριτζ",
        descriptionEn: "Aperol, prosecco, soda.",
        descriptionEl: "Άπερολ, προσεκό, σόδα.",
        priceCents: 780,
        costCents: 300,
      },
      {
        slug: "mojito",
        titleEn: "Mojito",
        titleEl: "Μοχίτο",
        descriptionEn: "Rum, lime, mint, soda.",
        descriptionEl: "Ρούμι, λάιμ, δυόσμος, σόδα.",
        priceCents: 800,
        costCents: 320,
      },
    ],
  },
  {
    slug: "food-snacks",
    titleEn: "Snacks & Bites",
    titleEl: "Σνακ & μεζέδες",
    sortOrder: 5,
    items: [
      {
        slug: "club-sandwich",
        titleEn: "Club Sandwich",
        titleEl: "Κλαμπ σάντουιτς",
        descriptionEn: "Toasted sandwich with fries.",
        descriptionEl: "Τοστ σάντουιτς με πατάτες.",
        priceCents: 900,
        costCents: 380,
      },
      {
        slug: "fries",
        titleEn: "Fries",
        titleEl: "Πατάτες τηγανητές",
        descriptionEn: "Crispy fries with salt.",
        descriptionEl: "Τραγανές πατάτες με αλάτι.",
        priceCents: 380,
        costCents: 150,
      },
      {
        slug: "nachos",
        titleEn: "Nachos",
        titleEl: "Νάτσος",
        descriptionEn: "Tortilla chips with cheese and jalapeños.",
        descriptionEl: "Τορτίγια με τυρί και χαλαπένιο.",
        priceCents: 700,
        costCents: 280,
      },
    ],
  },
  {
    slug: "desserts",
    titleEn: "Desserts",
    titleEl: "Γλυκά",
    sortOrder: 6,
    items: [
      {
        slug: "brownie",
        titleEn: "Chocolate Brownie",
        titleEl: "Σοκολατένιο μπράουνι",
        descriptionEn: "Rich chocolate brownie.",
        descriptionEl: "Πλούσιο σοκολατένιο μπράουνι.",
        priceCents: 450,
        costCents: 180,
      },
      {
        slug: "cheesecake",
        titleEn: "Cheesecake",
        titleEl: "Τσιζκέικ",
        descriptionEn: "Cheesecake with biscuit base.",
        descriptionEl: "Τσιζκέικ με μπισκότο.",
        priceCents: 500,
        costCents: 200,
      },
      {
        slug: "ice-cream",
        titleEn: "Ice Cream Scoop",
        titleEl: "Μπάλα παγωτό",
        descriptionEn: "Single scoop of ice cream.",
        descriptionEl: "Μία μπάλα παγωτό.",
        priceCents: 300,
        costCents: 110,
      },
    ],
  },
];

async function seed() {
  console.log(`Seeding demo data for store slug: ${STORE_SLUG}`);

  // Try to find the store by slug
  let store = await prisma.store.findUnique({
    where: { slug: STORE_SLUG },
  });

  // If it does not exist, create it once
  if (!store) {
    console.log(`No store found with slug "${STORE_SLUG}", creating it now...`);
    store = await prisma.store.create({
      data: {
        slug: STORE_SLUG,
        name: "Demo Cafe", // change if you want a different default name
      },
    });
  }

  const storeId = store.id;
  console.log(`Seeding for store "${store.slug}" (${storeId})`);
  // ...

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
    "Demo Architect",
    process.env.ARCHITECT_PASSWORD
  );

  console.log("Profiles ready:", {
    manager: manager.email,
    waiter1: waiter1.email,
    waiter2: waiter2.email,
    cook: cook.email,
    architect: architect.email,
  });

  // ---------- CLEAR EXISTING DATA ----------
  console.log(
    "Clearing existing demo orders, waiter data, and menu for this store..."
  );

  // Orders (cascade to order_items & order_item_options)
  await prisma.order.deleteMany({ where: { storeId } });

  // Waiter-related
  await prisma.waiterTable.deleteMany({ where: { storeId } });
  await prisma.waiterShift.deleteMany({ where: { storeId } });

  // Menu-related
  await prisma.itemModifier.deleteMany({ where: { storeId } });
  await prisma.modifierOption.deleteMany({ where: { storeId } });
  await prisma.modifier.deleteMany({ where: { storeId } });
  await prisma.item.deleteMany({ where: { storeId } });
  await prisma.category.deleteMany({ where: { storeId } });

  // ---------- MENU (CATEGORIES + ITEMS) ----------
  console.log("Creating demo categories and items...");

  const createdCategories = await Promise.all(
    demoMenu.map((cat) =>
      prisma.category.create({
        data: {
          storeId,
          slug: cat.slug,
          title: cat.titleEn,
          titleEn: cat.titleEn,
          titleEl: cat.titleEl,
          sortOrder: cat.sortOrder,
        },
      })
    )
  );

  const categoryBySlug: Record<string, (typeof createdCategories)[number]> = {};
  for (const cat of createdCategories) {
    categoryBySlug[cat.slug] = cat;
  }

  const createdItems: Awaited<ReturnType<typeof prisma.item.create>>[] = [];

  for (const cat of demoMenu) {
    const category = categoryBySlug[cat.slug];
    if (!category) continue;

    let sort = 1;
    for (const itemCfg of cat.items) {
      const imageUrl = imageUrlBySlug[itemCfg.slug] || null;

      const item = await prisma.item.create({
        data: {
          storeId,
          categoryId: category.id,
          slug: itemCfg.slug,
          title: itemCfg.titleEn,
          titleEn: itemCfg.titleEn,
          titleEl: itemCfg.titleEl,
          description: itemCfg.descriptionEn,
          descriptionEn: itemCfg.descriptionEn,
          descriptionEl: itemCfg.descriptionEl,
          priceCents: itemCfg.priceCents,
          costCents: itemCfg.costCents ?? null,
          isAvailable: true,
          sortOrder: sort++,
          imageUrl,
        },
      });

      createdItems.push(item);
    }
  }

  console.log(
    `Created ${createdItems.length} items across ${createdCategories.length} categories.`
  );

  // (Optional) simple size modifier for coffees to keep demo realistic
  console.log("Creating demo modifiers...");
  const coffeeItemSlugs = [
    "espresso",
    "double-espresso",
    "cappuccino",
    "latte",
    "freddo-espresso",
    "freddo-cappuccino",
  ];

  const sizeModifier = await prisma.modifier.create({
    data: {
      storeId,
      slug: "size",
      title: "Size",
      titleEn: "Size",
      titleEl: "Μέγεθος",
      minSelect: 1,
      maxSelect: 1,
      isAvailable: true,
      modifierOptions: {
        create: [
          {
            storeId,
            slug: "small",
            title: "Small",
            titleEn: "Small",
            titleEl: "Μικρό",
            priceDeltaCents: 0,
            sortOrder: 1,
          },
          {
            storeId,
            slug: "medium",
            title: "Medium",
            titleEn: "Medium",
            titleEl: "Μεσαίο",
            priceDeltaCents: 50,
            sortOrder: 2,
          },
          {
            storeId,
            slug: "large",
            title: "Large",
            titleEn: "Large",
            titleEl: "Μεγάλο",
            priceDeltaCents: 100,
            sortOrder: 3,
          },
        ],
      },
    },
  });

  const itemsBySlug: Record<string, (typeof createdItems)[number]> = {};
  for (const item of createdItems) {
    itemsBySlug[item.slug] = item;
  }

  for (const slug of coffeeItemSlugs) {
    const item = itemsBySlug[slug];
    if (!item) continue;

    await prisma.itemModifier.create({
      data: {
        storeId,
        itemId: item.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
    });
  }

  console.log("Demo modifiers attached to coffee items.");

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

  // ---------- WAITER TABLE ASSIGNMENTS ----------
  console.log("Assigning tables to waiters...");

  const waiters = [waiter1, waiter2];

  await prisma.waiterTable.deleteMany({ where: { storeId } });

  for (const table of tables) {
    for (const waiter of waiters) {
      await prisma.waiterTable.create({
        data: {
          storeId,
          tableId: table.id,
          waiterId: waiter.id,
        },
      });
    }
  }

  console.log(
    `Assigned ${tables.length} tables to ${waiters.length} waiters (full mesh).`
  );

  // ---------- ORDERS (LAST 60 DAYS) ----------
  console.log(
    `Generating demo orders for the last ${DAYS_BACK_ORDERS} days (~2 months)...`
  );

  const items = createdItems;
  if (items.length === 0) {
    console.error("No items created; cannot generate demo orders.");
    process.exit(1);
  }

  let globalTicketNumber = 1;
  const now = new Date();

  for (let daysAgo = 0; daysAgo < DAYS_BACK_ORDERS; daysAgo++) {
    const day = new Date();
    day.setDate(now.getDate() - daysAgo);
    day.setHours(0, 0, 0, 0);

    const ordersCountToday = randInt(MIN_ORDERS_PER_DAY, MAX_ORDERS_PER_DAY);

    for (let i = 0; i < ordersCountToday; i++) {
      const table = randFromArray(tables);
      const placedAt = randomDateOnDay(day);

      const itemsCount = randInt(1, 5);

      type Line = {
        item: (typeof items)[number];
        quantity: number;
        unitPriceCents: number;
      };

      const lines: Line[] = [];

      for (let j = 0; j < itemsCount; j++) {
        const item = randFromArray(items);
        const quantity = randInt(1, 3);
        const unitPriceCents = item.priceCents;

        lines.push({
          item,
          quantity,
          unitPriceCents,
        });
      }

      const totalCents = lines.reduce(
        (sum, line) => sum + line.unitPriceCents * line.quantity,
        0
      );

      let status: OrderStatus;
      let preparingAt: Date | null = null;
      let readyAt: Date | null = null;
      let servedAt: Date | null = null;
      let paidAt: Date | null = null;
      let cancelledAt: Date | null = null;
      let cancelReason: string | null = null;

      if (daysAgo > 0) {
        // Past days: mostly completed & paid
        status = OrderStatus.PAID;
        const prepOffset = randInt(2, 10);
        const readyOffset = prepOffset + randInt(2, 10);
        const serveOffset = readyOffset + randInt(2, 20);
        const payOffset = serveOffset + randInt(0, 20);

        preparingAt = new Date(placedAt.getTime() + prepOffset * 60 * 1000);
        readyAt = new Date(placedAt.getTime() + readyOffset * 60 * 1000);
        servedAt = new Date(placedAt.getTime() + serveOffset * 60 * 1000);
        paidAt = new Date(placedAt.getTime() + payOffset * 60 * 1000);
      } else {
        // Today: mix of live statuses
        const roll = Math.random();
        if (roll < 0.15) {
          status = OrderStatus.CANCELLED;
          cancelledAt = new Date(
            placedAt.getTime() + randInt(1, 10) * 60 * 1000
          );
          cancelReason = "Customer changed mind";
        } else if (roll < 0.35) {
          status = OrderStatus.PLACED;
        } else if (roll < 0.6) {
          status = OrderStatus.PREPARING;
          preparingAt = new Date(
            placedAt.getTime() + randInt(2, 10) * 60 * 1000
          );
        } else if (roll < 0.8) {
          status = OrderStatus.READY;
          preparingAt = new Date(
            placedAt.getTime() + randInt(2, 10) * 60 * 1000
          );
          readyAt = new Date(placedAt.getTime() + randInt(10, 20) * 60 * 1000);
        } else {
          status = OrderStatus.PAID;
          const prepOffset = randInt(2, 10);
          const readyOffset = prepOffset + randInt(2, 10);
          const serveOffset = readyOffset + randInt(2, 20);
          const payOffset = serveOffset + randInt(0, 20);

          preparingAt = new Date(placedAt.getTime() + prepOffset * 60 * 1000);
          readyAt = new Date(placedAt.getTime() + readyOffset * 60 * 1000);
          servedAt = new Date(placedAt.getTime() + serveOffset * 60 * 1000);
          paidAt = new Date(placedAt.getTime() + payOffset * 60 * 1000);
        }
      }

      const order = await prisma.order.create({
        data: {
          storeId,
          tableId: table.id,
          status,
          note: null,
          totalCents,
          placedAt,
          ticketNumber: globalTicketNumber++,
          cancelReason,
          servedAt,
          cancelledAt,
          paidAt,
          preparingAt,
          readyAt,
          orderItems: {
            create: lines.map((line) => ({
              itemId: line.item.id,
              titleSnapshot: line.item.title,
              unitPriceCents: line.unitPriceCents,
              quantity: line.quantity,
            })),
          },
        },
      });

      if (!order) {
        console.error("Failed to create order for table", table.label);
      }
    }
  }

  console.log("Demo orders successfully generated.");
  console.log("Demo seed complete.");
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
