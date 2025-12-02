import { FastifyInstance } from "fastify";
import { db } from "../db/index.js";
import { ensureStore } from "../lib/store.js";

// naive in-memory cache with TTL
let cachedMenu: any | null = null;
let cachedMenuTs = 0;
// Keep TTL short so manager changes reflect quickly
const MENU_TTL_MS = 5_000; // 5s

export function invalidateMenuCache() {
  cachedMenu = null;
  cachedMenuTs = 0;
}

export async function menuRoutes(fastify: FastifyInstance) {
  fastify.get("/menu", async (request, reply) => {
    try {
      const acceptLang = (request.headers["accept-language"] || "").toString().toLowerCase();
      const preferGreek = acceptLang.includes("el");
      const now = Date.now();
      if (cachedMenu && now - cachedMenuTs < MENU_TTL_MS) {
        return reply.send(cachedMenu);
      }
      const store = await ensureStore();

      const [categories, items, modifiers, itemModifiers] = await Promise.all([
        db.category.findMany({
          where: { storeId: store.id },
          orderBy: { sortOrder: "asc" },
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
          const name = preferGreek ? titleEl || titleEn : titleEn || titleEl;
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
                label: preferGreek
                  ? option.titleEl || option.titleEn || option.title
                  : option.titleEn || option.titleEl || option.title,
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
        const name = preferGreek ? titleEl || titleEn : titleEn || titleEl;
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

      const payload = {
        store: {
          id: store.id,
          slug: store.slug,
          name: store.name,
        },
        categories: categories.map((category) => ({
          id: category.id,
          slug: category.slug,
          title: preferGreek ? category.titleEl || category.titleEn || category.title : category.titleEn || category.titleEl || category.title,
          titleEn: category.titleEn || category.title,
          titleEl: category.titleEl || category.title,
          sortOrder: category.sortOrder,
        })),
        items: itemsResponse,
        modifiers: Array.from(modifierMap.values()),
      };
      cachedMenu = payload;
      cachedMenuTs = now;
      return reply.send(payload);
    } catch (error) {
      console.error("Menu fetch error:", error);
      return reply.status(500).send({ error: "Failed to fetch menu" });
    }
  });
}
