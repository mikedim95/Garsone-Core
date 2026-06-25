CREATE TABLE "customer_push_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "tableId" UUID NOT NULL,
  "orderId" UUID,
  "endpoint" VARCHAR(1000) NOT NULL,
  "p256dh" VARCHAR(255) NOT NULL,
  "auth" VARCHAR(255) NOT NULL,
  "userAgent" VARCHAR(500),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL,

  CONSTRAINT "customer_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_push_subscriptions_endpoint_key"
  ON "customer_push_subscriptions"("endpoint");

CREATE INDEX "customer_push_subscriptions_storeId_tableId_idx"
  ON "customer_push_subscriptions"("storeId", "tableId");

CREATE INDEX "customer_push_subscriptions_orderId_idx"
  ON "customer_push_subscriptions"("orderId");

ALTER TABLE "customer_push_subscriptions"
  ADD CONSTRAINT "customer_push_subscriptions_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_push_subscriptions"
  ADD CONSTRAINT "customer_push_subscriptions_tableId_fkey"
  FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_push_subscriptions"
  ADD CONSTRAINT "customer_push_subscriptions_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
