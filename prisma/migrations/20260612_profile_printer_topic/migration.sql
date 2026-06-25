ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "printerTopic" VARCHAR(255);

UPDATE "profiles" p
SET "printerTopic" = ct."printerTopic"
FROM "cook_types" ct
WHERE p."cookTypeId" = ct."id"
  AND p."printerTopic" IS NULL
  AND ct."printerTopic" IS NOT NULL;
