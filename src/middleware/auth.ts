import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, type JWTPayload } from '../lib/jwt.js';
import { roleMatches, serializeRole } from '../lib/roles.js';
import { db } from '../db/index.js';

export async function currentSession(token: string): Promise<JWTPayload> {
  const payload = verifyToken(token);
  const profile = await db.profile.findUnique({
    where: { id: payload.userId }, include: { store: true, cookType: true, waiterType: true },
  });
  if (!profile?.store || profile.storeId !== payload.storeId ||
      profile.store.slug !== payload.storeSlug || serializeRole(profile.role) !== payload.role) {
    throw new Error('Session no longer authorized');
  }
  return { ...payload, email: profile.email, cookTypeId: profile.cookTypeId,
    waiterTypeId: profile.waiterTypeId, printerTopic: profile.printerTopic,
    cookTypePrinterTopic: profile.printerTopic ?? profile.cookType?.printerTopic ?? null,
    waiterTypePrinterTopic: profile.waiterType?.printerTopic ?? null };
}

function requestToken(request: FastifyRequest) {
  const header = request.headers.authorization;
  // Query tokens are reserved for legacy EventSource; never accepted on CRUD routes.
  const queryToken = request.url.split('?')[0] === '/events' && typeof (request.query as any)?.token === 'string'
    ? (request.query as any).token : undefined;
  return (header?.startsWith('Bearer ') ? header.slice(7) : undefined) ||
    request.headers['x-auth-token'] || queryToken;
}

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  try {
    const token = requestToken(request);
    if (typeof token !== 'string' || !token.trim()) throw new Error('Missing token');
    const payload = await currentSession(token.trim());
    (request as any).user = payload;
    (request as any).storeSlug = payload.storeSlug;
  } catch {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}

export async function optionalAuthMiddleware(request: FastifyRequest, reply: FastifyReply) {
  if (requestToken(request)) return authMiddleware(request, reply);
}

export function requireRole(roles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!roleMatches((request as any).user?.role, roles)) {
      return reply.status(403).send({ error: 'Insufficient permissions' });
    }
  };
}
