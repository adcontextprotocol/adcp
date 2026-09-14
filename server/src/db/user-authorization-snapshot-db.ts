import { isTransientConnectionError, queryWithTimeout } from './client.js';

const SNAPSHOT_TIMEOUT_MS = 2_000;

/** The exact credential and its authority, observed in one primary-database statement. */
export interface AuthorizationSnapshot {
  readonly authenticatedUserId: string;
  readonly canonicalUserId: string;
  readonly identityId: string | null;
  readonly selectedOrganizationId: string | null;
  /** PostgreSQL bigint text: converting to a number would lose revocations above 2^53. */
  readonly authorizationEpoch: string;
  readonly credential: Readonly<{
    email: string | null;
    emailVerified: boolean;
    firstName: string | null;
    lastName: string | null;
  }>;
  readonly credentialGrant: Readonly<{
    id: string;
    organizationId: string;
    role: 'owner' | 'admin' | 'member';
    effectiveFrom: string;
    effectiveUntil: string | null;
  }> | null;
}

/** Distinct from a missing credential or denied organization access. */
export class AuthorizationSnapshotUnavailableError extends Error {
  constructor(message = 'Authorization snapshot unavailable') {
    super(message);
    this.name = 'AuthorizationSnapshotUnavailableError';
  }
}

interface SnapshotRow {
  in_recovery: boolean;
  authenticated_user_id: string | null;
  canonical_user_id: string | null;
  identity_id: string | null;
  authorization_epoch: string;
  email: string | null;
  email_verified: boolean;
  first_name: string | null;
  last_name: string | null;
  grant_id: string | null;
  grant_organization_id: string | null;
  grant_role: 'owner' | 'admin' | 'member' | null;
  grant_effective_from: string | null;
  grant_effective_until: string | null;
}

/** A retry may replace a broken connection, never renew the statement budget. */
async function querySnapshot(statement: string, parameters: [string, string | null]) {
  const deadlineMs = Date.now() + SNAPSHOT_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) throw new AuthorizationSnapshotUnavailableError();
    try {
      const result = await queryWithTimeout<SnapshotRow>(statement, parameters, remainingMs, {
        // querySnapshot owns the one retry so checkout and statement failures
        // share this request's single absolute authorization budget.
        retryTransientCheckout: false,
      });
      if (Date.now() >= deadlineMs) throw new AuthorizationSnapshotUnavailableError();
      return result;
    } catch (error) {
      if (attempt === 1 || !isTransientConnectionError(error) || Date.now() >= deadlineMs) throw error;
    }
  }
  throw new AuthorizationSnapshotUnavailableError();
}

/**
 * Never hydrate identity and epoch separately: a binding change can commit
 * between the reads and stamp old attribution with the new epoch. One SELECT
 * gives every field the same PostgreSQL MVCC snapshot. The bounded query wrapper
 * uses the primary pool with transaction-local statement and lock timeouts;
 * a recovering replica fails closed in this statement.
 *
 * Organization selection must be explicit. Neither linked credentials nor the
 * organization_memberships cache supplies authority on a cold start/cache miss.
 */
export async function loadAuthorizationSnapshot(
  authenticatedUserId: string,
  selectedOrganizationId: string | null,
): Promise<AuthorizationSnapshot | null> {
  const organizationId = selectedOrganizationId || null;
  try {
    const result = await querySnapshot(
      `SELECT pg_catalog.pg_is_in_recovery() AS in_recovery,
              credential.workos_user_id AS authenticated_user_id,
              primary_binding.workos_user_id AS canonical_user_id,
              binding.identity_id,
              COALESCE(epoch.epoch, 0)::text AS authorization_epoch,
              credential.email, credential.email_verified, credential.first_name, credential.last_name,
              credential_grant.id AS grant_id,
              credential_grant.workos_organization_id AS grant_organization_id,
              credential_grant.role AS grant_role,
              to_char(credential_grant.effective_from AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS grant_effective_from,
              to_char(credential_grant.effective_until AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS grant_effective_until
         FROM (VALUES (1)) AS anchor(value)
         LEFT JOIN users credential ON credential.workos_user_id = $1
         LEFT JOIN identity_workos_users binding
           ON binding.workos_user_id = credential.workos_user_id
         LEFT JOIN identity_workos_users primary_binding
           ON primary_binding.identity_id = binding.identity_id AND primary_binding.is_primary
         LEFT JOIN authorization_epochs epoch
           ON epoch.workos_user_id = credential.workos_user_id
         LEFT JOIN organization_credential_grants credential_grant
           ON credential_grant.workos_user_id = credential.workos_user_id
          AND credential_grant.workos_organization_id = $2
          AND credential_grant.revoked_at IS NULL
          AND credential_grant.effective_from <= statement_timestamp()
          AND (credential_grant.effective_until IS NULL
               OR credential_grant.effective_until > statement_timestamp())`,
      [authenticatedUserId, organizationId],
    );
    const row = result.rows[0];
    if (!row || row.in_recovery) {
      throw new AuthorizationSnapshotUnavailableError();
    }
    if (!row.authenticated_user_id) return null;
    // Migration 460 backfills bindings and creates them on every user insert.
    // Missing attribution is an integrity failure, not a singleton fallback.
    if (!row.identity_id || !row.canonical_user_id) {
      throw new AuthorizationSnapshotUnavailableError();
    }

    const credentialGrant = row.grant_id
      ? Object.freeze({
        id: row.grant_id,
        organizationId: row.grant_organization_id!,
        role: row.grant_role!,
        effectiveFrom: row.grant_effective_from!,
        effectiveUntil: row.grant_effective_until,
      })
      : null;
    return Object.freeze({
      authenticatedUserId: row.authenticated_user_id,
      canonicalUserId: row.canonical_user_id,
      identityId: row.identity_id,
      selectedOrganizationId: organizationId,
      authorizationEpoch: row.authorization_epoch,
      credential: Object.freeze({
        email: row.email,
        emailVerified: row.email_verified,
        firstName: row.first_name,
        lastName: row.last_name,
      }),
      credentialGrant,
    });
  } catch (error) {
    if (error instanceof AuthorizationSnapshotUnavailableError) throw error;
    // Callers must distinguish unavailable from denied without exposing raw DB
    // errors or reusing stale identity, organization, or grant cache entries.
    throw new AuthorizationSnapshotUnavailableError();
  }
}

export function sameAuthorizationIdentity(
  previous: AuthorizationSnapshot,
  current: AuthorizationSnapshot,
): boolean {
  return previous.authenticatedUserId === current.authenticatedUserId
    && previous.canonicalUserId === current.canonicalUserId
    && previous.identityId === current.identityId
    && previous.authorizationEpoch === current.authorizationEpoch
    && previous.credential.email === current.credential.email
    && previous.credential.emailVerified === current.credential.emailVerified;
}

/** Compare equality, not epoch ordering: deletions and replay can move backwards. */
export function sameAuthorizationSnapshot(
  previous: AuthorizationSnapshot,
  current: AuthorizationSnapshot,
): boolean {
  if (!sameAuthorizationIdentity(previous, current)
      || previous.selectedOrganizationId !== current.selectedOrganizationId) return false;
  const before = previous.credentialGrant;
  const after = current.credentialGrant;
  if (!before || !after) return before === after;
  return before.id === after.id
    && before.organizationId === after.organizationId
    && before.role === after.role
    && before.effectiveFrom === after.effectiveFrom
    && before.effectiveUntil === after.effectiveUntil;
}
