import Fastify from "fastify";
import cors from "@fastify/cors";
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
import { localityRoutes } from "./routes/locality.js";
import { publicMenuBootstrapRoutes } from "./routes/publicMenuBootstrap.js";
import { setupRealtimeGateway } from "./lib/realtime.js";
import { getMqttClient } from "./lib/mqtt.js";
import { ensureOrderPaymentColumns } from "./db/ensureOrderPaymentColumns.js";

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
  logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : true,
  trustProxy: true,
});

// CORS: allow all origins for now, send credentials
await fastify.register(cors, {
  origin: true, // reflects request Origin
  credentials: true,
});
fastify.log.info("CORS configured: origin=true, credentials=true");
// Health check
fastify.get("/health", async (request, reply) => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

setupRealtimeGateway(fastify);
getMqttClient();
await ensureOrderPaymentColumns();

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
await fastify.register(localityRoutes);
await fastify.register(publicMenuBootstrapRoutes);

// Start server
try {
  await fastify.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`Server listening on port ${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
