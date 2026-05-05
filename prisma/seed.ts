/**
 * prisma/seed.ts
 *
 * Simplified QR flow:
 * - Seeded stores: acropolis-street-food, noor
 * - Uses the first 20 public codes from qr_codes.txt
 * - Maps code #1..#10 -> tables T1..T10 for acropolis-street-food
 * - Maps code #11..#20 -> unassigned QR tiles for noor
 * - Writes prisma/qr-print-list.txt and prisma/qr-url-assignments.txt
 * - Extra QR tiles are generated later from Architect dashboard
 */

import { PrismaClient, Role, OrderItemStatus, OrderStatus } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import { applyDbConnection } from "../src/db/config";

const { target: dbTarget, databaseUrl } = applyDbConnection();
const prisma = new PrismaClient();

try {
  const { hostname, pathname } = new URL(databaseUrl);
  const dbName = pathname?.replace("/", "") || "";
  console.log(
    `[seed] DB_CONNECTION=${dbTarget} -> ${hostname}${dbName ? `/${dbName}` : ""}`
  );
} catch {
  console.log(`[seed] DB_CONNECTION=${dbTarget}`);
}

// ===== runtime config =====
const SEED_RESET = process.env.SEED_RESET !== "0";
const QR_CODES_FILE = path.join(process.cwd(), "qr_codes.txt");
const QR_PER_STORE = 10;
const PRIMARY_STORE_SLUG = "acropolis-street-food";
const SEEDED_STORE_SLUGS = ["acropolis-street-food", "noor"] as const;
const QR_CODE_REGEX = /^GT-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/;
const PUBLIC_APP_URL = (
  process.env.PUBLIC_APP_URL ?? "https://www.garsone.gr"
).replace(/\/+$/, "");
const QR_PATH_PREFIX = "/q";

// ===== progress bars =====
function bar(label: string, current: number, total: number, width = 28) {
  const pct = total === 0 ? 1 : current / total;
  const filled = Math.round(width * pct);
  const empty = Math.max(0, width - filled);
  const p = Math.round(pct * 100);
  const line = `${label} [${"█".repeat(filled)}${" ".repeat(empty)}] ${String(
    p
  ).padStart(3)}% (${current}/${total})`;
  process.stdout.write("\r" + line);
  if (current >= total) process.stdout.write("\n");
}
function section(title: string) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

// ===== helpers =====
type QrAssignment = {
  storeSlug: string;
  tableLabel: string | null;
  publicCode: string;
  url: string;
};

function loadQrCodesFile(): { raw: string; codes: string[] } {
  if (!fs.existsSync(QR_CODES_FILE)) {
    throw new Error(`Missing file: ${QR_CODES_FILE}`);
  }

  const raw = fs.readFileSync(QR_CODES_FILE, "utf8");
  const lines = raw.split(/\r?\n/);

  const codes: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!QR_CODE_REGEX.test(trimmed)) {
      throw new Error(`Bad qr_codes.txt line (invalid code): "${line}"`);
    }
    if (seen.has(trimmed)) {
      throw new Error(`Duplicate publicCode in qr_codes.txt: ${trimmed}`);
    }
    seen.add(trimmed);
    codes.push(trimmed);
  }

  return { raw, codes };
}

function buildQrAssignments(codes: string[]): QrAssignment[] {
  const requiredCodes = QR_PER_STORE * SEEDED_STORE_SLUGS.length;
  if (codes.length < requiredCodes) {
    throw new Error(
      `qr_codes.txt must contain at least ${requiredCodes} codes. Found ${codes.length}.`
    );
  }

  const assignments: QrAssignment[] = [];
  for (let storeIndex = 0; storeIndex < SEEDED_STORE_SLUGS.length; storeIndex += 1) {
    const storeSlug = SEEDED_STORE_SLUGS[storeIndex];
    for (let tableIndex = 0; tableIndex < QR_PER_STORE; tableIndex += 1) {
      const codeIndex = storeIndex * QR_PER_STORE + tableIndex;
      const publicCode = codes[codeIndex];
      const tableLabel =
        storeSlug === PRIMARY_STORE_SLUG ? `T${tableIndex + 1}` : null;
      const url = `${PUBLIC_APP_URL}${QR_PATH_PREFIX}/${publicCode}`;
      assignments.push({
        storeSlug,
        tableLabel,
        publicCode,
        url,
      });
    }
  }
  return assignments;
}

function writeQrPrintList(assignments: QrAssignment[]) {
  const out = [
    "# url,storeSlug,tableLabel,publicCode",
    ...assignments.map(
      (x) => `${x.url},${x.storeSlug},${x.tableLabel ?? ""},${x.publicCode}`
    ),
    "",
  ].join("\n");

  fs.writeFileSync(
    path.join(process.cwd(), "prisma", "qr-print-list.txt"),
    out,
    "utf8"
  );
}

function writeQrUrlAssignments(assignments: QrAssignment[]) {
  const out = [
    "# storeSlug,tableLabel,publicCode,url",
    ...assignments.map(
      (x) => `${x.storeSlug},${x.tableLabel ?? ""},${x.publicCode},${x.url}`
    ),
    "",
  ].join("\n");

  fs.writeFileSync(
    path.join(process.cwd(), "prisma", "qr-url-assignments.txt"),
    out,
    "utf8"
  );
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randFromArray<T>(arr: T[]): T {
  return arr[randInt(0, arr.length - 1)];
}
function randomDateWithinDaysBack(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - randInt(0, daysBack));
  d.setHours(randInt(9, 23), randInt(0, 59), randInt(0, 59), 0);
  return d;
}
async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
function sessionToken64(): string {
  return crypto.randomBytes(32).toString("hex"); // 64 chars
}

function normalizeSlug(value: string) {
  const raw = value.trim().toLowerCase();
  if (!raw) return "";
  return raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function normalizePrinterTopic(value?: string | null, fallback?: string | null) {
  const raw = (value || fallback || "").trim().toLowerCase();
  if (!raw) return null;
  const sanitized = raw
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
  return sanitized || null;
}

// ===== seed config =====
type StoreConfig = {
  slug: string;
  name: string;
  currencyCode: string;
  locale: string;
  orderingMode: "qr" | "waiter" | "hybrid";
  printers?: string[];
  cookTypes?: { slug: string; title: string; printerTopic?: string }[];
  waiterTypes?: { slug: string; title: string; printerTopic?: string }[];
  profiles: {
    email: string;
    role: Role;
    displayName: string;
    cookTypeSlug?: string;
    waiterTypeSlug?: string;
  }[];
  modifiers?: {
    slug: string;
    title: string;
    titleEn?: string;
    titleEl?: string;
    minSelect?: number;
    maxSelect?: number;
    required?: boolean;
    itemSlugs: string[];
    options: {
      slug: string;
      title: string;
      titleEn?: string;
      titleEl?: string;
      priceDeltaCents?: number;
    }[];
  }[];
  categories: {
    slug: string;
    title: string;
    titleEn?: string;
    titleEl?: string;
    printerTopic?: string;
    items: {
      slug: string;
      title: string;
      titleEn?: string;
      titleEl?: string;
      subcategory?: string;
      subcategoryEn?: string;
      subcategoryEl?: string;
      description?: string;
      descriptionEn?: string;
      descriptionEl?: string;
      priceCents: number;
      imageUrl?: string;
    }[];
  }[];
};

const ALL_STORES: StoreConfig[] = [
  {
    slug: "harbor-breeze-lounge",
    name: "Harbor Breeze Lounge",
    currencyCode: "EUR",
    locale: "en",
    orderingMode: "qr",
    printers: ["printer_1", "printer_2"],
    modifiers: [
      {
        slug: "ice-level",
        title: "Ice level",
        minSelect: 1,
        maxSelect: 1,
        required: true,
        itemSlugs: ["mojito", "spritz", "gin-tonic", "whisky"],
        options: [
          { slug: "normal-ice", title: "Normal ice" },
          { slug: "light-ice", title: "Light ice" },
          { slug: "no-ice", title: "No ice" },
        ],
      },
      {
        slug: "garnish",
        title: "Garnish",
        minSelect: 0,
        maxSelect: 2,
        required: false,
        itemSlugs: ["mojito", "spritz", "gin-tonic", "whisky"],
        options: [
          { slug: "lime", title: "Lime wedge", priceDeltaCents: 0 },
          { slug: "mint", title: "Mint leaves", priceDeltaCents: 0 },
          { slug: "orange", title: "Orange peel", priceDeltaCents: 0 },
        ],
      },
      {
        slug: "snack-addons",
        title: "Snacks add-ons",
        minSelect: 0,
        maxSelect: 2,
        required: false,
        itemSlugs: ["nachos", "nuts"],
        options: [
          { slug: "extra-cheese", title: "Extra cheese", priceDeltaCents: 80 },
          { slug: "jalapenos", title: "Jalapeños", priceDeltaCents: 60 },
        ],
      },
    ],
    cookTypes: [
      { slug: "bar", title: "Bar Station", printerTopic: "printer_1" },
      { slug: "snacks", title: "Snacks Station", printerTopic: "printer_2" },
    ],
    waiterTypes: [
      { slug: "drinks", title: "Drinks Service", printerTopic: "printer_1" },
      { slug: "snacks", title: "Snack Service", printerTopic: "printer_2" },
    ],
    profiles: [
      {
        email: "manager@harbor-breeze.local",
        role: Role.MANAGER,
        displayName: "Harbor Manager",
      },
      {
        email: "waiter1@harbor-breeze.local",
        role: Role.WAITER,
        displayName: "Maria Waiter",
        waiterTypeSlug: "drinks",
      },
      {
        email: "waiter2@harbor-breeze.local",
        role: Role.WAITER,
        displayName: "Nikos Waiter",
        waiterTypeSlug: "snacks",
      },
      {
        email: "cook1@harbor-breeze.local",
        role: Role.COOK,
        displayName: "Bar Kitchen",
        cookTypeSlug: "bar",
      },
      {
        email: "cook2@harbor-breeze.local",
        role: Role.COOK,
        displayName: "Snack Kitchen",
        cookTypeSlug: "snacks",
      },
    ],
    categories: [
      {
        slug: "cocktails",
        title: "Cocktails",
        printerTopic: "bar",
        items: [
          {
            slug: "mojito",
            title: "Mojito",
            priceCents: 850,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/cocktails/mohito.jpg",
          },
          {
            slug: "spritz",
            title: "Spritz",
            priceCents: 900,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/cocktails/spritz.jpg",
          },
        ],
      },
      {
        slug: "spirits",
        title: "Spirits",
        printerTopic: "bar",
        items: [
          {
            slug: "gin-tonic",
            title: "Gin & Tonic",
            priceCents: 800,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/spirits/gin-tonic.jpg",
          },
          {
            slug: "whisky",
            title: "Whisky",
            priceCents: 900,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/spirits/whisky.jpg",
          },
        ],
      },
      {
        slug: "bar-snacks",
        title: "Bar Snacks",
        printerTopic: "snacks",
        items: [
          {
            slug: "nachos",
            title: "Nachos",
            priceCents: 650,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/bar-snacks/nachos.jpeg",
          },
          {
            slug: "nuts",
            title: "Mixed Nuts",
            priceCents: 350,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/harbor-breeze-lounge/bar-snacks/nuts.jpg",
          },
        ],
      },
    ],
  },
  {
    slug: "acropolis-street-food",
    name: "Acropolis Street Food",
    currencyCode: "EUR",
    locale: "el",
    orderingMode: "hybrid",
    printers: ["printer_1", "printer_2"],
    modifiers: [
      {
        slug: "sauce",
        title: "Sauce",
        titleEn: "Sauce",
        titleEl: "Σάλτσα",
        minSelect: 1,
        maxSelect: 1,
        required: true,
        itemSlugs: ["pita-pork", "pita-chicken", "gyro-plate", "mixed-grill"],
        options: [
          { slug: "tzatziki", title: "Tzatziki", titleEn: "Tzatziki", titleEl: "Τζατζίκι" },
          { slug: "spicy", title: "Spicy", titleEn: "Spicy", titleEl: "Καυτερή" },
          { slug: "mustard", title: "Mustard", titleEn: "Mustard", titleEl: "Μουστάρδα" },
        ],
      },
      {
        slug: "extras",
        title: "Extras",
        titleEn: "Extras",
        titleEl: "Έξτρα",
        minSelect: 0,
        maxSelect: 2,
        required: false,
        itemSlugs: ["pita-pork", "pita-chicken", "gyro-plate", "mixed-grill"],
        options: [
          { slug: "extra-fries", title: "Extra fries", titleEn: "Extra fries", titleEl: "Έξτρα πατάτες", priceDeltaCents: 150 },
          { slug: "extra-pita", title: "Extra pita", titleEn: "Extra pita", titleEl: "Έξτρα πίτα", priceDeltaCents: 100 },
          { slug: "feta", title: "Feta topping", titleEn: "Feta topping", titleEl: "Έξτρα φέτα", priceDeltaCents: 120 },
        ],
      },
      {
        slug: "drink-ice",
        title: "Ice level",
        titleEn: "Ice level",
        titleEl: "Ποσότητα πάγου",
        minSelect: 1,
        maxSelect: 1,
        required: true,
        itemSlugs: ["cola", "beer"],
        options: [
          { slug: "regular-ice", title: "Regular ice", titleEn: "Regular ice", titleEl: "Κανονικός πάγος" },
          { slug: "light-ice", title: "Light ice", titleEn: "Light ice", titleEl: "Λίγος πάγος" },
          { slug: "no-ice", title: "No ice", titleEn: "No ice", titleEl: "Χωρίς πάγο" },
        ],
      },
      {
        slug: "shisha-strength",
        title: "Shisha strength",
        titleEn: "Shisha strength",
        titleEl: "Ένταση ναργιλέ",
        minSelect: 1,
        maxSelect: 1,
        required: true,
        itemSlugs: [
          "shisha-double-apple",
          "shisha-blueberry-mint",
          "shisha-lemon-mint",
          "shisha-grapefruit",
          "shisha-watermelon-lemon",
          "shisha-passion-lime",
        ],
        options: [
          { slug: "light", title: "Light", titleEn: "Light", titleEl: "Ελαφρύς" },
          { slug: "heavy", title: "Heavy", titleEn: "Heavy", titleEl: "Δυνατός" },
        ],
      },
    ],
    cookTypes: [
      { slug: "grill", title: "Grill Station", printerTopic: "printer_1" },
      { slug: "bar", title: "Drinks Station", printerTopic: "printer_2" },
    ],
    waiterTypes: [
      { slug: "food", title: "Food Service", printerTopic: "printer_1" },
      { slug: "drinks", title: "Drinks Service", printerTopic: "printer_2" },
    ],
    profiles: [
      {
        email: "manager@acropolis-street.local",
        role: Role.MANAGER,
        displayName: "Acropolis Manager",
      },
      {
        email: "waiter1@acropolis-street.local",
        role: Role.WAITER,
        displayName: "Giannis Waiter",
        waiterTypeSlug: "food",
      },
      {
        email: "waiter2@acropolis-street.local",
        role: Role.WAITER,
        displayName: "Eleni Waiter",
        waiterTypeSlug: "drinks",
      },
      {
        email: "cook1@acropolis-street.local",
        role: Role.COOK,
        displayName: "Grill Master",
        cookTypeSlug: "grill",
      },
      {
        email: "cook2@acropolis-street.local",
        role: Role.COOK,
        displayName: "Bar Prep",
        cookTypeSlug: "bar",
      },
    ],
    categories: [
      {
        slug: "souvlaki",
        title: "Souvlaki",
        titleEn: "Souvlaki",
        titleEl: "Σουβλάκι",
        printerTopic: "grill",
        items: [
          {
            slug: "pita-pork",
            title: "Pita Pork",
            titleEn: "Pita Pork",
            titleEl: "Πίτα Χοιρινό",
            subcategory: "Pita Wraps",
            subcategoryEn: "Pita Wraps",
            subcategoryEl: "Τυλιχτά Πίτας",
            description: "Pita wrap with pork gyro, fries, onion and tzatziki.",
            descriptionEn: "Pita wrap with pork gyro, fries, onion and tzatziki.",
            descriptionEl: "Τυλιχτή πίτα με χοιρινό γύρο, πατάτες, κρεμμύδι και τζατζίκι.",
            priceCents: 350,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/souvlaki/pita-pork.jpg",
          },
          {
            slug: "pita-chicken",
            title: "Pita Chicken",
            titleEn: "Pita Chicken",
            titleEl: "Πίτα Κοτόπουλο",
            subcategory: "Pita Wraps",
            subcategoryEn: "Pita Wraps",
            subcategoryEl: "Τυλιχτά Πίτας",
            description: "Pita wrap with chicken gyro, fries, tomato and tzatziki.",
            descriptionEn: "Pita wrap with chicken gyro, fries, tomato and tzatziki.",
            descriptionEl: "Τυλιχτή πίτα με γύρο κοτόπουλο, πατάτες, ντομάτα και τζατζίκι.",
            priceCents: 380,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/souvlaki/pita-chicken.jpg",
          },
        ],
      },
      {
        slug: "plates",
        title: "Plates",
        titleEn: "Plates",
        titleEl: "Μερίδες",
        printerTopic: "grill",
        items: [
          {
            slug: "gyro-plate",
            title: "Gyro Plate",
            titleEn: "Gyro Plate",
            titleEl: "Μερίδα Γύρος",
            subcategory: "Grill Plates",
            subcategoryEn: "Grill Plates",
            subcategoryEl: "Μερίδες Σχάρας",
            description: "Gyro plate with fries, pita, onion and tzatziki.",
            descriptionEn: "Gyro plate with fries, pita, onion and tzatziki.",
            descriptionEl: "Μερίδα γύρου με πατάτες, πίτα, κρεμμύδι και τζατζίκι.",
            priceCents: 900,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/plates/gyro-plate.jpg",
          },
          {
            slug: "mixed-grill",
            title: "Mixed Grill",
            titleEn: "Mixed Grill",
            titleEl: "Ποικιλία Σχάρας",
            subcategory: "Grill Plates",
            subcategoryEn: "Grill Plates",
            subcategoryEl: "Μερίδες Σχάρας",
            description: "Mixed grill selection with pita, fries and sauces.",
            descriptionEn: "Mixed grill selection with pita, fries and sauces.",
            descriptionEl: "Ποικιλία σχάρας με πίτα, πατάτες και σάλτσες.",
            priceCents: 1400,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/plates/mixed-grill.jpg",
          },
        ],
      },
      {
        slug: "drinks",
        title: "Drinks",
        titleEn: "Drinks",
        titleEl: "Ποτά",
        printerTopic: "bar",
        items: [
          {
            slug: "cola",
            title: "Cola",
            titleEn: "Cola",
            titleEl: "Κόλα",
            subcategory: "Cold Drinks",
            subcategoryEn: "Cold Drinks",
            subcategoryEl: "Κρύα Ροφήματα",
            description: "Soft drink served cold.",
            descriptionEn: "Soft drink served cold.",
            descriptionEl: "Αναψυκτικό σερβιρισμένο παγωμένο.",
            priceCents: 200,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/drinks/cola.jpg",
          },
          {
            slug: "beer",
            title: "Beer",
            titleEn: "Beer",
            titleEl: "Μπίρα",
            subcategory: "Cold Drinks",
            subcategoryEn: "Cold Drinks",
            subcategoryEl: "Κρύα Ροφήματα",
            description: "Draft beer served chilled.",
            descriptionEn: "Draft beer served chilled.",
            descriptionEl: "Μπύρα βαρελίσια παγωμένη.",
            priceCents: 450,
            imageUrl:
              "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/acropolis-street-food/drinks/beer.jpg",
          },
        ],
      },
      {
        slug: "shisha",
        title: "Shisha",
        titleEn: "Shisha",
        titleEl: "Ναργιλές",
        printerTopic: "bar",
        items: [
          {
            slug: "shisha-double-apple",
            title: "Double Apple Shisha",
            titleEn: "Double Apple Shisha",
            titleEl: "Ναργιλές Διπλό Μήλο",
            subcategory: "Sweet",
            subcategoryEn: "Sweet",
            subcategoryEl: "Γλυκές Γεύσεις",
            description: "Classic double apple flavor.",
            descriptionEn: "Classic double apple flavor.",
            descriptionEl: "Κλασική γεύση διπλό μήλο.",
            priceCents: 1800,
          },
          {
            slug: "shisha-blueberry-mint",
            title: "Blueberry Mint Shisha",
            titleEn: "Blueberry Mint Shisha",
            titleEl: "Ναργιλές Μύρτιλο Μέντα",
            subcategory: "Sweet",
            subcategoryEn: "Sweet",
            subcategoryEl: "Γλυκές Γεύσεις",
            description: "Blueberry with a cool mint finish.",
            descriptionEn: "Blueberry with a cool mint finish.",
            descriptionEl: "Μύρτιλο με δροσερή επίγευση μέντας.",
            priceCents: 1900,
          },
          {
            slug: "shisha-lemon-mint",
            title: "Lemon Mint Shisha",
            titleEn: "Lemon Mint Shisha",
            titleEl: "Ναργιλές Λεμόνι Μέντα",
            subcategory: "Sour",
            subcategoryEn: "Sour",
            subcategoryEl: "Ξινές Γεύσεις",
            description: "Fresh lemon balanced with mint.",
            descriptionEn: "Fresh lemon balanced with mint.",
            descriptionEl: "Φρέσκο λεμόνι ισορροπημένο με μέντα.",
            priceCents: 1850,
          },
          {
            slug: "shisha-grapefruit",
            title: "Grapefruit Shisha",
            titleEn: "Grapefruit Shisha",
            titleEl: "Ναργιλές Γκρέιπφρουτ",
            subcategory: "Sour",
            subcategoryEn: "Sour",
            subcategoryEl: "Ξινές Γεύσεις",
            description: "Bright grapefruit citrus blend.",
            descriptionEn: "Bright grapefruit citrus blend.",
            descriptionEl: "Έντονο εσπεριδοειδές χαρμάνι γκρέιπφρουτ.",
            priceCents: 1850,
          },
          {
            slug: "shisha-watermelon-lemon",
            title: "Watermelon Lemon Shisha",
            titleEn: "Watermelon Lemon Shisha",
            titleEl: "Ναργιλές Καρπούζι Λεμόνι",
            subcategory: "Sweet-Sour",
            subcategoryEn: "Sweet-Sour",
            subcategoryEl: "Γλυκόξινες Γεύσεις",
            description: "Juicy watermelon with lemon zest.",
            descriptionEn: "Juicy watermelon with lemon zest.",
            descriptionEl: "Ζουμερό καρπούζι με ξύσμα λεμονιού.",
            priceCents: 1950,
          },
          {
            slug: "shisha-passion-lime",
            title: "Passion Lime Shisha",
            titleEn: "Passion Lime Shisha",
            titleEl: "Ναργιλές Passion Lime",
            subcategory: "Sweet-Sour",
            subcategoryEn: "Sweet-Sour",
            subcategoryEl: "Γλυκόξινες Γεύσεις",
            description: "Passion fruit with lively lime notes.",
            descriptionEn: "Passion fruit with lively lime notes.",
            descriptionEl: "Passion fruit με ζωηρές νότες λάιμ.",
            priceCents: 1950,
          },
        ],
      },
    ],
  },
];

const acropolisTemplate = ALL_STORES.find(
  (store) => store.slug === PRIMARY_STORE_SLUG
);

if (!acropolisTemplate) {
  throw new Error(`Missing seed template store "${PRIMARY_STORE_SLUG}".`);
}

const NOOR_IMAGE_BY_ITEM_SLUG: Record<string, string> = {
  "pita-pork":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/souvlaki/pita-pork.jpg",
  "pita-chicken":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/souvlaki/pita-chicken.jpg",
  "gyro-plate":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/plates/gyro-plate.jpg",
  "mixed-grill":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/plates/mixed-grill.jpg",
  cola:
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/drinks/cola.jpg",
  beer:
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/drinks/beer.jpg",
  "shisha-double-apple":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/shisha/Double-apple.webp",
  "shisha-grapefruit":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/shisha/Grapefruit.webp",
  "shisha-blueberry-mint":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/shisha/blueberry%20mint.webp",
  "shisha-lemon-mint":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/shisha/lime-mint.webp",
  "shisha-passion-lime":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/shisha/passion%20fruit.avif",
  "shisha-watermelon-lemon":
    "https://pub-c65f0575201a4ce580bfc48dbcc24b12.r2.dev/noor/shisha/watermelon-lemon.avif",
};

const applyNoorImageOverrides = (store: StoreConfig): StoreConfig => ({
  ...store,
  categories: (store.categories ?? []).map((category) => ({
    ...category,
    items: (category.items ?? []).map((item) => ({
      ...item,
      imageUrl: NOOR_IMAGE_BY_ITEM_SLUG[item.slug] ?? item.imageUrl ?? null,
    })),
  })),
});

ALL_STORES.push({
  ...applyNoorImageOverrides(JSON.parse(JSON.stringify(acropolisTemplate))),
  slug: "noor",
  name: "Noor",
  profiles: [
    {
      email: "manager@noor.local",
      role: Role.MANAGER,
      displayName: "Noor Manager",
    },
    {
      email: "waiter1@noor.local",
      role: Role.WAITER,
      displayName: "Noor Waiter",
      waiterTypeSlug: "food",
    },
    {
      email: "waiter2@noor.local",
      role: Role.WAITER,
      displayName: "Noor Drinks",
      waiterTypeSlug: "drinks",
    },
    {
      email: "cook1@noor.local",
      role: Role.COOK,
      displayName: "Noor Grill",
      cookTypeSlug: "grill",
    },
    {
      email: "cook2@noor.local",
      role: Role.COOK,
      displayName: "Noor Bar",
      cookTypeSlug: "bar",
    },
  ],
});

const STORES: StoreConfig[] = ALL_STORES.filter(
  (store) => SEEDED_STORE_SLUGS.includes(store.slug as (typeof SEEDED_STORE_SLUGS)[number])
);

if (STORES.length !== SEEDED_STORE_SLUGS.length) {
  throw new Error(
    `Seed expects stores: ${SEEDED_STORE_SLUGS.join(", ")}.`
  );
}

// ===== reset (best-effort order) =====
async function resetAll() {
  section("Resetting DB");
  const steps: Array<{ label: string; fn: () => Promise<any> }> = [
    {
      label: "orderItemOptions",
      fn: () => prisma.orderItemOption.deleteMany(),
    },
    { label: "orderItems", fn: () => prisma.orderItem.deleteMany() },
    { label: "orders", fn: () => prisma.order.deleteMany() },

    { label: "itemModifiers", fn: () => prisma.itemModifier.deleteMany() },
    { label: "modifierOptions", fn: () => prisma.modifierOption.deleteMany() },
    { label: "modifiers", fn: () => prisma.modifier.deleteMany() },

    { label: "items", fn: () => prisma.item.deleteMany() },
    { label: "categories", fn: () => prisma.category.deleteMany() },

    { label: "waiterTables", fn: () => prisma.waiterTable.deleteMany() },
    { label: "waiterShifts", fn: () => prisma.waiterShift.deleteMany() },

    { label: "tableVisits", fn: () => prisma.tableVisit.deleteMany() },
    { label: "qrTiles", fn: () => prisma.qRTile.deleteMany() },
    { label: "tables", fn: () => prisma.table.deleteMany() },

    { label: "auditLogs", fn: () => prisma.auditLog.deleteMany() },
    { label: "profiles", fn: () => prisma.profile.deleteMany() },
    { label: "waiterTypes", fn: () => prisma.waiterType.deleteMany() },
    { label: "cookTypes", fn: () => prisma.cookType.deleteMany() },

    {
      label: "kitchenTicketSeqs",
      fn: () => prisma.kitchenTicketSeq.deleteMany(),
    },
    { label: "kitchenCounters", fn: () => prisma.kitchenCounter.deleteMany() },
    { label: "storeMeta", fn: () => prisma.storeMeta.deleteMany() },
    { label: "stores", fn: () => prisma.store.deleteMany() },
  ];

  for (let i = 0; i < steps.length; i++) {
    bar("reset", i, steps.length);
    await steps[i].fn();
  }
  bar("reset", steps.length, steps.length);
}

// ===== seed pieces =====
async function seedStoresAndData(qrAssignments: QrAssignment[]) {
  const storeIds: string[] = [];

  for (let si = 0; si < STORES.length; si++) {
    const cfg = STORES[si];
    section(`Store ${si + 1}/${STORES.length}: ${cfg.slug}`);

    const categoryPrinters = Array.from(
      new Set(
        (cfg.categories ?? [])
          .map((c) => c.printerTopic)
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
          .map((p) => p.trim())
      )
    );
    const printerList = cfg.printers && cfg.printers.length > 0 ? cfg.printers : categoryPrinters;
    const normalizedPrinters = printerList
      .map((printer) => normalizePrinterTopic(printer, printer))
      .filter((printer): printer is string => Boolean(printer));

    const store = await prisma.store.upsert({
      where: { slug: cfg.slug },
      update: { name: cfg.name, settingsJson: { orderingMode: cfg.orderingMode, printers: printerList } },
      create: { slug: cfg.slug, name: cfg.name, settingsJson: { orderingMode: cfg.orderingMode, printers: printerList } },
    });
    const storeId = store.id;
    storeIds.push(storeId);

    await prisma.storeMeta.upsert({
      where: { storeId },
      update: { currencyCode: cfg.currencyCode, locale: cfg.locale },
      create: { storeId, currencyCode: cfg.currencyCode, locale: cfg.locale },
    });

    const cookTypesBySlug = new Map<string, { id: string; slug: string }>();
    if (cfg.cookTypes?.length) {
      for (let i = 0; i < cfg.cookTypes.length; i++) {
        const type = cfg.cookTypes[i];
        const slug = normalizeSlug(type.slug || type.title) || `cook-${i + 1}`;
        const printerTopic =
          normalizePrinterTopic(type.printerTopic, slug) ?? slug;
        const cooked = await prisma.cookType.upsert({
          where: { storeId_slug: { storeId, slug } },
          update: { title: type.title, printerTopic },
          create: { storeId, slug, title: type.title, printerTopic },
        });
        cookTypesBySlug.set(slug, { id: cooked.id, slug: cooked.slug });
        bar("store:cookTypes", i + 1, cfg.cookTypes.length);
      }
    }

    const waiterTypesBySlug = new Map<string, { id: string; slug: string }>();
    if (cfg.waiterTypes?.length) {
      for (let i = 0; i < cfg.waiterTypes.length; i++) {
        const type = cfg.waiterTypes[i];
        const slug = normalizeSlug(type.slug || type.title) || `waiter-${i + 1}`;
        const printerTopic =
          normalizePrinterTopic(type.printerTopic, slug) ?? slug;
        const created = await prisma.waiterType.upsert({
          where: { storeId_slug: { storeId, slug } },
          update: { title: type.title, printerTopic },
          create: { storeId, slug, title: type.title, printerTopic },
        });
        waiterTypesBySlug.set(slug, { id: created.id, slug: created.slug });
        bar("store:waiterTypes", i + 1, cfg.waiterTypes.length);
      }
    }

    // store-scoped profiles (all pass = changeme)
    const pw = await hashPassword("changeme");
    for (let i = 0; i < cfg.profiles.length; i++) {
      const p = cfg.profiles[i];
      const cookTypeId =
        p.role === Role.COOK
          ? cookTypesBySlug.get(normalizeSlug(p.cookTypeSlug || ""))?.id ||
            Array.from(cookTypesBySlug.values())[0]?.id ||
            null
          : null;
      const waiterTypeId =
        p.role === Role.WAITER
          ? waiterTypesBySlug.get(normalizeSlug(p.waiterTypeSlug || ""))?.id ||
            Array.from(waiterTypesBySlug.values())[0]?.id ||
            null
          : null;
      await prisma.profile.upsert({
        where: { storeId_email: { storeId, email: p.email } },
        update: {
          role: p.role,
          displayName: p.displayName,
          passwordHash: pw,
          isVerified: true,
          ...(p.role === Role.COOK ? { cookTypeId, waiterTypeId: null } : {}),
          ...(p.role === Role.WAITER ? { waiterTypeId, cookTypeId: null } : {}),
          ...(p.role !== Role.COOK && p.role !== Role.WAITER
            ? { cookTypeId: null, waiterTypeId: null }
            : {}),
        },
        create: {
          storeId,
          email: p.email,
          role: p.role,
          displayName: p.displayName,
          passwordHash: pw,
          isVerified: true,
          ...(p.role === Role.COOK ? { cookTypeId, waiterTypeId: null } : {}),
          ...(p.role === Role.WAITER ? { waiterTypeId, cookTypeId: null } : {}),
        },
      });
      bar("store:profiles", i + 1, cfg.profiles.length);
    }

    // tables T1..T10
    const tables = [];
    for (let i = 1; i <= 10; i++) {
      const t = await prisma.table.upsert({
        where: { storeId_label: { storeId, label: `T${i}` } },
        update: { isActive: true },
        create: { storeId, label: `T${i}`, isActive: true },
      });
      tables.push(t);
    }
    bar("store:tables", 10, 10);

    // waiter-table assignments: round-robin tables across waiters
    const waiters = await prisma.profile.findMany({
      where: { storeId, role: Role.WAITER },
      orderBy: { email: "asc" },
    });
    if (waiters.length > 0) {
      const assignments = tables.map((table, index) => ({
        storeId,
        waiterId: waiters[index % waiters.length].id,
        tableId: table.id,
      }));
      await prisma.waiterTable.createMany({
        data: assignments,
        skipDuplicates: true,
      });
      bar("store:waiterTables", assignments.length, assignments.length);
    }

    // qr tiles from qr_codes.txt assignments (MUST be 10/store)
    const storeQr = qrAssignments.filter((x) => x.storeSlug === cfg.slug);
    if (storeQr.length !== QR_PER_STORE)
      throw new Error(
        `qr_codes.txt must have exactly ${QR_PER_STORE} entries for ${cfg.slug} (found ${storeQr.length})`
      );

    for (let i = 0; i < storeQr.length; i++) {
      const x = storeQr[i];
      const table = x.tableLabel
        ? tables.find((t) => t.label === x.tableLabel)
        : null;
      if (x.tableLabel && !table)
        throw new Error(
          `qr_codes.txt references missing table ${cfg.slug}/${x.tableLabel}`
        );

      await prisma.qRTile.upsert({
        where: { publicCode: x.publicCode },
        update: {
          storeId,
          tableId: table?.id ?? null,
          label: x.tableLabel ? `Tile ${x.tableLabel}` : `Unassigned ${i + 1}`,
          isActive: true,
        },
        create: {
          storeId,
          tableId: table?.id ?? null,
          publicCode: x.publicCode,
          label: x.tableLabel ? `Tile ${x.tableLabel}` : `Unassigned ${i + 1}`,
          isActive: true,
        },
      });

      bar("store:qrTiles", i + 1, storeQr.length);
    }

    // categories + items
    const items: Array<{ id: string; title: string; priceCents: number; slug: string }> = [];

    for (let ci = 0; ci < cfg.categories.length; ci++) {
      const cat = cfg.categories[ci];
      const normalizedCategory = normalizePrinterTopic(cat.printerTopic, cat.slug);
      const fallbackPrinter =
        normalizedPrinters[ci % (normalizedPrinters.length || 1)] ??
        normalizedCategory ??
        "printer_1";
      const printerTopic =
        normalizedCategory && normalizedPrinters.includes(normalizedCategory)
          ? normalizedCategory
          : fallbackPrinter;
      const category = await prisma.category.upsert({
        where: { storeId_slug: { storeId, slug: cat.slug } },
        update: {
          title: cat.title,
          titleEl: cat.titleEl ?? cat.title,
          titleEn: cat.titleEn ?? cat.title,
          printerTopic,
          sortOrder: ci,
        },
        create: {
          storeId,
          slug: cat.slug,
          title: cat.title,
          titleEl: cat.titleEl ?? cat.title,
          titleEn: cat.titleEn ?? cat.title,
          printerTopic,
          sortOrder: ci,
        },
      });

      for (let ii = 0; ii < cat.items.length; ii++) {
        const it = cat.items[ii];
        const created = await prisma.item.upsert({
          where: { storeId_slug: { storeId, slug: it.slug } },
          update: {
            categoryId: category.id,
            title: it.title,
            titleEl: it.titleEl ?? it.title,
            titleEn: it.titleEn ?? it.title,
            description: it.description ?? null,
            descriptionEn: it.descriptionEn ?? it.description ?? null,
            descriptionEl: it.descriptionEl ?? it.description ?? null,
            subcategoryEn: it.subcategoryEn ?? it.subcategory ?? null,
            subcategoryEl: it.subcategoryEl ?? it.subcategory ?? null,
            priceCents: it.priceCents,
            isAvailable: true,
            imageUrl: it.imageUrl ?? null,
            printerTopic,
          },
          create: {
            storeId,
            categoryId: category.id,
            slug: it.slug,
            title: it.title,
            titleEl: it.titleEl ?? it.title,
            titleEn: it.titleEn ?? it.title,
            description: it.description ?? null,
            descriptionEn: it.descriptionEn ?? it.description ?? null,
            descriptionEl: it.descriptionEl ?? it.description ?? null,
            subcategoryEn: it.subcategoryEn ?? it.subcategory ?? null,
            subcategoryEl: it.subcategoryEl ?? it.subcategory ?? null,
            priceCents: it.priceCents,
            isAvailable: true,
            sortOrder: ii,
            imageUrl: it.imageUrl ?? null,
            printerTopic,
          },
        });

        items.push({
          id: created.id,
          title: created.title,
          priceCents: created.priceCents,
          slug: it.slug,
        });
      }

      bar("store:categories", ci + 1, cfg.categories.length);
    }

    // modifiers + options + item links
    const itemBySlug = new Map(items.map((it) => [it.slug, it]));
    const modifiers = cfg.modifiers ?? [];
    for (let mi = 0; mi < modifiers.length; mi++) {
      const mod = modifiers[mi];
      const minSelect = typeof mod.minSelect === "number" ? mod.minSelect : 0;
      const maxSelect = typeof mod.maxSelect === "number" ? mod.maxSelect : 1;

      const modifier = await prisma.modifier.upsert({
        where: { storeId_slug: { storeId, slug: mod.slug } },
        update: {
          title: mod.title,
          titleEl: mod.titleEl ?? mod.title,
          titleEn: mod.titleEn ?? mod.title,
          minSelect,
          maxSelect,
          isAvailable: true,
        },
        create: {
          storeId,
          slug: mod.slug,
          title: mod.title,
          titleEl: mod.titleEl ?? mod.title,
          titleEn: mod.titleEn ?? mod.title,
          minSelect,
          maxSelect,
          isAvailable: true,
        },
      });

      for (let oi = 0; oi < mod.options.length; oi++) {
        const opt = mod.options[oi];
        await prisma.modifierOption.upsert({
          where: {
            storeId_modifierId_slug: {
              storeId,
              modifierId: modifier.id,
              slug: opt.slug,
            },
          },
          update: {
            title: opt.title,
            titleEl: opt.titleEl ?? opt.title,
            titleEn: opt.titleEn ?? opt.title,
            priceDeltaCents: opt.priceDeltaCents ?? 0,
            sortOrder: oi,
          },
          create: {
            storeId,
            modifierId: modifier.id,
            slug: opt.slug,
            title: opt.title,
            titleEl: opt.titleEl ?? opt.title,
            titleEn: opt.titleEn ?? opt.title,
            priceDeltaCents: opt.priceDeltaCents ?? 0,
            sortOrder: oi,
          },
        });
      }

      const uniqueItemSlugs = Array.from(new Set(mod.itemSlugs || []));
      for (const itemSlug of uniqueItemSlugs) {
        const item = itemBySlug.get(itemSlug);
        if (!item) continue;
        await prisma.itemModifier.upsert({
          where: { itemId_modifierId: { itemId: item.id, modifierId: modifier.id } },
          update: { isRequired: mod.required ?? false },
          create: {
            storeId,
            itemId: item.id,
            modifierId: modifier.id,
            isRequired: mod.required ?? false,
          },
        });
      }
      bar("store:modifiers", mi + 1, modifiers.length);
    }

    // a couple OPEN visits
    for (let v = 0; v < 2; v++) {
      const table = randFromArray(tables);
      const tile = storeQr.find((x) => x.tableLabel === table.label);
      if (!tile) continue;

      const tileRow = await prisma.qRTile.findUnique({
        where: { publicCode: tile.publicCode },
      });
      if (!tileRow) continue;

      await prisma.tableVisit.create({
        data: {
          storeId,
          tableId: table.id,
          tileId: tileRow.id,
          sessionToken: sessionToken64(),
          status: "OPEN" as any,
        },
      });
    }
    bar("store:visits", 2, 2);

    // orders (simple, schema-agnostic: Order then OrderItem)
    section(`Orders for ${cfg.slug}`);
    const totalOrders = 80;
    for (let oi = 0; oi < totalOrders; oi++) {
      const table = randFromArray(tables);
      const it = randFromArray(items);
      const qty = randInt(1, 2);

      const placedAt = randomDateWithinDaysBack(30);
      const acceptedAt = new Date(placedAt.getTime() + randInt(2, 10) * 60_000);
      const servedAt = new Date(acceptedAt.getTime() + randInt(3, 15) * 60_000);
      const paidAt = new Date(servedAt.getTime() + randInt(2, 20) * 60_000);

      const order = await prisma.order.create({
        data: {
          storeId,
          tableId: table.id,
          status: OrderStatus.PAID,
          totalCents: it.priceCents * qty,
          placedAt,
          paidAt,
          // if your DB enforces this NOT NULL, keep it:
          paymentStatus: "COMPLETED" as any,
        } as any,
      });

      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          itemId: it.id,
          titleSnapshot: it.title,
          unitPriceCents: it.priceCents,
          quantity: qty,
          status: OrderItemStatus.SERVED,
          acceptedAt,
          servedAt,
        },
      });

      bar("orders", oi + 1, totalOrders);
    }
  }

  return storeIds;
}

async function seedArchitectForStore(storeId: string) {
  section("Seeding architect");

  const email = "architect@demo.local";
  const passwordHash = await hashPassword("changeme");

  await prisma.profile.upsert({
    where: { globalKey: email },
    update: {
      storeId,
      email,
      globalKey: email,
      role: Role.ARCHITECT,
      displayName: "Central Architect",
      passwordHash,
      isVerified: true,
    },
    create: {
      storeId,
      email,
      globalKey: email,
      role: Role.ARCHITECT,
      displayName: "Central Architect",
      passwordHash,
      isVerified: true,
    },
  });

  bar("architect", 1, 1);
}

// ===== main =====
async function main() {
  section("Seed start");

  const { codes } = loadQrCodesFile();
  const qrAssignments = buildQrAssignments(codes);
  writeQrPrintList(qrAssignments);

  section("Generated print list");
  console.log(
    "prisma/qr-print-list.txt -> first 10 qr_codes.txt codes mapped to acropolis-street-food T1..T10"
  );

  if (SEED_RESET) await resetAll();

  const storeIds = await seedStoresAndData(qrAssignments);
  const primaryStoreId = storeIds[0];
  if (!primaryStoreId) {
    throw new Error("Primary store was not seeded.");
  }
  await seedArchitectForStore(primaryStoreId);

  writeQrUrlAssignments(qrAssignments);
  section("Generated QR URL assignments");
  console.log("prisma/qr-url-assignments.txt -> store URL mapping");

  section("Seed done");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
