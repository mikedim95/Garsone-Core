import { db } from '../db/index.js';

export const STORE_SLUG = process.env.STORE_SLUG || 'demo-cafe';

type CachedStore = { id: string; slug: string; name: string; settingsJson?: any; ts: number };
const storeCache = new Map<string, CachedStore>();
const STORE_CACHE_TTL_MS = 60_000; // 60s

export function getRequestedStoreSlug(request?: any): string | undefined {
  const raw =
    (request?.headers as any)?.['x-store-slug'] ||
    (request?.headers as any)?.['X-Store-Slug'] ||
    (request as any)?.storeSlug ||
    undefined;
  if (typeof raw !== 'string') return undefined;
  const slug = raw.trim();
  return slug.length > 0 ? slug : undefined;
}

export async function ensureStore(slugOverride?: string) {
  const slug = (slugOverride || STORE_SLUG || '').trim() || STORE_SLUG;
  const now = Date.now();
  const cached = storeCache.get(slug);
  if (cached && now - cached.ts < STORE_CACHE_TTL_MS) {
    return cached;
  }

  let store = await db.store.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, settingsJson: true },
  });

  if (!store) {
    // Auto-bootstrap a minimal store so cloud deployments don't 500 when unseeded
    const created = await db.store.create({
      data: {
        slug,
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

  storeCache.set(slug, { ...store, ts: now });
  return store;
}
