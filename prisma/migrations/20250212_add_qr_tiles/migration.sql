-- Add ARCHITECT role for high-privilege users
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'Role' AND e.enumlabel = 'ARCHITECT'
  ) THEN
    ALTER TYPE "Role" ADD VALUE 'ARCHITECT';
  END IF;
END$$;

-- QR tiles mapped to stores and optionally tables
CREATE TABLE "qr_tiles" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "tableId" UUID REFERENCES "tables"("id") ON DELETE SET NULL,
  "publicCode" VARCHAR(32) NOT NULL UNIQUE,
  "label" VARCHAR(255),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
);

CREATE INDEX "qr_tiles_storeId_idx" ON "qr_tiles"("storeId");
CREATE INDEX "qr_tiles_tableId_idx" ON "qr_tiles"("tableId");
