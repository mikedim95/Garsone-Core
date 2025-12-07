// prisma/seed.ts

import { PrismaClient, Role, OrderStatus } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();
const DAYS_BACK = 60;

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

async function hashPassword(): Promise<string> {
  return bcrypt.hash("changeme", 10);
}

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

  for (const p of cfg.profiles) {
    await prisma.profile.create({
      data: {
        storeId,
        email: p.email,
        passwordHash,
        role: p.role,
        displayName: p.displayName,
      },
    });
  }

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

      const order = await prisma.order.create({
        data: {
          storeId,
          tableId: table.id,
          status,
          totalCents: item.priceCents * qty,
          placedAt,
          paidAt: paidAt ?? undefined,
          cancelledAt: cancelledAt ?? undefined,
          servedAt: servedAt ?? undefined,
          preparingAt: preparingAt ?? undefined,
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

  console.log(`Seeded store: ${cfg.slug}`);
}

async function main() {
  console.log("Starting seed...");

  for (const store of STORES) {
    await seedStore(store);
  }

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
