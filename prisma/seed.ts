// prisma/seed.ts
import { PrismaClient, OrderStatus, ShiftStatus, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

// Override per run: STORE_SLUG=cincin npm run db:seed
const STORE_SLUG = process.env.STORE_SLUG || "demo-bar";
const DEFAULT_PASSWORD =
  process.env.DEFAULT_PASSWORD ||
  process.env.MANAGER_PASSWORD ||
  process.env.WAITER_PASSWORD ||
  "changeme";

// CONFIG
const DAYS_BACK = 180; // ~6 months
const MIN_ORDERS_PER_DAY = 3;
const MAX_ORDERS_PER_DAY = 25;
const OPEN_HOUR = 9; // 09:00
const CLOSE_HOUR = 23; // 23:59

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFromArray<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

function randomOrderStatus(): OrderStatus {
  const pool: OrderStatus[] = [
    "PAID",
    "PAID",
    "PAID", // mostly paid
    "SERVED",
    "SERVED",
    "READY",
    "PREPARING",
    "PLACED",
    "CANCELLED",
  ];
  return randFromArray(pool);
}

function randomDateOnDay(day: Date): Date {
  const d = new Date(day);
  const hour = randInt(OPEN_HOUR, CLOSE_HOUR);
  const minute = randInt(0, 59);
  const second = randInt(0, 59);
  d.setHours(hour, minute, second, 0);
  return d;
}

async function recreateMenu(storeId: string) {
  console.log("Deleting existing menu for this store...");

  // Order of deletes to satisfy FKs
  await prisma.itemModifier.deleteMany({ where: { storeId } });
  await prisma.modifierOption.deleteMany({ where: { storeId } });
  await prisma.modifier.deleteMany({ where: { storeId } });
  await prisma.item.deleteMany({ where: { storeId } });
  await prisma.category.deleteMany({ where: { storeId } });
  await prisma.kitchenCounter.deleteMany({ where: { storeId } });

  console.log("Creating new sane menu...");

  // ---- Categories ----
  const coffeeCat = await prisma.category.create({
    data: {
      storeId,
      slug: "coffee",
      title: "Coffee",
      sortOrder: 1,
    },
  });

  const drinksCat = await prisma.category.create({
    data: {
      storeId,
      slug: "drinks",
      title: "Drinks",
      sortOrder: 2,
    },
  });

  const cocktailsCat = await prisma.category.create({
    data: {
      storeId,
      slug: "cocktails",
      title: "Cocktails",
      sortOrder: 3,
    },
  });

  const snacksCat = await prisma.category.create({
    data: {
      storeId,
      slug: "snacks",
      title: "Snacks",
      sortOrder: 4,
    },
  });

  const dessertsCat = await prisma.category.create({
    data: {
      storeId,
      slug: "desserts",
      title: "Desserts",
      sortOrder: 5,
    },
  });

  // ---- Items ----
  const espresso = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "espresso",
      title: "Espresso",
      description: "Single espresso shot",
      priceCents: 200,
      costCents: 40,
      sortOrder: 1,
    },
  });

  const doubleEspresso = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "double-espresso",
      title: "Double Espresso",
      description: "Double espresso shot",
      priceCents: 260,
      costCents: 55,
      sortOrder: 2,
    },
  });

  const cappuccino = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "cappuccino",
      title: "Cappuccino",
      description: "Classic cappuccino",
      priceCents: 320,
      costCents: 80,
      sortOrder: 3,
    },
  });

  const latte = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "latte",
      title: "Latte",
      description: "Espresso with steamed milk",
      priceCents: 350,
      costCents: 90,
      sortOrder: 4,
    },
  });

  const freddoEspresso = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "freddo-espresso",
      title: "Freddo Espresso",
      description: "Iced shaken espresso",
      priceCents: 320,
      costCents: 80,
      sortOrder: 5,
    },
  });

  const freddoCappuccino = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "freddo-cappuccino",
      title: "Freddo Cappuccino",
      description: "Iced shaken cappuccino",
      priceCents: 360,
      costCents: 100,
      sortOrder: 6,
    },
  });

  const filterCoffee = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "filter-coffee",
      title: "Filter Coffee",
      description: "Freshly brewed filter coffee",
      priceCents: 280,
      costCents: 70,
      sortOrder: 7,
    },
  });

  const stillWater = await prisma.item.create({
    data: {
      storeId,
      categoryId: drinksCat.id,
      slug: "water-500",
      title: "Water 500ml",
      description: "Bottled still water",
      priceCents: 80,
      costCents: 20,
      sortOrder: 1,
    },
  });

  const softDrink = await prisma.item.create({
    data: {
      storeId,
      categoryId: drinksCat.id,
      slug: "soft-drink-330",
      title: "Soft Drink 330ml",
      description: "Coke / Sprite / Orange",
      priceCents: 250,
      costCents: 80,
      sortOrder: 2,
    },
  });

  const draftBeer = await prisma.item.create({
    data: {
      storeId,
      categoryId: drinksCat.id,
      slug: "draft-beer-500",
      title: "Draft Beer 500ml",
      description: "House draft beer",
      priceCents: 450,
      costCents: 150,
      sortOrder: 3,
    },
  });

  const bottledBeer = await prisma.item.create({
    data: {
      storeId,
      categoryId: drinksCat.id,
      slug: "bottled-beer-330",
      title: "Bottled Beer 330ml",
      description: "Local / imported bottle",
      priceCents: 420,
      costCents: 160,
      sortOrder: 4,
    },
  });

  const mojito = await prisma.item.create({
    data: {
      storeId,
      categoryId: cocktailsCat.id,
      slug: "mojito",
      title: "Mojito",
      description: "Rum, lime, mint, soda",
      priceCents: 800,
      costCents: 280,
      sortOrder: 1,
    },
  });

  const aperolSpritz = await prisma.item.create({
    data: {
      storeId,
      categoryId: cocktailsCat.id,
      slug: "aperol-spritz",
      title: "Aperol Spritz",
      description: "Aperol, prosecco, soda",
      priceCents: 780,
      costCents: 260,
      sortOrder: 2,
    },
  });

  const ginTonic = await prisma.item.create({
    data: {
      storeId,
      categoryId: cocktailsCat.id,
      slug: "gin-tonic",
      title: "Gin & Tonic",
      description: "Gin, tonic water, lime",
      priceCents: 750,
      costCents: 250,
      sortOrder: 3,
    },
  });

  const fries = await prisma.item.create({
    data: {
      storeId,
      categoryId: snacksCat.id,
      slug: "fries",
      title: "French Fries",
      description: "Crispy fries with salt",
      priceCents: 380,
      costCents: 120,
      sortOrder: 1,
    },
  });

  const clubSandwich = await prisma.item.create({
    data: {
      storeId,
      categoryId: snacksCat.id,
      slug: "club-sandwich",
      title: "Club Sandwich",
      description: "Chicken, bacon, fries",
      priceCents: 850,
      costCents: 300,
      sortOrder: 2,
    },
  });

  const nachos = await prisma.item.create({
    data: {
      storeId,
      categoryId: snacksCat.id,
      slug: "nachos",
      title: "Nachos",
      description: "Nachos with cheese & salsa",
      priceCents: 650,
      costCents: 220,
      sortOrder: 3,
    },
  });

  const brownie = await prisma.item.create({
    data: {
      storeId,
      categoryId: dessertsCat.id,
      slug: "chocolate-brownie",
      title: "Chocolate Brownie",
      description: "With vanilla ice cream",
      priceCents: 520,
      costCents: 180,
      sortOrder: 1,
    },
  });

  const cheesecake = await prisma.item.create({
    data: {
      storeId,
      categoryId: dessertsCat.id,
      slug: "cheesecake",
      title: "Cheesecake",
      description: "Classic cheesecake slice",
      priceCents: 540,
      costCents: 190,
      sortOrder: 2,
    },
  });

  // ---- Modifiers ----
  const sizeModifier = await prisma.modifier.create({
    data: {
      storeId,
      slug: "size",
      title: "Size",
      minSelect: 1,
      maxSelect: 1,
    },
  });

  const milkModifier = await prisma.modifier.create({
    data: {
      storeId,
      slug: "milk",
      title: "Milk Type",
      minSelect: 0,
      maxSelect: 1,
    },
  });

  const sugarModifier = await prisma.modifier.create({
    data: {
      storeId,
      slug: "sugar",
      title: "Sugar",
      minSelect: 1,
      maxSelect: 1,
    },
  });

  const tempModifier = await prisma.modifier.create({
    data: {
      storeId,
      slug: "temperature",
      title: "Temperature",
      minSelect: 1,
      maxSelect: 1,
    },
  });

  const sizeSmall = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sizeModifier.id,
      slug: "small",
      title: "Small",
      priceDeltaCents: 0,
      sortOrder: 1,
    },
  });

  const sizeMedium = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sizeModifier.id,
      slug: "medium",
      title: "Medium",
      priceDeltaCents: 30,
      sortOrder: 2,
    },
  });

  const sizeLarge = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sizeModifier.id,
      slug: "large",
      title: "Large",
      priceDeltaCents: 60,
      sortOrder: 3,
    },
  });

  const milkCow = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: milkModifier.id,
      slug: "cow",
      title: "Cow Milk",
      priceDeltaCents: 0,
      sortOrder: 1,
    },
  });

  const milkLactoseFree = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: milkModifier.id,
      slug: "lactose-free",
      title: "Lactose-Free",
      priceDeltaCents: 40,
      sortOrder: 2,
    },
  });

  const milkOat = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: milkModifier.id,
      slug: "oat",
      title: "Oat Milk",
      priceDeltaCents: 50,
      sortOrder: 3,
    },
  });

  const sugarNo = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sugarModifier.id,
      slug: "no-sugar",
      title: "No sugar",
      priceDeltaCents: 0,
      sortOrder: 1,
    },
  });

  const sugarMedium = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sugarModifier.id,
      slug: "medium-sugar",
      title: "Medium",
      priceDeltaCents: 0,
      sortOrder: 2,
    },
  });

  const sugarSweet = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sugarModifier.id,
      slug: "sweet",
      title: "Sweet",
      priceDeltaCents: 0,
      sortOrder: 3,
    },
  });

  const tempHot = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: tempModifier.id,
      slug: "hot",
      title: "Hot",
      priceDeltaCents: 0,
      sortOrder: 1,
    },
  });

  const tempIced = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: tempModifier.id,
      slug: "iced",
      title: "Iced",
      priceDeltaCents: 0,
      sortOrder: 2,
    },
  });

  const coffeeItems = [
    espresso,
    doubleEspresso,
    cappuccino,
    latte,
    freddoEspresso,
    freddoCappuccino,
    filterCoffee,
  ];

  await prisma.itemModifier.createMany({
    data: coffeeItems.flatMap((item) => [
      {
        storeId,
        itemId: item.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: item.id,
        modifierId: sugarModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: item.id,
        modifierId: tempModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: item.id,
        modifierId: milkModifier.id,
        isRequired: false,
      },
    ]),
    skipDuplicates: true,
  });

  // init kitchen counter for today
  const today = new Date().toISOString().slice(0, 10);
  await prisma.kitchenCounter
    .create({
      data: {
        storeId,
        day: today,
        seq: 0,
      },
    })
    .catch(() => {
      /* ignore if already exists */
    });

  console.log("New menu created.");
}

async function main() {
  // ---------- STORE ----------
  const store = await prisma.store.findFirst({
    where: { slug: STORE_SLUG },
  });

  if (!store) {
    console.error(
      `No store found with slug "${STORE_SLUG}". Set STORE_SLUG or create the store first.`
    );
    process.exit(1);
  }

  console.log(`Seeding for store "${store.slug}" (${store.id})`);

  const ensureProfile = async (
    email: string,
    role: Role,
    displayName: string,
    password?: string
  ) => {
    const normalizedEmail = email.toLowerCase();
    const existing = await prisma.profile.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing) return existing;
    const passwordHash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
    return prisma.profile.create({
      data: {
        storeId: store.id,
        email: normalizedEmail,
        passwordHash,
        role,
        displayName,
      },
    });
  };

  // ---------- DEFAULT PROFILES ----------
  await ensureProfile(
    process.env.MANAGER_EMAIL || "manager@demo.local",
    Role.MANAGER,
    "Demo Manager",
    process.env.MANAGER_PASSWORD
  );
  await ensureProfile(
    process.env.WAITER_EMAIL || "waiter1@demo.local",
    Role.WAITER,
    "Waiter One",
    process.env.WAITER_PASSWORD
  );
  await ensureProfile(
    process.env.WAITER_EMAIL_2 || "waiter2@demo.local",
    Role.WAITER,
    "Waiter Two",
    process.env.WAITER_PASSWORD_2 || process.env.WAITER_PASSWORD
  );
  await ensureProfile(
    process.env.COOK_EMAIL || "cook@demo.local",
    Role.COOK,
    "Demo Cook",
    process.env.COOK_PASSWORD
  );
  await ensureProfile(
    process.env.ARCHITECT_EMAIL || "architect@demo.local",
    Role.ARCHITECT,
    "Architect Admin",
    process.env.ARCHITECT_PASSWORD
  );

  // ---------- KEEP EXISTING USERS ----------
  const [waiters, managers, cooks, architects] = await Promise.all([
    prisma.profile.findMany({
      where: { storeId: store.id, role: Role.WAITER },
    }),
    prisma.profile.findMany({
      where: { storeId: store.id, role: Role.MANAGER },
    }),
    prisma.profile.findMany({ where: { storeId: store.id, role: Role.COOK } }),
    prisma.profile.findMany({
      where: { storeId: store.id, role: Role.ARCHITECT },
    }),
  ]);

  console.log(
    `Existing users -> waiters: ${waiters.length}, managers: ${managers.length}, cooks: ${cooks.length}, architects: ${architects.length}`
  );

  // ---------- TABLES ----------
  const tables = await prisma.table.findMany({ where: { storeId: store.id } });
  if (tables.length === 0) {
    console.error("No tables found for this store. Cannot seed orders.");
    process.exit(1);
  }

  // ---------- DELETE ORDERS + SHIFTS ----------
  console.log("Deleting existing orders for this store...");
  await prisma.order.deleteMany({ where: { storeId: store.id } });

  console.log("Deleting existing waiter shifts for this store...");
  await prisma.waiterShift.deleteMany({ where: { storeId: store.id } });

  // ---------- RECREATE MENU ----------
  await recreateMenu(store.id);

  // reload items from new menu
  const items = await prisma.item.findMany({
    where: { storeId: store.id, isAvailable: true },
  });

  console.log(`New menu has ${items.length} items.`);

  // ---------- WAITER SHIFTS HISTORY ----------
  if (waiters.length > 0) {
    console.log("Creating random waiter shifts over the last 6 months...");
    const shiftsData: Parameters<
      typeof prisma.waiterShift.create
    >[0]["data"][] = [];

    for (let daysAgo = DAYS_BACK; daysAgo >= 0; daysAgo--) {
      const day = new Date();
      day.setDate(day.getDate() - daysAgo);

      const shiftsToday = randInt(1, Math.min(3, waiters.length));
      const usedWaiterIds = new Set<string>();

      for (let i = 0; i < shiftsToday; i++) {
        const waiter = randFromArray(waiters);
        if (usedWaiterIds.has(waiter.id)) continue;
        usedWaiterIds.add(waiter.id);

        const start = new Date(day);
        start.setHours(randInt(8, 15), 0, 0, 0);
        const end = new Date(start);
        end.setHours(start.getHours() + randInt(6, 10));

        shiftsData.push({
          storeId: store.id,
          waiterId: waiter.id,
          status: ShiftStatus.COMPLETED,
          startedAt: start,
          endedAt: end,
        });
      }
    }

    if (shiftsData.length > 0) {
      await prisma.waiterShift.createMany({ data: shiftsData });
      console.log(`Created ${shiftsData.length} waiter shifts.`);
    }
  }

  // ---------- 6 MONTHS OF ORDERS ----------
  console.log(
    `Generating orders for the last ${DAYS_BACK} days (~6 months)...`
  );

  let globalTicketNumber = 1;
  const now = new Date();

  for (let daysAgo = DAYS_BACK; daysAgo >= 0; daysAgo--) {
    const day = new Date();
    day.setDate(now.getDate() - daysAgo);

    const ordersCountToday = randInt(MIN_ORDERS_PER_DAY, MAX_ORDERS_PER_DAY);

    for (let i = 0; i < ordersCountToday; i++) {
      const table = randFromArray(tables);
      const placedAt = randomDateOnDay(day);

      const itemsCount = randInt(1, 5);
      const orderItemsData: {
        itemId: string;
        titleSnapshot: string;
        unitPriceCents: number;
        quantity: number;
      }[] = [];

      let totalCents = 0;

      for (let j = 0; j < itemsCount; j++) {
        const item = randFromArray(items);
        const quantity = randInt(1, 3);
        const unitPriceCents = item.priceCents;

        totalCents += unitPriceCents * quantity;

        orderItemsData.push({
          itemId: item.id,
          titleSnapshot: item.title,
          unitPriceCents,
          quantity,
        });
      }

      const status = randomOrderStatus();

      let preparingAt: Date | null = null;
      let readyAt: Date | null = null;
      let servedAt: Date | null = null;
      let paidAt: Date | null = null;
      let cancelledAt: Date | null = null;
      let cancelReason: string | null = null;

      const prepOffsetMin = randInt(1, 10);
      const readyOffsetMin = prepOffsetMin + randInt(3, 15);
      const serveOffsetMin = readyOffsetMin + randInt(1, 10);
      const payOffsetMin = serveOffsetMin + randInt(0, 30);
      const cancelOffsetMin = randInt(1, 20);

      if (["PREPARING", "READY", "SERVED", "PAID"].includes(status)) {
        preparingAt = new Date(placedAt.getTime() + prepOffsetMin * 60 * 1000);
      }
      if (["READY", "SERVED", "PAID"].includes(status)) {
        readyAt = new Date(placedAt.getTime() + readyOffsetMin * 60 * 1000);
      }
      if (["SERVED", "PAID"].includes(status)) {
        servedAt = new Date(placedAt.getTime() + serveOffsetMin * 60 * 1000);
      }
      if (status === "PAID") {
        paidAt = new Date(placedAt.getTime() + payOffsetMin * 60 * 1000);
      }
      if (status === "CANCELLED") {
        cancelledAt = new Date(
          placedAt.getTime() + cancelOffsetMin * 60 * 1000
        );
        cancelReason = randFromArray([
          "Customer left",
          "Order mistake",
          "Payment failed",
          "Changed mind",
        ]);
      }

      await prisma.order.create({
        data: {
          storeId: store.id,
          tableId: table.id,
          status,
          note: null,
          totalCents,
          placedAt,
          ticketNumber: globalTicketNumber++,
          cancelReason,
          servedAt: servedAt ?? undefined,
          preparingAt: preparingAt ?? undefined,
          readyAt: readyAt ?? undefined,
          paidAt: paidAt ?? undefined,
          cancelledAt: cancelledAt ?? undefined,
          orderItems: {
            create: orderItemsData.map((oi) => ({
              itemId: oi.itemId,
              titleSnapshot: oi.titleSnapshot,
              unitPriceCents: oi.unitPriceCents,
              quantity: oi.quantity,
            })),
          },
        },
      });
    }

    if (daysAgo % 30 === 0) {
      console.log(`...generated up to ${daysAgo} days ago`);
    }
  }

  console.log("Finished generating 6 months of orders and new menu.");
}

main()
  .then(async () => {
    console.log("db:seed completed successfully.");
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error("db:seed failed:", err);
    await prisma.$disconnect();
    process.exit(1);
  });
