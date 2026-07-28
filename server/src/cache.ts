interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class Cache<T> {
  private cache: Map<string, CacheEntry<T>> = new Map();
  private ttlMs: number;
  private maxEntries: number;

  constructor(ttlMinutes: number = 15, maxEntries: number = Number.POSITIVE_INFINITY) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    if (maxEntries <= 0) throw new Error('maxEntries must be greater than zero');
    this.maxEntries = maxEntries;
  }

  set(key: string, value: T): void {
    // Only a bounded cache needs this: it keeps expired entries from consuming
    // the entry budget and evicting a live one. An unbounded cache never
    // evicts, so scanning the whole map on every write would be pure cost —
    // `get` expires entries lazily instead.
    if (Number.isFinite(this.maxEntries)) this.pruneExpired();
    // Refresh insertion order on overwrite so finite caches evict the least
    // recently written/read entry rather than a hot key.
    this.cache.delete(key);
    while (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    if (Number.isFinite(this.maxEntries)) {
      this.cache.delete(key);
      this.cache.set(key, entry);
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    this.pruneExpired();
    return this.cache.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}
