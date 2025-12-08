import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from '../lib/jwt.js';

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  try {
    const authHeader = request.headers.authorization;
    const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
    const token =
      bearer ||
      (typeof (request.query as any)?.token === 'string' ? (request.query as any).token : undefined) ||
      (request.headers['x-auth-token'] as string | undefined);

    console.log("[authMiddleware] path", (request as any).url, "hasBearer", Boolean(bearer), "hasHeaderToken", Boolean(authHeader), "hasQueryToken", typeof (request.query as any)?.token === 'string', "hasXAuth", Boolean((request.headers['x-auth-token'] as string | undefined)));

    if (!token) {
      console.warn("[authMiddleware] missing token for", (request as any).url);
      return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const tokenTrimmed = token.trim();
    if (!tokenTrimmed) {
      console.warn("[authMiddleware] blank token for", (request as any).url);
      return reply.status(401).send({ error: 'Missing or invalid authorization header' });
    }

    const payload = verifyToken(tokenTrimmed);
    console.log("[authMiddleware] verified", { url: (request as any).url, userId: (payload as any)?.userId, role: (payload as any)?.role, storeSlug: (payload as any)?.storeSlug });
    
    // Attach user and store context to request
    (request as any).user = payload;
    if (payload.storeSlug) {
      (request as any).storeSlug = payload.storeSlug;
    }
  } catch (error) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export function requireRole(roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = (request as any).user;

    if (!user || !roles.includes(user.role)) {
      return reply.status(403).send({ error: 'Insufficient permissions' });
    }
  };
}
