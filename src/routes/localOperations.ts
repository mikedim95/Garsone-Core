import type { FastifyInstance } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { localPrintBusy, localPrinterRoutes, localPrintStatus } from "../lib/localPrinting.js";

const testRequest = z.object({ printerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), requestId: z.string().uuid() }).strict();
const resolveRequest = z.object({ action: z.enum(["printed", "reprint"]), requestId: z.string().uuid() }).strict();
const jobParams = z.object({ id: z.string().uuid() });

async function backupStatus() {
  const file = process.env.LOCAL_BACKUP_STATUS_FILE;
  if (!file) return { lastSuccessfulAt: null, source: "unknown" };
  try {
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    const at = Date.parse(record.lastSuccessfulAt);
    if (record.source !== "deployment" || !Number.isFinite(at) || at > Date.now() + 300_000) throw new Error("Invalid status");
    return { lastSuccessfulAt: new Date(at).toISOString(), source: "deployment" };
  } catch (error: any) {
    return { lastSuccessfulAt: null, source: "unknown", ...(error.code === "ENOENT" ? {} : { error: "Backup status could not be read" }) };
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Health check timed out")), milliseconds);
    })]);
  } finally { clearTimeout(timeout!); }
}

export async function localOperationsRoutes(app: FastifyInstance) {
  const restricted = [authMiddleware, requireRole(["manager", "architect"]), async (request: any, reply: any) => {
    if (process.env.LOCAL_ONLY !== "true" || request.user.storeSlug !== process.env.STORE_SLUG) {
      return reply.code(404).send({ error: "LOCAL_OPERATIONS_UNAVAILABLE" });
    }
  }];
  app.get("/manager/local-operations", { preHandler: restricted }, async () => {
    const database = await withTimeout(db.$queryRaw`SELECT 1`, 4000).then(() => ({ ok: true }), () => ({ ok: false }));
    const storage = await fs.statfs(process.env.LOCAL_UPLOAD_DIR || path.resolve("uploads"))
      .then(stat => ({ availableBytes: Number(stat.bavail) * Number(stat.bsize) }), () => ({ availableBytes: null }));
    const printing = database.ok
      ? await withTimeout(localPrintStatus(process.env.STORE_SLUG!), 4000).catch(() => ({ enabled: process.env.LOCAL_PRINTING_ENABLED === "true", lastError: "Print queue could not be read", printers: [], jobs: [], pendingCount: null }))
      : { enabled: process.env.LOCAL_PRINTING_ENABLED === "true", lastError: "Database unavailable; print queue could not be read", printers: [], jobs: [], pendingCount: null };
    return { localOnly: true, checkedAt: new Date().toISOString(), system: { uptimeSeconds: Math.floor(process.uptime()), database, storage },
      backup: await backupStatus(), printing };
  });

  app.post("/manager/local-operations/printers/test", { preHandler: restricted,
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request, reply) => {
    const parsed = testRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PRINT_REQUEST" });
    const user = (request as any).user;
    const { printerId, requestId } = parsed.data;
    const routes = localPrinterRoutes(user.storeSlug);
    const topic = Object.keys(routes).sort().find(topic => path.basename(routes[topic].device) === printerId);
    if (!topic || process.env.LOCAL_PRINTING_ENABLED !== "true") return reply.code(404).send({ error: "PRINTER_NOT_FOUND" });
    const replay = (job: any) => job?.storeId === user.storeId && job.payload?.opsAction === "test" &&
      job.payload?.opsPrinterId === printerId && job.payload?.opsActor === user.userId;
    const existing = await db.localPrintIntent.findUnique({ where: { id: requestId } });
    if (existing) return replay(existing) ? { jobId: existing.id, replayed: true } : reply.code(409).send({ error: "REQUEST_ID_REUSED" });
    try {
      const job = await db.localPrintIntent.create({ data: { id: requestId, storeId: user.storeId, topic,
        payload: { title: "Garsone printer test", printReason: "TEST - NOT AN ORDER", ts: new Date().toISOString(),
          items: [{ title: "Printer connection test", quantity: 1 }], note: "Verify that this ticket is complete and readable.",
          opsAction: "test", opsPrinterId: printerId, opsActor: user.userId } } });
      return reply.code(202).send({ jobId: job.id, replayed: false });
    } catch (error: any) {
      if (error.code !== "P2002") throw error;
      const job = await db.localPrintIntent.findUnique({ where: { id: requestId } });
      return replay(job) ? { jobId: job!.id, replayed: true } : reply.code(409).send({ error: "REQUEST_ID_REUSED" });
    }
  });

  app.post("/manager/local-operations/jobs/:id/resolve", { preHandler: restricted,
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const params = jobParams.safeParse(request.params);
    const parsed = resolveRequest.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: "INVALID_PRINT_REQUEST" });
    const user = (request as any).user;
    const { action, requestId } = parsed.data;
    // Serialize staff actions on this ticket so simultaneous taps cannot create two reprints.
    const result = await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${params.data.id}, 0))`;
      const job = await tx.localPrintIntent.findFirst({ where: { id: params.data.id, storeId: user.storeId } });
      if (!job) return { status: 404, error: "PRINT_JOB_NOT_FOUND" };
      if (job.resolvedAt) {
        if (job.resolution === action && job.resolvedBy === user.userId) {
          const reprint = action === "reprint" ? await tx.localPrintIntent.findFirst({ where: { reprintOfId: job.id, storeId: user.storeId } }) : null;
          return { jobId: reprint?.id || job.id, replayed: true };
        }
        return { status: 409, error: "PRINT_JOB_ALREADY_RESOLVED" };
      }
      if (job.state !== "uncertain") return { status: 409, error: "PRINT_JOB_NOT_UNCERTAIN" };
      if (localPrintBusy(job.id, job.startedAt)) return { status: 409, error: "PRINT_JOB_BUSY" };
      if (action === "reprint") {
        if (process.env.LOCAL_PRINTING_ENABLED !== "true" || !localPrinterRoutes(user.storeSlug)[job.topic]) return { status: 409, error: "PRINTER_NOT_CONFIGURED" };
        const existing = await tx.localPrintIntent.findUnique({ where: { id: requestId } });
        if (existing) return { status: 409, error: "REQUEST_ID_REUSED" };
        const original = job.payload as any;
        await tx.localPrintIntent.create({ data: { id: requestId, storeId: user.storeId, orderId: job.orderId,
          topic: job.topic, reprintOfId: job.id, payload: { ...original, printReason: "REPRINT - CHECK FOR DUPLICATE",
            opsAction: "reprint", opsActor: user.userId, originalPrintReason: original?.printReason } } });
      }
      await tx.localPrintIntent.update({ where: { id: job.id }, data: { resolvedAt: new Date(), resolvedBy: user.userId, resolution: action } });
      return { jobId: action === "reprint" ? requestId : job.id, replayed: false };
    }).catch((error: any) => {
      // Different tickets can race with the same client request ID. The unique
      // constraint rolls back the losing resolution along with its reprint.
      if (error.code === "P2002") return { status: 409, error: "REQUEST_ID_REUSED" };
      throw error;
    });
    if ("error" in result) return reply.code(result.status!).send({ error: result.error });
    return result;
  });
}
