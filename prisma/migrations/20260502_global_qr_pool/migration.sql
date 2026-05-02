ALTER TABLE "qr_tiles"
  ALTER COLUMN "storeId" DROP NOT NULL;

ALTER TABLE "qr_tiles"
  DROP CONSTRAINT IF EXISTS "qr_tiles_store_table_binding_check";

ALTER TABLE "qr_tiles"
  ADD CONSTRAINT "qr_tiles_store_table_binding_check"
  CHECK (
    "storeId" IS NOT NULL OR "tableId" IS NULL
  );
