import crypto from 'node:crypto';
import { query, isDatabaseInitialized } from './client.js';
import { encrypt, decrypt } from './encryption.js';
import { createLogger } from '../logger.js';

const logger = createLogger('native-auth-state-db');

export const NATIVE_PENDING_TTL_MS = 10 * 60 * 1000;
export const NATIVE_GRANT_TTL_MS = 2 * 60 * 1000;

export interface NativePendingAuth {
  clientId: string;
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  workosCodeVerifier: string;
  issuer: string;
}

export interface NativeGrantUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

export interface NativeGrant {
  clientId: string;
  redirectUri: string;
  clientState: string;
  codeChallenge: string;
  issuer: string;
  sealedSession: string;
  user: NativeGrantUser;
}

interface StoredNativeGrant extends Omit<NativeGrant, 'sealedSession'> {
  sealedSessionEncrypted: string;
  sealedSessionIv: string;
}

interface StoredNativePendingAuth extends Omit<NativePendingAuth, 'workosCodeVerifier'> {
  workosCodeVerifierEncrypted: string;
  workosCodeVerifierIv: string;
}

function hashOpaqueValue(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function setPendingAuth(id: string, data: NativePendingAuth): Promise<void> {
  const idHash = hashOpaqueValue(id);
  const encrypted = encrypt(data.workosCodeVerifier, idHash);
  const stored: StoredNativePendingAuth = {
    clientId: data.clientId,
    redirectUri: data.redirectUri,
    clientState: data.clientState,
    codeChallenge: data.codeChallenge,
    issuer: data.issuer,
    workosCodeVerifierEncrypted: encrypted.encrypted,
    workosCodeVerifierIv: encrypted.iv,
  };
  await query(
    `INSERT INTO native_oauth_pending_auths (id_hash, data, expires_at)
     VALUES ($1, $2, $3)`,
    [idHash, JSON.stringify(stored), new Date(Date.now() + NATIVE_PENDING_TTL_MS)],
  );
}

export async function consumePendingAuth(id: string): Promise<NativePendingAuth | undefined> {
  const idHash = hashOpaqueValue(id);
  const result = await query<{ data: StoredNativePendingAuth }>(
    `DELETE FROM native_oauth_pending_auths
     WHERE id_hash = $1 AND expires_at > NOW()
     RETURNING data`,
    [idHash],
  );
  const stored = result.rows[0]?.data;
  if (!stored) return undefined;
  return {
    clientId: stored.clientId,
    redirectUri: stored.redirectUri,
    clientState: stored.clientState,
    codeChallenge: stored.codeChallenge,
    workosCodeVerifier: decrypt(
      stored.workosCodeVerifierEncrypted,
      stored.workosCodeVerifierIv,
      idHash,
    ),
    issuer: stored.issuer,
  };
}

export async function setGrant(code: string, data: NativeGrant): Promise<void> {
  const codeHash = hashOpaqueValue(code);
  const encrypted = encrypt(data.sealedSession, codeHash);
  const stored: StoredNativeGrant = {
    clientId: data.clientId,
    redirectUri: data.redirectUri,
    clientState: data.clientState,
    codeChallenge: data.codeChallenge,
    issuer: data.issuer,
    sealedSessionEncrypted: encrypted.encrypted,
    sealedSessionIv: encrypted.iv,
    user: data.user,
  };
  await query(
    `INSERT INTO native_oauth_grants (code_hash, data, expires_at)
     VALUES ($1, $2, $3)`,
    [codeHash, JSON.stringify(stored), new Date(Date.now() + NATIVE_GRANT_TTL_MS)],
  );
}

export async function consumeGrant(
  code: string,
  binding: Pick<NativeGrant, 'clientId' | 'redirectUri' | 'clientState' | 'codeChallenge'>,
): Promise<NativeGrant | undefined> {
  const codeHash = hashOpaqueValue(code);
  const result = await query<{ data: StoredNativeGrant }>(
    `DELETE FROM native_oauth_grants
     WHERE code_hash = $1
       AND expires_at > NOW()
       AND data->>'clientId' = $2
       AND data->>'redirectUri' = $3
       AND data->>'clientState' = $4
       AND data->>'codeChallenge' = $5
     RETURNING data`,
    [codeHash, binding.clientId, binding.redirectUri, binding.clientState, binding.codeChallenge],
  );
  const stored = result.rows[0]?.data;
  if (!stored) return undefined;
  return {
    clientId: stored.clientId,
    redirectUri: stored.redirectUri,
    clientState: stored.clientState,
    codeChallenge: stored.codeChallenge,
    issuer: stored.issuer,
    sealedSession: decrypt(stored.sealedSessionEncrypted, stored.sealedSessionIv, codeHash),
    user: stored.user,
  };
}

export async function cleanupExpired(): Promise<number> {
  if (!isDatabaseInitialized()) return 0;
  try {
    const pending = await query('DELETE FROM native_oauth_pending_auths WHERE expires_at <= NOW()');
    const grants = await query('DELETE FROM native_oauth_grants WHERE expires_at <= NOW()');
    return (pending.rowCount ?? 0) + (grants.rowCount ?? 0);
  } catch (error) {
    logger.warn({ error }, 'Native OAuth expiry cleanup failed');
    return 0;
  }
}
