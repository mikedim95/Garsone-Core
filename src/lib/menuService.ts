import { db } from "../db/index.js";
import type { ensureStore } from "./store.js";
import { buildEtag } from "./httpCache.js";

type Store = Awaited<ReturnType<typeof ensureStore>>;

type MenuPayload = {
  store: { id: string; slug: string; name: string };
  categories: Array<{
    id: string;
    slug: string | null;
    title: string;
    titleEn?: string | null;
    titleEl?: string | null;
    sortOrder?: number | null;
    printerTopic?: string | null;
  }>;
  items: Array<{
    id: string;
    name: string;
    titleEn?: string | null;
    titleEl?: string | null;
    description?: string | null;
    descriptionEn?: string | null;
    descriptionEl?: string | null;
    price: number;
    priceCents: number;
    image: string | null;
    imageUrl: string | null;
    category: string | null;
    categoryId: string | null;
    available: boolean;
    modifiers: Array<{
      id: string;
      name: string;
      titleEn?: string | null;
      titleEl?: string | null;
      minSelect: number;
      maxSelect: number | null;
      required: boolean;
      options: Array<{
        id: string;
        label: string;
        titleEn?: string | null;
        titleEl?: string | null;
        priceDelta: number;
        priceDeltaCents: number;
      }>;
    }>;
  }>;
  modifiers: Array<{
    id: string;
    name: string;
    titleEn?: string | null;
    titleEl?: string | null;
    minSelect: number;
    maxSelect: number | null;
    required: boolean;
    isAvailable?: boolean | null;
    options: Array<{
      id: string;
      label: string;
      titleEn?: string | null;
      titleEl?: string | null;
      priceDelta: number;
      priceDeltaCents: number;
    }>;
  }>;
  updatedAt?: string;
};

type CachedMenu = {
  payload: MenuPayload;
  ts: number;
  etag: string;
  lastModified: number;
};

const menuCache = new Map<string, CachedMenu>();
const MENU_TTL_MS = 5_000;

const collectUpdatedAt = (
  records: Array<{ updatedAt?: Date | null }> | undefined
) => {
  if (!records?.length) return 0;
  return records.reduce((max, record) => {
    const ts = record.updatedAt ? new Date(record.updatedAt).getTime() : 0;
    return Math.max(max, ts);
  }, 0);
};

const localize = (preferGreek: boolean, en?: string | null, el?: string | null, fallback?: string | null) =>
  preferGreek ? el || en || fallback || "" : en || el || fallback || "";

export async function getMenuPayload(store: Store, preferGreek: boolean) {
  const cacheKey = `${store.slug}:${preferGreek ? "el" : "en"}`;
  const now = Date.now();
  const cached = menuCache.get(cacheKey);
  if (cached && now - cached.ts < MENU_TTL_MS) {
    return cached;
  }

  const [categories, items, modifiers, itemModifiers] = await Promise.all([
    db.category.findMany({
      where: { storeId: store.id },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        slug: true,
        title: true,
        titleEn: true,
        titleEl: true,
        printerTopic: true,
        sortOrder: true,
        updatedAt: true,
      },
    }),
    db.item.findMany({
      where: { storeId: store.id, isAvailable: true },
      orderBy: { sortOrder: "asc" },
      include: {
        category: true,
      },
    }),
    db.modifier.findMany({
      where: { storeId: store.id },
      orderBy: { title: "asc" },
      include: {
        modifierOptions: {
          orderBy: { sortOrder: "asc" },
        },
      },
    }),
    db.itemModifier.findMany({
      where: { storeId: store.id },
    }),
  ]);

  const modifierMap = new Map(
    modifiers.map((modifier) => {
      const titleEn = modifier.titleEn || modifier.title || "";
      const titleEl = modifier.titleEl || modifier.title || "";
      const name = localize(preferGreek, titleEn, titleEl, modifier.title);
      return [
        modifier.id,
        {
          id: modifier.id,
          name,
          titleEn,
          titleEl,
          minSelect: modifier.minSelect,
          maxSelect: modifier.maxSelect,
          required: modifier.minSelect > 0,
          isAvailable: modifier.isAvailable,
          options: modifier.modifierOptions.map((option) => ({
            id: option.id,
            label: localize(preferGreek, option.titleEn, option.titleEl, option.title),
            titleEn: option.titleEn || option.title,
            titleEl: option.titleEl || option.title,
            priceDelta: option.priceDeltaCents / 100,
            priceDeltaCents: option.priceDeltaCents,
          })),
        },
      ];
    })
  );

  const itemModifiersByItem = itemModifiers.reduce<Record<string, typeof itemModifiers>>(
    (acc, link) => {
      acc[link.itemId] = acc[link.itemId] || [];
      acc[link.itemId].push(link);
      return acc;
    },
    {}
  );

  const itemsResponse = items.map((item) => {
    const categoryTitle = preferGreek
      ? item.category?.titleEl || item.category?.title || "Uncategorized"
      : item.category?.titleEn || item.category?.title || "Uncategorized";
    const titleEn = item.titleEn || item.title;
    const titleEl = item.titleEl || item.title;
    const descriptionEn = item.descriptionEn || item.description || "";
    const descriptionEl = item.descriptionEl || item.description || "";
    const name = localize(preferGreek, titleEn, titleEl, item.title);
    const modifiersForItem = [] as Array<{
      id: string;
      name: string;
      titleEn?: string;
      titleEl?: string;
      minSelect: number;
      maxSelect: number | null;
      required: boolean;
      options: Array<{ id: string; label: string; priceDelta: number; priceDeltaCents: number }>;
    }>;

    for (const link of itemModifiersByItem[item.id] || []) {
      const modifier = modifierMap.get(link.modifierId);
      if (!modifier) {
        continue;
      }
      if (modifier.isAvailable) {
        modifiersForItem.push({
          ...modifier,
          required: link.isRequired || modifier.minSelect > 0,
        });
      }
    }

    return {
      id: item.id,
      name,
      titleEn,
      titleEl,
      description: preferGreek ? descriptionEl || descriptionEn : descriptionEn || descriptionEl,
      descriptionEn,
      descriptionEl,
      price: item.priceCents / 100,
      priceCents: item.priceCents,
      image: item.imageUrl ?? `https://placehold.co/400x400?text=${encodeURIComponent(name)}`,
      imageUrl: item.imageUrl ?? null,
      category: categoryTitle,
      categoryId: item.categoryId,
      available: item.isAvailable,
      modifiers: modifiersForItem,
    };
  });

  const lastModified = Math.max(
    collectUpdatedAt(categories),
    collectUpdatedAt(items as unknown as Array<{ updatedAt?: Date | null }>),
    collectUpdatedAt(modifiers as unknown as Array<{ updatedAt?: Date | null }>),
    now
  );

  const payload: MenuPayload = {
    store: {
      id: store.id,
      slug: store.slug,
      name: store.name,
    },
    categories: categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      title: localize(preferGreek, category.titleEn, category.titleEl, category.title),
      titleEn: category.titleEn || category.title,
      titleEl: category.titleEl || category.title,
      sortOrder: category.sortOrder ?? undefined,
      printerTopic: category.printerTopic ?? null,
    })),
    items: itemsResponse,
    modifiers: Array.from(modifierMap.values()),
    updatedAt: new Date(lastModified).toISOString(),
  };

  const etag = buildEtag({ store: store.slug, updatedAt: payload.updatedAt });
  const result: CachedMenu = { payload, ts: now, etag, lastModified };
  menuCache.set(cacheKey, result);
  return result;
}

export function invalidateMenuCache() {
  menuCache.clear();
}
