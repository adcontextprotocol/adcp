import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('newsletter-send-lock');

export type NewsletterSendLockResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/**
 * Serialize delivery for one newsletter edition across web and worker
 * processes. The caller must re-read the edition while holding the lock so a
 * stale approved snapshot cannot be delivered after another sender finishes.
 */
export async function withNewsletterSendLock<T>(
  newsletterId: string,
  editionId: number,
  work: () => Promise<T>,
): Promise<NewsletterSendLockResult<T>> {
  const client: PoolClient = await getPool().connect();
  const lockKey = `newsletter-send:${newsletterId}:${editionId}`;
  let acquired = false;
  let destroyClient = false;

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [lockKey],
    );
    acquired = lockResult.rows[0]?.acquired === true;
    if (!acquired) return { acquired: false };

    return { acquired: true, value: await work() };
  } finally {
    if (acquired) {
      try {
        const unlockResult = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
          [lockKey],
        );
        if (unlockResult.rows[0]?.unlocked !== true) {
          destroyClient = true;
          logger.warn(
            { newsletterId, editionId },
            'Newsletter send lock was not released; discarding pooled connection',
          );
        }
      } catch (error) {
        destroyClient = true;
        logger.warn(
          { error, newsletterId, editionId },
          'Failed to release newsletter send lock; discarding pooled connection',
        );
      }
    }
    client.release(destroyClient);
  }
}
