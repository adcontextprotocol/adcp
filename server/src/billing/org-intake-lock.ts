/**
 * Postgres advisory-lock helper that serializes billing intakes for a single
 * organization across all paths that mint a Stripe subscription/invoice.
 *
 * Without this, two concurrent requests can both pass `blockIfActiveSubscription`
 * (the read-then-write race the security review of #3171 flagged) and create
 * two subscriptions on the same Stripe customer — the same shape as the
 * months-apart Triton bug, just compressed to milliseconds.
 *
 * `pg_advisory_xact_lock(hashtext(orgId))` blocks any other transaction that
 * tries to acquire the same key until this transaction commits or rolls back.
 * Lock release is automatic on transaction end, so we don't have to track
 * release manually.
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('org-intake-lock');

/**
 * Hard caps on lock acquisition + statement execution inside the locked
 * transaction. Without these, a stuck Stripe call (network blip, slow
 * webhook hop) parks a pool connection indefinitely and queues every other
 * intake for the same org behind it.
 *
 * - lock_timeout: how long the inner `pg_advisory_xact_lock` may wait for
 *   another transaction to release the same key. After this, PG raises an
 *   error and we roll back; the caller surfaces a 500 and the user retries.
 * - statement_timeout: ceiling for any single statement inside the
 *   transaction. Stripe's slowest p99 invoice/subscription create is well
 *   under 30s; this is a safety net, not a performance budget.
 */
const LOCK_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Run `fn` while holding a transaction-scoped advisory lock keyed on the
 * organization id. Other concurrent calls for the same org wait until this
 * one's transaction commits or rolls back; calls for different orgs don't
 * contend. Lock release is automatic when the transaction ends.
 *
 * The lock serializes serialization of `getSubscriptionInfo` reads against
 * subsequent Stripe writes — `getSubscriptionInfo` queries Stripe live, so
 * by the time the second caller's guard runs, the first caller's
 * subscription is already visible in Stripe and the guard correctly blocks.
 *
 * The callback does not need to use the locked client; the lock is held by
 * this connection alone, but serialization is enforced regardless of which
 * connection the caller's other queries use.
 */
export async function withOrgIntakeLock<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client: PoolClient = await getPool().connect();
  try {
    try {
      await client.query('BEGIN');
      // Per-transaction timeouts: prevents a stuck Stripe call from parking
      // this connection indefinitely and queueing other same-org intakes.
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orgId]);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // Best-effort rollback. If ROLLBACK itself fails it usually means the
      // connection dropped mid-transaction — log so we know about it (the
      // pool client auto-discards dead connections, so no leak), but
      // surface the original error rather than the rollback failure.
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.warn(
          { err: rollbackErr, orgId, originalErr: err instanceof Error ? err.message : String(err) },
          'ROLLBACK failed inside withOrgIntakeLock — connection likely dropped',
        );
      }
      throw err;
    }
  } finally {
    client.release();
  }
}
