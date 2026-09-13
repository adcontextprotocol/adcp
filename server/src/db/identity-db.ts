/**
 * Identity-binding operations for `identity_workos_users`.
 *
 * An "identity" is the person; a WorkOS user is one credential bundle for
 * one email. `identity_workos_users` rows bind credentials to identities,
 * with a partial unique index enforcing exactly one primary per identity.
 *
 * Extracted from the webhook handler so the SQL can be exercised by
 * integration tests against a real PostgreSQL instance without dragging in
 * the full webhook transitive dependency chain.
 */

import { getPool } from './client.js';
import { assertIdentityConsolidationAllowed } from './identity-mutation-policy.js';
import { bumpAuthorizationEpochs } from './authorization-epoch-db.js';
import { createLogger } from '../logger.js';
import { notifySystemError } from '../addie/error-notifier.js';

const logger = createLogger('identity-db');

export const IDENTITY_RECOVERY_STATE = 'manual_primary_selection_required' as const;

export type IdentityCredentialDeletionSource = 'workos_webhook' | 'sync_users_backfill';

export interface IdentityBeforeGraph {
  identity: Record<string, unknown>;
  identity_workos_users: Record<string, unknown>[];
  users: Record<string, unknown>[];
  organization_memberships: Record<string, unknown>[];
  working_group_memberships: Record<string, unknown>[];
  working_group_leaders: Record<string, unknown>[];
  slack_user_mappings: Record<string, unknown>[];
  authorization_epochs: Record<string, unknown>[];
}

export interface IdentityRecoveryQuarantine {
  audit_id: string;
  identity_id: string;
  deleted_workos_user_id: string;
  deletion_source: IdentityCredentialDeletionSource;
  actor: {
    type: 'workos_provider';
    source: IdentityCredentialDeletionSource;
    workos_user_id: string;
  };
  recovery_state: typeof IDENTITY_RECOVERY_STATE;
  before_graph: IdentityBeforeGraph;
}

export interface IdentityCredentialDeletionResult {
  deleted: boolean;
  affectedUserIds: string[];
  affectedSlackUserIds: string[];
  quarantine: IdentityRecoveryQuarantine | null;
}

export interface WorkosUserUpsert {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  emailVerified: boolean;
  createdAt: string;
  updatedAt: string;
}

interface JsonRow {
  row: Record<string, unknown>;
}

function rowsAsJson(result: { rows: JsonRow[] }): Record<string, unknown>[] {
  return result.rows.map(({ row }) => row);
}

async function lockCredentialMutation(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  workosUserId: string,
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 6827))`, [workosUserId]);
}

/**
 * Serialize provider upserts with confirmed deletion and refuse resurrection
 * after a durable provider-deletion audit exists for the credential.
 */
export async function upsertWorkosUserUnlessConfirmedDeleted(
  user: WorkosUserUpsert,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockCredentialMutation(client, user.id);
    const tombstone = await client.query(
      `SELECT 1 FROM registry_audit_log
        WHERE workos_user_id = $1
          AND action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')
        LIMIT 1`,
      [user.id],
    );
    if (tombstone.rowCount) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(
      `INSERT INTO users (
         workos_user_id, email, first_name, last_name,
         email_verified, workos_created_at, workos_updated_at,
         created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = COALESCE(NULLIF(TRIM(EXCLUDED.first_name), ''), users.first_name),
         last_name = COALESCE(NULLIF(TRIM(EXCLUDED.last_name), ''), users.last_name),
         email_verified = EXCLUDED.email_verified,
         workos_updated_at = EXCLUDED.workos_updated_at,
         updated_at = NOW()`,
      [user.id, user.email, user.firstName, user.lastName, user.emailVerified, user.createdAt, user.updatedAt],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Retrieve the durable, unresolved recovery state for an identity. */
export async function getIdentityRecoveryQuarantine(
  identityId: string,
): Promise<IdentityRecoveryQuarantine | null> {
  const result = await getPool().query<{ id: string; details: IdentityRecoveryQuarantine }>(
    `SELECT id, details
       FROM registry_audit_log
      WHERE action = 'identity_primary_deletion_quarantined'
        AND resource_type = 'identity_recovery'
        AND resource_id = $1
        AND details->>'recovery_state' = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [identityId, IDENTITY_RECOVERY_STATE],
  );
  if (result.rows.length === 0) return null;
  return {
    ...result.rows[0].details,
    audit_id: result.rows[0].id,
  };
}

/**
 * Apply an authoritative provider deletion without selecting a new primary.
 * Revoke cached routing for every affected credential in the same transaction
 * as the binding disappears. Return the IDs to evict from local caches after
 * commit; their persisted epochs handle caches on other instances.
 */
export async function deleteIdentityCredentialTransaction(
  workosUserId: string,
  deletionSource: IdentityCredentialDeletionSource,
): Promise<IdentityCredentialDeletionResult> {
  const client = await getPool().connect();
  let result: IdentityCredentialDeletionResult | undefined;

  try {
    await client.query('BEGIN');
    const identityLookup = await client.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [workosUserId],
    );
    const identityId = identityLookup.rows[0]?.identity_id;

    // The identity row is the serialization point. Lock it before child rows
    // so webhook/backfill deletion of siblings cannot deadlock by first
    // holding different credential rows.
    const identity = identityId
      ? await client.query<JsonRow>(
          `SELECT to_jsonb(i) AS row FROM identities i WHERE id = $1 FOR UPDATE OF i`,
          [identityId],
        )
      : { rows: [] as JsonRow[] };
    // Serialize this credential with WorkOS create/update/backfill upserts.
    // Identity comes first whenever it exists, preserving the shared lock order.
    await lockCredentialMutation(client, workosUserId);
    const bound = identityId
      ? await client.query<JsonRow>(
          `SELECT to_jsonb(iwu) AS row
             FROM identity_workos_users iwu
            WHERE iwu.identity_id = $1
            ORDER BY iwu.workos_user_id
            FOR UPDATE OF iwu`,
          [identityId],
        )
      : { rows: [] as JsonRow[] };
    const bindingRows = rowsAsJson(bound);
    const targetBinding = bindingRows.find((row) => row.workos_user_id === workosUserId);
    if (identityId && !targetBinding) {
      // Another confirmed deletion won the identity lock. Do not mutate epochs
      // or emit a second audit on the replaying caller.
      await client.query('COMMIT');
      return {
        deleted: false,
        affectedUserIds: [workosUserId],
        affectedSlackUserIds: [],
        quarantine: null,
      };
    }
    const affectedUserIds = [...new Set([
      workosUserId,
      ...bindingRows.map((row) => String(row.workos_user_id)),
    ])].sort();

    // Lock and capture the complete authority-bearing before graph in stable
    // orders. The graph becomes the durable recovery evidence if this is the
    // primary-deletion fault path.
    const users = await client.query<JsonRow>(
      `SELECT to_jsonb(u) AS row FROM users u
        WHERE u.workos_user_id = ANY($1)
        ORDER BY u.workos_user_id
        FOR UPDATE OF u`,
      [affectedUserIds],
    );
    const organizationMemberships = await client.query<JsonRow>(
      `SELECT to_jsonb(om) AS row FROM organization_memberships om
        WHERE om.workos_user_id = ANY($1)
        ORDER BY om.workos_user_id, om.workos_organization_id
        FOR UPDATE OF om`,
      [affectedUserIds],
    );
    const workingGroupMemberships = await client.query<JsonRow>(
      `SELECT to_jsonb(wgm) AS row FROM working_group_memberships wgm
        WHERE wgm.workos_user_id = ANY($1)
        ORDER BY wgm.workos_user_id, wgm.working_group_id
        FOR UPDATE OF wgm`,
      [affectedUserIds],
    );
    const workingGroupLeaders = await client.query<JsonRow>(
      `SELECT to_jsonb(wgl) AS row FROM working_group_leaders wgl
        WHERE wgl.user_id = ANY($1)
        ORDER BY wgl.user_id, wgl.working_group_id
        FOR UPDATE OF wgl`,
      [affectedUserIds],
    );
    const slackUserMappings = await client.query<JsonRow>(
      `SELECT to_jsonb(sm) AS row FROM slack_user_mappings sm
        WHERE sm.workos_user_id = ANY($1)
        ORDER BY sm.workos_user_id, sm.slack_user_id
        FOR UPDATE OF sm`,
      [affectedUserIds],
    );
    const authorizationEpochs = await client.query<JsonRow>(
      `SELECT to_jsonb(ae) AS row FROM authorization_epochs ae
        WHERE ae.workos_user_id = ANY($1)
        ORDER BY ae.workos_user_id
        FOR UPDATE OF ae`,
      [affectedUserIds],
    );

    const userRows = rowsAsJson(users);
    const targetUser = userRows.find((row) => row.workos_user_id === workosUserId);
    if (!targetUser) {
      await client.query('COMMIT');
      return {
        deleted: false,
        affectedUserIds: [workosUserId],
        affectedSlackUserIds: [],
        quarantine: null,
      };
    }
    const survivingBindings = bindingRows.filter((row) => row.workos_user_id !== workosUserId);
    const needsQuarantine = targetBinding?.is_primary === true
      && survivingBindings.length > 0
      && survivingBindings.every((row) => row.is_primary !== true);
    let quarantine: IdentityRecoveryQuarantine | null = null;
    const beforeGraph: IdentityBeforeGraph = {
      identity: identity.rows[0]?.row ?? (identityId ? { id: identityId } : {}),
      identity_workos_users: bindingRows,
      users: userRows,
      organization_memberships: rowsAsJson(organizationMemberships),
      working_group_memberships: rowsAsJson(workingGroupMemberships),
      working_group_leaders: rowsAsJson(workingGroupLeaders),
      slack_user_mappings: rowsAsJson(slackUserMappings),
      authorization_epochs: rowsAsJson(authorizationEpochs),
    };
    const targetMembership = beforeGraph.organization_memberships.find(
      (row) => row.workos_user_id === workosUserId,
    );
    const auditOrganizationId = String(
      targetUser.primary_organization_id
        ?? targetMembership?.workos_organization_id
        ?? 'identity-recovery-unscoped',
    );
    const actor = {
      type: 'workos_provider' as const,
      source: deletionSource,
      workos_user_id: workosUserId,
    };
    const baseDetails = {
      identity_id: identityId ?? null,
      deleted_workos_user_id: workosUserId,
      deletion_source: deletionSource,
      actor,
      before_graph: beforeGraph,
    };
    const details = needsQuarantine && identityId
      ? { ...baseDetails, identity_id: identityId, recovery_state: IDENTITY_RECOVERY_STATE }
      : baseDetails;
    const auditAction = needsQuarantine
      ? 'identity_primary_deletion_quarantined'
      : 'identity_credential_deleted';
    const auditResourceType = needsQuarantine ? 'identity_recovery' : 'identity_credential';
    const auditResourceId = identityId ?? workosUserId;
    const audit = await client.query<{ id: string }>(
      `INSERT INTO registry_audit_log (
         workos_organization_id, workos_user_id, action,
         resource_type, resource_id, details
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [auditOrganizationId, workosUserId, auditAction, auditResourceType, auditResourceId, JSON.stringify(details)],
    );
    if (audit.rowCount !== 1 || audit.rows.length !== 1 || !audit.rows[0]?.id) {
      throw new Error('Confirmed identity credential deletion audit was not durably recorded');
    }
    if (needsQuarantine && identityId && 'recovery_state' in details) {
      quarantine = { audit_id: audit.rows[0].id, ...details };
    }

    // Authentication checks the actual credential's epoch, so deleting the
    // primary's epoch alone would leave each surviving credential's cache valid.
    await bumpAuthorizationEpochs(client, affectedUserIds);
    await client.query('DELETE FROM organization_memberships WHERE workos_user_id = $1', [workosUserId]);
    // Preserve membership history while revoking live group authority.
    await client.query(
      `UPDATE working_group_memberships
          SET status = 'inactive', updated_at = NOW()
        WHERE workos_user_id = $1 AND status <> 'inactive'`,
      [workosUserId],
    );
    // Leadership rows have no inactive state; the complete rows are retained
    // in before_graph before live authority is removed.
    await client.query('DELETE FROM working_group_leaders WHERE user_id = $1', [workosUserId]);
    // Preserve the Slack contact row while severing its WorkOS authority link.
    await client.query(
      `UPDATE slack_user_mappings
          SET workos_user_id = NULL,
              mapping_status = 'unmapped',
              mapping_source = NULL,
              mapped_at = NULL,
              mapped_by_user_id = NULL,
              updated_at = NOW()
        WHERE workos_user_id = $1`,
      [workosUserId],
    );
    const deleted = await client.query<{ workos_user_id: string }>(
      'DELETE FROM users WHERE workos_user_id = $1 RETURNING workos_user_id',
      [workosUserId],
    );
    if (quarantine && deleted.rowCount !== 1) {
      throw new Error('Quarantined primary credential deletion did not delete exactly one user');
    }
    await client.query('COMMIT');
    result = {
      deleted: deleted.rowCount === 1,
      affectedUserIds,
      affectedSlackUserIds: beforeGraph.slack_user_mappings
        .filter((row) => row.workos_user_id === workosUserId)
        .map((row) => String(row.slack_user_id)),
      quarantine,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return result;
}

/**
 * Legacy primary promotion is disabled for #6827: changing the canonical
 * credential can transfer authority even without moving membership rows.
 * Provider deletions use the identity-credential-deletion service without
 * inferring a successor.
 * @throws IdentityMutationDisabledError before any database access.
 */
export async function promoteSecondaryIfPrimaryDeleted(
  workosUserId: string,
): Promise<{ promotedUserId: string } | null> {
  // A primary flip changes canonical authority even without moving rows.
  assertIdentityConsolidationAllowed();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the binding row to serialize concurrent promotions (e.g. two
    // user.deleted webhooks against bindings on the same identity).
    const primaryCheck = await client.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users
        WHERE workos_user_id = $1 AND is_primary = TRUE
        FOR UPDATE`,
      [workosUserId],
    );

    if (primaryCheck.rows.length === 0) {
      // Not primary (or no binding at all) — nothing to promote.
      await client.query('ROLLBACK');
      return null;
    }

    const identityId = primaryCheck.rows[0].identity_id;

    // Pick the longest-bound surviving secondary — matches the
    // findSuccessorForPromotion convention used by membership owner
    // succession (created_at ASC).
    const successor = await client.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM identity_workos_users
        WHERE identity_id = $1
          AND workos_user_id <> $2
          AND is_primary = FALSE
        ORDER BY bound_at ASC
        LIMIT 1
        FOR UPDATE`,
      [identityId, workosUserId],
    );

    if (successor.rows.length === 0) {
      // Single-credential identity. Nothing to promote — the CASCADE will
      // drop the only binding and the (orphan) identity row alongside it.
      await client.query('ROLLBACK');
      return null;
    }

    const successorId = successor.rows[0].workos_user_id;

    // Demote the deleted user's binding first so the partial unique index
    // `idx_identity_workos_users_one_primary` doesn't reject the promotion.
    await client.query(
      `UPDATE identity_workos_users SET is_primary = FALSE
        WHERE workos_user_id = $1`,
      [workosUserId],
    );
    await client.query(
      `UPDATE identity_workos_users SET is_primary = TRUE
        WHERE workos_user_id = $1 AND identity_id = $2`,
      [successorId, identityId],
    );

    // The primary flipped: every session bound to this identity now routes
    // through a different credential, including secondaries that were not
    // promoted — their canonical target moves from the deleted primary to
    // the successor. Bump all of them in this transaction so stale sessions
    // on other instances lose their pre-promotion routing. The deleted
    // user's binding is still present here; the CASCADE fires later.
    const boundCredentials = await client.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM identity_workos_users WHERE identity_id = $1`,
      [identityId],
    );
    await bumpAuthorizationEpochs(client, [
      workosUserId,
      successorId,
      ...boundCredentials.rows.map((row) => row.workos_user_id),
    ]);

    await client.query('COMMIT');

    logger.info(
      { deletedUserId: workosUserId, promotedUserId: successorId, identityId },
      'Promoted secondary to primary before WorkOS user.deleted CASCADE',
    );

    return { promotedUserId: successorId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // logger.warn auto-routes to #admin-errors via posthog.ts:201-205.
    logger.warn(
      { err, userId: workosUserId },
      'Failed to promote secondary on user.deleted — identity may be left with zero primaries',
    );
    // Explicit ops alert so this doesn't drown in the warn stream.
    notifySystemError({
      source: 'workos-webhook',
      errorMessage: `user.deleted: failed to promote secondary for ${workosUserId}; identity may be left with zero primaries and the surviving binding will sign in to an empty workspace until repaired`,
    });
    return null;
  } finally {
    client.release();
  }
}
