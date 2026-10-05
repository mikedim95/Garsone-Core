import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import type { PrismaClient } from "@prisma/client";
import { LocalPrintQueue, type DurablePrintJob } from "./localPrintQueue.js";

export type PrinterRoute = { device: string; width?: number; codepage?: number; encoding?: string; cut?: boolean };
type Job = { id: string; topic: string; route: PrinterRoute; payload: any; createdAt: string; error?: string };
const spool = process.env.LOCAL_PRINT_SPOOL || "/app/print-spool";
const enabled = process.env.LOCAL_PRINTING_ENABLED === "true";
const chains = new Map<string, Promise<void>>();
let routes: Record<string, PrinterRoute> = {};
let initialized: Promise<void> | undefined;
let lastError: string | null = null;
let database: PrismaClient | undefined;
let durableQueue: LocalPrintQueue | undefined;

export function localPrinterRoutes(storeSlug: string): Record<string, PrinterRoute> {
  return Object.fromEntries(Object.entries(routes).filter(([topic]) => topic.startsWith(storeSlug + "/")));
}
export function localPrintBusy(id: string, startedAt?: Date | string | null): boolean {
  return Boolean(durableQueue?.active.has(id) || (startedAt && Date.now() - new Date(startedAt).getTime() < 30_000));
}
export function stopLocalPrinting() { durableQueue?.stop(); }

async function deviceAvailable(device: string) {
  try { await fs.access(device, fs.constants.W_OK); return true; } catch { return false; }
}

// Deterministic IDs make spool import safe if the process stops between DB commit and rename.
function importedId(topic: string, id: string) {
  const value = createHash("sha256").update(`garsone-print-spool:${topic}:${id}`).digest();
  value[6] = (value[6] & 15) | 80;
  value[8] = (value[8] & 63) | 128;
  const h = value.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function startDurableQueue(client: PrismaClient) {
  await fs.mkdir(path.join(spool, "imported"), { recursive: true });
  for (const state of ["uncertain", "queued"]) {
    for (const name of await fs.readdir(path.join(spool, state))) {
      if (!name.endsWith(".json")) continue;
      const source = path.join(spool, state, name);
      const job: Job = JSON.parse(await fs.readFile(source, "utf8"));
      const slug = job.topic.split("/")[0];
      const store = await client.store.findUnique({ where: { slug }, select: { id: true } });
      if (!store) throw new Error(`Cannot import print spool for unknown store: ${slug}`);
      const changed = routes[job.topic]?.device !== job.route.device;
      await client.localPrintIntent.upsert({
        where: { id: importedId(job.topic, job.id) }, update: {},
        create: { id: importedId(job.topic, job.id), storeId: store.id, topic: job.topic,
          payload: job.payload, state: changed ? "uncertain" : state,
          error: changed ? "Printer route changed since this ticket was queued. Inspect before reprinting." : job.error,
          createdAt: new Date(job.createdAt) },
      });
      await fs.rename(source, path.join(spool, "imported", `${state}-${name}`));
    }
  }
  durableQueue = new LocalPrintQueue({
    // One head per route prevents an unavailable printer from starving another printer.
    queued: () => client.$queryRaw<DurablePrintJob[]>`SELECT DISTINCT ON ("topic") * FROM "local_print_intents" WHERE "state" = 'queued' ORDER BY "topic", "createdAt", "id"`,
    claim: async id => (await client.localPrintIntent.updateMany({ where: { id, state: "queued" },
      data: { state: "uncertain", startedAt: new Date(), error: null } })).count === 1,
    delivered: async id => { await client.localPrintIntent.update({ where: { id }, data: { state: "delivered", completedAt: new Date(), error: null } }); },
    error: async (id, error) => { await client.localPrintIntent.updateMany({ where: { id, OR: [{ error: null }, { error: { not: error } }] }, data: { error } }); },
  }, topic => routes[topic], async (job, route) => {
    await worker({ ...job, route: route as PrinterRoute, createdAt: job.createdAt.toISOString(), error: job.error ?? undefined });
  }, deviceAvailable);
  durableQueue.start();
}

const clean = (value: unknown) => String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ");

export function renderLocalTicket(payload: any, route: PrinterRoute): Buffer {
  const order = payload.order || payload;
  const width = Math.max(24, Math.min(80, route.width || 32));
  const lines: string[] = [];
  const line = (value: unknown) => {
    const text = clean(value);
    for (let start = 0; start < text.length || start === 0; start += width) lines.push(text.slice(start, start + width));
  };
  line(payload.title || "NOOR");
  line(`Table: ${payload.tableLabel || order.tableLabel || order.table?.label || "-"}`);
  line(`Ticket: ${payload.ticketNumber || order.ticketNumber || payload.orderId || order.id || "-"}`);
  line(payload.printReason || payload.status || "ORDER");
  line(payload.ts || payload.createdAt || new Date().toISOString());
  line("-".repeat(width));
  // Top-level items are already grouped for this printer. Never replace them with the whole order.
  for (const item of payload.items || order.items || order.orderItems || []) {
    line(`${item.quantity ?? item.qty ?? 1}x ${item.title || item.name || item.titleSnapshot || "Item"}`);
    for (const mod of item.modifiers || item.mods || item.orderItemOptions || []) {
      line(`  + ${typeof mod === "string" ? mod : mod.titleSnapshot || mod.optionTitleSnapshot || mod.title || mod.name || ""}`);
    }
    if (item.note) line(`  ${item.note}`);
  }
  if (payload.note || order.note || payload.message) {
    line("-".repeat(width));
    line(payload.note || order.note || payload.message);
  }
  return Buffer.concat([
    Buffer.from([0x1b, 0x40, 0x1b, 0x74, route.codepage ?? 7]),
    iconv.encode(lines.join("\n") + "\n\n\n", route.encoding || "cp1253"),
    route.cut ? Buffer.from([0x1d, 0x56, 0]) : Buffer.alloc(0),
  ]);
}

function worker(job: Job): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./localPrintWorker.js", import.meta.url)), job.route.device], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let error = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20_000);
    child.stderr.on("data", chunk => { error = (error + chunk.toString()).slice(-2000); });
    child.stdin.on("error", () => {});
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else reject(new Error(timedOut ? "Bluetooth write timed out; inspect paper before reprinting" : error || `Print worker exited ${code}`));
    });
    child.stdin.end(renderLocalTicket(job.payload, job.route));
  });
}

function schedule(job: Job): Promise<void> {
  const previous = chains.get(job.route.device) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    // Interrupted/partially written tickets must never be automatically replayed.
    await fs.rename(path.join(spool, "queued", job.id + ".json"), path.join(spool, "uncertain", job.id + ".json"));
    try {
      await worker(job);
      await fs.unlink(path.join(spool, "uncertain", job.id + ".json"));
      console.info("[local-print] written", { jobId: job.id, topic: job.topic });
    } catch (error) {
      lastError = String(error);
      job.error = lastError;
      await fs.writeFile(path.join(spool, "uncertain", job.id + ".json"), JSON.stringify(job), { mode: 0o600 });
      console.error("[local-print] needs operator review", { jobId: job.id, error: lastError });
    }
  });
  chains.set(job.route.device, next);
  return next;
}

export async function startLocalPrinting(client?: PrismaClient): Promise<void> {
  // Staff must still see unresolved durable tickets when output is disabled.
  if (client) database = client;
  if (!enabled) return;
  if (initialized) return initialized;
  initialized = (async () => {
    routes = JSON.parse(await fs.readFile(process.env.LOCAL_PRINTER_ROUTES_FILE || "/app/printers.json", "utf8"));
    for (const [topic, route] of Object.entries(routes)) {
      if (!/^[^/]+\/orders\/(preparing|placed)\/[^/]+$/.test(topic) || !/^\/dev\/(rfcomm\d+|pts\/\d+)$/.test(route.device)) {
        throw new Error(`Invalid local printer route: ${topic}`);
      }
      if (!iconv.encodingExists(route.encoding || "cp1253")) throw new Error(`Unsupported printer encoding: ${route.encoding}`);
    }
    for (const state of ["queued", "uncertain"]) await fs.mkdir(path.join(spool, state), { recursive: true });
    if (client) { await startDurableQueue(client); return; }
    for (const name of (await fs.readdir(path.join(spool, "queued"))).sort()) {
      if (!name.endsWith(".json")) continue;
      const job: Job = JSON.parse(await fs.readFile(path.join(spool, "queued", name), "utf8"));
      // Resume only jobs still matching the explicitly configured device.
      if (routes[job.topic]?.device !== job.route.device) throw new Error(`Printer route changed for queued job ${job.id}`);
      void schedule(job).catch(error => { lastError = String(error); console.error("[local-print] queue failure", error); });
    }
  })();
  return initialized;
}

export function usesLocalPrinter(topic: string): boolean { return enabled && Boolean(routes[topic]); }

export async function enqueueLocalPrint(topic: string, payload: any): Promise<void> {
  await startLocalPrinting();
  const route = routes[topic];
  if (!enabled || !route) return;
  if (database) {
    const store = await database.store.findUnique({ where: { slug: topic.split("/")[0] }, select: { id: true } });
    if (!store) throw new Error("Printer store was not found");
    await database.localPrintIntent.create({ data: { storeId: store.id, topic, payload } });
    return;
  }
  const job: Job = { id: `${Date.now()}-${randomUUID()}`, topic, route, payload, createdAt: new Date().toISOString() };
  const file = path.join(spool, "queued", job.id + ".json");
  await fs.writeFile(file + ".tmp", JSON.stringify(job), { mode: 0o600 });
  await fs.rename(file + ".tmp", file);
  void schedule(job).catch(error => { lastError = String(error); console.error("[local-print] queue failure", error); });
}

export async function localPrintStatus(storeSlug: string) {
  if (database) {
    const store = await database.store.findUnique({ where: { slug: storeSlug }, select: { id: true } });
    if (!store) return { enabled, lastError: null, jobs: [], printers: [], pendingCount: 0 };
    const scope = { storeId: store.id };
    const [pending, recent, pendingCount] = await Promise.all([
      database.localPrintIntent.findMany({ where: { ...scope, state: { in: ["queued", "uncertain"] }, resolvedAt: null }, orderBy: [{ state: "desc" }, { createdAt: "asc" }], take: 200 }),
      database.localPrintIntent.findMany({ where: { ...scope, OR: [{ state: "delivered" }, { resolvedAt: { not: null } }] }, orderBy: { updatedAt: "desc" }, take: 20 }),
      database.localPrintIntent.count({ where: { ...scope, state: { in: ["queued", "uncertain"] }, resolvedAt: null } }),
    ]);
    const jobs = [...pending, ...recent].map(job => {
      const payload = job.payload as any;
      return { id: job.id, topic: job.topic, state: job.state, createdAt: job.createdAt,
        startedAt: job.startedAt, orderId: job.orderId, error: job.error, busy: !job.resolvedAt && job.state === "uncertain" && localPrintBusy(job.id, job.startedAt),
        ticketNumber: payload?.ticketNumber ?? payload?.order?.ticketNumber,
        tableLabel: payload?.tableLabel ?? payload?.order?.tableLabel ?? payload?.order?.table?.label,
        reprintOfId: job.reprintOfId, resolvedAt: job.resolvedAt, resolution: job.resolution };
    });
    const scopedRoutes = localPrinterRoutes(storeSlug);
    const devices = [...new Set(Object.values(scopedRoutes).map(route => route.device))];
    const printers = await Promise.all(devices.map(async device => {
      const topics = Object.keys(scopedRoutes).filter(topic => scopedRoutes[topic].device === device);
      return { id: path.basename(device), device, topics, available: await deviceAvailable(device),
        busy: durableQueue?.isDeviceBusy(device) || false,
        lastError: pending.find(job => topics.includes(job.topic) && job.error)?.error ?? null };
    }));
    return { enabled, lastError: null, jobs, printers, pendingCount };
  }
  const jobs: Array<{ id: string; topic: string; state: string; error?: string }> = [];
  if (enabled) {
    for (const state of ["queued", "uncertain"]) {
      for (const file of await fs.readdir(path.join(spool, state))) {
        if (!file.endsWith(".json")) continue;
        try {
          const job: Job = JSON.parse(await fs.readFile(path.join(spool, state, file), "utf8"));
          if (job.topic.startsWith(storeSlug + "/")) jobs.push({ id: job.id, topic: job.topic, state, error: job.error });
        } catch { /* A successfully written job can disappear while listing. */ }
      }
    }
  }
  return { enabled, lastError: jobs.find(job => job.error)?.error ?? null, jobs, printers: [], pendingCount: jobs.length };
}
