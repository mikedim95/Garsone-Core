import { db } from "./index.js";

/**
 * Ensure payment-related columns exist on the orders table in prod/stage.
 * Idempotent: safe to run on every boot.
 */
export async function ensureOrderPaymentColumns() {
  try {
    // Run statements sequentially to avoid "multiple commands" error in prepared statements.
    await db.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentStatus') THEN
          CREATE TYPE "PaymentStatus" AS ENUM ('PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED');
        END IF;
      END$$;
    `);

    await db.$executeRawUnsafe(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS "paymentStatus" "PaymentStatus",
        ADD COLUMN IF NOT EXISTS "paymentProvider" VARCHAR(50),
        ADD COLUMN IF NOT EXISTS "paymentId" VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "paymentError" TEXT;
    `);

    await db.$executeRawUnsafe(
      `UPDATE orders SET "paymentStatus" = 'PENDING' WHERE "paymentStatus" IS NULL;`
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE orders ALTER COLUMN "paymentStatus" SET NOT NULL;`
    );
    await db.$executeRawUnsafe(
      `ALTER TABLE orders ALTER COLUMN "paymentStatus" SET DEFAULT 'PENDING';`
    );
    await db.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "orders_storeId_paymentStatus_idx" ON orders("storeId", "paymentStatus");`
    );
    console.log("[db] ensured payment columns on orders");
  } catch (err) {
    console.error("[db] failed to ensure payment columns", err);
  }
}
