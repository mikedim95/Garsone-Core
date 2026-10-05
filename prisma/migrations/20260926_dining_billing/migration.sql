ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS     "diningVisitId" UUID;

CREATE TABLE IF NOT EXISTS "dining_visits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storeId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "activeTableId" UUID,
    "status" VARCHAR(24) NOT NULL DEFAULT 'OPEN',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "currencyCode" VARCHAR(8) NOT NULL DEFAULT 'EUR',
    "openedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(6),
    "billRequestedAt" TIMESTAMP(6),
    "updatedAt" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "dining_visits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "dining_guest_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "visitId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dining_guest_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "dining_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storeId" UUID NOT NULL,
    "visitId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "method" VARCHAR(16) NOT NULL,
    "recordedBy" UUID NOT NULL,
    "recordedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dining_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "dining_payment_allocations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "paymentId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "amountCents" INTEGER NOT NULL,

    CONSTRAINT "dining_payment_allocations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "dining_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "storeId" UUID NOT NULL,
    "visitId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "actorId" UUID,
    "detail" JSONB NOT NULL,
    "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dining_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dining_visits_activeTableId_key" ON "dining_visits"("activeTableId");

CREATE INDEX IF NOT EXISTS "dining_visits_storeId_status_openedAt_idx" ON "dining_visits"("storeId", "status", "openedAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "dining_guest_sessions_tokenHash_key" ON "dining_guest_sessions"("tokenHash");

CREATE INDEX IF NOT EXISTS "dining_guest_sessions_visitId_idx" ON "dining_guest_sessions"("visitId");

CREATE INDEX IF NOT EXISTS "dining_payments_storeId_recordedAt_idx" ON "dining_payments"("storeId", "recordedAt");

CREATE INDEX IF NOT EXISTS "dining_payments_visitId_idx" ON "dining_payments"("visitId");

CREATE UNIQUE INDEX IF NOT EXISTS "dining_payments_storeId_requestId_key" ON "dining_payments"("storeId", "requestId");

CREATE INDEX IF NOT EXISTS "dining_payment_allocations_orderItemId_idx" ON "dining_payment_allocations"("orderItemId");

CREATE UNIQUE INDEX IF NOT EXISTS "dining_payment_allocations_paymentId_orderItemId_key" ON "dining_payment_allocations"("paymentId", "orderItemId");

CREATE INDEX IF NOT EXISTS "dining_actions_visitId_createdAt_idx" ON "dining_actions"("visitId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "dining_actions_storeId_requestId_key" ON "dining_actions"("storeId", "requestId");

CREATE INDEX IF NOT EXISTS "orders_diningVisitId_idx" ON "orders"("diningVisitId");

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_diningVisitId_fkey') THEN ALTER TABLE "orders" ADD CONSTRAINT "orders_diningVisitId_fkey" FOREIGN KEY ("diningVisitId") REFERENCES "dining_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_visits_storeId_fkey') THEN ALTER TABLE "dining_visits" ADD CONSTRAINT "dining_visits_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_visits_tableId_fkey') THEN ALTER TABLE "dining_visits" ADD CONSTRAINT "dining_visits_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_guest_sessions_visitId_fkey') THEN ALTER TABLE "dining_guest_sessions" ADD CONSTRAINT "dining_guest_sessions_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "dining_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_payments_visitId_fkey') THEN ALTER TABLE "dining_payments" ADD CONSTRAINT "dining_payments_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "dining_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_payment_allocations_paymentId_fkey') THEN ALTER TABLE "dining_payment_allocations" ADD CONSTRAINT "dining_payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "dining_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_payment_allocations_orderItemId_fkey') THEN ALTER TABLE "dining_payment_allocations" ADD CONSTRAINT "dining_payment_allocations_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_actions_visitId_fkey') THEN ALTER TABLE "dining_actions" ADD CONSTRAINT "dining_actions_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "dining_visits"("id") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$;
