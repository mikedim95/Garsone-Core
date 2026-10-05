ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "submissionId" UUID;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "submissionHash" VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS "orders_storeId_submissionId_key" ON "orders"("storeId", "submissionId");

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
);
CREATE INDEX IF NOT EXISTS "local_print_intents_storeId_createdAt_idx" ON "local_print_intents"("storeId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "local_print_intents_state_createdAt_idx" ON "local_print_intents"("state", "createdAt");
CREATE INDEX IF NOT EXISTS "local_print_intents_orderId_idx" ON "local_print_intents"("orderId");
