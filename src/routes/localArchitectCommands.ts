import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/index.js';
import { getOrderingMode } from '../lib/store.js';
import { withArchitectDelegation } from '../lib/architectDelegation.js';
import { architectCommandSchema, commandFingerprint, commandRow, completeCommand, reserveCommand, type ArchitectCommand } from '../lib/architectCommands.js';

function operationRoute(command: ArchitectCommand, storeId: string) {
  const base = `/admin/stores/${storeId}`;
  const payload = { ...command.payload };
  const userRoute = () => {
    const id = z.string().uuid().parse(payload.userId);
    delete payload.userId;
    return `${base}/users/${id}`;
  };
  switch (command.operation) {
    case 'users.list': return { method: 'GET', url: `${base}/users`, payload: undefined };
    case 'users.create': return { method: 'POST', url: `${base}/users`, payload };
    case 'users.update': return { method: 'PATCH', url: userRoute(), payload };
    case 'users.delete': return { method: 'DELETE', url: userRoute(), payload: undefined };
    case 'settings.orderingMode': return { method: 'PATCH', url: `${base}/ordering-mode`, payload };
    case 'settings.printers': return { method: 'PATCH', url: `${base}/printers`, payload };
    case 'history.purge': return { method: 'DELETE', url: `${base}/history`, payload };
    case 'printing.status': return { method: 'GET', url: '/manager/local-operations', payload: undefined };
    case 'printing.test': return { method: 'POST', url: '/manager/local-operations/printers/test', payload: { ...payload, requestId: command.requestId } };
    default: return null;
  }
}

export async function localArchitectCommandRoutes(app: FastifyInstance) {
  app.post('/internal/architect/commands', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const expected = process.env.LOCAL_CONTROL_SECRET ?? '';
    const supplied = String(request.headers['x-local-control-secret'] ?? '');
    if (process.env.LOCAL_ONLY !== 'true' || expected.length < 32 || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return reply.code(401).send({ error: 'INVALID_LOCAL_CONTROL_SECRET' });
    const parsed = architectCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_LOCAL_COMMAND' });
    const command = parsed.data;
    const expiry = Date.parse(command.expiresAt);
    if (expiry <= Date.now() || expiry > Date.now() + 300_000) return reply.code(410).send({ error: 'COMMAND_EXPIRED' });
    if (command.storeSlug !== process.env.STORE_SLUG) return reply.code(409).send({ error: 'COMMAND_SCOPE_MISMATCH' });
    const store = await db.store.findUnique({ where: { slug: command.storeSlug } });
    const sourceId = (store?.settingsJson as any)?.nodeQrSync?.sourceStoreId;
    // The QR handshake binds a standalone local database to its cloud venue.
    // A same-slug command from another venue must never mutate this database.
    if (!store || (sourceId || store.id) !== command.storeId) return reply.code(409).send({ error: 'COMMAND_SCOPE_MISMATCH' });
    let route: ReturnType<typeof operationRoute>;
    try { route = operationRoute(command, store.id); }
    catch { return reply.code(400).send({ error: 'INVALID_LOCAL_COMMAND' }); }
    const fingerprint = commandFingerprint(command, expected);
    const fresh = await reserveCommand(command, fingerprint);
    const existing = await commandRow(command.requestId);
    if (existing.fingerprint !== fingerprint) return reply.code(409).send({ error: 'REQUEST_ID_REUSED' });
    if (!fresh) {
      if (existing.state === 'complete') return { requestId: command.requestId, statusCode: existing.statusCode, result: existing.result };
      // A process might have committed the business write before crashing.
      // Pending records are deliberately never re-executed automatically.
      return reply.code(409).send({ error: 'COMMAND_OUTCOME_UNCERTAIN', requestId: command.requestId });
    }
    let outcome;
    try {
      if (command.operation === 'snapshot') {
        const [usersCount, tilesCount, ordersCount] = await Promise.all([
          db.profile.count({ where: { storeId: store.id, role: { in: ['MANAGER', 'WAITER', 'COOK', 'HYBRID'] } } }),
          db.qRTile.count({ where: { storeId: store.id } }), db.order.count({ where: { storeId: store.id } }),
        ]);
        outcome = { statusCode: 200, result: { source: 'PI', checkedAt: new Date().toISOString(), store: { id: store.id, slug: store.slug, name: store.name,
          orderingMode: getOrderingMode(store), printers: Array.isArray((store.settingsJson as any)?.printers) ? (store.settingsJson as any).printers : [] }, counts: { usersCount, tilesCount, ordersCount } } };
      } else {
        if (!route) throw new Error('Unsupported command');
        const response = await withArchitectDelegation({ method: route.method, url: route.url, storeId: store.id, storeSlug: store.slug, actorId: command.actorId },
          capability => app.inject({ ...route, method: route!.method as any, headers: { 'x-internal-architect-capability': capability } }));
        outcome = { statusCode: response.statusCode, result: response.json() };
        if (command.operation === 'printing.test' && outcome.result.jobId) {
          const job = await db.localPrintIntent.findUnique({ where: { id: outcome.result.jobId } });
          outcome.result.state = job?.state ?? 'queued';
        }
      }
      await completeCommand(command.requestId, outcome);
      const completed = await commandRow(command.requestId);
      return { requestId: command.requestId, statusCode: completed.statusCode, result: completed.result };
    } catch {
      // Do not persist/log the command body: users.create/update may contain a
      // password. Preserve pending state if commit outcome is uncertain.
      return reply.code(500).send({ error: 'COMMAND_OUTCOME_UNCERTAIN', requestId: command.requestId });
    }
  });
}
