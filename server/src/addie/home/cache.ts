/**
 * Home Content Cache
 *
 * Per-user TTL cache for Addie Home content.
 * Short TTL (5 min) since member context already has its own 30-min cache.
 */

import type { HomeContent } from './types.js';

interface CacheEntry {
  data: HomeContent;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_SIZE = 500;

export class HomeContentCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;
  private maxSize: number;

  constructor(options?: { ttlMs?: number; maxSize?: number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
  }

  /**
   * Get cached content if still valid
   */
  get(userId: string): HomeContent | null {
    const entry = this.cache.get(userId);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(userId);
      return null;
    }

    return entry.data;
  }

  /**
   * Cache content for a user
   */
  set(userId: string, content: HomeContent): void {
    // LRU eviction if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(userId, {
      data: content,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Invalidate cache for a specific user
   */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /**
   * Clear all cached content
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (for monitoring)
   */
  get size(): number {
    return this.cache.size;
  }
}

// Singleton instance
let homeContentCache: HomeContentCache | null = null;

export function getHomeContentCache(): HomeContentCache {
  if (!homeContentCache) {
    homeContentCache = new HomeContentCache();
  }
  return homeContentCache;
}

/**
 * Invalidate home content cache for a user
 * Call this when user data changes (profile update, join working group, etc.)
 */
export function invalidateHomeCache(userId?: string): void {
  if (!homeContentCache) return;

  if (userId) {
    homeContentCache.invalidate(userId);
  } else {
    homeContentCache.clear();
  }
}
