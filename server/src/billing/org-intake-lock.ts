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
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [orgId]);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // Best-effort rollback; if it fails, surface the original error.
      try {
        await client.query('ROLLBACK');
      } catch {
        // intentionally swallowed — we re-throw `err` below
      }
      throw err;
    }
  } finally {
    client.release();
  }
}
