type Entry<T> = { value: T; ts: number };

type Options = { max?: number; ttlMs?: number };

export function createLruCache<T>(opts: Options = {}) {
  const max = Math.max(1, opts.max ?? 50);
  const ttlMs = Math.max(0, opts.ttlMs ?? 60_000);
  const map = new Map<string, Entry<T>>();

  const isExpired = (entry: Entry<T>) =>
    ttlMs > 0 && Date.now() - entry.ts > ttlMs;

  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        map.delete(key);
        return undefined;
      }
      map.delete(key);
      map.set(key, { ...entry, ts: Date.now() });
      return entry.value;
    },
    set(key: string, value: T) {
      if (map.size >= max) {
        const oldestKey = map.keys().next().value;
        if (oldestKey) map.delete(oldestKey);
      }
      map.set(key, { value, ts: Date.now() });
    },
    clear() {
      map.clear();
    },
  };
}
