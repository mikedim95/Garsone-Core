import { db } from './index.js';

export async function ensureArchitectCommandSchema() {
  await db.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS architect_commands (
    "requestId" UUID PRIMARY KEY, "storeId" UUID NOT NULL, "nodeId" UUID NOT NULL,
    "actorId" UUID NOT NULL, "storeSlug" VARCHAR(100) NOT NULL,
    operation VARCHAR(64) NOT NULL, fingerprint VARCHAR(64) NOT NULL,
    state VARCHAR(20) NOT NULL DEFAULT 'pending', "statusCode" INTEGER,
    result JSONB, "expiresAt" TIMESTAMP(6) NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(6)
  )`);
  await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "architect_commands_createdAt_idx" ON architect_commands ("createdAt")');
  await db.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "architect_commands_completedAt_idx" ON architect_commands ("completedAt")');
}
