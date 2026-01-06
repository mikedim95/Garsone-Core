import { db } from '../db/index.js';

export const STORE_SLUG = (process.env.STORE_SLUG || 'default-store').trim();

export type OrderingMode = 'qr' | 'waiter' | 'hybrid';
const DEFAULT_ORDERING_MODE: OrderingMode = 'qr';

const normalizeOrderingMode = (value?: unknown): OrderingMode => {
  if (value === 'waiter') return 'waiter';
  if (value === 'hybrid') return 'hybrid';
  return DEFAULT_ORDERING_MODE;
};

type CachedStore = {
  id: string;
  slug: string;
  name: string;
  settingsJson?: any;
  createdAt?: Date;
  updatedAt?: Date;
  orderingMode: OrderingMode;
  ts: number;
};
const storeCache = new Map<string, CachedStore>();
const STORE_CACHE_TTL_MS = 60_000; // 60s
export const invalidateStoreCache = (slug: string) => {
  if (!slug) return;
  storeCache.delete(slug);
};

export function getRequestedStoreSlug(request?: any): string | undefined {
  const raw =
    // Prefer authenticated user context to avoid stale client headers picking the wrong store
    (request as any)?.user?.storeSlug ||
    (request as any)?.storeSlug ||
    (request?.headers as any)?.['x-store-slug'] ||
    (request?.headers as any)?.['X-Store-Slug'] ||
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
    select: { id: true, slug: true, name: true, settingsJson: true, updatedAt: true, createdAt: true },
  });

  if (!store) {
    // Auto-bootstrap a minimal store so cloud deployments don't 500 when unseeded
    const created = await db.store.create({
      data: {
        slug,
        name: 'Garsone Offline Demo',
        settingsJson: { orderingMode: DEFAULT_ORDERING_MODE },
      },
      select: { id: true, slug: true, name: true, settingsJson: true, updatedAt: true, createdAt: true },
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

  const orderingMode = normalizeOrderingMode((store.settingsJson as any)?.orderingMode);

  storeCache.set(slug, { ...store, orderingMode, ts: now });
  return { ...store, orderingMode };
}

export const getOrderingMode = (store?: { settingsJson?: any; orderingMode?: OrderingMode }) =>
  normalizeOrderingMode((store as any)?.orderingMode || (store as any)?.settingsJson?.orderingMode);
