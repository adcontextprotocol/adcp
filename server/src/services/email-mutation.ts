import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { getEmailMutationWorkos } from '../auth/workos-client.js';
import { createLogger } from '../logger.js';
import { isEmailUnavailable } from '../routes/account-linking-errors.js';

const logger = createLogger('email-mutation');
export const EMAIL_RECONCILIATION_MESSAGE = 'Your email change needs support reconciliation with our sign-in provider. Email changes are disabled until support confirms the outcome. Please contact support.';

interface EmailMutation {
  id: string;
  workos_user_id: string;
  old_email: string;
  old_email_verified: boolean;
  new_email: string;
  state: 'pending' | 'succeeded' | 'compensated' | 'reconciliation_required';
  failure_code?: string | null;
}

export class EmailMutationError extends Error {
  constructor(public status: number, public body: {
    error: string;
    message?: string;
    reconciliation_required?: boolean;
    operation_id?: string;
  }) {
    super(body.message ?? body.error);
  }
}

function reconciliationError(operationId?: string): EmailMutationError {
  return new EmailMutationError(409, {
    error: 'Email reconciliation required',
    message: EMAIL_RECONCILIATION_MESSAGE,
    reconciliation_required: true,
    ...(operationId ? { operation_id: operationId } : {}),
  });
}

export async function getEmailMutationStatus(userId: string, client?: Pick<PoolClient, 'query'>): Promise<{
  reconciliation_required: boolean;
  message?: string;
  operation_id?: string;
}> {
  const result = await (client ?? getPool()).query<{ id: string }>(
    `SELECT id FROM email_mutations WHERE workos_user_id = $1
       AND state IN ('pending', 'reconciliation_required') LIMIT 1`, [userId],
  );
  return result.rows[0]
    ? { reconciliation_required: true, message: EMAIL_RECONCILIATION_MESSAGE, operation_id: result.rows[0].id }
    : { reconciliation_required: false };
}

async function withCredentialLock<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let locked = false;
  // If acquiring the lock loses its response, ownership is itself unknown.
  let discard = true;
  try {
    // Session scope keeps provider work serialized across local transactions.
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 6827)) AS locked', [userId],
    );
    const lockResult = result.rows[0]?.locked;
    locked = lockResult === true;
    discard = typeof lockResult !== 'boolean';
    if (!locked) throw reconciliationError();
    return await work(client);
  } finally {
    if (locked) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtextextended($1, 6827)) AS unlocked', [userId],
        );
        discard = result.rows[0]?.unlocked !== true;
      } catch {
        discard = true;
      }
      if (discard) logger.error({ userId, code: 'advisory_unlock_failed' }, 'Discarding email mutation connection');
    }
    client.release(discard);
  }
}

async function recordFailure(client: PoolClient, operation: EmailMutation, code: string): Promise<void> {
  // An unavailable database leaves the durable pending intent blocking retries.
  // Never overwrite a succeeded transaction after losing its COMMIT response.
  try {
    await client.query(
      `UPDATE email_mutations SET state = 'reconciliation_required', failure_code = $2, updated_at = NOW()
       WHERE id = $1 AND state IN ('pending', 'reconciliation_required')`, [operation.id, code],
    );
  } catch { /* The existing intent is still unresolved. */ }
  logger.warn({ operationId: operation.id, userId: operation.workos_user_id, code }, 'Email mutation requires reconciliation');
}

function definitiveRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  // 408, 5xx and transport errors are ambiguous even when a subsequent GET
  // still returns the old email: the original request can complete later.
  return typeof status === 'number' && [400, 401, 403, 404, 409, 422].includes(status);
}

async function restoreProvider(operation: EmailMutation): Promise<void> {
  const restored = await getEmailMutationWorkos().userManagement.updateUser({
    userId: operation.workos_user_id,
    email: operation.old_email,
    emailVerified: operation.old_email_verified,
  });
  if (restored.id !== operation.workos_user_id
      || restored.email.toLowerCase() !== operation.old_email.toLowerCase()
      || restored.emailVerified !== operation.old_email_verified) {
    throw new Error('Provider restoration was not acknowledged');
  }
}

async function restoreLocal(client: PoolClient, operation: EmailMutation): Promise<void> {
  // The alias swap was rolled back (or never started). Refresh only this
  // credential's email denormalizations; never transfer membership provenance.
  const user = await client.query(
    `UPDATE users SET email = $1, email_verified = $3, updated_at = NOW() WHERE workos_user_id = $2
     RETURNING workos_user_id`, [operation.old_email, operation.workos_user_id, operation.old_email_verified],
  );
  if (user.rows.length !== 1) throw new Error('Credential no longer exists');
  await client.query(
    `UPDATE organization_memberships SET email = $1, updated_at = NOW()
     WHERE workos_user_id = $2 AND email IS DISTINCT FROM $1`, [operation.old_email, operation.workos_user_id],
  );
  await client.query(
    `UPDATE person_relationships SET email = $1, updated_at = NOW()
     WHERE workos_user_id = $2 AND email IS DISTINCT FROM $1`, [operation.old_email, operation.workos_user_id],
  );
}

async function compensate(client: PoolClient, operation: EmailMutation): Promise<void> {
  try {
    await restoreProvider(operation);
    await client.query('BEGIN');
    await restoreLocal(client, operation);
    await client.query(
      `UPDATE email_mutations SET state = 'compensated', updated_at = NOW() WHERE id = $1`, [operation.id],
    );
    await client.query('COMMIT');
    logger.info({ operationId: operation.id, userId: operation.workos_user_id }, 'Email mutation compensated');
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    await recordFailure(client, operation, 'compensation_failed');
    throw reconciliationError(operation.id);
  }
}

/** Mutate the exact signed-in credential, never an identity's canonical user. */
export async function setPrimaryEmail(input: {
  userId: string;
  email: unknown;
  actorUserId?: string;
}): Promise<{ primary_email: string; operation_id?: string }> {
  if (typeof input.email !== 'string' || !input.email.trim()) {
    throw new EmailMutationError(400, { error: 'Email is required' });
  }
  const normalizedEmail = input.email.trim().toLowerCase();
  const at = normalizedEmail.indexOf('@');
  const dot = normalizedEmail.lastIndexOf('.');
  if (normalizedEmail.length > 255 || /\s/.test(normalizedEmail)
      || at < 1 || at !== normalizedEmail.lastIndexOf('@')
      || dot <= at + 1 || dot === normalizedEmail.length - 1) {
    throw new EmailMutationError(400, { error: 'Invalid email address' });
  }
  return withCredentialLock(input.userId, async (client) => {
    const unresolved = await getEmailMutationStatus(input.userId, client);
    if (unresolved.reconciliation_required) throw reconciliationError(unresolved.operation_id);
    const local = await client.query<{ email: string; email_verified: boolean }>(
      'SELECT email, email_verified FROM users WHERE workos_user_id = $1', [input.userId],
    );
    if (!local.rows[0]) throw new EmailMutationError(404, { error: 'User not found' });
    const alreadyPrimary = local.rows[0].email.toLowerCase() === normalizedEmail;
    let targetEmail = local.rows[0].email;
    if (!alreadyPrimary) {
      const alias = await client.query<{ email: string }>(
        `SELECT email FROM user_email_aliases
         WHERE workos_user_id = $1 AND LOWER(email) = $2 AND verified_at IS NOT NULL`, [input.userId, normalizedEmail],
      );
      if (!alias.rows[0]) throw new EmailMutationError(404, { error: 'Email is not linked to your account' });
      targetEmail = alias.rows[0].email;
    }

    let original;
    try {
      original = await getEmailMutationWorkos().userManagement.getUser(input.userId);
    } catch {
      throw new EmailMutationError(503, { error: 'Sign-in provider unavailable', message: 'Your email was not changed. Please try again later.' });
    }
    const providerMatches = original.id === input.userId
      && original.email.toLowerCase() === local.rows[0].email.toLowerCase()
      && original.emailVerified === local.rows[0].email_verified;
    if (alreadyPrimary && providerMatches) {
      // A lost success response can be retried only with provider agreement.
      return { primary_email: local.rows[0].email };
    }
    const operation: EmailMutation = {
      id: randomUUID(), workos_user_id: input.userId, old_email: original.email,
      old_email_verified: original.emailVerified, new_email: targetEmail,
      state: providerMatches ? 'pending' : 'reconciliation_required',
      failure_code: providerMatches ? null : 'preexisting_provider_mismatch',
    };
    await client.query(
      `INSERT INTO email_mutations (id, workos_user_id, actor_user_id, old_email, old_email_verified, new_email, state, failure_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [operation.id, input.userId, input.actorUserId ?? input.userId, operation.old_email,
        operation.old_email_verified, operation.new_email, operation.state, operation.failure_code],
    );
    if (!providerMatches) {
      logger.warn({ operationId: operation.id, userId: input.userId, code: operation.failure_code }, 'Email mutation requires baseline reconciliation');
      throw reconciliationError(operation.id);
    }

    let changed;
    try {
      changed = await getEmailMutationWorkos().userManagement.updateUser({
        userId: input.userId, email: operation.new_email, emailVerified: true,
      });
    } catch (error) {
      if (!definitiveRejection(error)) {
        await recordFailure(client, operation, 'provider_outcome_unknown');
        throw reconciliationError(operation.id);
      }
      await client.query(
        `UPDATE email_mutations SET state = 'compensated', failure_code = 'provider_rejected', updated_at = NOW()
         WHERE id = $1`, [operation.id],
      );
      throw new EmailMutationError(isEmailUnavailable(error) ? 409 : 502, {
        error: 'Sign-in provider rejected the email change',
        message: 'Your email was not changed. Please try again later or contact support.',
      });
    }
    if (changed.id !== input.userId || changed.email.toLowerCase() !== normalizedEmail || changed.emailVerified !== true) {
      await recordFailure(client, operation, 'provider_response_mismatch');
      throw reconciliationError(operation.id);
    }

    let committing = false;
    try {
      await client.query('BEGIN');
      const lockedAlias = await client.query(
        `SELECT email FROM user_email_aliases
         WHERE workos_user_id = $1 AND LOWER(email) = $2 AND verified_at IS NOT NULL FOR UPDATE`,
        [input.userId, normalizedEmail],
      );
      if (!lockedAlias.rows[0]) throw new Error('Verified alias changed');
      const updatedUser = await client.query(
        `UPDATE users SET email = $1, email_verified = true, updated_at = NOW()
         WHERE workos_user_id = $2 RETURNING workos_user_id`, [operation.new_email, input.userId],
      );
      if (updatedUser.rows.length !== 1) throw new Error('Credential no longer exists');
      await client.query(
        'DELETE FROM user_email_aliases WHERE workos_user_id = $1 AND LOWER(email) = $2', [input.userId, normalizedEmail],
      );
      await client.query(
        `INSERT INTO user_email_aliases (workos_user_id, email, verified_at) VALUES ($1, $2, CASE WHEN $3 THEN NOW() ELSE NULL END)
         ON CONFLICT (workos_user_id, email) DO UPDATE SET verified_at = EXCLUDED.verified_at`,
        [input.userId, operation.old_email, operation.old_email_verified],
      );
      await client.query(
        `UPDATE organization_memberships SET email = $1, updated_at = NOW()
         WHERE workos_user_id = $2 AND email IS DISTINCT FROM $1`, [operation.new_email, input.userId],
      );
      await client.query(
        `UPDATE person_relationships SET email = $1, updated_at = NOW()
         WHERE workos_user_id = $2 AND email IS DISTINCT FROM $1`, [operation.new_email, input.userId],
      );
      await client.query("UPDATE email_mutations SET state = 'succeeded', updated_at = NOW() WHERE id = $1", [operation.id]);
      committing = true;
      await client.query('COMMIT');
      return { primary_email: operation.new_email, operation_id: operation.id };
    } catch {
      const rolledBack = await client.query('ROLLBACK').then(() => true, () => false);
      if (committing || !rolledBack) {
        await recordFailure(client, operation, 'local_commit_unknown');
        throw reconciliationError(operation.id);
      }
      await recordFailure(client, operation, 'local_write_failed');
      await compensate(client, operation);
      throw new EmailMutationError(503, {
        error: 'Email change failed', message: 'Your previous email was restored with our sign-in provider. Please try again later or contact support.',
      });
    }
  });
}

/**
 * Support-only repair, deliberately not exposed through a user route. A provider
 * terminal assurance (including completion/cancellation of EVERY timed-out
 * attempt) is required BEFORE this call. A GET showing the old value is not
 * evidence. References must identify a support record, never contain secrets.
 */
export async function reconcileEmailMutation(input: {
  operationId: string;
  actorUserId: string;
  providerTerminalConfirmed: true;
  evidenceReference: string;
}): Promise<{ reconciled: true }> {
  if (input.providerTerminalConfirmed !== true || !input.actorUserId
      || !/^[A-Za-z0-9_:/#.-]{1,200}$/.test(input.evidenceReference)) {
    throw new EmailMutationError(400, { error: 'Provider terminal assurance and support evidence are required' });
  }
  const lookup = await getPool().query<EmailMutation>('SELECT * FROM email_mutations WHERE id = $1', [input.operationId]);
  if (!lookup.rows[0]) throw new EmailMutationError(404, { error: 'Email mutation not found' });
  return withCredentialLock(lookup.rows[0].workos_user_id, async (client) => {
    const current = await client.query<EmailMutation>('SELECT * FROM email_mutations WHERE id = $1', [input.operationId]);
    const operation = current.rows[0];
    if (operation.state === 'succeeded' || operation.state === 'compensated') return { reconciled: true };
    // A disagreement predating this operation has no verified alias baseline
    // to roll back to. Support must repair that baseline explicitly; replaying
    // the provider snapshot could lose the local primary or duplicate an alias.
    if (operation.failure_code === 'preexisting_provider_mismatch') throw reconciliationError(operation.id);
    await client.query(
      `UPDATE email_mutations SET state = 'reconciliation_required',
         reconciliation_attempts = reconciliation_attempts || jsonb_build_array(jsonb_build_object(
           'actor_user_id', $2::text, 'evidence_reference', $3::text, 'started_at', NOW())), updated_at = NOW()
       WHERE id = $1`, [operation.id, input.actorUserId, input.evidenceReference],
    );
    await compensate(client, operation);
    return { reconciled: true };
  });
}
