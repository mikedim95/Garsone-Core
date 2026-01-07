-- Cook types
CREATE TABLE IF NOT EXISTS "cook_types" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "slug" VARCHAR(100) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "printerTopic" VARCHAR(255),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cook_types_storeId_fkey'
  ) THEN
    ALTER TABLE "cook_types"
      ADD CONSTRAINT "cook_types_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "stores"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS "cook_types_storeId_slug_key"
  ON "cook_types"("storeId", "slug");
CREATE INDEX IF NOT EXISTS "cook_types_storeId_idx"
  ON "cook_types"("storeId");

-- Waiter types
CREATE TABLE IF NOT EXISTS "waiter_types" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "slug" VARCHAR(100) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "printerTopic" VARCHAR(255),
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'waiter_types_storeId_fkey'
  ) THEN
    ALTER TABLE "waiter_types"
      ADD CONSTRAINT "waiter_types_storeId_fkey"
      FOREIGN KEY ("storeId") REFERENCES "stores"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS "waiter_types_storeId_slug_key"
  ON "waiter_types"("storeId", "slug");
CREATE INDEX IF NOT EXISTS "waiter_types_storeId_idx"
  ON "waiter_types"("storeId");

-- Profiles: add staff type references
ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "cookTypeId" UUID;
ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "waiterTypeId" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_cookTypeId_fkey'
  ) THEN
    ALTER TABLE "profiles"
      ADD CONSTRAINT "profiles_cookTypeId_fkey"
      FOREIGN KEY ("cookTypeId") REFERENCES "cook_types"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_waiterTypeId_fkey'
  ) THEN
    ALTER TABLE "profiles"
      ADD CONSTRAINT "profiles_waiterTypeId_fkey"
      FOREIGN KEY ("waiterTypeId") REFERENCES "waiter_types"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "profiles_cookTypeId_idx"
  ON "profiles"("cookTypeId");
CREATE INDEX IF NOT EXISTS "profiles_waiterTypeId_idx"
  ON "profiles"("waiterTypeId");
