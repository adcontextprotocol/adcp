/**
 * PostgreSQL-backed store for express-rate-limit.
 *
 * Shares rate limit counters across application instances via the
 * `rate_limit_hits` table. Each rate limiter instance uses a prefix
 * for namespace isolation.
 */

import type { Store, Options, IncrementResponse } from 'express-rate-limit';
import { query, isDatabaseInitialized } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('pg-rate-limit');

// Periodic cleanup of expired rows (runs once, shared across all stores)
let cleanupStarted = false;
function startCleanup(): void {
  if (cleanupStarted) return;
  cleanupStarted = true;
  const timer = setInterval(async () => {
    if (!isDatabaseInitialized()) return;
    try {
      await query(`DELETE FROM rate_limit_hits WHERE reset_at <= NOW()`);
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up expired rate limit hits');
    }
  }, 5 * 60 * 1000); // every 5 minutes
  timer.unref();
}

export class PostgresStore implements Store {
  private windowMs = 60_000;
  prefix: string;

  constructor(prefix = '') {
    this.prefix = prefix;
    startCleanup();
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (!isDatabaseInitialized()) {
      // Permit requests if DB not yet ready (startup window)
      return { totalHits: 0, resetTime: undefined };
    }

    const prefixedKey = this.prefix + key;

    try {
      const result = await query<{ hits: number; reset_at: Date }>(
        `INSERT INTO rate_limit_hits (key, hits, reset_at)
         VALUES ($1, 1, NOW() + interval '1 millisecond' * $2::integer)
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE
             WHEN rate_limit_hits.reset_at <= NOW() THEN 1
             ELSE rate_limit_hits.hits + 1
           END,
           reset_at = CASE
             WHEN rate_limit_hits.reset_at <= NOW()
             THEN NOW() + interval '1 millisecond' * $2::integer
             ELSE rate_limit_hits.reset_at
           END
         RETURNING hits, reset_at`,
        [prefixedKey, this.windowMs],
      );

      const row = result.rows[0];
      return {
        totalHits: row.hits,
        resetTime: row.reset_at,
      };
    } catch (err) {
      logger.warn({ err, key: prefixedKey }, 'Rate limit increment failed — rate limiting disabled for this request');
      // Permit on error to avoid blocking requests due to DB issues
      return { totalHits: 0, resetTime: undefined };
    }
  }

  async decrement(key: string): Promise<void> {
    if (!isDatabaseInitialized()) return;
    const prefixedKey = this.prefix + key;
    try {
      await query(
        `UPDATE rate_limit_hits
         SET hits = GREATEST(hits - 1, 0)
         WHERE key = $1 AND reset_at > NOW()`,
        [prefixedKey],
      );
    } catch (err) {
      logger.warn({ err, key: prefixedKey }, 'Rate limit decrement failed');
    }
  }

  async resetKey(key: string): Promise<void> {
    if (!isDatabaseInitialized()) return;
    const prefixedKey = this.prefix + key;
    try {
      await query(`DELETE FROM rate_limit_hits WHERE key = $1`, [prefixedKey]);
    } catch (err) {
      logger.warn({ err, key: prefixedKey }, 'Rate limit resetKey failed');
    }
  }

  async resetAll(): Promise<void> {
    if (!isDatabaseInitialized()) return;
    try {
      if (this.prefix) {
        await query(`DELETE FROM rate_limit_hits WHERE key LIKE $1`, [this.prefix + '%']);
      } else {
        await query(`DELETE FROM rate_limit_hits`);
      }
    } catch (err) {
      logger.warn({ err }, 'Rate limit resetAll failed');
    }
  }
}

interface CachedEntry {
  hits: number;
  resetTime: Date;
}

/**
 * Rate limit store that increments in-memory for fast responses and
 * periodically syncs to/from Postgres so counters are shared across pods.
 *
 * This avoids a DB round-trip on every request while still enforcing
 * approximate cross-pod limits.
 */
export class CachedPostgresStore implements Store {
  private windowMs = 60_000;
  prefix: string;
  private cache = new Map<string, CachedEntry>();
  private dirty = new Set<string>();
  private syncIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(prefix = '', syncIntervalMs = 15_000) {
    this.prefix = prefix;
    this.syncIntervalMs = syncIntervalMs;
    startCleanup();
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.flushTimer = setInterval(() => this.flush(), this.syncIntervalMs);
    this.flushTimer.unref();
  }

  async increment(key: string): Promise<IncrementResponse> {
    const prefixedKey = this.prefix + key;
    const now = new Date();
    let entry = this.cache.get(prefixedKey);

    if (!entry || entry.resetTime <= now) {
      entry = { hits: 0, resetTime: new Date(now.getTime() + this.windowMs) };
    }

    entry.hits += 1;
    this.cache.set(prefixedKey, entry);
    this.dirty.add(prefixedKey);

    return { totalHits: entry.hits, resetTime: entry.resetTime };
  }

  async decrement(key: string): Promise<void> {
    const prefixedKey = this.prefix + key;
    const entry = this.cache.get(prefixedKey);
    if (entry && entry.hits > 0) {
      entry.hits -= 1;
      this.dirty.add(prefixedKey);
    }
  }

  async resetKey(key: string): Promise<void> {
    const prefixedKey = this.prefix + key;
    this.cache.delete(prefixedKey);
    this.dirty.delete(prefixedKey);
    if (!isDatabaseInitialized()) return;
    try {
      await query(`DELETE FROM rate_limit_hits WHERE key = $1`, [prefixedKey]);
    } catch (err) {
      logger.warn({ err, key: prefixedKey }, 'CachedPostgresStore resetKey failed');
    }
  }

  async resetAll(): Promise<void> {
    this.cache.clear();
    this.dirty.clear();
    if (!isDatabaseInitialized()) return;
    try {
      if (this.prefix) {
        await query(`DELETE FROM rate_limit_hits WHERE key LIKE $1`, [this.prefix + '%']);
      } else {
        await query(`DELETE FROM rate_limit_hits`);
      }
    } catch (err) {
      logger.warn({ err }, 'CachedPostgresStore resetAll failed');
    }
  }

  /** Flush dirty keys to Postgres and pull back the merged totals. */
  private async flush(): Promise<void> {
    if (!isDatabaseInitialized() || this.dirty.size === 0) return;

    const keys = [...this.dirty];
    this.dirty.clear();

    for (const prefixedKey of keys) {
      const entry = this.cache.get(prefixedKey);
      if (!entry) continue;

      try {
        const result = await query<{ hits: number; reset_at: Date }>(
          `INSERT INTO rate_limit_hits (key, hits, reset_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET
             hits = CASE
               WHEN rate_limit_hits.reset_at <= NOW() THEN $2
               ELSE GREATEST(rate_limit_hits.hits, $2)
             END,
             reset_at = CASE
               WHEN rate_limit_hits.reset_at <= NOW() THEN $3
               ELSE rate_limit_hits.reset_at
             END
           RETURNING hits, reset_at`,
          [prefixedKey, entry.hits, entry.resetTime],
        );

        const row = result.rows[0];
        // Adopt the merged value (picks up increments from other pods)
        this.cache.set(prefixedKey, { hits: row.hits, resetTime: row.reset_at });
      } catch (err) {
        logger.warn({ err, key: prefixedKey }, 'CachedPostgresStore flush failed');
        // Re-mark dirty so we retry next cycle
        this.dirty.add(prefixedKey);
      }
    }

    // Prune expired entries from local cache
    const now = new Date();
    for (const [k, v] of this.cache) {
      if (v.resetTime <= now) this.cache.delete(k);
    }
  }
}
