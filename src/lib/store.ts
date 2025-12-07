import { db } from '../db/index.js';

export const STORE_SLUG = (process.env.STORE_SLUG || 'default-store').trim();

type CachedStore = { id: string; slug: string; name: string; settingsJson?: any; ts: number };
const storeCache = new Map<string, CachedStore>();
const STORE_CACHE_TTL_MS = 60_000; // 60s

export function getRequestedStoreSlug(request?: any): string | undefined {
  const raw =
    (request?.headers as any)?.['x-store-slug'] ||
    (request?.headers as any)?.['X-Store-Slug'] ||
    (request as any)?.storeSlug ||
    (request as any)?.user?.storeSlug ||
    undefined;
  if (typeof raw !== 'string') return undefined;
  const slug = raw.trim();
  return slug.length > 0 ? slug : undefined;
}

const deriveSlug = (maybeRequestOrSlug?: string | any) => {
  if (typeof maybeRequestOrSlug === 'string') {
    return maybeRequestOrSlug;
  }
  const request = maybeRequestOrSlug;
  const slugFromRequest = getRequestedStoreSlug(request);
  return slugFromRequest || STORE_SLUG;
};

export async function ensureStore(slugOrRequest?: string | any) {
  const slug = (deriveSlug(slugOrRequest) || STORE_SLUG || '').trim() || STORE_SLUG;
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
