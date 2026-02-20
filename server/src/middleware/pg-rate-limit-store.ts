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
      logger.error({ err }, 'Failed to clean up expired rate limit hits');
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
      logger.error({ err, key: prefixedKey }, 'Rate limit increment failed');
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
      logger.error({ err, key: prefixedKey }, 'Rate limit decrement failed');
    }
  }

  async resetKey(key: string): Promise<void> {
    if (!isDatabaseInitialized()) return;
    const prefixedKey = this.prefix + key;
    try {
      await query(`DELETE FROM rate_limit_hits WHERE key = $1`, [prefixedKey]);
    } catch (err) {
      logger.error({ err, key: prefixedKey }, 'Rate limit resetKey failed');
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
      logger.error({ err }, 'Rate limit resetAll failed');
    }
  }
}
