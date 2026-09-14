import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { getPool } from '../db/client.js';
import {
  ADMIN_CREDENTIAL_ROW_VERSION, adminCredentialAuditReceipt, assertSingleAdminCredentialRow,
  insertAdminCredentialAudit, verifyAdminCredentialTransaction, readAdminCredentialAuditCohort,
  verifyAdminCredentialAuditCohort, type AdminCredentialReceipt,
} from '../db/admin-credential-bind-receipts.js';
import { bumpAuthorizationEpochs } from '../db/authorization-epoch-db.js';
import {
  lockAdminCredentialCompensationQuarantine,
  lockCredentialLifecyclesInTransaction,
  recordAdminCredentialCompensationQuarantine,
  recordConfirmedAdminCredentialCompensationDeletion,
  type LockedCredentialLifecycle,
} from '../db/identity-db.js';
import { getAdminCredentialMutationWorkos } from '../auth/workos-client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('admin-credential-bind');
type Provider = Pick<WorkOS['userManagement'], 'createUser' | 'deleteUser'>;
type Status = 'creating' | 'provider_created' | 'committed' | 'compensating' |
  'compensated' | 'provider_rejected' | 'reconciliation_required';
interface Operation extends Record<string, unknown> {
  email_hash: string;
  failure_code: string | null;
  receipt_version?: string;
  id: string;
  host_user_id: string;
  host_identity_id: string;
  actor_user_id: string;
  actor_identity_id: string;
  provider_user_id: string | null;
  status: Status;
}
interface Input {
  hostUserId: string;
  email: string;
  actorUserId: string;
  actorIdentityId: string;
}
interface Result { status: number; body: Record<string, unknown> }

// Only allowlisted fields reach evidence; never serialize provider bodies/errors.
function auditInput(op: Operation) {
  return { kind: 'operation' as const, workosUserId: op.actor_user_id, operationId: op.id, details: {
    status: op.status, failure_code: op.failure_code, operation_version: op.receipt_version,
    acting_workos_user_id: op.actor_user_id, actor_identity_id: op.actor_identity_id,
    host_user_id: op.host_user_id, host_identity_id: op.host_identity_id, provider_user_id: op.provider_user_id,
  } };
}

interface PendingOperation {
  operation: Operation;
  source?: Operation;
  operationReceipt: AdminCredentialReceipt;
  audits: AdminCredentialReceipt[];
}

function operationReceipt(row: Operation): AdminCredentialReceipt {
  const expected = structuredClone(row);
  return async client => {
    const result = await client.query<Operation>(
      `SELECT *, ${ADMIN_CREDENTIAL_ROW_VERSION} FROM admin_credential_bind_operations WHERE id = $1 FOR UPDATE`, [row.id],
    );
    if (!isDeepStrictEqual(assertSingleAdminCredentialRow(result), expected)) {
      throw new Error('Operation changed before commit');
    }
  };
}

function assertOperation(row: Operation, expected: Operation): void {
  const actual = { ...row };
  const fields = { ...expected };
  delete actual.receipt_version;
  delete fields.receipt_version;
  if (!isDeepStrictEqual(actual, fields)) throw new Error('Altered operation receipt');
}

/** The supplied transaction owns all writes; pending state is not committed state. */
async function insertIntent(client: PoolClient, op: Operation, recovering = false): Promise<PendingOperation> {
  const status = recovering ? 'reconciliation_required' : 'creating';
  const failureCode = recovering ? 'intent_commit_ambiguous' : null;
  const timestamp = new Date();
  let createdAt = timestamp;
  const audits: AdminCredentialReceipt[] = [];
  if (recovering) {
    const prior = await client.query<Operation>(
      `SELECT *, ${ADMIN_CREDENTIAL_ROW_VERSION} FROM admin_credential_bind_operations WHERE id = $1 FOR UPDATE`, [op.id],
    );
    if (prior.rowCount !== 0) {
      const row = assertSingleAdminCredentialRow(prior);
      for (const key of ['id', 'email_hash', 'host_user_id', 'host_identity_id', 'actor_user_id', 'actor_identity_id']) {
        if (row[key] !== op[key]) throw new Error('Intent recovery ownership changed');
      }
      if (row.provider_user_id !== null || !['creating', 'reconciliation_required'].includes(row.status)) {
        throw new Error('Intent recovery state changed');
      }
      createdAt = row.created_at as Date;
      audits.push(await existingOperationAudit(client, row));
    } else if (prior.rows.length !== 0) throw new Error('Intent recovery cardinality changed');
  }
  const intent = await client.query<Operation>(
    `INSERT INTO admin_credential_bind_operations
       (id, email_hash, host_user_id, host_identity_id, actor_user_id, actor_identity_id, status, failure_code, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ${recovering ? `ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status, failure_code = EXCLUDED.failure_code, updated_at = EXCLUDED.updated_at
       WHERE admin_credential_bind_operations.email_hash = EXCLUDED.email_hash
         AND admin_credential_bind_operations.host_user_id = EXCLUDED.host_user_id
         AND admin_credential_bind_operations.host_identity_id = EXCLUDED.host_identity_id
         AND admin_credential_bind_operations.actor_user_id = EXCLUDED.actor_user_id
         AND admin_credential_bind_operations.actor_identity_id = EXCLUDED.actor_identity_id
         AND admin_credential_bind_operations.provider_user_id IS NULL
         AND admin_credential_bind_operations.status IN ('creating', 'reconciliation_required')` : ''}
     RETURNING *, ${ADMIN_CREDENTIAL_ROW_VERSION},
       created_at = $9::timestamptz AND updated_at = $10::timestamptz AS timestamps_match`,
    [op.id, op.email_hash, op.host_user_id, op.host_identity_id, op.actor_user_id, op.actor_identity_id,
      status, failureCode, createdAt, timestamp],
  );
  const row = assertSingleAdminCredentialRow(intent);
  if (row.timestamps_match !== true) throw new Error('Altered intent timestamps');
  delete row.timestamps_match;
  assertOperation(row, { ...op, provider_user_id: null, status, failure_code: failureCode, created_at: createdAt, updated_at: timestamp });
  audits.push(await insertAdminCredentialAudit(client, auditInput(row)));
  return { operation: row, operationReceipt: operationReceipt(row), audits };
}

async function existingOperationAudit(client: PoolClient, op: Operation): Promise<AdminCredentialReceipt> {
  const audit = await client.query(
    `SELECT *, ${ADMIN_CREDENTIAL_ROW_VERSION} FROM registry_audit_log
      WHERE resource_id = $1 AND action = 'admin_credential_bind'
        AND details->>'operation_version' = $2 FOR UPDATE`, [op.id, op.receipt_version],
  );
  return adminCredentialAuditReceipt(assertSingleAdminCredentialRow(audit), auditInput(op));
}

async function transitionInTransaction(client: PoolClient, expected: Operation[],
  status: Status, failureCode: string | null, providerId: string | null): Promise<PendingOperation> {
  const current = assertSingleAdminCredentialRow(await client.query<Operation>(
    `SELECT *, ${ADMIN_CREDENTIAL_ROW_VERSION} FROM admin_credential_bind_operations WHERE id = $1 FOR UPDATE`, [expected[0].id],
  ));
  if (!expected.some(candidate => isDeepStrictEqual(candidate, current))) throw new Error('Operation state changed');
  if (current.provider_user_id !== null && current.provider_user_id !== providerId) throw new Error('Provider ownership changed');
  const sources: Partial<Record<Status, Status>> = {
    provider_created: 'creating', provider_rejected: 'creating', committed: 'provider_created',
    compensating: 'provider_created', compensated: 'compensating',
  };
  if (status !== 'reconciliation_required' && sources[status] !== current.status) throw new Error('Invalid transition');
  const priorAudit = await existingOperationAudit(client, current);
  const timestamp = new Date();
  const updated = await client.query<Operation>(
    `UPDATE admin_credential_bind_operations
        SET status = $2, failure_code = $3, provider_user_id = $4, updated_at = $5
      WHERE id = $1 AND xmin::text || ':' || ctid::text = $6
      RETURNING *, ${ADMIN_CREDENTIAL_ROW_VERSION},
        created_at = $7::timestamptz AND updated_at = $5::timestamptz AS timestamps_match`,
    [current.id, status, failureCode, providerId, timestamp, current.receipt_version, current.created_at],
  );
  const next = assertSingleAdminCredentialRow(updated);
  if (next.timestamps_match !== true) throw new Error('Altered operation timestamps');
  delete next.timestamps_match;
  assertOperation(next, { ...current, status, failure_code: failureCode, provider_user_id: providerId, updated_at: timestamp });
  if (next.receipt_version === current.receipt_version) throw new Error('Operation version did not change');
  const audit = await insertAdminCredentialAudit(client, auditInput(next));
  return { operation: next, source: current, operationReceipt: operationReceipt(next), audits: [priorAudit, audit] };
}

function reconciliation(op?: Operation): Result {
  return { status: 503, body: {
    error: 'reconciliation_required', reconciliation_required: true,
    message: 'The outcome requires engineering adjudication before another attempt.',
    ...(op ? { operation_id: op.id, new_workos_user_id: op.provider_user_id } : {}),
  } };
}

function success(op: Operation, email: string, replay = false): Result {
  return { status: replay ? 200 : 201, body: {
    bound: true, operation_id: op.id, existing_user_id: op.host_user_id,
    new_email: email, new_workos_user_id: op.provider_user_id,
    message: 'Sign-in credential bound. No organization memberships were transferred.',
  } };
}

function active(state: LockedCredentialLifecycle | undefined): boolean {
  return !!state && !state.terminal_marker && state.user_exists && state.binding_exists
    && !!state.identity_id && Number(state.primary_count) === 1;
}

function unseen(state: LockedCredentialLifecycle): boolean {
  return !state.terminal_marker && !state.user_exists && !state.binding_exists
    && state.identity_id === null && state.is_primary === null && Number(state.primary_count) === 0;
}

/**
 * Admin-only create-and-bind saga. The journal commits before WorkOS is called.
 * This deliberately does not share merge/member-email transaction semantics:
 * it never consolidates app state or writes organization memberships.
 *
 * A crash at any external boundary leaves a durable blocking state. No GET is
 * used to infer the outcome of an in-flight request. Only a confirmed local
 * rollback permits deleting the exact user returned by a successful create.
 */
export async function createAndBindAdminCredential(input: Input, dependencies: {
  pool?: Pool;
  workos?: Provider;
} = {}): Promise<Result> {
  const pool = dependencies.pool ?? getPool();
  const email = input.email.trim().toLowerCase();
  const emailHash = createHash('sha256').update(email).digest('hex');
  const keys = [`admin-credential-bind:email:${emailHash}`, `admin-credential-bind:host:${input.hostUserId}`].sort();
  const held: string[] = [];
  let client: PoolClient | undefined;
  let op: Operation | undefined;
  let observedProviderId: string | null = null;
  const durableAudits: AdminCredentialReceipt[] = [];
  let auditBaseline: Record<string, unknown>[] = [];
  const ambiguousOperations: Array<{ operation: Operation; audits: AdminCredentialReceipt[] }> = [];
  let destroy = false;
  let result: Result = { status: 503, body: { error: 'credential_bind_unavailable' } };

  function discardClient(): void {
    client?.release(true);
    client = undefined;
  }

  async function rollback(): Promise<boolean> {
    if (!client) return false;
    try {
      if ((await client.query('ROLLBACK')).command === 'ROLLBACK') return true;
    } catch { /* An unconfirmed rollback must never authorize compensation. */ }
    client.release(true);
    client = undefined;
    return false;
  }

  async function beginTransaction(transaction: PoolClient): Promise<void> {
    if (transaction !== client) throw new Error('Transaction client changed');
    if ((await transaction.query('BEGIN')).command !== 'BEGIN') throw new Error('Unconfirmed transaction begin');
    auditBaseline = op ? await readAdminCredentialAuditCohort(transaction, op.id) : [];
  }

  async function verifyPhase(receipts: AdminCredentialReceipt[]): Promise<void> {
    if (!client || !op) throw new Error('Missing operation transaction');
    await verifyAdminCredentialTransaction(client, receipts);
    await verifyAdminCredentialAuditCohort(client, op.id, auditBaseline, receipts);
  }

  async function commitOperation(pending: PendingOperation, extra: AdminCredentialReceipt[] = [],
    beforeCommit: () => void = () => {}): Promise<void> {
    if (!client) throw new Error('Missing transaction client');
    await verifyPhase([...durableAudits, ...extra,
      pending.operationReceipt, ...pending.audits]);
    // Only these exact old/new snapshots may be accepted after a lost reply.
    ambiguousOperations.push({ operation: pending.operation, audits: [...extra, ...pending.audits] });
    beforeCommit();
    if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Unconfirmed operation commit');
    op = pending.operation;
    ambiguousOperations.length = 0;
    durableAudits.push(...extra, ...pending.audits);
  }

  async function ownedTransition(status: Status, code: string | null = null): Promise<void> {
    if (!op) throw new Error('Missing operation');
    if (!client) {
      held.length = 0;
      client = await pool.connect();
    }
    try {
      await beginTransaction(client);
      await client.query("SET LOCAL lock_timeout = '5s'");
      for (const key of keys) {
        const lock = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [key],
        );
        if (lock.rowCount !== 1 || lock.rows.length !== 1 || lock.rows[0]?.locked !== true) {
          throw new Error('Unconfirmed transition lock');
        }
      }
      const pending = await transitionInTransaction(client,
        status === 'reconciliation_required' ? [op, ...ambiguousOperations.map(item => item.operation)] : [op],
        status, code, observedProviderId ?? op.provider_user_id);
      const observedCommit = ambiguousOperations.find(item => isDeepStrictEqual(item.operation, pending.source));
      await commitOperation(pending, observedCommit?.audits);
    } catch {
      await rollback();
      throw new Error('Operation transition unconfirmed');
    }
  }

  async function markUncertain(code: string): Promise<Result> {
    if (op) {
      try { await ownedTransition('reconciliation_required', code); }
      catch {
        client?.release(true);
        client = undefined;
        try { await ownedTransition('reconciliation_required', code); }
        catch {
          // The preceding checked phase still blocks replay during a DB outage.
          logger.error({ operationId: op.id, failureCode: 'journal_update_failed' },
            'Admin credential binding requires reconciliation');
        }
      }
    }
    return reconciliation(op ? { ...op, provider_user_id: observedProviderId ?? op.provider_user_id } : undefined);
  }

  async function reserveUncertainIntent(): Promise<Result> {
    // No provider call has started. Resolve the uncertain DB transaction by
    // serialization and an exact reservation, never by trusting an absent GET.
    let persisted = false;
    try {
      if (!client) {
        held.length = 0; // The discarded session released its session locks.
        client = await pool.connect();
      }
      await beginTransaction(client);
      await client.query("SET LOCAL lock_timeout = '5s'");
      for (const key of keys) {
        const lock = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [key],
        );
        if (lock.rowCount !== 1 || lock.rows.length !== 1 || lock.rows[0]?.locked !== true) {
          throw new Error('Unconfirmed intent recovery lock');
        }
      }
      await commitOperation(await insertIntent(client, op!, true));
      persisted = true;
    } catch {
      await rollback();
      // The reservation may exist, but a database outage can prevent even the
      // recovery evidence write. Expose unknown; never claim durable rollback.
      logger.error({ operationId: op?.id, failureCode: 'intent_reconciliation_unconfirmed' },
        'Admin credential intent requires reconciliation; provider was not called');
    }
    return { status: 503, body: { ...reconciliation(op).body,
      provider_creation_attempted: false, intent_persistence: persisted ? 'confirmed' : 'unconfirmed' } };
  }

  async function run(): Promise<Result> {
    client = await pool.connect();
    for (const key of keys) {
      try {
        const lock = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key],
        );
        if (lock.rowCount !== 1 || lock.rows.length !== 1) throw new Error('Unconfirmed lock cardinality');
        if (lock.rows[0]?.locked === false) {
          return { status: 409, body: { error: 'credential_bind_in_progress' } };
        }
        if (lock.rows[0]?.locked !== true) throw new Error('Unconfirmed lock acquisition');
        held.push(key);
      } catch {
        // The server may have granted a lock whose reply was lost. Never put
        // that session back in the pool, even though it is not in held yet.
        destroy = true;
        throw new Error('Unconfirmed lock acquisition');
      }
    }

    // Require a real credential and the identity observed by authentication.
    const actor = await client.query(
      `SELECT 1 FROM identity_workos_users WHERE workos_user_id = $1 AND identity_id = $2`,
      [input.actorUserId, input.actorIdentityId],
    );
    if (actor.rowCount !== 1) return { status: 403, body: { error: 'actor_identity_changed' } };

    const prior = await client.query<Operation>(
      `SELECT *, ${ADMIN_CREDENTIAL_ROW_VERSION} FROM admin_credential_bind_operations WHERE email_hash = $1
        ORDER BY created_at DESC, id LIMIT 1`, [emailHash],
    );
    if (prior.rows[0]) {
      const existing = prior.rows[0];
      // A different authenticated credential may inspect the blocked outcome,
      // but cannot author a transition attributed to the operation's actor.
      if (existing.actor_user_id !== input.actorUserId || existing.actor_identity_id !== input.actorIdentityId) {
        return reconciliation(existing);
      }
      op = existing;
      if (existing.status === 'committed' && existing.host_user_id === input.hostUserId
        && existing.provider_user_id) {
        // A stable journal is not proof that the credential is still live.
        // Serialize replay with the same lifecycle writers as a fresh bind.
        try {
          await beginTransaction(client);
          await client.query("SET LOCAL lock_timeout = '5s'");
          const states = await lockCredentialLifecyclesInTransaction(client,
            [input.actorUserId, input.hostUserId, existing.provider_user_id]);
          const actorState = states.find(state => state.workos_user_id === input.actorUserId);
          if (!states.every(active) || actorState?.identity_id !== input.actorIdentityId) {
            throw new Error('Replay lifecycle changed');
          }
          const bound = await client.query(
            `SELECT 1 FROM identity_workos_users host
             JOIN identity_workos_users credential ON credential.identity_id = host.identity_id
             JOIN users u ON u.workos_user_id = credential.workos_user_id
            WHERE host.workos_user_id = $1 AND host.identity_id = $2 AND host.is_primary
              AND credential.workos_user_id = $3 AND NOT credential.is_primary AND LOWER(u.email) = $4`,
            [input.hostUserId, existing.host_identity_id, existing.provider_user_id, email],
          );
          if (bound.rowCount !== 1 || bound.rows.length !== 1) throw new Error('Replay binding changed');
          await verifyPhase([operationReceipt(existing),
            await existingOperationAudit(client, existing)]);
          if ((await client.query('COMMIT')).command !== 'COMMIT') throw new Error('Unconfirmed replay commit');
          return success(existing, email, true);
        } catch {
          await rollback();
          return await markUncertain('committed_lifecycle_unavailable');
        }
      }
      return reconciliation(existing);
    }

    const hostResult = await client.query<{
      email: string; first_name: string | null; last_name: string | null;
      identity_id: string | null; is_primary: boolean | null;
    }>(
      `SELECT u.email, u.first_name, u.last_name, b.identity_id, b.is_primary
         FROM users u LEFT JOIN identity_workos_users b USING (workos_user_id)
        WHERE u.workos_user_id = $1`, [input.hostUserId],
    );
    const host = hostResult.rows[0];
    if (!host) return { status: 404, body: { error: 'User not found' } };
    if (!host.identity_id || !host.is_primary) return { status: 409, body: { error: 'host_primary_required' } };
    if (host.email.toLowerCase() === email) return { status: 409, body: { error: 'This is already the user\'s primary email' } };
    const claimed = await client.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
    if (claimed.rowCount !== 0) return { status: 409, body: { error: 'This email already has an AAO account' } };

    // Construct the client before recording intent; missing configuration has
    // no provider outcome to adjudicate. SDK retries are disabled for mutations.
    const workos = dependencies.workos ?? getAdminCredentialMutationWorkos().userManagement;
    op = { id: randomUUID(), host_user_id: input.hostUserId, host_identity_id: host.identity_id,
      actor_user_id: input.actorUserId, actor_identity_id: input.actorIdentityId,
      provider_user_id: null, status: 'creating', email_hash: emailHash, failure_code: null };
    let intentCommitStarted = false;
    try {
      await beginTransaction(client);
      await commitOperation(await insertIntent(client, op), [], () => { intentCommitStarted = true; });
    } catch {
      const rolledBack = await rollback();
      if (!intentCommitStarted && rolledBack) {
        op = undefined; // Neither the intent nor its audit committed.
        return { status: 503, body: { error: 'credential_bind_unavailable' } };
      }
      return await reserveUncertainIntent();
    }

    let created: Awaited<ReturnType<Provider['createUser']>>;
    try {
      created = await workos.createUser({
        email, emailVerified: true,
        firstName: host.first_name ?? undefined, lastName: host.last_name ?? undefined,
      });
    } catch (error) {
      const status = (error as { status?: number })?.status;
      // No retryable status (408/429/5xx), transport failure or timeout can
      // establish that the write did not happen.
      if (status && [400, 401, 403, 404, 409, 422].includes(status)) {
        await ownedTransition('provider_rejected', 'provider_rejected');
        return { status: 409, body: { error: 'provider_rejected', operation_id: op.id,
          message: 'WorkOS rejected creation. Check the account in the WorkOS Dashboard.' } };
      }
      return await markUncertain('provider_create_ambiguous');
    }

    if (typeof created?.id === 'string' && /^user_[a-zA-Z0-9_]{1,250}$/.test(created.id)) {
      observedProviderId = created.id;
    }
    if (!observedProviderId ||
        created.id === input.hostUserId || created.email?.toLowerCase() !== email) {
      return await markUncertain('provider_response_invalid');
    }
    await ownedTransition('provider_created');

    let commitStarted = false;
    let rollbackConfirmed = false;
    let lifecycleValidated = false;
    let lifecycleFailure = 'credential_lifecycle_unavailable';
    try {
      await beginTransaction(client);
      await client.query("SET LOCAL lock_timeout = '5s'");
      const states = await lockCredentialLifecyclesInTransaction(client,
        [input.actorUserId, input.hostUserId, created.id]);
      if (states.some(state => state.terminal_marker)) {
        lifecycleFailure = 'credential_lifecycle_terminal';
        throw new Error('Terminal credential');
      }
      const newState = states.find(state => state.workos_user_id === created.id);
      if (!newState || !unseen(newState)) {
        lifecycleFailure = 'local_user_already_exists';
        throw new Error('Credential already has local state');
      }
      const currentHost = states.find(state => state.workos_user_id === input.hostUserId);
      const currentActor = states.find(state => state.workos_user_id === input.actorUserId);
      if (!active(currentHost) || !active(currentActor)) throw new Error('Inactive actor or host');
      lifecycleValidated = true;
      if (currentHost?.identity_id !== op.host_identity_id || !currentHost.is_primary
        || currentActor?.identity_id !== input.actorIdentityId) {
        throw new Error('Binding changed');
      }

      // No upsert: a webhook or another operation may already own local state.
      // The insert, singleton binding move, epoch and audit commit together.
      const inserted = await client.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
           workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
        [created.id, email, created.firstName, created.lastName, created.emailVerified,
          created.createdAt, created.updatedAt],
      );
      if (inserted.rowCount !== 1) throw new Error('Credential insert cardinality changed');
      const singleton = await client.query<{ identity_id: string }>(
        `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1 FOR UPDATE`, [created.id],
      );
      if (singleton.rowCount !== 1) throw new Error('Missing new binding');
      const bound = await client.query(
        `UPDATE identity_workos_users SET identity_id = $2, is_primary = FALSE, bound_at = NOW()
          WHERE workos_user_id = $1 AND identity_id = $3`,
        [created.id, op.host_identity_id, singleton.rows[0].identity_id],
      );
      if (bound.rowCount !== 1) throw new Error('Binding changed');
      await client.query(
        `DELETE FROM identities WHERE id = $1
          AND NOT EXISTS (SELECT 1 FROM identity_workos_users WHERE identity_id = $1)`,
        [singleton.rows[0].identity_id],
      );
      const siblings = await client.query<{ workos_user_id: string }>(
        'SELECT workos_user_id FROM identity_workos_users WHERE identity_id = $1', [op.host_identity_id],
      );
      const siblingIds = [...new Set(siblings.rows.map(row => row.workos_user_id))].sort();
      if (!siblingIds.includes(created.id) || !siblingIds.includes(input.hostUserId)) {
        throw new Error('Incomplete credential binding set');
      }
      const bumped = (await bumpAuthorizationEpochs(client, siblingIds)).sort();
      if (bumped.length !== siblingIds.length || bumped.some((id, index) => id !== siblingIds[index])) {
        throw new Error('Incomplete credential epoch update');
      }
      await commitOperation(await transitionInTransaction(client, [op], 'committed', null, created.id),
        [], () => { commitStarted = true; });
      result = success(op, email);
    } catch {
      rollbackConfirmed = await rollback();
      if (commitStarted || !rollbackConfirmed) {
        // A lost COMMIT reply may mean a real binding exists. Never delete it.
        result = await markUncertain('local_commit_ambiguous');
      } else if (!lifecycleValidated) {
        // A marker or uncertain lifecycle observation cannot authorize an
        // upstream delete, even though our own local writes rolled back.
        result = await markUncertain(lifecycleFailure);
      } else {
        // Commit a truthful admission quarantine before deleting upstream.
        // It survives provider ambiguity and deletion-evidence write failures.
        // Reacquire the same fence and verify exact quarantine ownership, then
        // retain it through delete, the confirmed-deletion marker and COMMIT.
        const compensationClient = client;
        if (!compensationClient) return await markUncertain('compensation_lifecycle_unavailable');
        const compensationActor = {
          workosUserId: created.id, operationId: op.id,
          actorUserId: op.actor_user_id, actorIdentityId: op.actor_identity_id,
        };
        let compensationFailure = 'compensation_quarantine_failed';
        try {
          await beginTransaction(compensationClient);
          await compensationClient.query("SET LOCAL lock_timeout = '5s'");
          const quarantine = await recordAdminCredentialCompensationQuarantine(compensationClient, compensationActor);
          await commitOperation(await transitionInTransaction(compensationClient, [op], 'compensating', 'local_write_failed', created.id),
            [quarantine], () => { compensationFailure = 'compensation_quarantine_commit_ambiguous'; });

          compensationFailure = 'compensation_lifecycle_unavailable';
          await beginTransaction(compensationClient);
          await compensationClient.query("SET LOCAL lock_timeout = '5s'");
          const retainedQuarantine = await lockAdminCredentialCompensationQuarantine(compensationClient, compensationActor);
          await verifyPhase([...durableAudits, retainedQuarantine, operationReceipt(op)]);
          compensationFailure = 'provider_compensation_failed';
          await workos.deleteUser(created.id);
          compensationFailure = 'confirmed_delete_evidence_failed';
          const deletion = await recordConfirmedAdminCredentialCompensationDeletion(compensationClient, compensationActor);
          await commitOperation(await transitionInTransaction(compensationClient, [op], 'compensated', 'local_write_failed', created.id),
            [retainedQuarantine, deletion], () => { compensationFailure = 'compensation_commit_ambiguous'; });
        } catch {
          await rollback();
          return await markUncertain(compensationFailure);
        }
        result = { status: 500, body: { error: 'Failed to bind sign-in email', operation_id: op.id,
          compensated: true, message: 'The new WorkOS user was rolled back. Engineering adjudication is required before another attempt.' } };
      }
    }
    return result;
  }
  try {
    result = await run();
  } catch {
    result = op ? await markUncertain('operation_interrupted')
      : { status: 503, body: { error: 'credential_bind_unavailable' } };
  } finally {
    if (client) {
      for (const key of held.reverse()) {
        try {
          const unlock = await client.query<{ unlocked: boolean }>(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key],
          );
          if (unlock.rowCount !== 1 || unlock.rows.length !== 1 || unlock.rows[0]?.unlocked !== true) destroy = true;
        } catch { destroy = true; }
      }
      client.release(destroy);
      client = undefined;
      if (destroy) {
        logger.error({ operationId: op?.id, failureCode: 'lock_release_unconfirmed' },
          'Admin credential binding connection discarded');
        result = await markUncertain('lock_release_unconfirmed');
        // Recovery used transaction locks on a replacement connection.
        discardClient();
      }
    }
  }
  return result;
}
