import { FastifyInstance } from "fastify";
import { IncomingMessage } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./jwt.js";
import { db } from "../db/index.js";
import { serializeRole } from "./roles.js";
import { isAllowedOrigin } from "./httpSecurity.js";

type RoleName = "waiter" | "cook" | "manager" | "architect" | "hybrid";

interface ClientSession {
  socket: WebSocket;
  userId?: string;
  role?: RoleName;
  storeSlug?: string;
  tableId?: string;
  expiresAt?: number;
  isAlive: boolean;
}

const clients = new Set<ClientSession>();

export interface EmitOptions {
  roles?: RoleName[];
  userIds?: string[];
  anonymousOnly?: boolean;
}

async function extractAuth(req: IncomingMessage): Promise<Omit<ClientSession, "socket" | "isAlive">> {
  const url = new URL(req.url || "/", "http://localhost");
  const token = url.searchParams.get("token");
  if (token) {
    const payload = verifyToken(token);
    const profile = await db.profile.findUnique({
      where: { id: payload.userId },
      select: { id: true, storeId: true, role: true, store: { select: { slug: true } } },
    });
    if (!profile || profile.storeId !== payload.storeId || profile.store?.slug !== payload.storeSlug || serializeRole(profile.role) !== payload.role) {
      throw new Error("SESSION_REVOKED");
    }
    return {
      userId: profile.id,
      role: payload.role,
      storeSlug: payload.storeSlug,
      expiresAt: Number((payload as any).exp) * 1000,
    };
  }
  const storeSlug = url.searchParams.get("storeSlug") || "";
  const tableId = url.searchParams.get("tableId") || "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(storeSlug) || !/^[0-9a-f-]{36}$/i.test(tableId)) return {};
  const table = await db.table.findFirst({
    where: { id: tableId, isActive: true, store: { slug: storeSlug } },
    select: { id: true },
  });
  return table ? { storeSlug, tableId: table.id } : {};
}

function roleMatches(sessionRole: RoleName | undefined, roles: RoleName[]) {
  if (!sessionRole) return false;
  if (roles.includes(sessionRole)) return true;
  return sessionRole === "hybrid" && (roles.includes("waiter") || roles.includes("cook"));
}

// Node control messages contain credentials and are never browser events.
function topicStore(topic: string): string | null {
  if (topic.startsWith("garsone/nodes/")) return null;
  const parts = topic.split("/");
  const slug = parts[0] === "stores" ? parts[1] : parts[0];
  return parts.length > 1 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || "") ? slug : null;
}

function guestPayload(payload: any) {
  const out: Record<string, unknown> = {};
  // Send table status invalidations, never staff order/item/price/note data.
  for (const key of ["orderId", "tableId", "status", "ts"]) {
    if (typeof payload?.[key] === "string") out[key] = payload[key];
  }
  return out;
}

export function setupRealtimeGateway(fastify: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

  fastify.server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url || "/", "http://localhost").pathname !== "/events/ws" || !isAllowedOrigin(req.headers.origin)) {
      socket.destroy();
      return;
    }
    void extractAuth(req).then((meta) => {
      if (socket.destroyed) return;
      wss.handleUpgrade(req, socket as any, head, (ws) => {
        const session: ClientSession = { socket: ws, ...meta, isAlive: true };
        clients.add(session);
        ws.on("pong", () => { session.isAlive = true; });
        ws.on("close", () => clients.delete(session));
        ws.on("error", () => clients.delete(session));
      });
    }).catch(() => socket.destroy());
  });

  const interval = setInterval(() => {
    for (const session of clients) {
      if (!session.isAlive || (session.expiresAt && session.expiresAt <= Date.now())) {
        session.socket.terminate();
        clients.delete(session);
        continue;
      }
      session.isAlive = false;
      try { session.socket.ping(); } catch { session.socket.terminate(); clients.delete(session); }
    }
  }, 30_000);

  fastify.addHook("onClose", async () => {
    clearInterval(interval);
    for (const session of clients) session.socket.terminate();
    clients.clear();
    wss.close();
  });
}

export function emitRealtime(topic: string, payload: any, options?: EmitOptions) {
  const storeSlug = topicStore(topic);
  if (!storeSlug) return;
  for (const session of clients) {
    if (session.socket.readyState !== WebSocket.OPEN || session.storeSlug !== storeSlug) continue;
    if (session.expiresAt && session.expiresAt <= Date.now()) continue;
    if (options?.anonymousOnly) {
      if (session.role || !session.tableId || session.tableId !== payload?.tableId) continue;
    } else {
      if (!session.role) continue;
      if (options?.roles && !roleMatches(session.role, options.roles)) continue;
      if (options?.userIds && (!session.userId || !options.userIds.includes(session.userId))) continue;
    }
    if (session.socket.bufferedAmount > 1024 * 1024) {
      session.socket.terminate();
      clients.delete(session);
      continue;
    }
    try {
      session.socket.send(JSON.stringify({ topic, payload: options?.anonymousOnly ? guestPayload(payload) : payload }));
    } catch {
      session.socket.terminate();
      clients.delete(session);
    }
  }
}
