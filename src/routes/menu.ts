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
        modifiers.map((modifier) => [
          modifier.id,
          {
            id: modifier.id,
            name: modifier.title,
            minSelect: modifier.minSelect,
            maxSelect: modifier.maxSelect,
            required: modifier.minSelect > 0,
            options: modifier.modifierOptions.map((option) => ({
              id: option.id,
              label: option.title,
              priceDelta: option.priceDeltaCents / 100,
              priceDeltaCents: option.priceDeltaCents,
            })),
          },
        ])
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
        const categoryTitle = item.category?.title ?? "Uncategorized";
        const modifiersForItem = [] as Array<{
          id: string;
          name: string;
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
          modifiersForItem.push({
            ...modifier,
            required: link.isRequired || modifier.minSelect > 0,
          });
        }

        return {
          id: item.id,
          name: item.title,
          description: item.description ?? "",
          price: item.priceCents / 100,
          priceCents: item.priceCents,
          image: item.imageUrl ?? `https://placehold.co/400x400?text=${encodeURIComponent(item.title)}`,
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
          title: category.title,
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
