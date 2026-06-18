import { db } from "./index.js";

/**
 * Keeps production databases compatible with current staff management routes.
 * Idempotent: safe to run on every boot while migrations are catching up.
 */
export async function ensureStaffSchema() {
  try {
    const roleValues = ["COOK", "ARCHITECT", "HYBRID"];
    for (const role of roleValues) {
      await db.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
            WHERE t.typname = 'Role' AND e.enumlabel = '${role}'
          ) THEN
            ALTER TYPE "Role" ADD VALUE '${role}';
          END IF;
        END
        $$;
      `);
    }

    await db.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShiftStatus') THEN
          CREATE TYPE "ShiftStatus" AS ENUM ('SCHEDULED', 'ACTIVE', 'ENDED');
        END IF;
      END
      $$;
    `);

    const statements = [
      `
      CREATE TABLE IF NOT EXISTS "cook_types" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "storeId" UUID NOT NULL,
        "slug" VARCHAR(100) NOT NULL,
        "title" VARCHAR(255) NOT NULL,
        "printerTopic" VARCHAR(255),
        "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS "waiter_types" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "storeId" UUID NOT NULL,
        "slug" VARCHAR(100) NOT NULL,
        "title" VARCHAR(255) NOT NULL,
        "printerTopic" VARCHAR(255),
        "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
      )
      `,
      `ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "cookTypeId" UUID`,
      `ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "waiterTypeId" UUID`,
      `ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "printerTopic" VARCHAR(255)`,
      `
      CREATE TABLE IF NOT EXISTS "waiter_shifts" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "storeId" UUID NOT NULL,
        "waiterId" UUID NOT NULL,
        "status" "ShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
        "startedAt" TIMESTAMP(6),
        "endedAt" TIMESTAMP(6),
        "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
      )
      `,
      `
      CREATE TABLE IF NOT EXISTS "waiter_tables" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "storeId" UUID NOT NULL,
        "waiterId" UUID NOT NULL,
        "tableId" UUID NOT NULL,
        "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now()
      )
      `,
      `CREATE UNIQUE INDEX IF NOT EXISTS "cook_types_storeId_slug_key" ON "cook_types"("storeId", "slug")`,
      `CREATE INDEX IF NOT EXISTS "cook_types_storeId_idx" ON "cook_types"("storeId")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "waiter_types_storeId_slug_key" ON "waiter_types"("storeId", "slug")`,
      `CREATE INDEX IF NOT EXISTS "waiter_types_storeId_idx" ON "waiter_types"("storeId")`,
      `CREATE INDEX IF NOT EXISTS "profiles_cookTypeId_idx" ON "profiles"("cookTypeId")`,
      `CREATE INDEX IF NOT EXISTS "profiles_waiterTypeId_idx" ON "profiles"("waiterTypeId")`,
      `CREATE INDEX IF NOT EXISTS "waiter_shifts_storeId_status_idx" ON "waiter_shifts"("storeId", "status")`,
      `CREATE INDEX IF NOT EXISTS "waiter_shifts_waiterId_idx" ON "waiter_shifts"("waiterId")`,
      `CREATE UNIQUE INDEX IF NOT EXISTS "waiter_tables_storeId_waiterId_tableId_key" ON "waiter_tables"("storeId", "waiterId", "tableId")`,
      `CREATE INDEX IF NOT EXISTS "waiter_tables_storeId_idx" ON "waiter_tables"("storeId")`,
      `CREATE INDEX IF NOT EXISTS "waiter_tables_waiterId_idx" ON "waiter_tables"("waiterId")`,
      `CREATE INDEX IF NOT EXISTS "waiter_tables_tableId_idx" ON "waiter_tables"("tableId")`,
    ];

    for (const statement of statements) {
      await db.$executeRawUnsafe(statement);
    }

    const constraints = [
      {
        name: "cook_types_storeId_fkey",
        sql: `ALTER TABLE "cook_types" ADD CONSTRAINT "cook_types_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      },
      {
        name: "waiter_types_storeId_fkey",
        sql: `ALTER TABLE "waiter_types" ADD CONSTRAINT "waiter_types_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      },
      {
        name: "profiles_cookTypeId_fkey",
        sql: `ALTER TABLE "profiles" ADD CONSTRAINT "profiles_cookTypeId_fkey" FOREIGN KEY ("cookTypeId") REFERENCES "cook_types"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
      },
      {
        name: "profiles_waiterTypeId_fkey",
        sql: `ALTER TABLE "profiles" ADD CONSTRAINT "profiles_waiterTypeId_fkey" FOREIGN KEY ("waiterTypeId") REFERENCES "waiter_types"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
      },
      {
        name: "waiter_shifts_storeId_fkey",
        sql: `ALTER TABLE "waiter_shifts" ADD CONSTRAINT "waiter_shifts_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      },
      {
        name: "waiter_shifts_waiterId_fkey",
        sql: `ALTER TABLE "waiter_shifts" ADD CONSTRAINT "waiter_shifts_waiterId_fkey" FOREIGN KEY ("waiterId") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      },
      {
        name: "waiter_tables_storeId_fkey",
        sql: `ALTER TABLE "waiter_tables" ADD CONSTRAINT "waiter_tables_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      },
      {
        name: "waiter_tables_tableId_fkey",
        sql: `ALTER TABLE "waiter_tables" ADD CONSTRAINT "waiter_tables_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      },
      {
        name: "waiter_tables_waiterId_fkey",
        sql: `ALTER TABLE "waiter_tables" ADD CONSTRAINT "waiter_tables_waiterId_fkey" FOREIGN KEY ("waiterId") REFERENCES "profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      },
    ];

    for (const constraint of constraints) {
      await db.$executeRawUnsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${constraint.name}'
          ) THEN
            ${constraint.sql};
          END IF;
        END
        $$;
      `);
    }

    await db.$executeRawUnsafe(`
      UPDATE "profiles" p
      SET "printerTopic" = ct."printerTopic"
      FROM "cook_types" ct
      WHERE p."cookTypeId" = ct."id"
        AND p."printerTopic" IS NULL
        AND ct."printerTopic" IS NOT NULL;
    `);

    console.log("[db] ensured staff schema");
  } catch (err) {
    console.error("[db] failed to ensure staff schema", err);
  }
}
