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
import type { PoolClient } from 'pg';
import { assertIdentityConsolidationAllowed } from './identity-mutation-policy.js';
import { bumpAuthorizationEpochs } from './authorization-epoch-db.js';
import { createLogger } from '../logger.js';
import { notifySystemError } from '../addie/error-notifier.js';

const logger = createLogger('identity-db');

export const IDENTITY_RECOVERY_STATE = 'manual_primary_selection_required' as const;
export const IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION = 10_000;
export const IDENTITY_DELETION_SNAPSHOT_MAX_DETAILS_BYTES = 4 * 1024 * 1024;
export const IDENTITY_DELETION_SNAPSHOT_POLICY = {
  completeness: 'complete_or_fail_closed',
  max_rows_per_collection: IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION,
  max_details_bytes: IDENTITY_DELETION_SNAPSHOT_MAX_DETAILS_BYTES,
} as const;

export type IdentityCredentialDeletionSource = 'workos_webhook' | 'sync_users_backfill';

export interface IdentityBeforeGraph {
  identity: Record<string, unknown>;
  identity_workos_users: Record<string, unknown>[];
  users: Record<string, unknown>[];
  organization_memberships: Record<string, unknown>[];
  working_group_memberships: Record<string, unknown>[];
  working_group_leaders: Record<string, unknown>[];
  working_group_topic_subscriptions: Record<string, unknown>[];
  slack_user_mappings: Record<string, unknown>[];
  authorization_epochs: Record<string, unknown>[];
  /** Every current ON DELETE CASCADE child of users, keyed by table name. */
  user_cascade_rows: Record<string, Record<string, unknown>[]>;
  /** Attribution rows whose user FK is cleared with ON DELETE SET NULL. */
  user_set_null_attributions: Record<string, Record<string, unknown>[]>;
}

export interface AAOAdminParallelRevocationEvidence {
  event_type: 'revoked';
  target_user_id: string;
  working_group_id: string;
  mechanism: 'aao_admin_working_group';
  actor: {
    type: 'workos_provider';
    source: IdentityCredentialDeletionSource;
    workos_user_id: string;
  };
  evidence_ledger: 'registry_audit_log';
  dedicated_ledger_limitation: 'provider_deletion_actor_not_representable';
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
  snapshot_policy: typeof IDENTITY_DELETION_SNAPSHOT_POLICY;
  before_graph: IdentityBeforeGraph;
  aao_admin_revocations: AAOAdminParallelRevocationEvidence[];
}

export interface IdentityCredentialDeletionResult {
  deleted: boolean;
  affectedUserIds: string[];
  affectedSlackUserIds: string[];
  quarantine: IdentityRecoveryQuarantine | null;
  replay: {
    audit_id: string;
    kind: 'same_source' | 'different_source';
    original_deletion_source: IdentityCredentialDeletionSource;
    requested_deletion_source: IdentityCredentialDeletionSource;
  } | null;
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

/**
 * Current users-row CASCADE inventory. Keep this explicit and test it against
 * pg_constraint so a future authority/provenance table cannot disappear
 * without becoming part of the durable deletion snapshot.
 */
export const USER_CASCADE_SNAPSHOT_INVENTORY = [
  { table: 'authorization_epochs', columns: ['workos_user_id'] },
  { table: 'certification_attempts', columns: ['workos_user_id'] },
  { table: 'certification_learner_feedback', columns: ['workos_user_id'] },
  { table: 'community_points', columns: ['workos_user_id'] },
  { table: 'connections', columns: ['requester_user_id', 'recipient_user_id'] },
  {
    table: 'email_link_tokens',
    columns: ['primary_workos_user_id'],
    redactColumns: ['token'],
  },
  { table: 'identity_workos_users', columns: ['workos_user_id'] },
  { table: 'learner_progress', columns: ['workos_user_id'] },
  {
    table: 'member_portraits',
    columns: ['user_id'],
    redactBinaryColumns: ['portrait_data'],
  },
  { table: 'organization_credential_grants', columns: ['workos_user_id'] },
  { table: 'teaching_checkpoints', columns: ['workos_user_id'] },
  {
    table: 'user_avatar_uploads',
    columns: ['workos_user_id'],
    redactBinaryColumns: ['image_data'],
  },
  { table: 'user_badges', columns: ['workos_user_id'] },
  { table: 'user_credentials', columns: ['workos_user_id'] },
  { table: 'user_email_aliases', columns: ['workos_user_id'] },
] as const;

export const USER_SET_NULL_SNAPSHOT_INVENTORY = [
  { table: 'flagged_conversations', columns: ['reviewed_by'] },
  { table: 'known_media_contacts', columns: ['added_by'] },
] as const;

type UserSnapshotSpec = {
  readonly table: string;
  readonly columns: readonly string[];
  /** Preserve row metadata and payload length without retaining raw binary PII. */
  readonly redactBinaryColumns?: readonly string[];
  /** Preserve row provenance without retaining bearer-like secret values. */
  readonly redactColumns?: readonly string[];
};

function assertSnapshotCollectionBound(
  collection: string,
  rows: readonly unknown[],
): void {
  if (rows.length > IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION) {
    throw new Error(
      `Identity deletion snapshot ${collection} exceeds the fail-closed row limit`,
    );
  }
}

function quoteSnapshotIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe deletion snapshot identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function snapshotAndLockUserChildren(
  client: PoolClient,
  specs: readonly UserSnapshotSpec[],
  affectedUserIds: string[],
): Promise<Record<string, Record<string, unknown>[]>> {
  const snapshot: Record<string, Record<string, unknown>[]> = {};
  for (const spec of specs) {
    const table = quoteSnapshotIdentifier(spec.table);
    const binaryColumns = spec.redactBinaryColumns ?? [];
    const binaryRedactedExpression = binaryColumns.reduce((expression, column) => {
      const quotedColumn = quoteSnapshotIdentifier(column);
      return `(${expression} - '${column}') || jsonb_build_object(
        '${column}_redacted', child.${quotedColumn} IS NOT NULL,
        '${column}_byte_length', octet_length(child.${quotedColumn})
      )`;
    }, 'to_jsonb(child)');
    const jsonExpression = (spec.redactColumns ?? []).reduce((expression, column) => {
      const quotedColumn = quoteSnapshotIdentifier(column);
      return `(${expression} - '${column}') || jsonb_build_object(
        '${column}_redacted', child.${quotedColumn} IS NOT NULL
      )`;
    }, binaryRedactedExpression);
    const predicates = spec.columns
      .map((column) => `child.${quoteSnapshotIdentifier(column)} = ANY($1)`)
      .join(' OR ');
    const result = await client.query<JsonRow>(
      `SELECT ${jsonExpression} AS row
         FROM ${table} child
        WHERE ${predicates}
        ORDER BY to_jsonb(child)::text
        LIMIT $2
        FOR UPDATE OF child`,
      [affectedUserIds, IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1],
    );
    assertSnapshotCollectionBound(spec.table, result.rows);
    snapshot[spec.table] = rowsAsJson(result);
  }
  return snapshot;
}

export const CREDENTIAL_MUTATION_LOCK_TIMEOUT_MS = 1_000;
export const CREDENTIAL_MUTATION_MAX_ATTEMPTS = 3;
export const CREDENTIAL_MUTATION_ADMISSION_TIMEOUT_MS = 1_000;

/**
 * Keep one connection free for confirmed deletion and bound admission wait.
 * Guard mutation callbacks must use their supplied client and must not perform
 * provider I/O. A serialized prefetch may use the admitted connection before
 * the credential lock is acquired, so confirmed deletion can still progress.
 */
const credentialMutationAdmission = {
  active: 0,
  waiters: [] as Array<(release: () => void) => void>,
};

async function acquireCredentialMutationPoolCapacity(): Promise<() => void> {
  const configuredMax = getPool().options.max;
  if (configuredMax < 4) {
    throw new Error('Credential event mutation requires a database pool with at least four connections');
  }
  const limit = Math.max(1, configuredMax - 1);

  const makeRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = credentialMutationAdmission.waiters.shift();
      if (next) {
        // Transfer this occupied admission directly to the oldest waiter so
        // a newly arriving mutation cannot steal capacity between turns.
        next(makeRelease());
      } else {
        credentialMutationAdmission.active--;
      }
    };
  };

  if (credentialMutationAdmission.active < limit) {
    credentialMutationAdmission.active++;
    return makeRelease();
  }
  return new Promise((resolve, reject) => {
    const waiter = (release: () => void) => {
      clearTimeout(timeout);
      resolve(release);
    };
    const timeout = setTimeout(() => {
      const index = credentialMutationAdmission.waiters.indexOf(waiter);
      if (index >= 0) credentialMutationAdmission.waiters.splice(index, 1);
      reject(new Error('Credential event mutation admission timed out'));
    }, CREDENTIAL_MUTATION_ADMISSION_TIMEOUT_MS);
    credentialMutationAdmission.waiters.push(waiter);
  });
}

function rowsAsJson(result: { rows: JsonRow[] }): Record<string, unknown>[] {
  return result.rows.map(({ row }) => row);
}

async function lockCredentialMutations(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  workosUserIds: string[],
): Promise<void> {
  for (const workosUserId of [...new Set(workosUserIds)].sort()) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 6827))`, [workosUserId]);
  }
}

async function lockCredentialThenIdentityMutation(
  client: PoolClient,
  workosUserId: string,
): Promise<{ identityId: string | undefined; identity: { rows: JsonRow[] } }> {
  await lockCredentialMutations(client, [workosUserId]);
  const identityLookup = await client.query<{ identity_id: string }>(
    `SELECT identity_id FROM identity_workos_users
      WHERE workos_user_id = $1
      FOR UPDATE`,
    [workosUserId],
  );
  const identityId = identityLookup.rows[0]?.identity_id;
  const identity = identityId
    ? await client.query<JsonRow>(
        `SELECT to_jsonb(i) AS row FROM identities i WHERE id = $1 FOR UPDATE OF i`,
        [identityId],
      )
    : { rows: [] as JsonRow[] };
  return { identityId, identity };
}

async function hasConfirmedDeletionTombstone(
  client: PoolClient,
  workosUserId: string,
): Promise<boolean> {
  const tombstone = await client.query(
    `SELECT 1 FROM registry_audit_log
      WHERE workos_user_id = $1
        AND action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')
      LIMIT 1`,
    [workosUserId],
  );
  return tombstone.rowCount !== null && tombstone.rowCount > 0;
}

type ConfirmedDeletionAuditAction =
  | 'identity_credential_deleted'
  | 'identity_primary_deletion_quarantined';

async function getConfirmedDeletionReplay(
  client: PoolClient,
  workosUserId: string,
  requestedSource: IdentityCredentialDeletionSource,
): Promise<IdentityCredentialDeletionResult | null> {
  const audits = await client.query<{
    id: string;
    action: ConfirmedDeletionAuditAction;
    details: Record<string, unknown>;
  }>(
    `SELECT id, action, details
       FROM registry_audit_log
      WHERE workos_user_id = $1
        AND action IN ('identity_credential_deleted', 'identity_primary_deletion_quarantined')
      ORDER BY created_at ASC, id ASC`,
    [workosUserId],
  );
  if (audits.rows.length === 0) return null;

  const prior = audits.rows[0];
  const details = prior.details;
  const originalSource = details?.deletion_source;
  const beforeGraph = details?.before_graph;
  if ((originalSource !== 'workos_webhook' && originalSource !== 'sync_users_backfill')
    || details?.deleted_workos_user_id !== workosUserId
    || typeof beforeGraph !== 'object'
    || beforeGraph === null
    || Array.isArray(beforeGraph)) {
    throw new Error('Confirmed credential deletion replay audit is malformed');
  }

  const graph = beforeGraph as unknown as IdentityBeforeGraph;
  if (!Array.isArray(graph.identity_workos_users)
    || !Array.isArray(graph.slack_user_mappings)) {
    throw new Error('Confirmed credential deletion replay before graph is malformed');
  }
  const affectedUserIds = [...new Set([
    workosUserId,
    ...graph.identity_workos_users.map((row) => String(row.workos_user_id)),
  ])].sort();
  const affectedSlackUserIds = graph.slack_user_mappings
    .filter((row) => row.workos_user_id === workosUserId)
    .map((row) => String(row.slack_user_id));

  let quarantine: IdentityRecoveryQuarantine | null = null;
  if (prior.action === 'identity_primary_deletion_quarantined') {
    if (details.recovery_state !== IDENTITY_RECOVERY_STATE
      || typeof details.identity_id !== 'string'
      || !Array.isArray(details.aao_admin_revocations)) {
      throw new Error('Confirmed credential deletion replay quarantine is malformed');
    }
    quarantine = {
      audit_id: prior.id,
      identity_id: details.identity_id,
      deleted_workos_user_id: workosUserId,
      deletion_source: originalSource,
      actor: details.actor as IdentityRecoveryQuarantine['actor'],
      recovery_state: IDENTITY_RECOVERY_STATE,
      snapshot_policy: IDENTITY_DELETION_SNAPSHOT_POLICY,
      before_graph: graph,
      aao_admin_revocations:
        details.aao_admin_revocations as AAOAdminParallelRevocationEvidence[],
    };
  }

  return {
    // `deleted` means this invocation changed the live row. Replays return the
    // original durable outcome below without incrementing caller counters.
    deleted: false,
    affectedUserIds,
    affectedSlackUserIds,
    quarantine,
    replay: {
      audit_id: prior.id,
      kind: originalSource === requestedSource ? 'same_source' : 'different_source',
      original_deletion_source: originalSource,
      requested_deletion_source: requestedSource,
    },
  };
}

function isRetryableCredentialLockError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  return code === '55P03' || code === '40P01';
}

export interface CredentialEventMutationResult<T> {
  applied: boolean;
  value?: T;
}

type CredentialMutationMode = 'active' | 'provider_upsert';

/**
 * Run every authority-bearing side effect of one provider event while the
 * same transaction-scoped credential lock used by deletion remains held.
 * Tombstones are checked after locking. Deletion uses the same lock through
 * its tombstone commit, so the marker cannot appear before this guard releases.
 * Lock timeout/deadlock failures retry a bounded number of times, then throw
 * so the signed webhook returns 500 and WorkOS can retry; no unlocked fallback
 * is permitted. Once the callback starts it is never retried here: every
 * local write must use the supplied client and a callback failure rolls the
 * transaction back, but replaying arbitrary callback code is still unsafe.
 */
async function withCredentialEventMutation<T>(
  workosUserId: string,
  mode: CredentialMutationMode,
  mutation: (client: PoolClient) => Promise<T>,
  serializedPrefetch?: () => Promise<void>,
): Promise<CredentialEventMutationResult<T>> {
  const releaseCapacity = await acquireCredentialMutationPoolCapacity();
  try {
    for (let attempt = 1; attempt <= CREDENTIAL_MUTATION_MAX_ATTEMPTS; attempt++) {
      const client = await getPool().connect();
      let mutationStarted = false;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '${CREDENTIAL_MUTATION_LOCK_TIMEOUT_MS}ms'`);
        if (serializedPrefetch) {
          // Membership provider reads can be slow, so serialize them on a
          // distinct lock before taking the credential-revocation lock. This
          // preserves webhook ordering without delaying a confirmed deletion.
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 6828))`, [workosUserId]);

          // Avoid provider reads for a credential that is already inactive.
          // This is only an optimization: deletion can race this read, and the
          // locked lifecycle check below remains the authority before effects.
          const preflight = await client.query<{
            user_exists: boolean;
            binding_exists: boolean;
            primary_count: string;
          }>(
            `SELECT EXISTS (
                      SELECT 1 FROM users WHERE workos_user_id = $1
                    ) AS user_exists,
                    EXISTS (
                      SELECT 1 FROM identity_workos_users WHERE workos_user_id = $1
                    ) AS binding_exists,
                    COALESCE((
                      SELECT COUNT(*)
                        FROM identity_workos_users actor_iwu
                        JOIN identity_workos_users primary_iwu
                          ON primary_iwu.identity_id = actor_iwu.identity_id
                         AND primary_iwu.is_primary = TRUE
                       WHERE actor_iwu.workos_user_id = $1
                    ), 0)::text AS primary_count`,
            [workosUserId],
          );
          const state = preflight.rows[0];
          if (state?.user_exists !== true
            || state.binding_exists !== true
            || Number(state.primary_count) !== 1) {
            await client.query('COMMIT');
            return { applied: false };
          }
          await serializedPrefetch();
        }
        const { identityId } = await lockCredentialThenIdentityMutation(client, workosUserId);
        if (await hasConfirmedDeletionTombstone(client, workosUserId)) {
          await client.query('COMMIT');
          return { applied: false };
        }
        const lifecycle = await client.query<{
          user_exists: boolean;
          binding_exists: boolean;
          primary_count: string;
        }>(
          `SELECT EXISTS (
                    SELECT 1 FROM users WHERE workos_user_id = $1
                  ) AS user_exists,
                  EXISTS (
                    SELECT 1 FROM identity_workos_users WHERE workos_user_id = $1
                  ) AS binding_exists,
                  COALESCE((
                    SELECT COUNT(*)
                      FROM identity_workos_users primary_iwu
                     WHERE primary_iwu.identity_id = $2
                       AND primary_iwu.is_primary = TRUE
                  ), 0)::text AS primary_count`,
          [workosUserId, identityId ?? null],
        );
        const state = lifecycle.rows[0];
        const isActive = state?.user_exists === true
          && state.binding_exists === true
          && Number(state.primary_count) === 1;
        const isUnseen = state?.user_exists === false && state.binding_exists === false;
        if ((mode === 'active' && !isActive)
          || (mode === 'provider_upsert' && !isActive && !isUnseen)) {
            await client.query('COMMIT');
            return { applied: false };
        }

        mutationStarted = true;
        const value = await mutation(client);
        const bumped = await bumpAuthorizationEpochs(client, [workosUserId]);
        if (bumped.length !== 1 || bumped[0] !== workosUserId) {
          throw new Error('Credential event mutation did not bump the live authorization epoch');
        }
        await client.query('COMMIT');
        return { applied: true, value };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (!mutationStarted
          && attempt < CREDENTIAL_MUTATION_MAX_ATTEMPTS
          && isRetryableCredentialLockError(error)) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new Error('Credential event mutation retry bound exhausted');
  } finally {
    releaseCapacity();
  }
}

export async function withActiveCredentialEventMutation<T>(
  workosUserId: string,
  mutation: (client: PoolClient) => Promise<T>,
): Promise<CredentialEventMutationResult<T>> {
  return withCredentialEventMutation(workosUserId, 'active', mutation);
}

/**
 * Serialize read-only provider state for one credential before taking the
 * credential lifecycle lock, then recheck the locked lifecycle before local
 * effects. The prefetch must be bounded and must not perform provider writes.
 */
export async function withActiveCredentialEventMutationAfterSerializedPrefetch<T>(
  workosUserId: string,
  prefetch: () => Promise<void>,
  mutation: (client: PoolClient) => Promise<T>,
): Promise<CredentialEventMutationResult<T>> {
  return withCredentialEventMutation(workosUserId, 'active', mutation, prefetch);
}

/** Apply one atomic authority mutation to a sorted set of live credentials. */
export async function withActiveCredentialSetMutation<T>(
  workosUserIds: string[],
  mutation: (client: PoolClient) => Promise<T>,
): Promise<CredentialEventMutationResult<T>> {
  const ids = [...new Set(workosUserIds.filter(Boolean))].sort();
  if (ids.length === 0) return { applied: false };
  const releaseCapacity = await acquireCredentialMutationPoolCapacity();
  try {
    for (let attempt = 1; attempt <= CREDENTIAL_MUTATION_MAX_ATTEMPTS; attempt++) {
      const client = await getPool().connect();
      let mutationStarted = false;
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '${CREDENTIAL_MUTATION_LOCK_TIMEOUT_MS}ms'`);
        await lockCredentialMutations(client, ids);
        const bindings = await client.query<{ workos_user_id: string; identity_id: string }>(
          `SELECT workos_user_id, identity_id
             FROM identity_workos_users
            WHERE workos_user_id = ANY($1)
            ORDER BY workos_user_id
            FOR UPDATE`,
          [ids],
        );
        const identityIds = [...new Set(bindings.rows.map((row) => row.identity_id))].sort();
        if (identityIds.length > 0) {
          await client.query(
            `SELECT id FROM identities
              WHERE id = ANY($1)
              ORDER BY id
              FOR UPDATE`,
            [identityIds],
          );
        }
        const lifecycle = await client.query<{
          workos_user_id: string;
          user_exists: boolean;
          binding_exists: boolean;
          primary_count: string;
          terminal_marker: boolean;
        }>(
          `SELECT requested.workos_user_id,
                  (u.workos_user_id IS NOT NULL) AS user_exists,
                  (iwu.workos_user_id IS NOT NULL) AS binding_exists,
                  COALESCE((
                    SELECT COUNT(*) FROM identity_workos_users primary_iwu
                     WHERE primary_iwu.identity_id = iwu.identity_id
                       AND primary_iwu.is_primary = TRUE
                  ), 0)::text AS primary_count,
                  EXISTS (
                    SELECT 1 FROM registry_audit_log ral
                     WHERE ral.workos_user_id = requested.workos_user_id
                       AND ral.action IN (
                         'identity_credential_deleted',
                         'identity_primary_deletion_quarantined'
                       )
                  ) AS terminal_marker
             FROM unnest($1::text[]) AS requested(workos_user_id)
             LEFT JOIN users u USING (workos_user_id)
             LEFT JOIN identity_workos_users iwu USING (workos_user_id)
            ORDER BY requested.workos_user_id`,
          [ids],
        );
        if (lifecycle.rows.length !== ids.length
          || lifecycle.rows.some((row) => !row.user_exists
            || !row.binding_exists
            || row.terminal_marker
            || Number(row.primary_count) !== 1)) {
          await client.query('COMMIT');
          return { applied: false };
        }

        mutationStarted = true;
        const value = await mutation(client);
        const bumped = (await bumpAuthorizationEpochs(client, ids)).sort();
        if (bumped.length !== ids.length || bumped.some((id, index) => id !== ids[index])) {
          throw new Error('Authority mutation did not bump every live credential epoch');
        }
        await client.query('COMMIT');
        return { applied: true, value };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (!mutationStarted
          && attempt < CREDENTIAL_MUTATION_MAX_ATTEMPTS
          && isRetryableCredentialLockError(error)) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new Error('Credential authority mutation retry bound exhausted');
  } finally {
    releaseCapacity();
  }
}

export async function withCredentialCreationEventMutation<T>(
  workosUserId: string,
  mutation: (client: PoolClient) => Promise<T>,
): Promise<CredentialEventMutationResult<T>> {
  return withCredentialEventMutation(workosUserId, 'provider_upsert', mutation);
}

export async function upsertWorkosUserInCredentialEvent(
  credentialLockClient: PoolClient,
  user: WorkosUserUpsert,
  nameConflictPolicy: 'provider_authoritative' | 'preserve_existing',
): Promise<void> {
  await credentialLockClient.query(
    `INSERT INTO users (
       workos_user_id, email, first_name, last_name,
       email_verified, workos_created_at, workos_updated_at,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (workos_user_id) DO UPDATE SET
       email = EXCLUDED.email,
       first_name = CASE WHEN $8::text = 'preserve_existing'
         THEN COALESCE(NULLIF(TRIM(users.first_name), ''), EXCLUDED.first_name)
         ELSE COALESCE(NULLIF(TRIM(EXCLUDED.first_name), ''), users.first_name)
       END,
       last_name = CASE WHEN $8::text = 'preserve_existing'
         THEN COALESCE(NULLIF(TRIM(users.last_name), ''), EXCLUDED.last_name)
         ELSE COALESCE(NULLIF(TRIM(EXCLUDED.last_name), ''), users.last_name)
       END,
       email_verified = EXCLUDED.email_verified,
       workos_updated_at = EXCLUDED.workos_updated_at,
       updated_at = NOW()`,
    [
      user.id,
      user.email,
      user.firstName,
      user.lastName,
      user.emailVerified,
      user.createdAt,
      user.updatedAt,
      nameConflictPolicy,
    ],
  );
}

/**
 * Serialize provider upserts with confirmed deletion and refuse resurrection
 * after a durable provider-deletion audit exists for the credential.
 */
export async function upsertWorkosUserUnlessConfirmedDeleted(
  user: WorkosUserUpsert,
): Promise<boolean> {
  const result = await withCredentialCreationEventMutation(user.id, async (client) => {
    await upsertWorkosUserInCredentialEvent(client, user, 'provider_authoritative');
  });
  return result.applied;
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
    await client.query(`SET LOCAL lock_timeout = '${CREDENTIAL_MUTATION_LOCK_TIMEOUT_MS}ms'`);
    const discoveredBinding = await client.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [workosUserId],
    );
    const discoveredIdentityId = discoveredBinding.rows[0]?.identity_id;
    const discoveredSiblings = discoveredIdentityId
      ? await client.query<{ workos_user_id: string }>(
          `SELECT workos_user_id FROM identity_workos_users
            WHERE identity_id = $1
            ORDER BY workos_user_id
            LIMIT $2`,
          [discoveredIdentityId, IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1],
        )
      : { rows: [] as Array<{ workos_user_id: string }> };
    assertSnapshotCollectionBound('discovered_identity_workos_users', discoveredSiblings.rows);
    const discoveredUserIds = [...new Set([
      workosUserId,
      ...discoveredSiblings.rows.map((row) => row.workos_user_id),
    ])].sort();
    await lockCredentialMutations(client, discoveredUserIds);
    const lockedBinding = await client.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users
        WHERE workos_user_id = $1
        FOR UPDATE`,
      [workosUserId],
    );
    const identityId = lockedBinding.rows[0]?.identity_id;
    const replay = await getConfirmedDeletionReplay(client, workosUserId, deletionSource);
    if (replay) {
      if (identityId) {
        throw new Error('Confirmed credential deletion audit conflicts with a live identity binding');
      }
      await client.query('COMMIT');
      return replay;
    }
    if (identityId !== discoveredIdentityId) {
      throw new Error('Credential identity changed while acquiring deletion locks');
    }
    const identity = identityId
      ? await client.query<JsonRow>(
          `SELECT to_jsonb(i) AS row FROM identities i WHERE id = $1 FOR UPDATE OF i`,
          [identityId],
        )
      : { rows: [] as JsonRow[] };
    const bound = identityId
      ? await client.query<JsonRow>(
          `SELECT to_jsonb(iwu) AS row
             FROM identity_workos_users iwu
            WHERE iwu.identity_id = $1
            ORDER BY iwu.workos_user_id
            LIMIT $2
            FOR UPDATE OF iwu`,
          [identityId, IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1],
        )
      : { rows: [] as JsonRow[] };
    assertSnapshotCollectionBound('identity_workos_users', bound.rows);
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
        replay: null,
      };
    }
    const affectedUserIds = [...new Set([
      workosUserId,
      ...bindingRows.map((row) => String(row.workos_user_id)),
    ])].sort();
    if (affectedUserIds.length !== discoveredUserIds.length
      || affectedUserIds.some((id, index) => id !== discoveredUserIds[index])) {
      throw new Error('Credential sibling graph changed while acquiring deletion locks');
    }

    // Lock and capture the complete authority-bearing before graph in stable
    // orders. The graph becomes the durable recovery evidence if this is the
    // primary-deletion fault path.
    const users = await client.query<JsonRow>(
      `SELECT to_jsonb(u) AS row FROM users u
        WHERE u.workos_user_id = ANY($1)
        ORDER BY u.workos_user_id
        LIMIT $2
        FOR UPDATE OF u`,
      [affectedUserIds, IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1],
    );
    assertSnapshotCollectionBound('users', users.rows);
    const organizationMemberships = await client.query<JsonRow>(
      `SELECT to_jsonb(om) AS row FROM organization_memberships om
        WHERE om.workos_user_id = ANY($1)
        ORDER BY om.workos_user_id, om.workos_organization_id
        LIMIT $2
        FOR UPDATE OF om`,
      [affectedUserIds, IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1],
    );
    assertSnapshotCollectionBound('organization_memberships', organizationMemberships.rows);
    const slackUserMappings = await client.query<JsonRow>(
      `SELECT to_jsonb(sm) AS row FROM slack_user_mappings sm
        WHERE sm.workos_user_id = ANY($1)
        ORDER BY sm.workos_user_id, sm.slack_user_id
        LIMIT $2
        FOR UPDATE OF sm`,
      [affectedUserIds, IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1],
    );
    assertSnapshotCollectionBound('slack_user_mappings', slackUserMappings.rows);
    const targetSlackUserIds = rowsAsJson(slackUserMappings)
      .filter((row) => row.workos_user_id === workosUserId)
      .map((row) => String(row.slack_user_id));
    const targetAuthorityPrincipalIds = [...new Set([
      workosUserId,
      ...targetSlackUserIds,
    ])].sort();
    const snapshotAuthorityPrincipalIds = [...new Set([
      ...affectedUserIds,
      ...targetSlackUserIds,
    ])].sort();
    const workingGroupMemberships = await client.query<JsonRow>(
      `SELECT to_jsonb(wgm) AS row FROM working_group_memberships wgm
        WHERE wgm.workos_user_id = ANY($1)
        ORDER BY wgm.workos_user_id, wgm.working_group_id
        LIMIT $2
        FOR UPDATE OF wgm`,
      [
        snapshotAuthorityPrincipalIds,
        IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1,
      ],
    );
    assertSnapshotCollectionBound('working_group_memberships', workingGroupMemberships.rows);
    const workingGroupLeaders = await client.query<JsonRow>(
      `SELECT to_jsonb(wgl) AS row FROM working_group_leaders wgl
        WHERE wgl.user_id = ANY($1)
        ORDER BY wgl.user_id, wgl.working_group_id
        LIMIT $2
        FOR UPDATE OF wgl`,
      [
        snapshotAuthorityPrincipalIds,
        IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1,
      ],
    );
    assertSnapshotCollectionBound('working_group_leaders', workingGroupLeaders.rows);
    const workingGroupTopicSubscriptions = await client.query<JsonRow>(
      `SELECT to_jsonb(wgts) AS row FROM working_group_topic_subscriptions wgts
        WHERE wgts.workos_user_id = ANY($1)
        ORDER BY wgts.workos_user_id, wgts.working_group_id
        LIMIT $2
        FOR UPDATE OF wgts`,
      [
        snapshotAuthorityPrincipalIds,
        IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1,
      ],
    );
    assertSnapshotCollectionBound(
      'working_group_topic_subscriptions',
      workingGroupTopicSubscriptions.rows,
    );
    const authorizationEpochs = await client.query<JsonRow>(
      `SELECT to_jsonb(ae) AS row FROM authorization_epochs ae
        WHERE ae.workos_user_id = ANY($1)
        ORDER BY ae.workos_user_id
        LIMIT $2
        FOR UPDATE OF ae`,
      [affectedUserIds, IDENTITY_DELETION_SNAPSHOT_MAX_ROWS_PER_COLLECTION + 1],
    );
    assertSnapshotCollectionBound('authorization_epochs', authorizationEpochs.rows);
    const userCascadeRows = await snapshotAndLockUserChildren(
      client,
      USER_CASCADE_SNAPSHOT_INVENTORY.filter(
        ({ table }) => table !== 'identity_workos_users' && table !== 'authorization_epochs',
      ),
      affectedUserIds,
    );
    userCascadeRows.identity_workos_users = bindingRows;
    userCascadeRows.authorization_epochs = rowsAsJson(authorizationEpochs);
    const userSetNullAttributions = await snapshotAndLockUserChildren(
      client,
      USER_SET_NULL_SNAPSHOT_INVENTORY,
      affectedUserIds,
    );

    const userRows = rowsAsJson(users);
    const targetUser = userRows.find((row) => row.workos_user_id === workosUserId);
    const survivingBindings = bindingRows.filter((row) => row.workos_user_id !== workosUserId);
    const needsQuarantine = identityId !== undefined
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
      working_group_topic_subscriptions: rowsAsJson(workingGroupTopicSubscriptions),
      slack_user_mappings: rowsAsJson(slackUserMappings),
      authorization_epochs: rowsAsJson(authorizationEpochs),
      user_cascade_rows: userCascadeRows,
      user_set_null_attributions: userSetNullAttributions,
    };
    const targetMembership = beforeGraph.organization_memberships.find(
      (row) => row.workos_user_id === workosUserId,
    );
    const auditOrganizationId = String(
      targetUser?.primary_organization_id
        ?? targetMembership?.workos_organization_id
        ?? 'identity-recovery-unscoped',
    );
    const actor = {
      type: 'workos_provider' as const,
      source: deletionSource,
      workos_user_id: workosUserId,
    };
    const aaoAdminGroup = await client.query<{ id: string }>(
      `SELECT id FROM working_groups WHERE slug = 'aao-admin' LIMIT 1`,
    );
    const aaoAdminGroupId = aaoAdminGroup.rows[0]?.id;
    // Migration 578 cannot truthfully encode a provider-deletion actor in
    // actor_authorization_mechanism. Record compatible immutable revocation
    // evidence in the generic deletion audit instead of forging one of its
    // human/admin mechanisms; the full membership row is in before_graph.
    const aaoAdminRevocations: AAOAdminParallelRevocationEvidence[] = aaoAdminGroupId
      ? beforeGraph.working_group_memberships
          .filter((row) => targetAuthorityPrincipalIds.includes(String(row.workos_user_id))
            && row.working_group_id === aaoAdminGroupId
            && row.status === 'active')
          .map((row) => ({
            event_type: 'revoked' as const,
            target_user_id: String(row.workos_user_id),
            working_group_id: aaoAdminGroupId,
            mechanism: 'aao_admin_working_group' as const,
            actor,
            evidence_ledger: 'registry_audit_log' as const,
            dedicated_ledger_limitation: 'provider_deletion_actor_not_representable' as const,
          }))
      : [];
    const baseDetails = {
      identity_id: identityId ?? null,
      deleted_workos_user_id: workosUserId,
      deletion_source: deletionSource,
      actor,
      snapshot_policy: IDENTITY_DELETION_SNAPSHOT_POLICY,
      before_graph: beforeGraph,
      aao_admin_revocations: aaoAdminRevocations,
    };
    const details = needsQuarantine && identityId
      ? { ...baseDetails, identity_id: identityId, recovery_state: IDENTITY_RECOVERY_STATE }
      : baseDetails;
    const auditAction = needsQuarantine
      ? 'identity_primary_deletion_quarantined'
      : 'identity_credential_deleted';
    const auditResourceType = needsQuarantine ? 'identity_recovery' : 'identity_credential';
    const auditResourceId = identityId ?? workosUserId;
    const serializedDetails = JSON.stringify(details);
    if (Buffer.byteLength(serializedDetails, 'utf8')
      > IDENTITY_DELETION_SNAPSHOT_MAX_DETAILS_BYTES) {
      throw new Error('Identity deletion snapshot exceeds the fail-closed byte limit');
    }
    const audit = await client.query<{ id: string }>(
      `INSERT INTO registry_audit_log (
         workos_organization_id, workos_user_id, action,
         resource_type, resource_id, details
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [auditOrganizationId, workosUserId, auditAction, auditResourceType, auditResourceId, serializedDetails],
    );
    if (audit.rowCount !== 1 || audit.rows.length !== 1 || !audit.rows[0]?.id) {
      throw new Error('Confirmed identity credential deletion audit was not durably recorded');
    }
    if (needsQuarantine && identityId && 'recovery_state' in details) {
      quarantine = { audit_id: audit.rows[0].id, ...details };
    }

    // Authentication checks the actual credential's epoch, so deleting the
    // primary's epoch alone would leave each surviving credential's cache valid.
    const expectedEpochUserIds = userRows
      .map((row) => String(row.workos_user_id))
      .sort();
    const bumpedEpochUserIds = (await bumpAuthorizationEpochs(client, expectedEpochUserIds)).sort();
    if (bumpedEpochUserIds.length !== expectedEpochUserIds.length
      || bumpedEpochUserIds.some((id, index) => id !== expectedEpochUserIds[index])) {
      throw new Error('Confirmed credential deletion did not bump every live authorization epoch');
    }
    const deletedOrganizationMemberships = await client.query(
      `DELETE FROM organization_memberships WHERE workos_user_id = $1 RETURNING workos_organization_id`,
      [workosUserId],
    );
    const expectedOrganizationMemberships = beforeGraph.organization_memberships
      .filter((row) => row.workos_user_id === workosUserId).length;
    if (deletedOrganizationMemberships.rowCount !== expectedOrganizationMemberships) {
      throw new Error('Confirmed credential deletion did not revoke every organization membership');
    }
    // Preserve membership history while revoking live group authority.
    const deactivatedWorkingGroupMemberships = await client.query<{ working_group_id: string }>(
      `UPDATE working_group_memberships
          SET status = 'inactive', updated_at = NOW()
        WHERE workos_user_id = ANY($1) AND status <> 'inactive'
        RETURNING working_group_id`,
      [targetAuthorityPrincipalIds],
    );
    const expectedWorkingGroupDeactivations = beforeGraph.working_group_memberships
      .filter((row) => targetAuthorityPrincipalIds.includes(String(row.workos_user_id))
        && row.status !== 'inactive').length;
    if (deactivatedWorkingGroupMemberships.rowCount !== expectedWorkingGroupDeactivations) {
      throw new Error('Confirmed credential deletion did not deactivate every working-group membership');
    }
    const deactivatedAAOAdminRows = aaoAdminGroupId
      ? deactivatedWorkingGroupMemberships.rows
          .filter((row) => row.working_group_id === aaoAdminGroupId).length
      : 0;
    if (deactivatedAAOAdminRows !== aaoAdminRevocations.length) {
      throw new Error('AAO-admin revocation evidence cardinality did not match live deactivation');
    }
    // Leadership rows have no inactive state; the complete rows are retained
    // in before_graph before live authority is removed.
    const deletedLeaderships = await client.query(
      `DELETE FROM working_group_leaders WHERE user_id = ANY($1) RETURNING working_group_id`,
      [targetAuthorityPrincipalIds],
    );
    const expectedLeaderships = beforeGraph.working_group_leaders
      .filter((row) => targetAuthorityPrincipalIds.includes(String(row.user_id))).length;
    if (deletedLeaderships.rowCount !== expectedLeaderships) {
      throw new Error('Confirmed credential deletion did not revoke every working-group leadership');
    }
    const deletedTopicSubscriptions = await client.query(
      `DELETE FROM working_group_topic_subscriptions
        WHERE workos_user_id = ANY($1)
        RETURNING working_group_id`,
      [targetAuthorityPrincipalIds],
    );
    const expectedTopicSubscriptions = beforeGraph.working_group_topic_subscriptions
      .filter((row) => targetAuthorityPrincipalIds.includes(String(row.workos_user_id))).length;
    if (deletedTopicSubscriptions.rowCount !== expectedTopicSubscriptions) {
      throw new Error('Confirmed credential deletion did not revoke every topic subscription');
    }
    // Preserve the Slack contact row while severing its WorkOS authority link.
    const unlinkedSlackMappings = await client.query(
      `UPDATE slack_user_mappings
          SET workos_user_id = NULL,
              mapping_status = 'unmapped',
              mapping_source = NULL,
              mapped_at = NULL,
              mapped_by_user_id = NULL,
              updated_at = NOW()
        WHERE workos_user_id = $1
        RETURNING slack_user_id`,
      [workosUserId],
    );
    const expectedSlackMappings = beforeGraph.slack_user_mappings
      .filter((row) => row.workos_user_id === workosUserId).length;
    if (unlinkedSlackMappings.rowCount !== expectedSlackMappings) {
      throw new Error('Confirmed credential deletion did not unlink every Slack mapping');
    }
    let deletedRow = false;
    if (targetUser) {
      const deleted = await client.query<{ workos_user_id: string }>(
        'DELETE FROM users WHERE workos_user_id = $1 RETURNING workos_user_id',
        [workosUserId],
      );
      if (deleted.rowCount !== 1 || deleted.rows.length !== 1) {
        throw new Error('Confirmed credential deletion did not delete exactly one locked user');
      }
      deletedRow = true;
    }
    await client.query('COMMIT');
    result = {
      deleted: deletedRow,
      affectedUserIds,
      affectedSlackUserIds: beforeGraph.slack_user_mappings
        .filter((row) => row.workos_user_id === workosUserId)
        .map((row) => String(row.slack_user_id)),
      quarantine,
      replay: null,
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
