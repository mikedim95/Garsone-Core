import { db } from "./index.js";

// Additive bootstrap for existing hosted installations; local installs also use db push.
async function main() {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "qr_events" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "storeId" UUID NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      "name" VARCHAR(120) NOT NULL,
      "publicAppUrl" VARCHAR(2000) NOT NULL,
      "publicApiUrl" VARCHAR(2000) NOT NULL,
      "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "assignmentsJson" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "isImported" BOOLEAN NOT NULL DEFAULT false,
      "syncTokenHash" VARCHAR(64),
      "lastAppliedRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("lastAppliedRevision" >= 0),
      "lastAppliedAt" TIMESTAMP(6),
      "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "qr_events_storeId_updatedAt_idx" ON "qr_events"("storeId", "updatedAt" DESC)`);
  console.log("[db] QR event schema ready");
}

main().catch((error) => {
  console.error("[db] Failed to ensure QR event schema", error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
