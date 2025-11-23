// prisma/test_io.ts
import { PrismaClient, Role, OrderStatus } from "@prisma/client";
import { performance } from "perf_hooks";

const prisma = new PrismaClient();

/**
 * CONFIG (override with env vars)
 *
 * TEST_STORE_SLUG: which store to hit
 * TEST_CONCURRENCY: how many workers in parallel
 * TEST_DURATION_SEC: how long to run the test
 */
const STORE_SLUG =
  process.env.TEST_STORE_SLUG || process.env.STORE_SLUG || "demo-bar";
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 5);
const DURATION_SEC = Number(process.env.TEST_DURATION_SEC || 60);

type OpName = "create" | "update" | "read";

type StatBucket = {
  samples: number[]; // ms per op
  errors: number;
};

const stats: Record<OpName, StatBucket> = {
  create: { samples: [], errors: 0 },
  update: { samples: [], errors: 0 },
  read: { samples: [], errors: 0 },
};

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pickRandom<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}

type TestContext = {
  store: Awaited<ReturnType<typeof prisma.store.findFirst>>;
  tables: Awaited<ReturnType<typeof prisma.table.findMany>>;
  items: Awaited<ReturnType<typeof prisma.item.findMany>>;
  waiters: Awaited<ReturnType<typeof prisma.profile.findMany>>;
  orderIds: string[]; // new: in-memory pool of order ids
};

async function prepareContext(): Promise<TestContext> {
  const store = await prisma.store.findFirst({
    where: { slug: STORE_SLUG },
  });
  if (!store) {
    throw new Error(
      `No store found with slug "${STORE_SLUG}". Run db:seed first or set TEST_STORE_SLUG.`
    );
  }

  const tables = await prisma.table.findMany({ where: { storeId: store.id } });
  if (!tables.length) {
    throw new Error("No tables found for this store. Run db:seed first.");
  }

  const items = await prisma.item.findMany({
    where: { storeId: store.id, isAvailable: true },
  });
  if (!items.length) {
    throw new Error(
      "No available items found for this store. Run db:seed first."
    );
  }

  const waiters = await prisma.profile.findMany({
    where: { storeId: store.id, role: Role.WAITER },
  });

  // preload recent orders so updates have something to target
  const recentOrders = await prisma.order.findMany({
    where: { storeId: store.id },
    select: { id: true },
    orderBy: { placedAt: "desc" },
    take: 1000, // enough for randomization
  });

  return {
    store,
    tables,
    items,
    waiters,
    orderIds: recentOrders.map((o) => o.id),
  };
}

// ------------- OPERATIONS -------------

async function opCreateOrder(ctx: TestContext) {
  const { store, tables, items, orderIds } = ctx;
  const table = pickRandom(tables);

  const itemsCount = randInt(1, 4);
  const orderItemsData: {
    itemId: string;
    titleSnapshot: string;
    unitPriceCents: number;
    quantity: number;
  }[] = [];

  let totalCents = 0;
  for (let i = 0; i < itemsCount; i++) {
    const item = pickRandom(items);
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

  const placedAt = new Date();
  const created = await prisma.order.create({
    data: {
      storeId: store!.id,
      tableId: table.id,
      status: OrderStatus.PLACED,
      totalCents,
      placedAt,
      ticketNumber: undefined, // let your logic fill if you have triggers, else null
      orderItems: {
        create: orderItemsData,
      },
    },
    select: { id: true },
  });

  // keep pool of order IDs fresh
  orderIds.push(created.id);
  if (orderIds.length > 2000) {
    orderIds.splice(0, orderIds.length - 2000); // cap size
  }
}

async function opUpdateRandomOrder(ctx: TestContext) {
  const { store, orderIds } = ctx;
  if (!orderIds.length) return;

  const orderId = pickRandom(orderIds);

  const targetStatusPool: OrderStatus[] = [
    OrderStatus.PREPARING,
    OrderStatus.READY,
    OrderStatus.SERVED,
    OrderStatus.PAID,
  ];
  const newStatus = pickRandom(targetStatusPool);

  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: newStatus,
      note: Math.random() < 0.2 ? "Updated during benchmark" : undefined,
    },
  });
}

async function opReadRecentOrders(ctx: TestContext) {
  const { store } = ctx;
  await prisma.order.findMany({
    where: { storeId: store!.id },
    orderBy: { placedAt: "desc" },
    take: 50,
  });
}

// ------------- WORKERS -------------

async function runWorker(id: number, ctx: TestContext, endAt: number) {
  while (Date.now() < endAt) {
    const roll = Math.random();
    let op: OpName;
    let fn: (ctx: TestContext) => Promise<void>;

    if (roll < 0.3) {
      op = "create";
      fn = opCreateOrder;
    } else if (roll < 0.6) {
      op = "update";
      fn = opUpdateRandomOrder;
    } else {
      op = "read";
      fn = opReadRecentOrders;
    }

    const start = performance.now();
    try {
      await fn(ctx);
      const dur = performance.now() - start;
      stats[op].samples.push(dur);
    } catch (err: any) {
      stats[op].errors++;
      // optional verbose:
      // console.warn(`[worker ${id}] ${op} failed:`, err?.message || err);
    }
  }
  console.log(`[worker ${id}] finished`);
}

// ------------- STATS -------------

function computePercentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

function summarizeStats(totalDurationSec: number) {
  const totalOps =
    stats.create.samples.length +
    stats.update.samples.length +
    stats.read.samples.length;
  const opsPerSec = totalOps / totalDurationSec;

  console.log("\n===== DB I/O BENCHMARK RESULTS =====");
  console.log(`Store        : ${STORE_SLUG}`);
  console.log(`Concurrency  : ${CONCURRENCY}`);
  console.log(`Duration     : ${totalDurationSec.toFixed(1)} s`);
  console.log(`Total ops    : ${totalOps}`);
  console.log(`Overall TPS  : ${opsPerSec.toFixed(2)} ops/s\n`);

  (["create", "update", "read"] as OpName[]).forEach((name) => {
    const bucket = stats[name];
    const n = bucket.samples.length;
    if (!n) {
      console.log(`${name.toUpperCase()}: no samples`);
      return;
    }
    const sum = bucket.samples.reduce((a, b) => a + b, 0);
    const avg = sum / n;
    const p50 = computePercentile(bucket.samples, 50);
    const p90 = computePercentile(bucket.samples, 90);
    const p95 = computePercentile(bucket.samples, 95);
    const p99 = computePercentile(bucket.samples, 99);
    const max = Math.max(...bucket.samples);

    console.log(`${name.toUpperCase()}:`);
    console.log(
      `  ops=${n}, errors=${bucket.errors}, avg=${avg.toFixed(
        1
      )}ms, p50=${p50.toFixed(1)}ms, p90=${p90.toFixed(1)}ms, p95=${p95.toFixed(
        1
      )}ms, p99=${p99.toFixed(1)}ms, max=${max.toFixed(1)}ms`
    );
  });

  console.log("====================================\n");
}

// ------------- MAIN -------------

async function main() {
  console.log(
    `Starting DB I/O test for store=${STORE_SLUG} concurrency=${CONCURRENCY} duration=${DURATION_SEC}s`
  );

  const ctx = await prepareContext();
  console.log(
    `Context loaded: ${ctx.tables.length} tables, ${ctx.items.length} items, ${ctx.waiters.length} waiters, ${ctx.orderIds.length} existing orders`
  );

  const start = Date.now();
  const endAt = start + DURATION_SEC * 1000;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => runWorker(i + 1, ctx, endAt))
  );

  const totalDurationSec = (Date.now() - start) / 1000;
  summarizeStats(totalDurationSec);
}

main()
  .catch((err) => {
    console.error("DB test crashed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
