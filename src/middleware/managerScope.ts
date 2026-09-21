import type { FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/index.js";
import { ensureStore } from "../lib/store.js";

// Validate both the resource being changed and its foreign keys before any handler writes.
export async function managerResourceScope(request: FastifyRequest, reply: FastifyReply) {
  const store = await ensureStore(request);
  const resource = request.routeOptions.url?.split("/")[2];
  const models: Record<string, string> = {
    items: "item", categories: "category", modifiers: "modifier",
    "modifier-options": "modifierOption", orders: "order", tables: "table",
    waiters: "profile", cooks: "profile",
  };
  const checks: Array<[string, unknown]> = [];
  const params = request.params as Record<string, unknown>;
  if (params?.id && resource && models[resource]) checks.push([models[resource], params.id]);
  const body = request.body as Record<string, unknown> | undefined;
  const relationships: Record<string, string> = {
    categoryId: "category", itemId: "item", modifierId: "modifier", tableId: "table",
    cookTypeId: "cookType", waiterTypeId: "waiterType",
  };
  for (const [key, model] of Object.entries(relationships)) {
    if (body?.[key] != null) checks.push([model, body[key]]);
  }
  for (const [model, id] of checks) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return reply.code(400).send({ error: "INVALID_RESOURCE_ID" });
    }
    const row = await (db as any)[model].findFirst({ where: { id, storeId: store.id }, select: { id: true } });
    if (!row) return reply.code(404).send({ error: "RESOURCE_NOT_FOUND" });
  }
}
