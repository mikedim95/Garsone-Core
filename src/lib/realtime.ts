import { FastifyInstance } from "fastify";
import { IncomingMessage } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { verifyToken } from "./jwt.js";

type RoleName = "waiter" | "cook" | "manager";

interface ClientSession {
  socket: WebSocket;
  userId?: string;
  role?: RoleName;
  isAlive: boolean;
}

const clients = new Set<ClientSession>();

export interface EmitOptions {
  roles?: RoleName[];
  userIds?: string[];
  anonymousOnly?: boolean;
}

function extractAuth(req: IncomingMessage) {
  try {
    if (!req.url) return {};
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token") || undefined;
    if (!token) return {};
    const payload = verifyToken(token);
    return {
      userId: payload.userId,
      role: payload.role as RoleName,
    };
  } catch {
    return {};
  }
}

export function setupRealtimeGateway(fastify: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });

  fastify.server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/events/ws")) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head, (ws) => {
      const meta = extractAuth(req);
      const session: ClientSession = {
        socket: ws,
        userId: meta.userId,
        role: meta.role,
        isAlive: true,
      };
      clients.add(session);

      ws.on("pong", () => {
        session.isAlive = true;
      });

      ws.on("close", () => {
        clients.delete(session);
      });

      ws.on("error", () => {
        clients.delete(session);
      });
    });
  });

  const HEARTBEAT = 30_000;
  const interval = setInterval(() => {
    for (const session of clients) {
      if (!session.isAlive) {
        try {
          session.socket.terminate();
        } catch {}
        clients.delete(session);
        continue;
      }
      session.isAlive = false;
      try {
        session.socket.ping();
      } catch {
        try {
          session.socket.terminate();
        } catch {}
        clients.delete(session);
      }
    }
  }, HEARTBEAT);

  fastify.addHook("onClose", async () => {
    clearInterval(interval);
    for (const session of clients) {
      try {
        session.socket.terminate();
      } catch {}
    }
    clients.clear();
  });
}

export function emitRealtime(
  topic: string,
  payload: any,
  options?: EmitOptions
) {
  const message = JSON.stringify({ topic, payload });
  const roles = options?.roles;
  const userIds = options?.userIds;
  const anonymousOnly = options?.anonymousOnly ?? false;

  for (const session of clients) {
    if (session.socket.readyState !== WebSocket.OPEN) continue;
    const isAnonymous = !session.role;
    if (anonymousOnly) {
      if (!isAnonymous) continue;
    } else {
      if (roles && (!session.role || !roles.includes(session.role))) continue;
      if (userIds && (!session.userId || !userIds.includes(session.userId)))
        continue;
    }
    try {
      session.socket.send(message);
    } catch {
      try {
        session.socket.terminate();
      } catch {}
      clients.delete(session);
    }
  }
}
