import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkOS } from '@workos-inc/node';
import { getPool } from '../db/client.js';
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
interface Operation {
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

// Only allowlisted fields reach the audit log; never serialize SDK errors,
// request/response bodies, email addresses, tokens, or credential material.
const auditSql = `INSERT INTO registry_audit_log
  (workos_organization_id, workos_user_id, action, resource_type, resource_id, details)
  SELECT 'system', actor_user_id, 'admin_credential_bind',
         'admin_credential_bind_operation', id::text,
         jsonb_build_object('status', status, 'failure_code', failure_code,
           'acting_workos_user_id', actor_user_id, 'actor_identity_id', actor_identity_id,
           'host_user_id', host_user_id, 'host_identity_id', host_identity_id,
           'provider_user_id', provider_user_id)
    FROM operation`;

async function transition(db: Pick<Pool | PoolClient, 'query'>, op: Operation,
  status: Status, failureCode: string | null = null): Promise<void> {
  const result = await db.query(
    `WITH operation AS (
       UPDATE admin_credential_bind_operations
          SET status = $2, failure_code = $3, provider_user_id = $4, updated_at = NOW()
        WHERE id = $1 RETURNING *
     ) ${auditSql}`,
    [op.id, status, failureCode, op.provider_user_id],
  );
  if (result.rowCount !== 1) throw new Error('Missing operation journal');
  op.status = status;
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
  let destroy = false;
  let result: Result = { status: 503, body: { error: 'credential_bind_unavailable' } };

  async function rollback(): Promise<boolean> {
    if (!client) return false;
    try {
      if ((await client.query('ROLLBACK')).command === 'ROLLBACK') return true;
    } catch { /* An unconfirmed rollback must never authorize compensation. */ }
    client.release(true);
    client = undefined;
    return false;
  }

  async function markUncertain(code: string): Promise<Result> {
    if (op) {
      try { await transition(client ?? pool, op, 'reconciliation_required', code); }
      catch {
        // Release a broken session before using a second connection, so a
        // pool full of failing requests cannot deadlock its own evidence writes.
        client?.release(true);
        client = undefined;
        try { await transition(pool, op, 'reconciliation_required', code); }
        catch {
          // The precommitted intent still blocks replay during a DB outage.
          logger.error({ operationId: op.id, failureCode: 'journal_update_failed' },
            'Admin credential binding requires reconciliation');
        }
      }
    }
    return reconciliation(op);
  }

  async function run(): Promise<Result> {
    client = await pool.connect();
    for (const key of keys) {
      try {
        const lock = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key],
        );
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
      `SELECT * FROM admin_credential_bind_operations WHERE email_hash = $1
        AND status NOT IN ('compensated', 'provider_rejected')`, [emailHash],
    );
    if (prior.rows[0]) {
      const existing = prior.rows[0];
      op = existing;
      if (existing.status === 'committed' && existing.host_user_id === input.hostUserId
        && existing.provider_user_id) {
        // A stable journal is not proof that the credential is still live.
        // Serialize replay with the same lifecycle writers as a fresh bind.
        try {
          await client.query('BEGIN');
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
    const intent = await client.query<Operation>(
      `WITH operation AS (
         INSERT INTO admin_credential_bind_operations
           (email_hash, host_user_id, host_identity_id, actor_user_id, actor_identity_id, status)
         VALUES ($1, $2, $3, $4, $5, 'creating') RETURNING *
       ), audit AS (${auditSql}) SELECT * FROM operation`,
      [emailHash, input.hostUserId, host.identity_id, input.actorUserId, input.actorIdentityId],
    );
    op = intent.rows[0];
    if (!op) throw new Error('Missing operation intent');

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
        await transition(client, op, 'provider_rejected', 'provider_rejected');
        return { status: 409, body: { error: 'provider_rejected', operation_id: op.id,
          message: 'WorkOS rejected creation. Check the account in the WorkOS Dashboard.' } };
      }
      return await markUncertain('provider_create_ambiguous');
    }

    if (typeof created?.id === 'string' && /^user_[a-zA-Z0-9_]{1,250}$/.test(created.id)) {
      op.provider_user_id = created.id;
    }
    if (!op.provider_user_id ||
        created.id === input.hostUserId || created.email?.toLowerCase() !== email) {
      return await markUncertain('provider_response_invalid');
    }
    await transition(client, op, 'provider_created');

    let commitStarted = false;
    let rollbackConfirmed = false;
    let lifecycleValidated = false;
    let lifecycleFailure = 'credential_lifecycle_unavailable';
    try {
      await client.query('BEGIN');
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
      await transition(client, op, 'committed');
      commitStarted = true;
      const commit = await client.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new Error('Unconfirmed commit');
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
          await compensationClient.query('BEGIN');
          await compensationClient.query("SET LOCAL lock_timeout = '5s'");
          await recordAdminCredentialCompensationQuarantine(compensationClient, compensationActor);
          await transition(compensationClient, op, 'compensating', 'local_write_failed');
          compensationFailure = 'compensation_quarantine_commit_ambiguous';
          if ((await compensationClient.query('COMMIT')).command !== 'COMMIT') throw new Error('Unconfirmed quarantine commit');

          compensationFailure = 'compensation_lifecycle_unavailable';
          await compensationClient.query('BEGIN');
          await compensationClient.query("SET LOCAL lock_timeout = '5s'");
          await lockAdminCredentialCompensationQuarantine(compensationClient, compensationActor);
          compensationFailure = 'provider_compensation_failed';
          await workos.deleteUser(created.id);
          compensationFailure = 'confirmed_delete_evidence_failed';
          await recordConfirmedAdminCredentialCompensationDeletion(compensationClient, compensationActor);
          await transition(compensationClient, op, 'compensated', 'local_write_failed');
          compensationFailure = 'compensation_commit_ambiguous';
          if ((await compensationClient.query('COMMIT')).command !== 'COMMIT') throw new Error('Unconfirmed compensation commit');
        } catch {
          await rollback();
          return await markUncertain(compensationFailure);
        }
        result = { status: 500, body: { error: 'Failed to bind sign-in email', operation_id: op.id,
          compensated: true, message: 'The new WorkOS user was rolled back. Please retry.' } };
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
          if (unlock.rows[0]?.unlocked !== true) destroy = true;
        } catch { destroy = true; }
      }
      client.release(destroy);
      client = undefined;
      if (destroy) {
        logger.error({ operationId: op?.id, failureCode: 'lock_release_unconfirmed' },
          'Admin credential binding connection discarded');
        result = await markUncertain('lock_release_unconfirmed');
      }
    }
  }
  return result;
}
