import { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { importNodeQrSnapshot } from "../lib/nodeQrConfig.js";

export async function localQrConfigRoutes(app: FastifyInstance) {
  app.post("/internal/qr-config", async (request, reply) => {
    const expected = Buffer.from(process.env.LOCAL_QR_SYNC_SECRET || "");
    const provided = Buffer.from(String(request.headers["x-local-qr-secret"] || ""));
    if (process.env.LOCAL_ONLY !== "true" || expected.length < 32 || provided.length !== expected.length || !timingSafeEqual(expected, provided)) {
      return reply.status(401).send({ error: "INVALID_LOCAL_QR_SECRET" });
    }
    try { return await importNodeQrSnapshot(request.body); }
    catch (error) {
      request.log.warn({ errorType: error instanceof Error ? error.name : "Error" }, "Local QR configuration rejected");
      return reply.status(400).send({ error: "INVALID_LOCAL_QR_CONFIG" });
    }
  });
}
