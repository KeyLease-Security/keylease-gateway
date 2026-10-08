import { describe, expect, it } from 'vitest';
import { DEFAULT_TTL_MS, TtlCache } from './cache.js';

describe('TtlCache', () => {
  it('returns values inside the TTL window', () => {
    let now = 0;
    const cache = new TtlCache<number>({ ttlMs: 1_000, clock: () => now });

    cache.set('a', 1);
    now = 999;
    expect(cache.get('a')).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('expires values once the TTL elapses', () => {
    let now = 0;
    const cache = new TtlCache<number>({ ttlMs: 1_000, clock: () => now });

    cache.set('a', 1);
    now = 1_000;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.stats().expirations).toBe(1);
  });

  it('honours a per-entry ttl override', () => {
    let now = 0;
    const cache = new TtlCache<string>({ ttlMs: 10_000, clock: () => now });

    cache.set('short', 'value', 100);
    now = 50;
    expect(cache.get('short')).toBe('value');
    now = 100;
    expect(cache.get('short')).toBeUndefined();
  });

  it('does not store entries with a non-positive ttl', () => {
    const cache = new TtlCache<string>({ ttlMs: 1_000, clock: () => 0 });
    cache.set('a', 'value', 0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('tracks hits and misses', () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000, clock: () => 0 });
    cache.set('a', 1);
    cache.get('a');
    cache.get('a');
    cache.get('b');

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);

    cache.resetStats();
    expect(cache.stats()).toEqual({ hits: 0, misses: 0, evictions: 0, expirations: 0 });
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000, maxEntries: 2, clock: () => 0 });

    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1); // refresh 'a' so 'b' becomes the oldest
    cache.set('c', 3);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
    expect(cache.stats().evictions).toBe(1);
  });

  it('supports delete, clear and has', () => {
    const cache = new TtlCache<number>({ ttlMs: 1_000, clock: () => 0 });
    cache.set('a', 1);
    expect(cache.has('a')).toBe(true);
    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);

    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('rejects invalid options', () => {
    expect(() => new TtlCache({ ttlMs: 0 })).toThrow(RangeError);
    expect(() => new TtlCache({ maxEntries: 0 })).toThrow(RangeError);
  });

  it('uses a 30s default TTL', () => {
    expect(DEFAULT_TTL_MS).toBe(30_000);
    let now = 0;
    const cache = new TtlCache<number>({ clock: () => now });
    cache.set('a', 1);
    now = 29_999;
    expect(cache.get('a')).toBe(1);
    now = 30_000;
    expect(cache.get('a')).toBeUndefined();
  });
});
