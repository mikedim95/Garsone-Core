-- Add per-status timestamps for orders
ALTER TABLE "orders"
  ADD COLUMN "preparingAt" TIMESTAMP(6),
  ADD COLUMN "readyAt" TIMESTAMP(6),
  ADD COLUMN "paidAt" TIMESTAMP(6),
  ADD COLUMN "cancelledAt" TIMESTAMP(6);
