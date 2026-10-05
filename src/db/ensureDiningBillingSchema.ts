import { db } from "./index.js";
import { pathToFileURL } from "node:url";

// Matches the additive migration; also supports existing cloud databases and Pi
// db-push upgrades without allowing destructive schema changes.
const statements: string[] = [
  "ALTER TABLE \"orders\" ADD COLUMN IF NOT EXISTS     \"diningVisitId\" UUID",
  "CREATE TABLE IF NOT EXISTS \"dining_visits\" (\n    \"id\" UUID NOT NULL DEFAULT gen_random_uuid(),\n    \"storeId\" UUID NOT NULL,\n    \"tableId\" UUID NOT NULL,\n    \"activeTableId\" UUID,\n    \"status\" VARCHAR(24) NOT NULL DEFAULT 'OPEN',\n    \"revision\" INTEGER NOT NULL DEFAULT 1,\n    \"currencyCode\" VARCHAR(8) NOT NULL DEFAULT 'EUR',\n    \"openedAt\" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n    \"closedAt\" TIMESTAMP(6),\n    \"billRequestedAt\" TIMESTAMP(6),\n    \"updatedAt\" TIMESTAMP(6) NOT NULL,\n\n    CONSTRAINT \"dining_visits_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"dining_guest_sessions\" (\n    \"id\" UUID NOT NULL DEFAULT gen_random_uuid(),\n    \"visitId\" UUID NOT NULL,\n    \"tokenHash\" VARCHAR(64) NOT NULL,\n    \"createdAt\" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"dining_guest_sessions_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"dining_payments\" (\n    \"id\" UUID NOT NULL DEFAULT gen_random_uuid(),\n    \"storeId\" UUID NOT NULL,\n    \"visitId\" UUID NOT NULL,\n    \"requestId\" UUID NOT NULL,\n    \"amountCents\" INTEGER NOT NULL,\n    \"method\" VARCHAR(16) NOT NULL,\n    \"recordedBy\" UUID NOT NULL,\n    \"recordedAt\" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"dining_payments_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"dining_payment_allocations\" (\n    \"id\" UUID NOT NULL DEFAULT gen_random_uuid(),\n    \"paymentId\" UUID NOT NULL,\n    \"orderItemId\" UUID NOT NULL,\n    \"amountCents\" INTEGER NOT NULL,\n\n    CONSTRAINT \"dining_payment_allocations_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"dining_actions\" (\n    \"id\" UUID NOT NULL DEFAULT gen_random_uuid(),\n    \"storeId\" UUID NOT NULL,\n    \"visitId\" UUID NOT NULL,\n    \"requestId\" UUID NOT NULL,\n    \"requestHash\" VARCHAR(64) NOT NULL,\n    \"kind\" VARCHAR(24) NOT NULL,\n    \"actorId\" UUID,\n    \"detail\" JSONB NOT NULL,\n    \"createdAt\" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"dining_actions_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"dining_visits_activeTableId_key\" ON \"dining_visits\"(\"activeTableId\")",
  "CREATE INDEX IF NOT EXISTS \"dining_visits_storeId_status_openedAt_idx\" ON \"dining_visits\"(\"storeId\", \"status\", \"openedAt\" DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"dining_guest_sessions_tokenHash_key\" ON \"dining_guest_sessions\"(\"tokenHash\")",
  "CREATE INDEX IF NOT EXISTS \"dining_guest_sessions_visitId_idx\" ON \"dining_guest_sessions\"(\"visitId\")",
  "CREATE INDEX IF NOT EXISTS \"dining_payments_storeId_recordedAt_idx\" ON \"dining_payments\"(\"storeId\", \"recordedAt\")",
  "CREATE INDEX IF NOT EXISTS \"dining_payments_visitId_idx\" ON \"dining_payments\"(\"visitId\")",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"dining_payments_storeId_requestId_key\" ON \"dining_payments\"(\"storeId\", \"requestId\")",
  "CREATE INDEX IF NOT EXISTS \"dining_payment_allocations_orderItemId_idx\" ON \"dining_payment_allocations\"(\"orderItemId\")",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"dining_payment_allocations_paymentId_orderItemId_key\" ON \"dining_payment_allocations\"(\"paymentId\", \"orderItemId\")",
  "CREATE INDEX IF NOT EXISTS \"dining_actions_visitId_createdAt_idx\" ON \"dining_actions\"(\"visitId\", \"createdAt\")",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"dining_actions_storeId_requestId_key\" ON \"dining_actions\"(\"storeId\", \"requestId\")",
  "CREATE INDEX IF NOT EXISTS \"orders_diningVisitId_idx\" ON \"orders\"(\"diningVisitId\")",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_diningVisitId_fkey') THEN ALTER TABLE \"orders\" ADD CONSTRAINT \"orders_diningVisitId_fkey\" FOREIGN KEY (\"diningVisitId\") REFERENCES \"dining_visits\"(\"id\") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_visits_storeId_fkey') THEN ALTER TABLE \"dining_visits\" ADD CONSTRAINT \"dining_visits_storeId_fkey\" FOREIGN KEY (\"storeId\") REFERENCES \"stores\"(\"id\") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_visits_tableId_fkey') THEN ALTER TABLE \"dining_visits\" ADD CONSTRAINT \"dining_visits_tableId_fkey\" FOREIGN KEY (\"tableId\") REFERENCES \"tables\"(\"id\") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_guest_sessions_visitId_fkey') THEN ALTER TABLE \"dining_guest_sessions\" ADD CONSTRAINT \"dining_guest_sessions_visitId_fkey\" FOREIGN KEY (\"visitId\") REFERENCES \"dining_visits\"(\"id\") ON DELETE CASCADE ON UPDATE CASCADE; END IF; END $$",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_payments_visitId_fkey') THEN ALTER TABLE \"dining_payments\" ADD CONSTRAINT \"dining_payments_visitId_fkey\" FOREIGN KEY (\"visitId\") REFERENCES \"dining_visits\"(\"id\") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_payment_allocations_paymentId_fkey') THEN ALTER TABLE \"dining_payment_allocations\" ADD CONSTRAINT \"dining_payment_allocations_paymentId_fkey\" FOREIGN KEY (\"paymentId\") REFERENCES \"dining_payments\"(\"id\") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_payment_allocations_orderItemId_fkey') THEN ALTER TABLE \"dining_payment_allocations\" ADD CONSTRAINT \"dining_payment_allocations_orderItemId_fkey\" FOREIGN KEY (\"orderItemId\") REFERENCES \"order_items\"(\"id\") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$",
  "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dining_actions_visitId_fkey') THEN ALTER TABLE \"dining_actions\" ADD CONSTRAINT \"dining_actions_visitId_fkey\" FOREIGN KEY (\"visitId\") REFERENCES \"dining_visits\"(\"id\") ON DELETE RESTRICT ON UPDATE CASCADE; END IF; END $$"
];

export async function ensureDiningBillingSchema() {
  const [row] = await db.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('orders') IS NOT NULL AS present`;
  if (!row?.present) return;
  for (const statement of statements) await db.$executeRawUnsafe(statement);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureDiningBillingSchema().catch((error) => {
    console.error("[db] Failed to ensure dining billing schema", error);
    process.exitCode = 1;
  }).finally(() => db.$disconnect());
}
