import { db } from '../db/index.js';

export const STORE_SLUG = process.env.STORE_SLUG || 'demo-cafe';

let cachedStore: { id: string; slug: string; name: string; settingsJson?: any } | null = null;
let lastFetch = 0;
const STORE_CACHE_TTL_MS = 60_000; // 60s

export async function ensureStore() {
  const now = Date.now();
  if (cachedStore && now - lastFetch < STORE_CACHE_TTL_MS) {
    return cachedStore;
  }

  let store = await db.store.findUnique({
    where: { slug: STORE_SLUG },
    select: { id: true, slug: true, name: true, settingsJson: true },
  });

  if (!store) {
    // Auto-bootstrap a minimal store so cloud deployments don't 500 when unseeded
    const created = await db.store.create({
      data: {
        slug: STORE_SLUG,
        name: 'Garsone Offline Demo',
        settingsJson: {},
      },
      select: { id: true, slug: true, name: true, settingsJson: true },
    });

    // Also create default meta if missing
    try {
      await db.storeMeta.create({
        data: {
          storeId: created.id,
          currencyCode: 'EUR',
          locale: 'en',
        },
      });
    } catch {}

    store = created;
  }

  cachedStore = store;
  lastFetch = now;
  return store;
}
