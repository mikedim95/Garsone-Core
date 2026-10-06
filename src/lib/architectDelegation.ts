import { randomBytes } from 'node:crypto';

type Delegation = { method: string; url: string; storeId: string; storeSlug: string; actorId: string };
const capabilities = new Map<string, Delegation>();

// This capability exists only in-process while dispatching a validated command.
// It is single-use, scoped to an exact route, never persisted or sent over the
// network, and revoked when inject finishes. Fastify injection crosses async
// contexts, so a private random capability identifies that one injected request.
export async function withArchitectDelegation<T>(context: Delegation, action: (capability: string) => Promise<T>): Promise<T> {
  const capability = randomBytes(32).toString('hex');
  capabilities.set(capability, context);
  try { return await action(capability); } finally { capabilities.delete(capability); }
}

export function delegatedArchitect(request: { method: string; url: string; headers: any }) {
  const capability = request.headers['x-internal-architect-capability'];
  const context = typeof capability === 'string' ? capabilities.get(capability) : undefined;
  if (!context || process.env.LOCAL_ONLY !== 'true' || context.method !== request.method || context.url !== request.url) return null;
  capabilities.delete(capability);
  return { userId: null, remoteActorId: context.actorId, email: '', role: 'architect', storeId: context.storeId, storeSlug: context.storeSlug };
}
