/**
 * Database layer for MCP OAuth transient state
 *
 * Persists pending authorizations and authorization codes in PostgreSQL
 * so they survive server restarts and work across multiple instances.
 * Auth code token fields are encrypted at rest.
 */

import { query, isDatabaseInitialized } from './client.js';
import { encrypt, decrypt } from './encryption.js';
import { createLogger } from '../logger.js';

const logger = createLogger('mcp-oauth-state-db');


// ---------------------------------------------------------------------------
// Pending authorizations
// ---------------------------------------------------------------------------

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string; // URL serialized as string
}

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function setPendingAuth(
  id: string,
  data: PendingAuth,
): Promise<void> {
  const expiresAt = new Date(Date.now() + PENDING_AUTH_TTL_MS);
  try {
    await query(
      `INSERT INTO mcp_oauth_pending_auths (id, data, expires_at)
       VALUES ($1, $2, $3)`,
      [id, JSON.stringify(data), expiresAt],
    );
  } catch (err) {
    logger.error({ err, id }, 'Failed to store pending auth');
    throw err;
  }
}

/**
 * Atomically consume a pending auth (single-use).
 * Returns the data if found and not expired, undefined otherwise.
 */
export async function consumePendingAuth(
  id: string,
): Promise<PendingAuth | undefined> {
  try {
    const result = await query<{ data: PendingAuth }>(
      `DELETE FROM mcp_oauth_pending_auths
       WHERE id = $1 AND expires_at > NOW()
       RETURNING data`,
      [id],
    );
    return result.rows[0]?.data ?? undefined;
  } catch (err) {
    logger.error({ err, id }, 'Failed to consume pending auth');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export interface AuthCodeData {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string;
}

// Internal representation stored in JSONB (tokens encrypted)
interface StoredAuthCodeData {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  accessToken: string;
  accessTokenIv: string;
  refreshToken: string;
  refreshTokenIv: string;
}

function encryptAuthCodeData(data: AuthCodeData): StoredAuthCodeData {
  const salt = data.clientId; // Per-client key isolation
  const encAccess = encrypt(data.accessToken, salt);
  const encRefresh = encrypt(data.refreshToken, salt);
  return {
    clientId: data.clientId,
    codeChallenge: data.codeChallenge,
    redirectUri: data.redirectUri,
    accessToken: encAccess.encrypted,
    accessTokenIv: encAccess.iv,
    refreshToken: encRefresh.encrypted,
    refreshTokenIv: encRefresh.iv,
  };
}

function decryptAuthCodeData(stored: StoredAuthCodeData): AuthCodeData {
  const salt = stored.clientId;
  return {
    clientId: stored.clientId,
    codeChallenge: stored.codeChallenge,
    redirectUri: stored.redirectUri,
    accessToken: decrypt(stored.accessToken, stored.accessTokenIv, salt),
    refreshToken: decrypt(stored.refreshToken, stored.refreshTokenIv, salt),
  };
}

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function setAuthCode(
  code: string,
  data: AuthCodeData,
): Promise<void> {
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_MS);
  const stored = encryptAuthCodeData(data);
  try {
    await query(
      `INSERT INTO mcp_oauth_auth_codes (code, data, expires_at)
       VALUES ($1, $2, $3)`,
      [code, JSON.stringify(stored), expiresAt],
    );
  } catch (err) {
    logger.error({ err, codePrefix: code.slice(0, 8) }, 'Failed to store auth code');
    throw err;
  }
}

export async function getAuthCode(
  code: string,
): Promise<AuthCodeData | undefined> {
  try {
    const result = await query<{ data: StoredAuthCodeData }>(
      `SELECT data FROM mcp_oauth_auth_codes WHERE code = $1 AND expires_at > NOW()`,
      [code],
    );
    const stored = result.rows[0]?.data;
    if (!stored) return undefined;
    return decryptAuthCodeData(stored);
  } catch (err) {
    logger.error({ err, codePrefix: code.slice(0, 8) }, 'Failed to look up auth code');
    throw err;
  }
}

/**
 * Atomically consume an auth code (single-use).
 * Returns the data if found and not expired, undefined otherwise.
 */
export async function consumeAuthCode(
  code: string,
): Promise<AuthCodeData | undefined> {
  try {
    const result = await query<{ data: StoredAuthCodeData }>(
      `DELETE FROM mcp_oauth_auth_codes
       WHERE code = $1 AND expires_at > NOW()
       RETURNING data`,
      [code],
    );
    const stored = result.rows[0]?.data;
    if (!stored) return undefined;
    return decryptAuthCodeData(stored);
  } catch (err) {
    logger.error({ err, codePrefix: code.slice(0, 8) }, 'Failed to consume auth code');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cleanup expired rows (call periodically)
// ---------------------------------------------------------------------------

export async function cleanupExpired(): Promise<number> {
  if (!isDatabaseInitialized()) return 0;
  try {
    const r1 = await query(
      `DELETE FROM mcp_oauth_pending_auths WHERE expires_at <= NOW()`,
    );
    const r2 = await query(
      `DELETE FROM mcp_oauth_auth_codes WHERE expires_at <= NOW()`,
    );
    const total = (r1.rowCount ?? 0) + (r2.rowCount ?? 0);
    if (total > 0) {
      logger.info({ deleted: total }, 'Cleaned up expired MCP OAuth state');
    }
    return total;
  } catch (err) {
    logger.error({ err }, 'Failed to clean up expired MCP OAuth state');
    return 0;
  }
}
