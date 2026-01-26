CREATE TABLE IF NOT EXISTS "locality_approvals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "tableId" UUID NOT NULL REFERENCES "tables"("id") ON DELETE CASCADE,
  "tileId" UUID NOT NULL REFERENCES "qr_tiles"("id") ON DELETE CASCADE,
  "approvalToken" VARCHAR(64) NOT NULL UNIQUE,
  "purpose" VARCHAR(32) NOT NULL,
  "method" VARCHAR(16) NOT NULL,
  "sessionId" VARCHAR(64) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT NOW(),
  "expiresAt" TIMESTAMP(6) NOT NULL,
  "consumedAt" TIMESTAMP(6),
  "consumedOrderId" UUID
);

CREATE INDEX IF NOT EXISTS "locality_approvals_store_table_expires_idx"
  ON "locality_approvals" ("storeId", "tableId", "expiresAt");

CREATE INDEX IF NOT EXISTS "locality_approvals_token_idx"
  ON "locality_approvals" ("approvalToken");

CREATE INDEX IF NOT EXISTS "locality_approvals_consumed_order_idx"
  ON "locality_approvals" ("consumedOrderId");
