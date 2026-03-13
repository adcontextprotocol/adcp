/**
 * Database layer for cross-machine session refresh sharing.
 *
 * WorkOS refresh tokens are single-use. When two Fly.io machines both try
 * to refresh the same expired session, only one succeeds. The winner stores
 * the new sealed session here so the loser can retrieve it instead of
 * logging the user out.
 */

import { query, isDatabaseInitialized } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('session-refresh-db');

const REFRESH_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for the browser to pick up the new cookie

/**
 * Store a refreshed session keyed by the hash of the old cookie.
 */
export async function storeRefreshedSession(
  oldCookieHash: string,
  newSealedSession: string,
): Promise<void> {
  if (!isDatabaseInitialized()) return;
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  try {
    await query(
      `INSERT INTO session_refreshes (old_cookie_hash, new_sealed_session, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (old_cookie_hash) DO UPDATE SET
         new_sealed_session = EXCLUDED.new_sealed_session,
         expires_at = EXCLUDED.expires_at`,
      [oldCookieHash, newSealedSession, expiresAt],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to store refreshed session');
  }
}

/**
 * Look up a refreshed session by the hash of the old cookie.
 * Returns the new sealed session if found and not expired, undefined otherwise.
 */
export async function getRefreshedSession(
  oldCookieHash: string,
): Promise<string | undefined> {
  if (!isDatabaseInitialized()) return undefined;
  try {
    const result = await query(
      `SELECT new_sealed_session FROM session_refreshes
       WHERE old_cookie_hash = $1 AND expires_at > NOW()`,
      [oldCookieHash],
    );
    if (result.rows.length > 0) {
      return result.rows[0].new_sealed_session;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to look up refreshed session');
  }
  return undefined;
}

/**
 * Clean up expired entries. Called periodically.
 */
export async function cleanExpiredRefreshes(): Promise<number> {
  if (!isDatabaseInitialized()) return 0;
  try {
    const result = await query(
      `DELETE FROM session_refreshes WHERE expires_at < NOW()`,
    );
    return result.rowCount ?? 0;
  } catch (err) {
    logger.warn({ err }, 'Failed to clean expired session refreshes');
    return 0;
  }
}
