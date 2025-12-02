-- Table visits for public QR sessions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'TableVisitStatus'
  ) THEN
    CREATE TYPE "TableVisitStatus" AS ENUM ('OPEN', 'CLOSED', 'EXPIRED');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS "table_visits" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tileId" UUID NOT NULL REFERENCES "qr_tiles"("id") ON DELETE CASCADE,
  "tableId" UUID NOT NULL REFERENCES "tables"("id") ON DELETE CASCADE,
  "storeId" UUID NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
  "sessionToken" VARCHAR(64) NOT NULL UNIQUE,
  "status" "TableVisitStatus" NOT NULL DEFAULT 'OPEN',
  "expiresAt" TIMESTAMP(6) NOT NULL,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "table_visits_store_table_status_idx" ON "table_visits"("storeId", "tableId", "status");
CREATE INDEX IF NOT EXISTS "table_visits_expiresAt_idx" ON "table_visits"("expiresAt");
