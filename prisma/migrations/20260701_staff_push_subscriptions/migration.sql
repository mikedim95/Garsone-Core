CREATE TABLE IF NOT EXISTS "staff_push_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "role" VARCHAR(32) NOT NULL,
  "printerTopic" VARCHAR(255),
  "endpoint" VARCHAR(1000) NOT NULL,
  "p256dh" VARCHAR(255) NOT NULL,
  "auth" VARCHAR(255) NOT NULL,
  "userAgent" VARCHAR(500),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "staff_push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "staff_push_subscriptions_endpoint_key"
  ON "staff_push_subscriptions"("endpoint");

CREATE INDEX IF NOT EXISTS "staff_push_subscriptions_store_profile_idx"
  ON "staff_push_subscriptions"("storeId", "profileId");

CREATE INDEX IF NOT EXISTS "staff_push_subscriptions_store_role_topic_idx"
  ON "staff_push_subscriptions"("storeId", "role", "printerTopic");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staff_push_subscriptions_storeId_fkey'
  ) THEN
    ALTER TABLE "staff_push_subscriptions"
      ADD CONSTRAINT "staff_push_subscriptions_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "stores"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staff_push_subscriptions_profileId_fkey'
  ) THEN
    ALTER TABLE "staff_push_subscriptions"
      ADD CONSTRAINT "staff_push_subscriptions_profileId_fkey"
      FOREIGN KEY ("profileId") REFERENCES "profiles"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
