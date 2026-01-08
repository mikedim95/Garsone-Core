-- Add printer topic per item so routing is handled at the item level
ALTER TABLE "items"
  ADD COLUMN IF NOT EXISTS "printerTopic" VARCHAR(255);

-- Backfill from category printer topic where possible
UPDATE "items" AS i
SET "printerTopic" = c."printerTopic"
FROM "categories" AS c
WHERE i."printerTopic" IS NULL
  AND i."categoryId" = c."id"
  AND c."printerTopic" IS NOT NULL;

-- Fallback to category slug if still unset
UPDATE "items" AS i
SET "printerTopic" = c."slug"
FROM "categories" AS c
WHERE i."printerTopic" IS NULL
  AND i."categoryId" = c."id"
  AND c."slug" IS NOT NULL;

-- If the item printer topic is not in the store printers list, fallback to the first configured printer.
WITH store_printers AS (
  SELECT
    id,
    settingsJson->'printers' AS printers,
    settingsJson->'printers'->>0 AS first_printer
  FROM "stores"
  WHERE settingsJson ? 'printers'
)
UPDATE "items" AS i
SET "printerTopic" = sp.first_printer
FROM store_printers sp
WHERE i."storeId" = sp.id
  AND sp.first_printer IS NOT NULL
  AND (
    i."printerTopic" IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(sp.printers) AS p(value)
      WHERE p.value = i."printerTopic"
    )
  );

-- Normalize cook/waiter type printer topics to store printers when they reference unknown values.
UPDATE "cook_types" AS ct
SET "printerTopic" = sp.first_printer
FROM store_printers sp
WHERE ct."storeId" = sp.id
  AND sp.first_printer IS NOT NULL
  AND ct."printerTopic" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(sp.printers) AS p(value)
    WHERE p.value = ct."printerTopic"
  );

UPDATE "waiter_types" AS wt
SET "printerTopic" = sp.first_printer
FROM store_printers sp
WHERE wt."storeId" = sp.id
  AND sp.first_printer IS NOT NULL
  AND wt."printerTopic" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(sp.printers) AS p(value)
    WHERE p.value = wt."printerTopic"
  );
