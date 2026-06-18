import { db } from "./index.js";

/**
 * Keep older production databases compatible with the current Profile model.
 * Safe to run on every boot while Prisma migrations are catching up.
 */
export async function ensureProfilePrinterTopic() {
  try {
    await db.$executeRawUnsafe(`
      ALTER TABLE "profiles"
        ADD COLUMN IF NOT EXISTS "printerTopic" VARCHAR(255);
    `);

    await db.$executeRawUnsafe(`
      UPDATE "profiles" p
      SET "printerTopic" = ct."printerTopic"
      FROM "cook_types" ct
      WHERE p."cookTypeId" = ct."id"
        AND p."printerTopic" IS NULL
        AND ct."printerTopic" IS NOT NULL;
    `);

    console.log("[db] ensured printerTopic on profiles");
  } catch (err) {
    console.error("[db] failed to ensure profile printerTopic", err);
  }
}
