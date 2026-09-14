import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { getPool } from './client.js';

export class CredentialDetachConflict extends Error {}

export interface DetachCredentialInput {
  hostUserId: string;
  credentialId: string;
  expectedIdentityId: string;
  expectedAuthorizationEpoch: string;
  actorUserId: string;
  actorCredentialId: string;
  actorIdentityId: string;
}

function exactlyOne<T extends QueryResultRow>(result: QueryResult<T>, operation: string): T {
  if (result.rowCount !== 1 || result.rows.length !== 1 || !result.rows[0]) {
    throw new Error(`Credential detach: ${operation} did not return exactly one row`);
  }
  return result.rows[0];
}

/**
 * Detach only the observed non-primary credential/person binding. Authority
 * rows are never consolidated or reconstructed, including after legacy merges.
 *
 * Lock order: sorted identity advisory keys, sorted identity rows, sorted
 * binding rows, sorted credential lifecycle try-locks, sorted user rows,
 * sorted bind-operation rows, sorted epoch writes. Every acquisition that can
 * conflict with the parent's credential-before-binding protocol is nonblocking:
 * NOWAIT/try-lock failure rolls back instead of creating an inverse-order wait.
 * Session locks are checked and released BEFORE COMMIT while row locks still
 * protect the binding: an unlock failure must roll back the entire operation.
 * Any failure destroys the connection, releasing even an uncertain session lock.
 */
export async function detachCredential(input: DetachCredentialInput): Promise<{
  newIdentityId: string;
  affectedCredentialIds: string[];
}> {
  const client = await getPool().connect();
  let destroyClient = false;
  try {
    await client.query('BEGIN');
    const identityIds = [...new Set([input.expectedIdentityId, input.actorIdentityId])].sort();
    const lockKeys = identityIds.map((id) => `identity-binding:${id}`);
    for (const key of lockKeys) {
      const lock = exactlyOne(await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key],
      ), 'advisory lock');
      if (lock.acquired === false) throw new CredentialDetachConflict('Identity binding is busy; reload and retry');
      if (lock.acquired !== true) throw new Error('Credential detach: advisory lock was not acquired');
    }

    const identities = await client.query<{ id: string }>(
      `SELECT id FROM identities WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT`,
      [identityIds],
    );
    if (identities.rowCount !== identityIds.length) {
      throw new CredentialDetachConflict('Identity changed; reload credentials');
    }
    const bindings = await client.query<{
      workos_user_id: string; identity_id: string; is_primary: boolean;
    }>(
      `SELECT workos_user_id, identity_id, is_primary FROM identity_workos_users
        WHERE identity_id = ANY($1::uuid[]) ORDER BY workos_user_id FOR UPDATE NOWAIT`,
      [identityIds],
    );
    const credentialIds = bindings.rows.map((row) => row.workos_user_id).sort();
    if (bindings.rowCount !== credentialIds.length || new Set(credentialIds).size !== credentialIds.length ||
        bindings.rows.some((row) => !row.workos_user_id || !identityIds.includes(row.identity_id) ||
          typeof row.is_primary !== 'boolean')) {
      throw new Error('Credential detach: binding locks were not confirmed');
    }
    // Bind/deletion writers use this same credential fence. Acquiring it after
    // our NOWAIT row locks avoids an unlocked discovery snapshot; try-locks
    // ensure an earlier lifecycle writer always makes this detach fail closed.
    for (const credentialId of credentialIds) {
      const lock = exactlyOne(await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 6827)) AS acquired', [credentialId],
      ), 'credential lifecycle lock');
      if (lock.acquired === false) throw new CredentialDetachConflict('Credential lifecycle is busy; reload and retry');
      if (lock.acquired !== true) throw new Error('Credential detach: lifecycle lock was not acquired');
    }
    const host = bindings.rows.find((row) => row.workos_user_id === input.hostUserId);
    const target = bindings.rows.find((row) => row.workos_user_id === input.credentialId);
    const actor = bindings.rows.find((row) => row.workos_user_id === input.actorCredentialId);
    const actorPrimaries = bindings.rows.filter((row) => row.identity_id === input.actorIdentityId && row.is_primary);
    if (actor?.identity_id !== input.actorIdentityId || actorPrimaries.length !== 1 ||
        actorPrimaries[0].workos_user_id !== input.actorUserId) {
      throw new CredentialDetachConflict('Acting identity changed; authenticate again');
    }
    if (host?.identity_id !== input.expectedIdentityId || target?.identity_id !== input.expectedIdentityId) {
      throw new CredentialDetachConflict('Credential binding changed; reload credentials');
    }
    if (target.is_primary || input.hostUserId === input.credentialId) {
      throw new CredentialDetachConflict('Cannot remove the primary credential');
    }
    if (bindings.rows.filter((row) => row.identity_id === input.expectedIdentityId && row.is_primary).length !== 1) {
      throw new CredentialDetachConflict('Identity has no primary credential; repair it before detaching');
    }
    const affectedCredentialIds = bindings.rows
      .filter((row) => row.identity_id === input.expectedIdentityId)
      .map((row) => row.workos_user_id).sort();
    // Keep the complete actor/affected graphs live, including the canonical
    // actor, until all required epochs and the attributed audit are committed.
    const liveUsers = await client.query<{ workos_user_id: string }>(
      `SELECT workos_user_id FROM users WHERE workos_user_id = ANY($1)
        ORDER BY workos_user_id FOR UPDATE NOWAIT`, [credentialIds],
    );
    if (liveUsers.rowCount !== credentialIds.length || liveUsers.rows.length !== credentialIds.length ||
        new Set(liveUsers.rows.map((row) => row.workos_user_id)).size !== credentialIds.length ||
        liveUsers.rows.some((row) => !credentialIds.includes(row.workos_user_id))) {
      throw new CredentialDetachConflict('Credential lifecycle changed; reload credentials');
    }
    async function requireActiveLifecycle() {
      // Journal reconciliation can be recorded after a bind has released its
      // lifecycle fence. Lock every matching row, including committed rows,
      // before checking status so that transition serializes with this detach.
      const operations = await client.query<{ id: string; provider_user_id: string; status: string }>(
        `SELECT id, provider_user_id, status FROM admin_credential_bind_operations
          WHERE provider_user_id = ANY($1) ORDER BY id FOR UPDATE NOWAIT`, [credentialIds],
      );
      if (operations.rowCount !== operations.rows.length ||
          new Set(operations.rows.map((row) => row.id)).size !== operations.rows.length ||
          operations.rows.some((row) => !row.id || !credentialIds.includes(row.provider_user_id) || row.status !== 'committed')) {
        throw new CredentialDetachConflict('Credential lifecycle requires reconciliation');
      }
      const marker = exactlyOne(await client.query<{ blocked: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM registry_audit_log
           WHERE (workos_user_id = ANY($1) AND action IN (
             'identity_credential_deleted', 'identity_primary_deletion_quarantined',
             'identity_credential_admin_compensation_deleted', 'identity_credential_admin_compensation_quarantined'))
              OR (action = 'admin_credential_bind' AND details->>'provider_user_id' = ANY($1)
                  AND details->>'status' IN ('reconciliation_required', 'compensating', 'compensated'))
        ) AS blocked`, [credentialIds],
      ), 'lifecycle marker check');
      // Bind audits attribute workos_user_id to the actor: only their explicit
      // provider_user_id identifies the credential that requires reconciliation.
      if (marker.blocked !== false) throw new CredentialDetachConflict('Credential lifecycle is terminal or requires reconciliation');
    }
    await requireActiveLifecycle();
    const beforeEpochs = await client.query<{ workos_user_id: string; epoch: string }>(
      `SELECT workos_user_id, epoch::text FROM authorization_epochs WHERE workos_user_id = ANY($1)
        ORDER BY workos_user_id FOR UPDATE NOWAIT`, [affectedCredentialIds],
    );
    const previousEpochs = new Map(beforeEpochs.rows.map((row) => [row.workos_user_id, row.epoch]));
    if ((previousEpochs.get(input.credentialId) ?? '0') !== input.expectedAuthorizationEpoch) {
      throw new CredentialDetachConflict('Credential authorization changed; reload credentials');
    }

    const newIdentityId = randomUUID();
    const newIdentity = exactlyOne(await client.query<{ id: string }>(
      'INSERT INTO identities (id) VALUES ($1) RETURNING id', [newIdentityId],
    ), 'identity insert');
    if (newIdentity.id !== newIdentityId) throw new Error('Credential detach: identity insert failed');
    const detached = exactlyOne(await client.query<{ workos_user_id: string; identity_id: string; is_primary: boolean }>(
      `UPDATE identity_workos_users SET identity_id = $1, is_primary = TRUE, bound_at = NOW()
        WHERE workos_user_id = $2 AND identity_id = $3 AND is_primary = FALSE
        RETURNING workos_user_id, identity_id, is_primary`,
      [newIdentityId, input.credentialId, input.expectedIdentityId],
    ), 'binding update');
    if (detached.workos_user_id !== input.credentialId || detached.identity_id !== newIdentityId || detached.is_primary !== true) {
      throw new Error('Credential detach: binding update failed');
    }

    // Every session on the old identity must observe the binding change, even
    // when the URL's host is itself secondary. Check suppression as well as errors.
    const epochs = await client.query<{ workos_user_id: string; epoch: string }>(
      `INSERT INTO authorization_epochs (workos_user_id, epoch)
       SELECT workos_user_id, 1 FROM users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id
       ON CONFLICT (workos_user_id) DO UPDATE
         SET epoch = authorization_epochs.epoch + 1, updated_at = NOW()
       RETURNING workos_user_id, epoch::text`, [affectedCredentialIds],
    );
    function verifyEpochs(result: typeof epochs) {
      if (result.rowCount !== affectedCredentialIds.length || result.rows.length !== affectedCredentialIds.length ||
          new Set(result.rows.map((row) => row.workos_user_id)).size !== affectedCredentialIds.length ||
          result.rows.some((row) => !affectedCredentialIds.includes(row.workos_user_id) || !row.epoch ||
            BigInt(row.epoch) !== BigInt(previousEpochs.get(row.workos_user_id) ?? '0') + 1n)) {
        throw new Error('Credential detach: authorization epochs were not advanced');
      }
    }
    verifyEpochs(epochs);

    const auditId = randomUUID();
    const details = JSON.stringify({
      operation_id: auditId,
      host_user_id: input.hostUserId,
      affected_workos_user_id: input.credentialId,
      detached_from_identity_id: input.expectedIdentityId,
      new_identity_id: newIdentityId,
      acting_workos_user_id: input.actorCredentialId,
      acting_identity_id: actor.identity_id,
      expected_authorization_epoch: input.expectedAuthorizationEpoch,
      affected_credential_ids: affectedCredentialIds,
    });
    const audit = exactlyOne(await client.query<{ id: string }>(
      `INSERT INTO registry_audit_log (
        id, workos_organization_id, workos_user_id, action, resource_type, resource_id, details
      ) VALUES ($1, 'system', $2, 'unbind_credential', 'user', $3, $4) RETURNING id`,
      [auditId, input.actorUserId, input.credentialId, details],
    ), 'audit insert');
    if (audit.id !== auditId) throw new Error('Credential detach: audit insert returned an invalid id');
    // Flush deferred triggers before the final stored-state checks; otherwise
    // they could suppress the audit or epoch advance during COMMIT itself.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await requireActiveLifecycle();
    verifyEpochs(await client.query<{ workos_user_id: string; epoch: string }>(
      `SELECT workos_user_id, epoch::text FROM authorization_epochs WHERE workos_user_id = ANY($1)
        ORDER BY workos_user_id`, [affectedCredentialIds],
    ));
    // RETURNING alone cannot detect an AFTER INSERT trigger deleting or
    // duplicating the audit. Require exactly one stored record for this operation.
    const storedAudit = exactlyOne(await client.query<{ id: string; matches: boolean }>(
      `SELECT id, (workos_organization_id = 'system' AND workos_user_id = $2
        AND action = 'unbind_credential' AND resource_type = 'user' AND resource_id = $3
        AND details = $4::jsonb) AS matches
        FROM registry_audit_log WHERE details->>'operation_id' = $1`,
      [auditId, input.actorUserId, input.credentialId, details],
    ), 'stored audit');
    if (storedAudit.id !== auditId || storedAudit.matches !== true) throw new Error('Credential detach: audit record is missing or changed');

    for (const key of [...lockKeys].reverse()) {
      const unlock = exactlyOne(await client.query<{ unlocked: boolean }>(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key],
      ), 'advisory unlock');
      if (unlock.unlocked !== true) throw new Error('Credential detach: advisory unlock failed');
    }
    await client.query('COMMIT');
    return { newIdentityId, affectedCredentialIds };
  } catch (error) {
    destroyClient = true;
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '55P03') {
      throw new CredentialDetachConflict('Identity binding is busy; reload and retry');
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
}
