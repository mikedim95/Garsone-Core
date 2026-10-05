import { db } from "./index.js";
import { pathToFileURL } from "node:url";

// Additive startup bootstrap for existing hosted installs. The Pi also uses db
// push; keep this DDL aligned with the Prisma models and the checked-in migration.
export async function ensureOrderReliabilitySchema() {
  const [existing] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('orders') IS NOT NULL AS present`;
  // The entrypoint runs this before db push. Empty installations must still let
  // Prisma create the base schema; existing installs get the safe additive DDL
  // first so a new nullable unique index does not require --accept-data-loss.
  if (!existing?.present) return;
  await db.$executeRawUnsafe(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "submissionId" UUID`);
  await db.$executeRawUnsafe(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "submissionHash" VARCHAR(64)`);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "orders_storeId_submissionId_key" ON "orders"("storeId", "submissionId")`);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "local_print_intents" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "storeId" UUID NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      "orderId" UUID REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
      "topic" VARCHAR(512) NOT NULL,
      "payload" JSONB NOT NULL,
      "state" VARCHAR(20) NOT NULL DEFAULT 'queued',
      "error" TEXT,
      "reprintOfId" UUID,
      "resolvedAt" TIMESTAMP(6),
      "resolvedBy" VARCHAR(255),
      "resolution" VARCHAR(255),
      "startedAt" TIMESTAMP(6),
      "completedAt" TIMESTAMP(6),
      "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "local_print_intents_storeId_createdAt_idx" ON "local_print_intents"("storeId", "createdAt" DESC)`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "local_print_intents_state_createdAt_idx" ON "local_print_intents"("state", "createdAt")`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "local_print_intents_orderId_idx" ON "local_print_intents"("orderId")`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureOrderReliabilitySchema().catch((error) => {
    console.error("[db] Failed to ensure order reliability schema", error);
    process.exitCode = 1;
  }).finally(() => db.$disconnect());
}
