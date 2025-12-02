import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";
import { applyDbConnection } from "../src/db/config";

const { target: dbTarget, databaseUrl } = applyDbConnection();
const prisma = new PrismaClient();

const STORE_SLUG = process.env.STORE_SLUG || "demo-bar";
const DEFAULT_PASSWORD =
  process.env.DEFAULT_PASSWORD ||
  process.env.MANAGER_PASSWORD ||
  process.env.WAITER_PASSWORD ||
  "changeme";

try {
  const { hostname, pathname } = new URL(databaseUrl);
  const dbName = pathname?.replace("/", "") || "";
  console.log(`[seedProfiles] DB_CONNECTION=${dbTarget} -> ${hostname}${dbName ? `/${dbName}` : ""}`);
} catch {
  console.log(`[seedProfiles] DB_CONNECTION=${dbTarget}`);
}

async function ensureProfile(
  storeId: string,
  email: string,
  role: Role,
  displayName: string,
  password?: string
) {
  const normalizedEmail = email.toLowerCase();
  const existing = await prisma.profile.findUnique({
    where: { email: normalizedEmail },
  });
  if (existing) {
    return existing;
  }
  const passwordHash = await bcrypt.hash(password || DEFAULT_PASSWORD, 10);
  return prisma.profile.create({
    data: {
      storeId,
      email: normalizedEmail,
      passwordHash,
      role,
      displayName,
    },
  });
}

async function main() {
  const store = await prisma.store.findUnique({
    where: { slug: STORE_SLUG },
  });

  if (!store) {
    throw new Error(`Store with slug "${STORE_SLUG}" not found. Create it first or set STORE_SLUG.`);
  }

  const manager = await ensureProfile(
    store.id,
    process.env.MANAGER_EMAIL || "manager@demo.local",
    Role.MANAGER,
    "Demo Manager",
    process.env.MANAGER_PASSWORD
  );

  const waiter1 = await ensureProfile(
    store.id,
    process.env.WAITER_EMAIL || "waiter1@demo.local",
    Role.WAITER,
    "Waiter One",
    process.env.WAITER_PASSWORD
  );

  const waiter2 = await ensureProfile(
    store.id,
    process.env.WAITER_EMAIL_2 || "waiter2@demo.local",
    Role.WAITER,
    "Waiter Two",
    process.env.WAITER_PASSWORD_2 || process.env.WAITER_PASSWORD
  );

  const cook = await ensureProfile(
    store.id,
    process.env.COOK_EMAIL || "cook@demo.local",
    Role.COOK,
    "Demo Cook",
    process.env.COOK_PASSWORD
  );

  const architect = await ensureProfile(
    store.id,
    process.env.ARCHITECT_EMAIL || "architect@demo.local",
    Role.ARCHITECT,
    "Architect Admin",
    process.env.ARCHITECT_PASSWORD
  );

  console.log("Seeded profiles:");
  console.table(
    [manager, waiter1, waiter2, cook, architect].map((u) => ({
      email: u.email,
      role: u.role,
    }))
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
