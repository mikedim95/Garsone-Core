-- Daily kitchen counter for ticket numbers
DO $$
BEGIN
  -- Create table if it doesn't exist (older environments were created via db push)
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'kitchen_counters'
  ) THEN
    CREATE TABLE "kitchen_counters" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "storeId" UUID NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
      "slug" VARCHAR(100) NOT NULL,
      "title" VARCHAR(255) NOT NULL,
      "day" VARCHAR(10) NOT NULL DEFAULT '1970-01-01',
      "seq" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "kitchen_counters_storeId_slug_key" ON "kitchen_counters"("storeId", "slug");
    CREATE INDEX "kitchen_counters_storeId_idx" ON "kitchen_counters"("storeId");
  END IF;
END$$;

-- Add daily sequence fields for environments where the table already existed
ALTER TABLE "kitchen_counters"
  ADD COLUMN IF NOT EXISTS "day" VARCHAR(10) NOT NULL DEFAULT '1970-01-01',
  ADD COLUMN IF NOT EXISTS "seq" INTEGER NOT NULL DEFAULT 0;

-- Ensure uniqueness per store/day
CREATE UNIQUE INDEX IF NOT EXISTS "kitchen_counters_storeId_day_key"
  ON "kitchen_counters"("storeId", "day");
