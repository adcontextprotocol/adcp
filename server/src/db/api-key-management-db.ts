import type { PoolClient, QueryConfig, QueryResultRow } from 'pg';
import { getPool, queryWithTimeout } from './client.js';
import {
  AuthorizationSnapshotUnavailableError,
  sameAuthorizationIdentity,
  type AuthorizationSnapshot,
} from './user-authorization-snapshot-db.js';

const AUTHORIZATION_TIMEOUT_MS = 2_000;
const FENCE_TIMEOUT_MS = 15_000;

// pg supports per-query read deadlines; @types/pg declares this option only on
// ClientConfig. Preserve the runtime option without weakening query result types.
type BoundedQueryConfig = QueryConfig & { query_timeout: number };

// Secret management never reads grants, including during authentication. Keep
// this projection separate from the grant-aware snapshot used by other routes.
const SNAPSHOT_SQL = `
  SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
         credential.workos_user_id AS authenticated_user_id,
         primary_binding.workos_user_id AS canonical_user_id, binding.identity_id,
         binding.xmin::text AS binding_version,
         COALESCE(primary_binding.primary_count, 0)::text AS primary_count,
         EXISTS (
           SELECT 1 FROM registry_audit_log audit
            WHERE audit.workos_user_id = $1
              AND audit.action IN (
                'identity_credential_deleted', 'identity_primary_deletion_quarantined'
              )
         ) AS terminal_marker,
         COALESCE(epoch.epoch, 0)::text AS authorization_epoch,
         credential.email, credential.email_verified, credential.first_name, credential.last_name
    FROM (VALUES (1)) AS anchor(value)
    LEFT JOIN users credential ON credential.workos_user_id = $1
    LEFT JOIN identity_workos_users binding ON binding.workos_user_id = credential.workos_user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS primary_count, MIN(candidate.workos_user_id) AS workos_user_id
        FROM identity_workos_users candidate
       WHERE candidate.identity_id = binding.identity_id AND candidate.is_primary
    ) primary_binding ON TRUE
    LEFT JOIN authorization_epochs epoch ON epoch.workos_user_id = credential.workos_user_id`;

interface SnapshotRow {
  in_recovery: boolean;
  terminal_marker: boolean;
  primary_count: string;
  authenticated_user_id: string | null;
  canonical_user_id: string | null;
  identity_id: string | null;
  binding_version: string | null;
  authorization_epoch: string;
  email: string | null;
  email_verified: boolean;
  first_name: string | null;
  last_name: string | null;
}

function snapshotFromRow(row: SnapshotRow | undefined, organizationId: string | null): AuthorizationSnapshot | null {
  if (!row || row.in_recovery) throw new AuthorizationSnapshotUnavailableError();
  // Grant-free management must retain the primary snapshot's terminal
  // lifecycle boundary, including stale provider recreation and bad routing.
  if (row.terminal_marker || !row.authenticated_user_id || !row.identity_id || !row.binding_version
      || row.primary_count !== '1' || !row.canonical_user_id) return null;
  return Object.freeze({
    authenticatedUserId: row.authenticated_user_id,
    canonicalUserId: row.canonical_user_id,
    identityId: row.identity_id,
    bindingVersion: row.binding_version,
    selectedOrganizationId: organizationId,
    authorizationEpoch: row.authorization_epoch,
    credential: Object.freeze({
      email: row.email, emailVerified: row.email_verified,
      firstName: row.first_name, lastName: row.last_name,
    }),
    credentialGrant: null,
  });
}

export async function loadApiKeyManagementSnapshot(
  authenticatedUserId: string,
  organizationId: string | null,
): Promise<AuthorizationSnapshot | null> {
  try {
    const result = await queryWithTimeout<SnapshotRow>(SNAPSHOT_SQL, [authenticatedUserId], AUTHORIZATION_TIMEOUT_MS, {
      retryTransientCheckout: false,
    });
    return snapshotFromRow(result.rows[0], organizationId);
  } catch {
    throw new AuthorizationSnapshotUnavailableError();
  }
}

export class ApiKeyManagementStateChangedError extends Error {}

function assertSameState(previous: AuthorizationSnapshot, current: AuthorizationSnapshot | null): void {
  if (!current || !sameAuthorizationIdentity(previous, current)
      || previous.selectedOrganizationId !== current.selectedOrganizationId) {
    throw new ApiKeyManagementStateChangedError();
  }
}

async function checkoutBefore(deadline: number): Promise<PoolClient> {
  const checkout = getPool().connect();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    return await Promise.race([
      checkout.then((client) => {
        if (expired) client.release();
        return client;
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new AuthorizationSnapshotUnavailableError());
        }, Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Serialize with real identity/epoch row writers, not a route-local mutex.
 * No rows are inserted or updated, and the callback is never retried. A users
 * FOR UPDATE lock also blocks a first epoch INSERT through its foreign key.
 *
 * WorkOS membership changes do not participate in this database transaction.
 * The caller must recheck direct membership inside it immediately before the
 * effect; this fence does not claim atomicity with out-of-band WorkOS changes.
 */
export async function withApiKeyManagementFence<T>(
  previous: AuthorizationSnapshot,
  work: (assertCurrent: () => Promise<void>, assertLive: () => void) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  const deadline = Date.now() + FENCE_TIMEOUT_MS;
  try {
    client = await checkoutBefore(Date.now() + AUTHORIZATION_TIMEOUT_MS);
  } catch {
    throw new AuthorizationSnapshotUnavailableError();
  }
  let destroyed = false;
  const onConnectionError = () => { destroyed = true; };
  client.on('error', onConnectionError);
  const query = async <T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) => {
    const remaining = deadline - Date.now();
    if (destroyed || remaining <= 0) throw new AuthorizationSnapshotUnavailableError();
    try {
      // Driver timeout also bounds BEGIN/configuration and network loss. A timed
      // out query is never returned to the pool with an uncertain transaction.
      const config: BoundedQueryConfig = { text, values, query_timeout: Math.min(AUTHORIZATION_TIMEOUT_MS, remaining) };
      return await client.query<T>(config);
    } catch (error) {
      destroyed = true;
      throw error;
    }
  };
  try {
    try {
      await query('BEGIN');
      await query("SELECT set_config('statement_timeout', '2000ms', true), set_config('lock_timeout', '2000ms', true)");
      await query("SELECT set_config('idle_in_transaction_session_timeout', '15000ms', true)");
      const credential = await query(
        'SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR UPDATE',
        [previous.authenticatedUserId],
      );
      if (credential.rows.length === 0) throw new ApiKeyManagementStateChangedError();
      // Lock the identity against new primary bindings and its current primary
      // against demotion/deletion. Attribution is a replay guard, never authority.
      // Take the shared identity lock before either binding so simultaneous
      // requests through primary and linked credentials cannot lock each other.
      await query('SELECT id FROM identities WHERE id = $1 FOR UPDATE', [previous.identityId]);
      await query(
        'SELECT workos_user_id FROM identity_workos_users WHERE workos_user_id = $1 FOR UPDATE',
        [previous.authenticatedUserId],
      );
      await query(
        'SELECT workos_user_id FROM identity_workos_users WHERE identity_id = $1 AND is_primary FOR UPDATE',
        [previous.identityId],
      );
      await query(
        'SELECT epoch FROM authorization_epochs WHERE workos_user_id = $1 FOR UPDATE',
        [previous.authenticatedUserId],
      );
    } catch (error) {
      if (error instanceof ApiKeyManagementStateChangedError) throw error;
      throw new AuthorizationSnapshotUnavailableError();
    }
    const assertLive = () => {
      if (destroyed || Date.now() >= deadline) throw new AuthorizationSnapshotUnavailableError();
    };
    const assertCurrent = async () => {
      let current: AuthorizationSnapshot | null;
      try {
        if (Date.now() + 5_000 >= deadline) throw new AuthorizationSnapshotUnavailableError();
        const result = await query<SnapshotRow>(SNAPSHOT_SQL, [previous.authenticatedUserId]);
        if (destroyed || Date.now() + 5_000 >= deadline) throw new AuthorizationSnapshotUnavailableError();
        current = snapshotFromRow(result.rows[0], previous.selectedOrganizationId);
      } catch {
        throw new AuthorizationSnapshotUnavailableError();
      }
      assertSameState(previous, current);
    };
    await assertCurrent();
    return await work(assertCurrent, assertLive);
  } finally {
    // The transaction contains locks only. Cleanup failure cannot turn a known
    // provider success into a claimed failed mutation, nor cause a second call.
    try {
      const cleanup: BoundedQueryConfig = { text: 'ROLLBACK', query_timeout: 500 };
      if (!destroyed) await client.query(cleanup);
    } catch {
      destroyed = true;
    }
    client.removeListener('error', onConnectionError);
    client.release(destroyed);
  }
}
