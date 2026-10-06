import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/index.js';
import { getMqttClient } from './mqtt.js';
import { jwtSecret } from './jwt.js';

export const architectOperation = z.enum(['snapshot', 'users.list', 'users.create', 'users.update', 'users.delete',
  'settings.orderingMode', 'settings.printers', 'history.purge', 'printing.status', 'printing.test']);
export const architectCommandSchema = z.object({
  type: z.literal('LOCAL_ARCHITECT_COMMAND').optional(), requestId: z.string().uuid(), nodeId: z.string().uuid(),
  storeId: z.string().uuid(), storeSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  actorId: z.string().uuid(), role: z.literal('architect'), operation: architectOperation,
  payload: z.record(z.unknown()), expiresAt: z.string().datetime(),
}).strict();
export type ArchitectCommand = z.infer<typeof architectCommandSchema>;
export type CommandResult = { statusCode: number; result: any };
export class LocalCommandError extends Error {
  constructor(public statusCode: number, public code: string) { super(code); }
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function commandFingerprint(command: ArchitectCommand, secret: string) {
  // HMAC prevents the ledger becoming an offline password guessing oracle.
  return createHmac('sha256', secret).update(stable({ nodeId: command.nodeId, storeId: command.storeId,
    storeSlug: command.storeSlug, actorId: command.actorId, operation: command.operation, payload: command.payload })).digest('hex');
}
export async function commandRow(requestId: string): Promise<any> {
  const rows = await db.$queryRaw<any[]>`SELECT * FROM architect_commands WHERE "requestId" = ${requestId}::uuid`;
  return rows[0] ?? null;
}
let lastCleanupAt = 0;
async function pruneCommandResults() {
  if (Date.now() - lastCleanupAt < 60_000) return;
  lastCleanupAt = Date.now();
  // Frequently polled reads expire quickly. Mutation fingerprints remain as
  // permanent tombstones; trimming their old response must never permit reruns.
  await db.$executeRaw`DELETE FROM architect_commands WHERE "requestId" IN (
    SELECT "requestId" FROM architect_commands WHERE operation IN ('snapshot', 'users.list', 'printing.status')
    AND "createdAt" < NOW() - INTERVAL '1 day' ORDER BY "createdAt" LIMIT 500)`;
  await db.$executeRaw`UPDATE architect_commands SET result = '{"error":"COMMAND_RESULT_EXPIRED"}'::jsonb, "statusCode" = 410 WHERE "requestId" IN (
    SELECT "requestId" FROM architect_commands WHERE state = 'complete' AND "statusCode" != 410
    AND operation NOT IN ('snapshot', 'users.list', 'printing.status') AND "completedAt" < NOW() - INTERVAL '7 days' ORDER BY "completedAt" LIMIT 500)`;
}
export async function reserveCommand(command: ArchitectCommand, fingerprint: string) {
  await pruneCommandResults();
  return (await db.$executeRaw`INSERT INTO architect_commands ("requestId", "storeId", "nodeId", "actorId", "storeSlug", operation, fingerprint, "expiresAt")
    VALUES (${command.requestId}::uuid, ${command.storeId}::uuid, ${command.nodeId}::uuid, ${command.actorId}::uuid, ${command.storeSlug}, ${command.operation}, ${fingerprint}, ${new Date(command.expiresAt)}) ON CONFLICT DO NOTHING`) === 1;
}
export async function completeCommand(requestId: string, outcome: CommandResult) {
  const serialized = JSON.stringify(outcome.result);
  if (Buffer.byteLength(serialized) > 256 * 1024) outcome = { statusCode: 502, result: { error: 'LOCAL_RESULT_TOO_LARGE' } };
  await db.$executeRaw`UPDATE architect_commands SET state = 'complete', "statusCode" = ${outcome.statusCode}, result = ${JSON.stringify(outcome.result)}::jsonb, "completedAt" = NOW()
    WHERE "requestId" = ${requestId}::uuid AND state = 'pending'`;
}

export async function localDeployment(storeId: string) {
  if (process.env.LOCAL_ONLY === 'true') return null;
  const deployment = await db.venueDeployment.findUnique({ where: { storeId }, include: { node: true, store: true } });
  return deployment?.target === 'PI' ? deployment : null;
}

// Kept injectable for isolated transport tests; production uses the connected
// broker directly with retain:false so old commands cannot run after reconnect.
export async function sendArchitectCommand(command: ArchitectCommand, node: any) {
  const client = getMqttClient();
  const config = node.configJson as any;
  if (!client?.connected || !config?.bootstrapNodeKey || !config?.mqttConfigToken) throw new LocalCommandError(503, 'LOCAL_PI_UNAVAILABLE');
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new LocalCommandError(504, 'LOCAL_COMMAND_TIMEOUT')), 5000);
    client.publish(`garsone/nodes/${config.bootstrapNodeKey}/config`,
      JSON.stringify({ ...command, configToken: config.mqttConfigToken }), { qos: 1, retain: false },
      error => { clearTimeout(timeout); error ? reject(new LocalCommandError(503, 'LOCAL_PI_UNAVAILABLE')) : resolve(); });
  });
}

export async function relayArchitectCommand(storeId: string, actorId: string, operation: ArchitectCommand['operation'], payload: Record<string, unknown>, requestId = randomUUID(),
  transport = sendArchitectCommand, timeoutMs = 25_000): Promise<CommandResult> {
  const deployment = await localDeployment(storeId);
  if (!deployment?.node || deployment.node.storeId !== storeId) throw new LocalCommandError(503, 'LOCAL_PI_UNAVAILABLE');
  const node = deployment.node;
  if (!node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > 180_000) throw new LocalCommandError(503, 'LOCAL_PI_UNAVAILABLE');
  const command = architectCommandSchema.parse({ type: 'LOCAL_ARCHITECT_COMMAND', requestId, nodeId: node.id,
    storeId, storeSlug: deployment.store.slug, actorId, role: 'architect', operation, payload, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  if (Buffer.byteLength(JSON.stringify(command)) > 64 * 1024) throw new LocalCommandError(400, 'LOCAL_COMMAND_TOO_LARGE');
  const fingerprint = commandFingerprint(command, String(jwtSecret()));
  await reserveCommand(command, fingerprint);
  const existing = await commandRow(requestId);
  if (existing.fingerprint !== fingerprint) throw new LocalCommandError(409, 'REQUEST_ID_REUSED');
  if (existing.state === 'complete') return { statusCode: existing.statusCode, result: existing.result };
  // An explicit retry can recover a lost broker delivery or callback. Refresh
  // only the deadline and resend the same identity/intent; the Pi's durable
  // ledger replays completed work and refuses to rerun an uncertain mutation.
  await db.$executeRaw`UPDATE architect_commands SET "expiresAt" = ${new Date(command.expiresAt)}
    WHERE "requestId" = ${requestId}::uuid AND fingerprint = ${fingerprint} AND state = 'pending'`;
  await transport(command, node);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await commandRow(requestId);
    if (row.state === 'complete') return { statusCode: row.statusCode, result: row.result };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new LocalCommandError(504, 'LOCAL_COMMAND_TIMEOUT');
}

export async function maybeRelayArchitect(request: any, reply: any, operation: ArchitectCommand['operation'], payload: Record<string, unknown> = request.body ?? {}) {
  if (!z.string().uuid().safeParse(request.params.storeId).success) { reply.code(400).send({ error: 'INVALID_STORE_ID' }); return true; }
  if (!(await localDeployment(request.params.storeId))) return false;
  if (request.user?.role !== 'architect') { reply.code(403).send({ error: 'LOCAL_ARCHITECT_REQUIRED' }); return true; }
  try {
    const suppliedId = request.headers['x-request-id'] ?? (operation === 'printing.test' ? payload.requestId : undefined);
    if (suppliedId !== undefined && !z.string().uuid().safeParse(suppliedId).success) throw new LocalCommandError(400, 'INVALID_REQUEST_ID');
    const outcome = await relayArchitectCommand(request.params.storeId, request.user.userId, operation, payload, suppliedId);
    // Local and cloud store IDs intentionally differ on standalone installs.
    if (outcome.result?.store?.id) outcome.result.store.id = request.params.storeId;
    reply.code(outcome.statusCode).send(outcome.result);
  } catch (error: any) {
    reply.code(error.statusCode ?? 502).send({ error: error.code ?? 'LOCAL_COMMAND_FAILED' });
  }
  return true;
}

export async function acceptArchitectResult(node: any, input: unknown) {
  const parsed = z.object({ requestId: z.string().uuid(), nodeId: z.string().uuid(), storeId: z.string().uuid(), storeSlug: z.string(),
    statusCode: z.number().int().min(200).max(599), result: z.record(z.unknown()) }).strict().safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > 256 * 1024) throw new LocalCommandError(400, 'INVALID_COMMAND_RESULT');
  const body = parsed.data;
  const deployment = await localDeployment(node.storeId);
  const row = await commandRow(body.requestId);
  if (!deployment || deployment.nodeId !== node.id || node.id !== body.nodeId || node.storeId !== body.storeId || node.store.slug !== body.storeSlug ||
      !row || row.nodeId !== node.id || row.storeId !== body.storeId || row.storeSlug !== body.storeSlug) throw new LocalCommandError(409, 'COMMAND_SCOPE_MISMATCH');
  if (row.state === 'complete') return { ok: true, replayed: true };
  if (new Date(row.expiresAt).getTime() + 60_000 < Date.now()) throw new LocalCommandError(410, 'COMMAND_EXPIRED');
  const retryable = body.statusCode === 502 && body.result.error === 'LOCAL_COMMAND_UNAVAILABLE';
  await db.$transaction(async tx => {
    // Serialize with reassociation/target changes so a previous node cannot
    // publish a result after another Pi becomes this venue's authority.
    const current = await tx.$queryRaw<any[]>`SELECT "nodeId", target FROM venue_deployments WHERE "storeId" = ${node.storeId}::uuid FOR UPDATE`;
    if (current[0]?.nodeId !== node.id || current[0]?.target !== 'PI') throw new LocalCommandError(409, 'COMMAND_SCOPE_MISMATCH');
    // This is the bridge's transport error, not a result from the local ledger.
    // Core may have committed before its response was lost. Keep the request
    // recoverable so a same-ID retry can read that durable result safely.
    if (retryable) return;
    await tx.$executeRaw`UPDATE architect_commands SET state = 'complete', "statusCode" = ${body.statusCode}, result = ${JSON.stringify(body.result)}::jsonb, "completedAt" = NOW()
      WHERE "requestId" = ${row.requestId}::uuid AND state = 'pending' AND "nodeId" = ${node.id}::uuid AND "storeId" = ${node.storeId}::uuid`;
  });
  return { ok: true, replayed: false, ...(retryable ? { retryable: true } : {}) };
}
