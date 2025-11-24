// prisma/seed.ts
import { PrismaClient, OrderStatus, ShiftStatus, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const STORE_SLUG = process.env.STORE_SLUG || "demo-bar";

const DEFAULT_PASSWORD =
  process.env.DEFAULT_PASSWORD ||
  process.env.MANAGER_PASSWORD ||
  process.env.WAITER_PASSWORD ||
  "changeme";

const DAYS_BACK = 180; // ~6 months
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

  // ---------- PROFILES (fused from old seedProfiles) ----------
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

  // ---------- CLEAR EXISTING DEMO DATA (orders/menu/shifts) ----------
  console.log("Clearing existing demo data for this store...");

  await prisma.order.deleteMany({ where: { storeId } });
  await prisma.waiterTable.deleteMany({ where: { storeId } });
  await prisma.waiterShift.deleteMany({ where: { storeId } });

  await prisma.itemModifier.deleteMany({ where: { storeId } });
  await prisma.modifierOption.deleteMany({ where: { storeId } });
  await prisma.modifier.deleteMany({ where: { storeId } });

  await prisma.item.deleteMany({ where: { storeId } });
  await prisma.category.deleteMany({ where: { storeId } });

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

  // ---------- CATEGORIES ----------
  console.log("Creating categories...");

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

  // ---------- ITEMS ----------
  console.log("Creating items...");

  const espresso = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "espresso",
      title: "Espresso",
      description: "Classic single shot espresso.",
      priceCents: 250,
      isAvailable: true,
      sortOrder: 1,
    },
  });

  const doubleEspresso = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "double-espresso",
      title: "Double Espresso",
      description: "Double shot espresso.",
      priceCents: 320,
      isAvailable: true,
      sortOrder: 2,
    },
  });

  const cappuccino = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "cappuccino",
      title: "Cappuccino",
      description: "Espresso with steamed milk and foam.",
      priceCents: 350,
      isAvailable: true,
      sortOrder: 3,
    },
  });

  const latte = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "latte",
      title: "Latte",
      description: "Espresso with extra steamed milk.",
      priceCents: 380,
      isAvailable: true,
      sortOrder: 4,
    },
  });

  const freddoEspresso = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "freddo-espresso",
      title: "Freddo Espresso",
      description: "Iced shaken espresso.",
      priceCents: 320,
      isAvailable: true,
      sortOrder: 5,
    },
  });

  const freddoCappuccino = await prisma.item.create({
    data: {
      storeId,
      categoryId: coffeeCat.id,
      slug: "freddo-cappuccino",
      title: "Freddo Cappuccino",
      description: "Iced shaken espresso with foam milk.",
      priceCents: 380,
      isAvailable: true,
      sortOrder: 6,
    },
  });

  const softDrink = await prisma.item.create({
    data: {
      storeId,
      categoryId: drinksCat.id,
      slug: "soft-drink",
      title: "Soft Drink",
      description: "Cola, lemon or orange.",
      priceCents: 250,
      isAvailable: true,
      sortOrder: 1,
    },
  });

  const bottledWater = await prisma.item.create({
    data: {
      storeId,
      categoryId: drinksCat.id,
      slug: "bottled-water",
      title: "Bottled Water",
      description: "Still spring water 500ml.",
      priceCents: 100,
      isAvailable: true,
      sortOrder: 2,
    },
  });

  const beer = await prisma.item.create({
    data: {
      storeId,
      categoryId: drinksCat.id,
      slug: "beer",
      title: "Beer (draft)",
      description: "Pint of draft beer.",
      priceCents: 450,
      isAvailable: true,
      sortOrder: 3,
    },
  });

  const mojito = await prisma.item.create({
    data: {
      storeId,
      categoryId: cocktailsCat.id,
      slug: "mojito",
      title: "Mojito",
      description: "Rum, lime, mint, soda.",
      priceCents: 800,
      isAvailable: true,
      sortOrder: 1,
    },
  });

  const aperolSpritz = await prisma.item.create({
    data: {
      storeId,
      categoryId: cocktailsCat.id,
      slug: "aperol-spritz",
      title: "Aperol Spritz",
      description: "Aperol, prosecco, soda.",
      priceCents: 750,
      isAvailable: true,
      sortOrder: 2,
    },
  });

  const espressoMartini = await prisma.item.create({
    data: {
      storeId,
      categoryId: cocktailsCat.id,
      slug: "espresso-martini",
      title: "Espresso Martini",
      description: "Vodka, espresso, coffee liqueur.",
      priceCents: 850,
      isAvailable: true,
      sortOrder: 3,
    },
  });

  const clubSandwich = await prisma.item.create({
    data: {
      storeId,
      categoryId: snacksCat.id,
      slug: "club-sandwich",
      title: "Club Sandwich",
      description: "Triple sandwich with fries.",
      priceCents: 900,
      isAvailable: true,
      sortOrder: 1,
    },
  });

  const nachos = await prisma.item.create({
    data: {
      storeId,
      categoryId: snacksCat.id,
      slug: "nachos",
      title: "Nachos",
      description: "Tortilla chips with cheese and jalapeños.",
      priceCents: 700,
      isAvailable: true,
      sortOrder: 2,
    },
  });

  const fries = await prisma.item.create({
    data: {
      storeId,
      categoryId: snacksCat.id,
      slug: "fries",
      title: "Fries",
      description: "Crispy french fries.",
      priceCents: 350,
      isAvailable: true,
      sortOrder: 3,
    },
  });

  const brownie = await prisma.item.create({
    data: {
      storeId,
      categoryId: dessertsCat.id,
      slug: "brownie",
      title: "Chocolate Brownie",
      description: "Warm brownie with vanilla ice cream.",
      priceCents: 600,
      isAvailable: true,
      sortOrder: 1,
    },
  });

  const cheesecake = await prisma.item.create({
    data: {
      storeId,
      categoryId: dessertsCat.id,
      slug: "cheesecake",
      title: "Cheesecake",
      description: "Classic baked cheesecake slice.",
      priceCents: 650,
      isAvailable: true,
      sortOrder: 2,
    },
  });

  const iceCream = await prisma.item.create({
    data: {
      storeId,
      categoryId: dessertsCat.id,
      slug: "ice-cream",
      title: "Ice Cream Scoop",
      description: "Vanilla, chocolate or strawberry.",
      priceCents: 250,
      isAvailable: true,
      sortOrder: 3,
    },
  });

  const items = [
    espresso,
    doubleEspresso,
    cappuccino,
    latte,
    freddoEspresso,
    freddoCappuccino,
    softDrink,
    bottledWater,
    beer,
    mojito,
    aperolSpritz,
    espressoMartini,
    clubSandwich,
    nachos,
    fries,
    brownie,
    cheesecake,
    iceCream,
  ];

  console.log(`Created ${items.length} items.`);

  // ---------- MODIFIERS & OPTIONS ----------
  console.log("Creating modifiers and options...");

  // We use minSelect/maxSelect instead of a 'required' flag on Modifier.
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

  const sweetnessModifier = await prisma.modifier.create({
    data: {
      storeId,
      slug: "sweetness",
      title: "Sweetness",
      minSelect: 0,
      maxSelect: 1,
    },
  });

  const iceModifier = await prisma.modifier.create({
    data: {
      storeId,
      slug: "ice",
      title: "Ice",
      minSelect: 0,
      maxSelect: 1,
    },
  });

  // options; note: ModifierOption has slug, title, priceDeltaCents, sortOrder
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

  const milkRegular = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: milkModifier.id,
      slug: "regular",
      title: "Regular",
      priceDeltaCents: 0,
      sortOrder: 1,
    },
  });
  const milkSoy = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: milkModifier.id,
      slug: "soy",
      title: "Soy",
      priceDeltaCents: 50,
      sortOrder: 2,
    },
  });
  const milkOat = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: milkModifier.id,
      slug: "oat",
      title: "Oat",
      priceDeltaCents: 70,
      sortOrder: 3,
    },
  });

  const sweetnessNo = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sweetnessModifier.id,
      slug: "no-sugar",
      title: "No sugar",
      priceDeltaCents: 0,
      sortOrder: 1,
    },
  });
  const sweetness1 = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sweetnessModifier.id,
      slug: "1-sugar",
      title: "1 sugar",
      priceDeltaCents: 0,
      sortOrder: 2,
    },
  });
  const sweetness2 = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sweetnessModifier.id,
      slug: "2-sugars",
      title: "2 sugars",
      priceDeltaCents: 0,
      sortOrder: 3,
    },
  });
  const sweetness3 = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: sweetnessModifier.id,
      slug: "3-sugars",
      title: "3 sugars",
      priceDeltaCents: 0,
      sortOrder: 4,
    },
  });

  const iceNone = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: iceModifier.id,
      slug: "no-ice",
      title: "No ice",
      priceDeltaCents: 0,
      sortOrder: 1,
    },
  });
  const iceNormal = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: iceModifier.id,
      slug: "normal-ice",
      title: "Normal ice",
      priceDeltaCents: 0,
      sortOrder: 2,
    },
  });
  const iceExtra = await prisma.modifierOption.create({
    data: {
      storeId,
      modifierId: iceModifier.id,
      slug: "extra-ice",
      title: "Extra ice",
      priceDeltaCents: 0,
      sortOrder: 3,
    },
  });

  const modifierOptionsByModifierId: Record<
    string,
    { id: string; title: string; priceDeltaCents: number }[]
  > = {
    [sizeModifier.id]: [sizeSmall, sizeMedium, sizeLarge],
    [milkModifier.id]: [milkRegular, milkSoy, milkOat],
    [sweetnessModifier.id]: [sweetnessNo, sweetness1, sweetness2, sweetness3],
    [iceModifier.id]: [iceNone, iceNormal, iceExtra],
  };

  console.log("Modifiers and options created.");

  // ---------- ITEM <-> MODIFIER LINKING ----------
  console.log("Linking item modifiers...");

  // isRequired is on ItemModifier; we use it for things like "Size".
  await prisma.itemModifier.createMany({
    data: [
      // Espresso & Double Espresso: size + sweetness
      {
        storeId,
        itemId: espresso.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: espresso.id,
        modifierId: sweetnessModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: doubleEspresso.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: doubleEspresso.id,
        modifierId: sweetnessModifier.id,
        isRequired: false,
      },

      // Cappuccino & Latte: size + milk + sweetness
      {
        storeId,
        itemId: cappuccino.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: cappuccino.id,
        modifierId: milkModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: cappuccino.id,
        modifierId: sweetnessModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: latte.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: latte.id,
        modifierId: milkModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: latte.id,
        modifierId: sweetnessModifier.id,
        isRequired: false,
      },

      // Freddo Espresso & Freddo Cappuccino: size + sweetness + ice (+ milk for cappuccino)
      {
        storeId,
        itemId: freddoEspresso.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: freddoEspresso.id,
        modifierId: sweetnessModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: freddoEspresso.id,
        modifierId: iceModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: freddoCappuccino.id,
        modifierId: sizeModifier.id,
        isRequired: true,
      },
      {
        storeId,
        itemId: freddoCappuccino.id,
        modifierId: milkModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: freddoCappuccino.id,
        modifierId: sweetnessModifier.id,
        isRequired: false,
      },
      {
        storeId,
        itemId: freddoCappuccino.id,
        modifierId: iceModifier.id,
        isRequired: false,
      },
    ],
  });

  const itemModifiers = await prisma.itemModifier.findMany({
    where: { storeId },
    include: { modifier: true },
  });

  console.log("Item modifiers linked.");

  // ---------- WAITER SHIFTS ----------
  console.log("Generating waiter shifts (last 30 days)...");

  const waiters = [waiter1, waiter2];
  const today = new Date();
  const daysForShifts = 30;

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
          status: ShiftStatus.CLOSED,
          startedAt: start,
          endedAt: end,
        },
      });
    }
  }

  console.log("Waiter shifts generated.");

  // ---------- ORDERS (status distribution + options) ----------
  console.log(
    `Generating orders for the last ${DAYS_BACK} days (~6 months)...`
  );

  let globalTicketNumber = 1;
  const now = new Date();

  const TARGET_PER_TABLE_STATUS = 5; // PLACED, PREPARING, READY per table
  const TARGET_CANCELLED_GLOBAL = 30; // CANCELLED across all tables

  const tableStatusCounters: Record<
    string,
    { PLACED: number; PREPARING: number; READY: number }
  > = {};
  for (const table of tables) {
    tableStatusCounters[table.id] = { PLACED: 0, PREPARING: 0, READY: 0 };
  }

  let cancelledCountGlobal = 0;

  // helper: get itemModifiers + options for a given item
  function getItemModifiersWithOptions(itemId: string) {
    return itemModifiers.filter((im) => im.itemId === itemId);
  }

  for (let daysAgo = DAYS_BACK; daysAgo >= 0; daysAgo--) {
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

      // status distribution logic
      const counters = tableStatusCounters[table.id];
      const needed: OrderStatus[] = [];

      if (counters.PLACED < TARGET_PER_TABLE_STATUS) needed.push("PLACED");
      if (counters.PREPARING < TARGET_PER_TABLE_STATUS)
        needed.push("PREPARING");
      if (counters.READY < TARGET_PER_TABLE_STATUS) needed.push("READY");

      let status: OrderStatus;

      if (needed.length > 0) {
        status = randFromArray(needed);
      } else if (cancelledCountGlobal < TARGET_CANCELLED_GLOBAL) {
        status = "CANCELLED";
      } else {
        status = "PAID";
      }

      if (status === "PLACED" || status === "PREPARING" || status === "READY") {
        counters[status] += 1;
      } else if (status === "CANCELLED") {
        cancelledCountGlobal += 1;
      }

      // timestamps
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
          storeId,
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
            create: lines.map((line) => ({
              itemId: line.item.id,
              titleSnapshot: line.item.title,
              unitPriceCents: line.basePrice,
              quantity: line.quantity,
              orderItemOptions: {
                create: line.options.map((o) => ({
                  modifierId: o.modifierId,
                  modifierOptionId: o.option.id,
                  titleSnapshot: `${o.option.title}`,
                  priceDeltaCents: o.option.priceDeltaCents,
                })),
              },
            })),
          },
        },
      });
    }

    if (daysAgo % 30 === 0) {
      console.log(`...generated up to ${daysAgo} days ago`);
    }
  }

  console.log("Finished generating orders and menu.");
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
