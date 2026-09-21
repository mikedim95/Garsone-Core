import Fastify from "fastify";
import { registerHttpSecurity } from "./lib/httpSecurity.js";
import { jwtSecret } from "./lib/jwt.js";
import { startQrSync } from "./lib/qrSync.js";
import dotenv from "dotenv";
import { authRoutes } from "./routes/auth.js";
import { menuRoutes } from "./routes/menu.js";
import { orderRoutes } from "./routes/orders.js";
import { storeRoutes } from "./routes/store.js";
import { waiterTableRoutes } from "./routes/waiterTables.js";
import { managerRoutes } from "./routes/manager.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { eventsRoutes } from "./routes/events.js";
import { qrTileRoutes } from "./routes/qrTiles.js";
import { qrEventRoutes } from "./routes/qrEvents.js";
import { localityRoutes } from "./routes/locality.js";
import { publicMenuBootstrapRoutes } from "./routes/publicMenuBootstrap.js";
import { nodeAgentRoutes } from "./routes/nodeAgents.js";
import { customerPushRoutes } from "./routes/customerPush.js";
import { staffPushRoutes } from "./routes/staffPush.js";
import { venueDeploymentRoutes } from "./routes/venueDeployment.js";
import { piReleaseRoutes } from "./routes/piReleases.js";
import { setupRealtimeGateway } from "./lib/realtime.js";
import { getMqttClient } from "./lib/mqtt.js";
import { startLocalPrinting, localPrintStatus } from "./lib/localPrinting.js";
import { authMiddleware, requireRole } from "./middleware/auth.js";
import { ensureOrderPaymentColumns } from "./db/ensureOrderPaymentColumns.js";
import { ensureProfilePrinterTopic } from "./db/ensureProfilePrinterTopic.js";
import { ensureStaffSchema } from "./db/ensureStaffSchema.js";
import { ensureStaffPushSchema } from "./lib/staffPush.js";

// Load local .env only for non-production environments.
// In online deployments, rely solely on platform-provided env vars.
if ((process.env.NODE_ENV || "").toLowerCase() !== "production") {
  dotenv.config();
}

const PORT = parseInt(process.env.PORT || "8787", 10);
// CORS configuration with sensible fallbacks for production deploys
// Accept either CORS_ORIGINS or CORS_ORIGIN (singular) for compatibility

// CORS
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info",
    serializers: { req: request => ({ method: request.method, url: request.url?.split("?")[0], hostname: request.hostname, remoteAddress: request.ip }) },
    redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-auth-token", "req.headers.x-deployment-secret"],
  },
  trustProxy: (_address, hop) => hop < Number(process.env.TRUST_PROXY_HOPS || "0"),
});
jwtSecret();

if (process.env.LOCAL_ONLY === "true") {
  fastify.addHook("onRequest", async (request, reply) => {
    if (request.url.split("?")[0] === "/payment/viva/checkout-url") {
      return reply.code(503).send({ error: "Online payment is disabled on this local installation. Pay at the venue." });
    }
  });
}

await registerHttpSecurity(fastify);
// Health check
fastify.get("/health", async (request, reply) => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

setupRealtimeGateway(fastify);
await startLocalPrinting();
fastify.get("/manager/local-printing", {
  preHandler: [authMiddleware, requireRole(["manager", "architect"])],
}, async request => localPrintStatus((request as any).user.storeSlug));
getMqttClient();
await ensureStaffSchema();
await ensureProfilePrinterTopic();
await ensureOrderPaymentColumns();
await ensureStaffPushSchema();

// Register routes
await fastify.register(authRoutes);
await fastify.register(storeRoutes);
await fastify.register(menuRoutes);
await fastify.register(orderRoutes);
await fastify.register(waiterTableRoutes);
await fastify.register(managerRoutes);
await fastify.register(webhookRoutes);
await fastify.register(eventsRoutes);
await fastify.register(qrTileRoutes);
await fastify.register(qrEventRoutes);
await fastify.register(localityRoutes);
await fastify.register(publicMenuBootstrapRoutes);
await fastify.register(nodeAgentRoutes);
await fastify.register(customerPushRoutes);
await fastify.register(staffPushRoutes);
await fastify.register(venueDeploymentRoutes);
await fastify.register(piReleaseRoutes);
await startQrSync(fastify);

// Start server
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on port ${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
