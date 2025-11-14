-- Adds COOK value to the Role enum if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t
                 JOIN pg_enum e ON t.oid = e.enumtypid
                 WHERE t.typname = 'Role' AND e.enumlabel = 'COOK') THEN
    ALTER TYPE "Role" ADD VALUE 'COOK';
  END IF;
END$$;

