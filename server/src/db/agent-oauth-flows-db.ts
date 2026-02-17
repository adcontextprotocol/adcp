/**
 * Database layer for agent OAuth pending flows.
 *
 * Persists pending flows in PostgreSQL so they survive server
 * restarts and work across multiple instances.
 * The PKCE code_verifier is encrypted at rest.
 */

import { query, isDatabaseInitialized } from './client.js';
import { encrypt, decrypt } from './encryption.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-oauth-flows-db');

export interface PendingOAuthFlow {
  agentContextId: string;
  organizationId: string;
  userId: string;
  codeVerifier: string;
  redirectUri: string;
  agentUrl: string;
  pendingRequest?: {
    task: string;
    params: Record<string, unknown>;
  };
}

// Internal stored representation (codeVerifier encrypted)
interface StoredPendingOAuthFlow {
  agentContextId: string;
  organizationId: string;
  userId: string;
  codeVerifier: string;
  codeVerifierIv: string;
  redirectUri: string;
  agentUrl: string;
  pendingRequest?: {
    task: string;
    params: Record<string, unknown>;
  };
}

function encryptFlowData(data: PendingOAuthFlow): StoredPendingOAuthFlow {
  const enc = encrypt(data.codeVerifier, data.organizationId);
  return {
    ...data,
    codeVerifier: enc.encrypted,
    codeVerifierIv: enc.iv,
  };
}

function decryptFlowData(stored: StoredPendingOAuthFlow): PendingOAuthFlow {
  const codeVerifier = decrypt(stored.codeVerifier, stored.codeVerifierIv, stored.organizationId);
  const { codeVerifierIv: _, ...rest } = stored;
  return { ...rest, codeVerifier };
}

const FLOW_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function setPendingFlow(
  state: string,
  data: PendingOAuthFlow,
): Promise<void> {
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS);
  const stored = encryptFlowData(data);
  try {
    await query(
      `INSERT INTO agent_oauth_pending_flows (state, data, expires_at)
       VALUES ($1, $2, $3)`,
      [state, JSON.stringify(stored), expiresAt],
    );
  } catch (err) {
    logger.error({ err, state }, 'Failed to store pending OAuth flow');
    throw err;
  }
}

/**
 * Atomically consume a pending flow (single-use).
 */
export async function consumePendingFlow(
  state: string,
): Promise<PendingOAuthFlow | undefined> {
  try {
    const result = await query<{ data: StoredPendingOAuthFlow }>(
      `DELETE FROM agent_oauth_pending_flows
       WHERE state = $1 AND expires_at > NOW()
       RETURNING data`,
      [state],
    );
    const stored = result.rows[0]?.data;
    if (!stored) return undefined;
    return decryptFlowData(stored);
  } catch (err) {
    logger.error({ err, state }, 'Failed to consume pending OAuth flow');
    throw err;
  }
}

export async function cleanupExpired(): Promise<number> {
  if (!isDatabaseInitialized()) return 0;
  try {
    const result = await query(
      `DELETE FROM agent_oauth_pending_flows WHERE expires_at <= NOW()`,
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      logger.info({ deleted: count }, 'Cleaned up expired agent OAuth flows');
    }
    return count;
  } catch (err) {
    logger.error({ err }, 'Failed to clean up expired agent OAuth flows');
    return 0;
  }
}
