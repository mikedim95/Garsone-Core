import { PrismaClient, Role, OrderStatus } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcrypt";
import crypto from "crypto";

const prisma = new PrismaClient();

const SEED_RESET = process.env.SEED_RESET !== "0";
const PUBLIC_APP_URL = (
  process.env.PUBLIC_APP_URL ?? "https://www.garsone.gr"
).replace(/\/+$/, "");
const QR_PATH_PREFIX = "/publiccode"; // <-- matches your production pattern

/**
 * =========================
 * progress bars
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
 * helpers
 * =========================
 */
type QrLine = { storeSlug: string; tableLabel: string; publicCode: string };

function loadQrTilesFile(): QrLine[] {
  const file = path.join(process.cwd(), "prisma", "qr-tiles.txt");
  const raw = fs.readFileSync(file, "utf8");

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const parsed: QrLine[] = [];

  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length !== 3) throw new Error(`Bad qr-tiles.txt line: "${line}"`);
    const [storeSlug, tableLabel, publicCode] = parts;
    parsed.push({ storeSlug, tableLabel, publicCode });
  }

  const seen = new Set<string>();
  for (const x of parsed) {
    if (seen.has(x.publicCode))
      throw new Error(`Duplicate publicCode in qr-tiles.txt: ${x.publicCode}`);
    seen.add(x.publicCode);
  }

  return parsed;
}

function writeQrPrintList(all: QrLine[]) {
  const out = [
    "# url,storeSlug,tableLabel,publicCode",
    ...all.map(
      (x) =>
        `${PUBLIC_APP_URL}${QR_PATH_PREFIX}/${x.publicCode},${x.storeSlug},${x.tableLabel},${x.publicCode}`
    ),
    "",
  ].join("\n");

  fs.writeFileSync(
    path.join(process.cwd(), "prisma", "qr-print-list.txt"),
    out,
    "utf8"
  );
}

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
function sessionToken(): string {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
}
async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

/**
 * =========================
 * seed config
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
 * reset (best-effort)
 * NOTE: uses your existing tables; keep if it works for you.
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

async function seedStore(cfg: StoreConfig, qrAll: QrLine[]) {
  section(`Store: ${cfg.slug}`);

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

  // profiles
  const pw = await hashPassword("changeme");
  for (let i = 0; i < cfg.profiles.length; i++) {
    const p = cfg.profiles[i];
    await prisma.profile.upsert({
      where: { storeId_email: { storeId, email: p.email } },
      update: {
        role: p.role,
        displayName: p.displayName,
        passwordHash: pw,
        isVerified: true,
      },
      create: {
        storeId,
        email: p.email,
        role: p.role,
        displayName: p.displayName,
        passwordHash: pw,
        isVerified: true,
      },
    });
    bar("profiles", i + 1, cfg.profiles.length);
  }

  // tables (T1..T10)
  const tables = await Promise.all(
    Array.from({ length: 10 }).map((_, i) =>
      prisma.table.upsert({
        where: { storeId_label: { storeId, label: `T${i + 1}` } },
        update: { isActive: true },
        create: { storeId, label: `T${i + 1}`, isActive: true },
      })
    )
  );
  bar("tables", 10, 10);

  // QR tiles from txt (STATIC publicCode)
  const storeQr = qrAll.filter((x) => x.storeSlug === cfg.slug);
  if (storeQr.length !== 10)
    throw new Error(
      `qr-tiles.txt must have exactly 10 entries for ${cfg.slug}`
    );

  for (let i = 0; i < storeQr.length; i++) {
    const x = storeQr[i];
    const table = tables.find((t) => t.label === x.tableLabel);
    if (!table)
      throw new Error(
        `qr-tiles.txt references missing table ${cfg.slug}/${x.tableLabel}`
      );

    await prisma.qRTile.upsert({
      where: { publicCode: x.publicCode },
      update: {
        storeId,
        tableId: table.id,
        label: `Tile ${x.tableLabel}`,
        isActive: true,
      },
      create: {
        storeId,
        tableId: table.id,
        publicCode: x.publicCode,
        label: `Tile ${x.tableLabel}`,
        isActive: true,
      },
    });

    bar("qrTiles", i + 1, storeQr.length);
  }

  // categories + items
  const items: { id: string; title: string; priceCents: number }[] = [];
  for (let ci = 0; ci < cfg.categories.length; ci++) {
    const cat = cfg.categories[ci];
    const category = await prisma.category.upsert({
      where: { storeId_slug: { storeId, slug: cat.slug } },
      update: {
        title: cat.title,
        titleEl: cat.title,
        titleEn: cat.title,
        sortOrder: 0,
      },
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
      items.push({
        id: created.id,
        title: created.title,
        priceCents: created.priceCents,
      });
    }
    bar("categories", ci + 1, cfg.categories.length);
  }

  // minimal orders (optional)
  const now = new Date();
  const approx = 120;
  for (let i = 0; i < approx; i++) {
    const day = new Date(now);
    day.setDate(now.getDate() - randInt(0, 30));
    const placedAt = randomDateOnDay(day);
    const table = randFromArray(tables);
    const item = randFromArray(items);
    const qty = randInt(1, 2);
    const status = OrderStatus.PAID;

    const order = await prisma.order.create({
      data: {
        storeId,
        tableId: table.id,
        status,
        totalCents: item.priceCents * qty,
        placedAt,
        paidAt: new Date(placedAt.getTime() + 1000 * 60 * randInt(1, 30)),
        paymentStatus: "COMPLETED" as any,
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

    bar("orders", i + 1, approx);
  }
}

async function main() {
  section("Seed start");

  const qrAll = loadQrTilesFile();
  writeQrPrintList(qrAll);

  if (SEED_RESET) await resetAll();

  await seedGlobalArchitect();

  for (let i = 0; i < STORES.length; i++) {
    await seedStore(STORES[i], qrAll);
    bar("stores", i + 1, STORES.length);
  }

  section("Seed done");
  section("Generated");
  console.log(
    `- prisma/qr-print-list.txt  (URLs: ${PUBLIC_APP_URL}${QR_PATH_PREFIX}/<publicCode>)`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
