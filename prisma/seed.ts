/**
 * prisma/seed.ts
 *
 * Requirements covered:
 * - Reads STATIC publicCodes from prisma/qr-tiles.txt (random-looking, stable forever)
 * - Generates prisma/qr-print-list.txt with URLs:
 *     ${PUBLIC_APP_URL}/publiccode/${publicCode}
 * - Seeds 3 stores, 10 tables/store, 10 qrTiles/store
 * - Seeds central architect (architect@demo.local / changeme) with NON-NULL storeId:
 *     assigned to a RANDOM existing store id
 * - Progress bars
 * - No migrationsqrqr
 * - Avoids nested relation writes for Order -> OrderItem (schema-name agnostic)
 */

import { PrismaClient, Role, OrderStatus } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcrypt";
import crypto from "node:crypto";

const prisma = new PrismaClient();

// ===== runtime config =====
const SEED_RESET = process.env.SEED_RESET !== "0";
const PUBLIC_APP_URL = (
  process.env.PUBLIC_APP_URL ?? "https://www.garsone.gr"
).replace(/\/+$/, "");
const QR_PATH_PREFIX = "/publiccode";

// ===== progress bars =====
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

// ===== helpers =====
type QrLine = { storeSlug: string; tableLabel: string; publicCode: string };

function loadQrTilesFile(): QrLine[] {
  const file = path.join(process.cwd(), "prisma", "qr-tiles.txt");
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${file}`);

  const raw = fs.readFileSync(file, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const parsed: QrLine[] = [];
  for (const line of lines) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length !== 3)
      throw new Error(
        `Bad qr-tiles.txt line (expected 3 CSV values): "${line}"`
      );
    const [storeSlug, tableLabel, publicCode] = parts;
    if (!storeSlug || !tableLabel || !publicCode)
      throw new Error(`Bad qr-tiles.txt line (empty value): "${line}"`);
    parsed.push({ storeSlug, tableLabel, publicCode });
  }

  // enforce unique publicCode
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
function randomDateWithinDaysBack(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - randInt(0, daysBack));
  d.setHours(randInt(9, 23), randInt(0, 59), randInt(0, 59), 0);
  return d;
}
async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
function sessionToken64(): string {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
}

// ===== seed config =====
type StoreConfig = {
  slug: string;
  name: string;
  currencyCode: string;
  locale: string;
  profiles: { email: string; role: Role; displayName: string }[];
  categories: {
    slug: string;
    title: string;
    items: {
      slug: string;
      title: string;
      priceCents: number;
      imageUrl: string;
    }[];
  }[];
};

const STORES: StoreConfig[] = [
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
        displayName: "Bar Kitchen",
      },
    ],
    categories: [
      {
        slug: "cocktails",
        title: "Cocktails",
        items: [
          {
            slug: "mojito",
            title: "Mojito",
            priceCents: 850,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/cocktails/mohito.jpg",
          },
          {
            slug: "spritz",
            title: "Spritz",
            priceCents: 900,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/cocktails/spritz.jpg",
          },
        ],
      },
      {
        slug: "spirits",
        title: "Spirits",
        items: [
          {
            slug: "gin-tonic",
            title: "Gin & Tonic",
            priceCents: 800,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/spirits/gin-tonic.jpg",
          },
          {
            slug: "whisky",
            title: "Whisky",
            priceCents: 900,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/spirits/whisky.jpg",
          },
        ],
      },
      {
        slug: "bar-snacks",
        title: "Bar Snacks",
        items: [
          {
            slug: "nachos",
            title: "Nachos",
            priceCents: 650,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/bar-snacks/nachos.jpeg",
          },
          {
            slug: "nuts",
            title: "Mixed Nuts",
            priceCents: 350,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/bar-snacks/nuts.jpg",
          },
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
        slug: "souvlaki",
        title: "Souvlaki",
        items: [
          {
            slug: "pita-pork",
            title: "Pita Pork",
            priceCents: 350,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/souvlaki/pita-pork.jpg",
          },
          {
            slug: "pita-chicken",
            title: "Pita Chicken",
            priceCents: 380,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/souvlaki/pita-chicken.jpg",
          },
        ],
      },
      {
        slug: "plates",
        title: "Plates",
        items: [
          {
            slug: "gyro-plate",
            title: "Gyro Plate",
            priceCents: 900,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/plates/gyro-plate.jpg",
          },
          {
            slug: "mixed-grill",
            title: "Mixed Grill",
            priceCents: 1400,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/plates/mixed-grill.jpg",
          },
        ],
      },
      {
        slug: "drinks",
        title: "Drinks",
        items: [
          {
            slug: "cola",
            title: "Cola",
            priceCents: 200,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/drinks/cola.jpg",
          },
          {
            slug: "beer",
            title: "Beer",
            priceCents: 450,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/drinks/beer.jpg",
          },
        ],
      },
    ],
  },
];

// ===== reset (best-effort order) =====
async function resetAll() {
  section("Resetting DB");
  const steps: Array<{ label: string; fn: () => Promise<any> }> = [
    {
      label: "orderItemOptions",
      fn: () => prisma.orderItemOption.deleteMany(),
    },
    { label: "orderItems", fn: () => prisma.orderItem.deleteMany() },
    { label: "orders", fn: () => prisma.order.deleteMany() },

    { label: "itemModifiers", fn: () => prisma.itemModifier.deleteMany() },
    { label: "modifierOptions", fn: () => prisma.modifierOption.deleteMany() },
    { label: "modifiers", fn: () => prisma.modifier.deleteMany() },

    { label: "items", fn: () => prisma.item.deleteMany() },
    { label: "categories", fn: () => prisma.category.deleteMany() },

    { label: "waiterTables", fn: () => prisma.waiterTable.deleteMany() },
    { label: "waiterShifts", fn: () => prisma.waiterShift.deleteMany() },

    { label: "tableVisits", fn: () => prisma.tableVisit.deleteMany() },
    { label: "qrTiles", fn: () => prisma.qRTile.deleteMany() },
    { label: "tables", fn: () => prisma.table.deleteMany() },

    { label: "auditLogs", fn: () => prisma.auditLog.deleteMany() },
    { label: "profiles", fn: () => prisma.profile.deleteMany() },

    {
      label: "kitchenTicketSeqs",
      fn: () => prisma.kitchenTicketSeq.deleteMany(),
    },
    { label: "kitchenCounters", fn: () => prisma.kitchenCounter.deleteMany() },
    { label: "storeMeta", fn: () => prisma.storeMeta.deleteMany() },
    { label: "stores", fn: () => prisma.store.deleteMany() },
  ];

  for (let i = 0; i < steps.length; i++) {
    bar("reset", i, steps.length);
    await steps[i].fn();
  }
  bar("reset", steps.length, steps.length);
}

// ===== seed pieces =====
async function seedStoresAndData(qrAll: QrLine[]) {
  const storeIds: string[] = [];

  for (let si = 0; si < STORES.length; si++) {
    const cfg = STORES[si];
    section(`Store ${si + 1}/${STORES.length}: ${cfg.slug}`);

    const store = await prisma.store.upsert({
      where: { slug: cfg.slug },
      update: { name: cfg.name },
      create: { slug: cfg.slug, name: cfg.name, settingsJson: {} },
    });
    const storeId = store.id;
    storeIds.push(storeId);

    await prisma.storeMeta.upsert({
      where: { storeId },
      update: { currencyCode: cfg.currencyCode, locale: cfg.locale },
      create: { storeId, currencyCode: cfg.currencyCode, locale: cfg.locale },
    });

    // store-scoped profiles (all pass = changeme)
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
      bar("store:profiles", i + 1, cfg.profiles.length);
    }

    // tables T1..T10
    const tables = [];
    for (let i = 1; i <= 10; i++) {
      const t = await prisma.table.upsert({
        where: { storeId_label: { storeId, label: `T${i}` } },
        update: { isActive: true },
        create: { storeId, label: `T${i}`, isActive: true },
      });
      tables.push(t);
    }
    bar("store:tables", 10, 10);

    // qr tiles from qr-tiles.txt (MUST be 10/store)
    const storeQr = qrAll.filter((x) => x.storeSlug === cfg.slug);
    if (storeQr.length !== 10)
      throw new Error(
        `qr-tiles.txt must have exactly 10 entries for ${cfg.slug} (found ${storeQr.length})`
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

      bar("store:qrTiles", i + 1, storeQr.length);
    }

    // categories + items
    const items: Array<{ id: string; title: string; priceCents: number }> = [];

    for (let ci = 0; ci < cfg.categories.length; ci++) {
      const cat = cfg.categories[ci];
      const category = await prisma.category.upsert({
        where: { storeId_slug: { storeId, slug: cat.slug } },
        update: {
          title: cat.title,
          titleEl: cat.title,
          titleEn: cat.title,
          sortOrder: ci,
        },
        create: {
          storeId,
          slug: cat.slug,
          title: cat.title,
          titleEl: cat.title,
          titleEn: cat.title,
          sortOrder: ci,
        },
      });

      for (let ii = 0; ii < cat.items.length; ii++) {
        const it = cat.items[ii];
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
            sortOrder: ii,
          },
        });
        items.push({
          id: created.id,
          title: created.title,
          priceCents: created.priceCents,
        });
      }

      bar("store:categories", ci + 1, cfg.categories.length);
    }

    // a couple OPEN visits
    for (let v = 0; v < 2; v++) {
      const table = randFromArray(tables);
      const tile = storeQr.find((x) => x.tableLabel === table.label);
      if (!tile) continue;

      const tileRow = await prisma.qRTile.findUnique({
        where: { publicCode: tile.publicCode },
      });
      if (!tileRow) continue;

      await prisma.tableVisit.create({
        data: {
          storeId,
          tableId: table.id,
          tileId: tileRow.id,
          sessionToken: sessionToken64(),
          status: "OPEN" as any,
        },
      });
    }
    bar("store:visits", 2, 2);

    // orders (simple, schema-agnostic: Order then OrderItem)
    section(`Orders for ${cfg.slug}`);
    const totalOrders = 80;
    for (let oi = 0; oi < totalOrders; oi++) {
      const table = randFromArray(tables);
      const it = randFromArray(items);
      const qty = randInt(1, 2);

      const placedAt = randomDateWithinDaysBack(30);
      const paidAt = new Date(placedAt.getTime() + randInt(2, 35) * 60_000);

      const order = await prisma.order.create({
        data: {
          storeId,
          tableId: table.id,
          status: OrderStatus.PAID,
          totalCents: it.priceCents * qty,
          placedAt,
          paidAt,
          // if your DB enforces this NOT NULL, keep it:
          paymentStatus: "COMPLETED" as any,
        } as any,
      });

      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          itemId: it.id,
          titleSnapshot: it.title,
          unitPriceCents: it.priceCents,
          quantity: qty,
        },
      });

      bar("orders", oi + 1, totalOrders);
    }
  }

  return storeIds;
}

async function seedArchitectAssignedToRandomStore(storeIds: string[]) {
  section("Seeding architect (random storeId, not null)");

  if (storeIds.length === 0)
    throw new Error("No stores were seeded; cannot assign architect storeId.");

  const email = "architect@demo.local";
  const passwordHash = await hashPassword("changeme");

  const randomStoreId = randFromArray(storeIds);

  await prisma.profile.upsert({
    where: { globalKey: email },
    update: {
      storeId: randomStoreId,
      email,
      globalKey: email,
      role: Role.ARCHITECT,
      displayName: "Central Architect",
      passwordHash,
      isVerified: true,
    },
    create: {
      storeId: randomStoreId,
      email,
      globalKey: email,
      role: Role.ARCHITECT,
      displayName: "Central Architect",
      passwordHash,
      isVerified: true,
    },
  });

  bar("architect", 1, 1);
}

// ===== main =====
async function main() {
  section("Seed start");

  const qrAll = loadQrTilesFile();
  writeQrPrintList(qrAll);

  section("Generated print list");
  console.log(
    `prisma/qr-print-list.txt -> ${PUBLIC_APP_URL}${QR_PATH_PREFIX}/<publicCode>`
  );

  if (SEED_RESET) await resetAll();

  const storeIds = await seedStoresAndData(qrAll);
  await seedArchitectAssignedToRandomStore(storeIds);

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
