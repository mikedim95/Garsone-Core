import type { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

export function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true; // CLI, server-to-server and same-origin requests without Origin.
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) return false;
  const configured = [process.env.CORS_ORIGINS, process.env.CORS_ORIGIN,
    process.env.FRONTEND_ORIGIN, process.env.PUBLIC_ORIGIN, process.env.PUBLIC_APP_BASE_URL]
    .filter(Boolean).flatMap(value => value!.split(",")).map(value => value.trim().replace(/\/$/, ""));
  if (configured.includes(origin)) return true;
  if (process.env.LOCAL_ONLY === "true") return false;
  // Existing hosted venue frontends use one subdomain per venue.
  const domain = process.env.PUBLIC_APP_DOMAIN || "garsone.gr";
  if (url.protocol === "https:" && !url.port &&
      (url.hostname === domain || (url.hostname.endsWith(`.${domain}`) &&
        !url.hostname.slice(0, -(domain.length + 1)).includes(".")))) return true;
  return process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export async function registerHttpSecurity(app: FastifyInstance) {
  // Enforce the same rule on writes too; merely omitting CORS headers is insufficient.
  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedOrigin(request.headers.origin)) return reply.code(403).send({ error: "ORIGIN_NOT_ALLOWED" });
  });
  await app.register(cors, { origin: (origin, done) => done(null, isAllowedOrigin(origin)), credentials: false });
  await app.register(rateLimit, {
    global: true,
    max: request => request.url.split("?")[0].startsWith("/auth/") ? 15 : 600,
    timeWindow: "1 minute",
    cache: 10000,
    keyGenerator: request => `${request.ip}:${request.url.split("?")[0].startsWith("/auth/") ? "auth" : "api"}`,
  });
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    if (request.headers.authorization || request.url.startsWith("/admin/") || request.url.startsWith("/qr-sync/")) {
      reply.header("Cache-Control", "no-store");
    }
  });
}
