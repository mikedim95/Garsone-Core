-- Add printer topic per category so printers can subscribe to category-specific topics
ALTER TABLE "categories"
  ADD COLUMN IF NOT EXISTS "printerTopic" VARCHAR(255);

-- Backfill existing rows with their slug to keep a non-null printer topic by default
UPDATE "categories"
SET "printerTopic" = "slug"
WHERE "printerTopic" IS NULL;

-- Helpful for routing/lookups per store/printer
CREATE INDEX IF NOT EXISTS "categories_storeId_printerTopic_idx"
  ON "categories"("storeId", "printerTopic");
