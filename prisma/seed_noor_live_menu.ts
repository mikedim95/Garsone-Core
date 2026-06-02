import { db } from "../src/db/index.js";

type MenuItem = {
  slug: string;
  title: string;
  titleEl?: string;
  priceCents: number;
  subcategoryEn?: string;
  subcategoryEl?: string;
};

type MenuCategory = {
  slug: string;
  title: string;
  titleEl: string;
  sortOrder: number;
  reuseSlugs?: string[];
  items: MenuItem[];
};

const PRINTER_TOPIC = "printer_1";
const NOOR_MENU_IMAGE_BASE_URL =
  process.env.NOOR_MENU_IMAGE_BASE_URL ||
  "https://order-flow-api-3uuy.onrender.com/media/garsone-media/noor/Menu";

const slugify = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

const noorImageUrl = (slug: string) =>
  `${NOOR_MENU_IMAGE_BASE_URL.replace(/\/$/, "")}/${encodeURIComponent(slug)}.webp`;

const shishaItem = (
  tier: "simple" | "special" | "premium",
  flavor: string,
  priceCents: number
): MenuItem => {
  const label =
    tier === "simple"
      ? "Simple Shisha"
      : tier === "special"
      ? "Special Shisha"
      : "Premium Shisha";
  const subcategoryEn =
    tier === "simple" ? "Simple" : tier === "special" ? "Special" : "Premium";
  const subcategoryEl =
    tier === "simple" ? "Απλός" : tier === "special" ? "Special" : "Premium";
  return {
    slug: `shisha-${tier}-${slugify(flavor)}`,
    title: `${label} - ${flavor}`,
    titleEl: `${label} - ${flavor}`,
    priceCents,
    subcategoryEn,
    subcategoryEl,
  };
};

const menu: MenuCategory[] = [
  {
    slug: "coffee",
    title: "Coffee",
    titleEl: "Καφέδες",
    sortOrder: 10,
    reuseSlugs: ["souvlaki"],
    items: [
      { slug: "cappuccino", title: "Cappuccino", titleEl: "Καπουτσίνο", priceCents: 250 },
      { slug: "double-cappuccino", title: "Double Cappuccino", titleEl: "Καπουτσίνο Διπλό", priceCents: 350 },
      { slug: "freddo-cappuccino", title: "Freddo Cappuccino", titleEl: "Φρέντο Καπουτσίνο", priceCents: 350 },
      { slug: "espresso", title: "Espresso", titleEl: "Εσπρέσο", priceCents: 250 },
      { slug: "double-espresso", title: "Double Espresso", titleEl: "Εσπρέσο Διπλό", priceCents: 300 },
      { slug: "freddo-espresso", title: "Freddo Espresso", titleEl: "Φρέντο Εσπρέσο", priceCents: 300 },
      { slug: "americano", title: "Americano", titleEl: "Αμερικάνο", priceCents: 300 },
    ],
  },
  {
    slug: "beverages",
    title: "Beverages",
    titleEl: "Ροφήματα",
    sortOrder: 20,
    reuseSlugs: ["plates"],
    items: [
      { slug: "chocolate", title: "Chocolate", titleEl: "Σοκολάτα", priceCents: 400 },
      { slug: "chocolate-recipe", title: "Chocolate Recipe", titleEl: "Σοκολάτα Συνταγή", priceCents: 500 },
      { slug: "natural-juice", title: "Natural Juice", titleEl: "Φυσικός Χυμός", priceCents: 400 },
      { slug: "hot-tea", title: "Hot Tea", titleEl: "Τσάι Ζεστό", priceCents: 300 },
      { slug: "ice-tea", title: "Ice Tea", titleEl: "Τσάι Κρύο", priceCents: 300 },
      { slug: "refreshments", title: "Refreshments", titleEl: "Αναψυκτικά", priceCents: 300 },
      { slug: "hell", title: "Hell", titleEl: "Hell", priceCents: 300 },
      { slug: "monster", title: "Monster", titleEl: "Monster", priceCents: 350 },
    ],
  },
  {
    slug: "drinks",
    title: "Drinks",
    titleEl: "Ποτά",
    sortOrder: 30,
    items: [
      { slug: "drink-simple", title: "Simple Drink", titleEl: "Ποτό Απλό", priceCents: 600 },
      { slug: "drink-special", title: "Special Drink", titleEl: "Ποτό Σπέσιαλ", priceCents: 800 },
      { slug: "bottle-simple", title: "Bottle Simple", titleEl: "Φιάλη Απλή", priceCents: 7000 },
      { slug: "bottle-special", title: "Bottle Special", titleEl: "Φιάλη Σπέσιαλ", priceCents: 8000 },
      { slug: "ouzo", title: "Ouzo", titleEl: "Ούζο", priceCents: 300 },
      { slug: "sangria", title: "Sangria", titleEl: "Σανγκρία", priceCents: 500 },
      { slug: "wine", title: "Wine", titleEl: "Κρασί", priceCents: 400 },
      { slug: "honeydew-small", title: "Honeydew Small", titleEl: "Ρακόμελο Μικρό", priceCents: 600 },
      { slug: "honeydew-large", title: "Honeydew Large", titleEl: "Ρακόμελο Μεγάλο", priceCents: 1200 },
      { slug: "shots", title: "Shots", titleEl: "Σφηνάκια", priceCents: 300 },
      { slug: "shots-special", title: "Shots Special", titleEl: "Σφηνάκια Σπέσιαλ", priceCents: 400 },
    ],
  },
  {
    slug: "beer",
    title: "Beer",
    titleEl: "Μπύρες",
    sortOrder: 40,
    items: ["Alfa", "Mamos", "Amstel", "Heineken", "Fisher", "Kaiser", "Corona"].map((name) => ({
      slug: `beer-${slugify(name)}`,
      title: name,
      titleEl: name,
      priceCents: 500,
    })),
  },
  {
    slug: "shisha",
    title: "Shisha",
    titleEl: "Ναργιλέδες",
    sortOrder: 50,
    items: [
      ...["Mint", "Apple"].map((flavor) => shishaItem("simple", flavor, 500)),
      ...[
        "Big Boy",
        "Devil",
        "Ali Baba",
        "Fuck66",
        "Love66",
        "Mango Lemoni",
        "Pagoto Vanillia Vatomouro",
        "Marshmellow",
        "Lemoni",
        "Keik Lemoni",
        "Menta",
        "Milo",
      ].map((flavor) => shishaItem("special", flavor, 800)),
      ...["Caramella", "Mpiskoto Voutirou", "Ice Bomb", "Mesh Juicy", "Bueno"].map((flavor) =>
        shishaItem("premium", flavor, 800)
      ),
    ],
  },
];

async function ensureCategory(tx: any, storeId: string, category: MenuCategory) {
  const existing = await tx.category.findFirst({
    where: { storeId, slug: { in: [category.slug, ...(category.reuseSlugs ?? [])] } },
    orderBy: { sortOrder: "asc" },
  });

  if (existing) {
    return tx.category.update({
      where: { id: existing.id },
      data: {
        slug: category.slug,
        title: category.title,
        titleEn: category.title,
        titleEl: category.titleEl,
        printerTopic: PRINTER_TOPIC,
        sortOrder: category.sortOrder,
      },
    });
  }

  return tx.category.create({
    data: {
      storeId,
      slug: category.slug,
      title: category.title,
      titleEn: category.title,
      titleEl: category.titleEl,
      printerTopic: PRINTER_TOPIC,
      sortOrder: category.sortOrder,
    },
  });
}

async function main() {
  const store = await db.store.findUnique({ where: { slug: "noor" } });
  if (!store) throw new Error('Store "noor" not found');

  await db.$transaction(async (tx) => {
    await tx.item.updateMany({
      where: { storeId: store.id },
      data: { isAvailable: false },
    });

    for (const categoryConfig of menu) {
      const category = await ensureCategory(tx, store.id, categoryConfig);
      for (const [index, item] of categoryConfig.items.entries()) {
        await tx.item.upsert({
          where: { storeId_slug: { storeId: store.id, slug: item.slug } },
          update: {
            categoryId: category.id,
            title: item.title,
            titleEn: item.title,
            titleEl: item.titleEl ?? item.title,
            subcategoryEn: item.subcategoryEn ?? null,
            subcategoryEl: item.subcategoryEl ?? null,
            description: null,
            descriptionEn: null,
            descriptionEl: null,
            imageUrl: noorImageUrl(item.slug),
            printerTopic: PRINTER_TOPIC,
            priceCents: item.priceCents,
            isAvailable: true,
            sortOrder: categoryConfig.sortOrder * 100 + index,
          },
          create: {
            storeId: store.id,
            categoryId: category.id,
            slug: item.slug,
            title: item.title,
            titleEn: item.title,
            titleEl: item.titleEl ?? item.title,
            subcategoryEn: item.subcategoryEn ?? null,
            subcategoryEl: item.subcategoryEl ?? null,
            description: null,
            descriptionEn: null,
            descriptionEl: null,
            imageUrl: noorImageUrl(item.slug),
            printerTopic: PRINTER_TOPIC,
            priceCents: item.priceCents,
            isAvailable: true,
            sortOrder: categoryConfig.sortOrder * 100 + index,
          },
        });
      }
    }
  });

  const categories = await db.category.findMany({
    where: { storeId: store.id },
    include: { items: { where: { isAvailable: true } } },
    orderBy: { sortOrder: "asc" },
  });
  console.log(
    JSON.stringify(
      {
        store: { id: store.id, slug: store.slug, name: store.name },
        categories: categories.map((category) => ({
          slug: category.slug,
          title: category.title,
          itemCount: category.items.length,
        })),
        itemCount: categories.reduce((total, category) => total + category.items.length, 0),
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
