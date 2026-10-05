-- Each order line retains its own preparation instructions; existing lines stay null.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "note" VARCHAR(500);
