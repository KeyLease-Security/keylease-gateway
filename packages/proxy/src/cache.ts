/**
 * Small in-memory TTL cache with LRU eviction.
 *
 * Used by the verifier to remember on-chain lease state for a short window so
 * a hot proxy path does not hammer Soroban RPC. Values are only cached on
 * success; failures always fall through to the provider.
 */
export interface TtlCacheOptions {
  /** Default time-to-live in milliseconds. Defaults to 30 seconds. */
  ttlMs?: number;
  /** Maximum number of live entries. Defaults to 1000. */
  maxEntries?: number;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  clock?: () => number;
}

export interface TtlCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export const DEFAULT_TTL_MS = 30_000;
export const DEFAULT_MAX_ENTRIES = 1_000;

export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly clock: () => number;
  private readonly counters: TtlCacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    expirations: 0,
  };

  constructor(options: TtlCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.clock = options.clock ?? Date.now;
    if (this.ttlMs <= 0) throw new RangeError('ttlMs must be positive');
    if (this.maxEntries <= 0) throw new RangeError('maxEntries must be positive');
  }

  /** Returns a live value, refreshing its recency. Expired entries vanish. */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) {
      this.counters.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this.store.delete(key);
      this.counters.expirations += 1;
      this.counters.misses += 1;
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.store.delete(key);
    this.store.set(key, entry);
    this.counters.hits += 1;
    return entry.value;
  }

  /** Stores a value for `ttlMs` (or the cache default). */
  set(key: string, value: V, ttlMs: number = this.ttlMs): void {
    if (ttlMs <= 0) return;
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.clock() + ttlMs });
    this.evictOverflow();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    this.prune();
    return this.store.size;
  }

  stats(): TtlCacheStats {
    return { ...this.counters };
  }

  resetStats(): void {
    this.counters.hits = 0;
    this.counters.misses = 0;
    this.counters.evictions = 0;
    this.counters.expirations = 0;
  }

  /** Drops every expired entry. */
  private prune(): void {
    const now = this.clock();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        this.counters.expirations += 1;
      }
    }
  }

  private evictOverflow(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
      this.counters.evictions += 1;
    }
  }
}
