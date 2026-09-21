import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";

export type PrinterRoute = { device: string; width?: number; codepage?: number; encoding?: string; cut?: boolean };
type Job = { id: string; topic: string; route: PrinterRoute; payload: any; createdAt: string; error?: string };
const spool = process.env.LOCAL_PRINT_SPOOL || "/app/print-spool";
const enabled = process.env.LOCAL_PRINTING_ENABLED === "true";
const chains = new Map<string, Promise<void>>();
let routes: Record<string, PrinterRoute> = {};
let initialized: Promise<void> | undefined;
let lastError: string | null = null;

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

export async function startLocalPrinting(): Promise<void> {
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
  const job: Job = { id: `${Date.now()}-${randomUUID()}`, topic, route, payload, createdAt: new Date().toISOString() };
  const file = path.join(spool, "queued", job.id + ".json");
  await fs.writeFile(file + ".tmp", JSON.stringify(job), { mode: 0o600 });
  await fs.rename(file + ".tmp", file);
  void schedule(job).catch(error => { lastError = String(error); console.error("[local-print] queue failure", error); });
}

export async function localPrintStatus(storeSlug: string) {
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
  return { enabled, lastError, jobs };
}
