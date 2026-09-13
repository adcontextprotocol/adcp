import { createHmac } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { getDedicatedClient, getPool } from '../db/client.js';
import { getEmailMutationWorkos } from '../auth/workos-client.js';
import { createLogger } from '../logger.js';
import { isEmailUnavailable } from '../routes/account-linking-errors.js';

const logger = createLogger('email-mutation');
export const EMAIL_RECONCILIATION_MESSAGE = 'Your email change needs support reconciliation with our sign-in provider. Email changes are disabled until support confirms the outcome. Please contact support.';
type ResultBody = { operation_id?: string; error?: string; message?: string; reconciliation_required?: boolean; retryable?: boolean; status?: string; primary_email?: string };
interface EmailMutation {
  id: string;
  workos_user_id: string;
  actor_user_id: string;
  payload_hash: string;
  old_email: string;
  old_email_verified: boolean;
  new_email: string;
  expected_email_version: string;
  applied_email_version: string | null;
  epoch_after: string | null;
  state: 'pending' | 'succeeded' | 'compensated' | 'reconciliation_required';
  failure_code: string | null;
  result_status: number;
  result_body: ResultBody;
}
type QueryClient = Pick<PoolClient, 'query'>;
class CommitUnknown extends Error {}

/** Stable request identity, not password storage. The domain key is public and
 * fixed so retries on different replicas/deployments compare the same payload. */
function emailMutationRequestFingerprint(userId: string, normalizedEmail: string): string {
  return createHmac('sha256', 'adcp:member-primary-email:idempotency:v1')
    .update(JSON.stringify([userId, normalizedEmail])).digest('hex');
}

export class EmailMutationError extends Error {
  constructor(public status: number, public body: ResultBody) { super(body.message ?? body.error); }
}
function reconciliationError(operationId: string): EmailMutationError {
  return new EmailMutationError(409, { error: 'Email reconciliation required', message: EMAIL_RECONCILIATION_MESSAGE, reconciliation_required: true, operation_id: operationId });
}
function busyError(): EmailMutationError {
  return new EmailMutationError(409, { error: 'credential_busy', message: 'An email change is already in progress. Please retry.', retryable: true });
}
function unrecordedError(): EmailMutationError {
  return new EmailMutationError(503, { error: 'Email change unavailable', message: 'Your email change could not be recorded. Please retry with the same request.', retryable: true });
}
function exactOne(result: { rowCount: number | null; rows: unknown[] }): void {
  if (result.rowCount !== 1 || result.rows.length !== 1) throw new Error('Expected exactly one affected row');
}
async function readOperation(client: QueryClient, id: string): Promise<EmailMutation | undefined> {
  const result = await client.query<EmailMutation>('SELECT * FROM email_mutations WHERE id = $1', [id]);
  if (result.rowCount === 0 && result.rows.length === 0) return undefined;
  exactOne(result);
  return result.rows[0];
}
const evidenceFields: Array<keyof EmailMutation> = ['id', 'workos_user_id', 'actor_user_id', 'payload_hash', 'old_email', 'old_email_verified', 'new_email', 'expected_email_version', 'applied_email_version', 'epoch_after', 'state', 'failure_code', 'result_status', 'result_body'];
function assertEvidence(actual: EmailMutation | undefined, expected: EmailMutation): void {
  if (!actual || evidenceFields.some(field => !isDeepStrictEqual(actual[field], expected[field]))) throw new Error('Email mutation evidence differs');
}
async function insertIntent(client: PoolClient, operation: EmailMutation): Promise<void> {
  try {
    await client.query('BEGIN');
    const inserted = await client.query<EmailMutation>(
    `INSERT INTO email_mutations (id, workos_user_id, actor_user_id, payload_hash, old_email, old_email_verified,
      new_email, expected_email_version, state, failure_code, result_status, result_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [operation.id, operation.workos_user_id, operation.actor_user_id, operation.payload_hash, operation.old_email,
      operation.old_email_verified, operation.new_email, operation.expected_email_version, operation.state,
      operation.failure_code, operation.result_status, operation.result_body],
  );
    exactOne(inserted);
    assertEvidence(inserted.rows[0], operation);
    assertEvidence(await readOperation(client, operation.id), operation);
    let acknowledged = false;
    try { acknowledged = (await client.query('COMMIT')).command === 'COMMIT'; } catch { /* Confirm on a fresh connection. */ }
    if (!acknowledged) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    const verifier = await getDedicatedClient();
    try { assertEvidence(await readOperation(verifier, operation.id), operation); }
    finally { await verifier.end(); }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
async function updateJournal(client: PoolClient, operation: EmailMutation): Promise<void> {
  const updated = await client.query<EmailMutation>(
    `UPDATE email_mutations SET state=$3, failure_code=$4, result_status=$5, result_body=$6,
      applied_email_version=$7, epoch_after=$8, updated_at=NOW()
     WHERE id=$1 AND workos_user_id=$2 AND state IN ('pending','reconciliation_required') RETURNING *`,
    [operation.id, operation.workos_user_id, operation.state, operation.failure_code, operation.result_status,
      operation.result_body, operation.applied_email_version, operation.epoch_after],
  );
  exactOne(updated);
  assertEvidence(updated.rows[0], operation);
  assertEvidence(await readOperation(client, operation.id), operation);
}
export async function getEmailMutationStatus(userId: string, client?: QueryClient): Promise<{ reconciliation_required: boolean; message?: string; operation_id?: string }> {
  const result = await (client ?? getPool()).query<{ id: string }>(
    `SELECT id FROM email_mutations WHERE workos_user_id=$1 AND state IN ('pending','reconciliation_required') LIMIT 1`, [userId],
  );
  return result.rows[0] ? { reconciliation_required: true, message: EMAIL_RECONCILIATION_MESSAGE, operation_id: result.rows[0].id } : { reconciliation_required: false };
}
async function withCredentialLock<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let locked = false;
  let discard = true;
  try {
    const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 6827)) AS locked', [userId]);
    const lockResult = result.rows[0]?.locked;
    locked = lockResult === true;
    discard = typeof lockResult !== 'boolean';
    if (!locked) throw busyError();
    return await work(client);
  } finally {
    if (locked) {
      try {
        const result = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtextextended($1, 6827)) AS unlocked', [userId]);
        discard = result.rows[0]?.unlocked !== true;
      } catch { discard = true; }
      if (discard) logger.error({ userId, code: 'advisory_unlock_failed' }, 'Discarding email mutation connection');
    }
    client.release(discard);
  }
}
async function recordFailure(client: PoolClient, operation: EmailMutation, code: string): Promise<void> {
  try {
    await client.query('BEGIN');
    const epoch = await bumpEpoch(client, operation.workos_user_id);
    const failure: EmailMutation = { ...operation, state: 'reconciliation_required', failure_code: code,
      applied_email_version: null, epoch_after: epoch, result_status: 409, result_body: operation.result_body };
    await updateJournal(client, failure);
    let acknowledged = false;
    try { acknowledged = (await client.query('COMMIT')).command === 'COMMIT'; } catch { /* Verify independently. */ }
    if (!acknowledged) await client.query('ROLLBACK').catch(() => undefined);
    const verifier = await getDedicatedClient();
    try {
      assertEvidence(await readOperation(verifier, operation.id), failure);
      const savedEpoch = await verifier.query<{ epoch: string }>('SELECT epoch FROM authorization_epochs WHERE workos_user_id=$1', [operation.workos_user_id]);
      exactOne(savedEpoch);
      if (savedEpoch.rows[0].epoch !== epoch) throw new Error('Reconciliation epoch unproven');
    } finally { await verifier.end(); }
    await invalidateCredential(operation.workos_user_id);
  } catch { await client.query('ROLLBACK').catch(() => undefined); /* The durable intent remains unresolved. */ }
  logger.warn({ operationId: operation.id, userId: operation.workos_user_id, code }, 'Email mutation requires reconciliation');
}
function definitiveRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && [400, 401, 403, 404, 409, 422].includes(status);
}
async function invalidateCredential(userId: string): Promise<void> {
  try {
    const { invalidateSessionsForUsers } = await import('../middleware/auth.js');
    invalidateSessionsForUsers([userId]);
  } catch { logger.error({ userId, code: 'session_eviction_failed' }, 'Persisted credential epoch requires session revalidation'); }
}
async function outcome(operation: EmailMutation): Promise<{ primary_email: string; operation_id: string; status: string }> {
  if (operation.result_body.operation_id !== operation.id) throw new Error('Recorded operation result differs');
  if (operation.state === 'succeeded' || operation.state === 'compensated') {
    await committedEvidence(operation, true);
    await invalidateCredential(operation.workos_user_id);
  }
  if (operation.result_status !== 200) throw new EmailMutationError(operation.result_status, operation.result_body);
  if (typeof operation.result_body.primary_email !== 'string' || operation.result_body.operation_id !== operation.id || operation.result_body.status !== 'primary_updated') throw new Error('Invalid recorded email outcome');
  return { primary_email: operation.result_body.primary_email, operation_id: operation.id, status: 'primary_updated' };
}
async function bumpEpoch(client: PoolClient, userId: string): Promise<string> {
  const before = await client.query<{ epoch: string }>('SELECT epoch FROM authorization_epochs WHERE workos_user_id=$1 FOR UPDATE', [userId]);
  if (before.rowCount !== before.rows.length || before.rows.length > 1) throw new Error('Invalid credential epoch');
  const expected = (BigInt(before.rows[0]?.epoch ?? '0') + 1n).toString();
  const bumped = await client.query<{ workos_user_id: string; epoch: string }>(
    `INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ($1,1)
     ON CONFLICT (workos_user_id) DO UPDATE SET epoch=authorization_epochs.epoch+1, updated_at=NOW()
     RETURNING workos_user_id, epoch`, [userId],
  );
  exactOne(bumped);
  if (bumped.rows[0].workos_user_id !== userId || bumped.rows[0].epoch !== expected) throw new Error('Credential epoch did not advance');
  const verified = await client.query<{ epoch: string }>('SELECT epoch FROM authorization_epochs WHERE workos_user_id=$1', [userId]);
  exactOne(verified);
  if (verified.rows[0].epoch !== expected) throw new Error('Credential epoch readback differs');
  return expected;
}
async function localEmail(client: PoolClient, operation: EmailMutation, restore: boolean): Promise<string> {
  await client.query("SELECT set_config('adcp.email_mutation_id',$1,true)", [operation.id]);
  const email = restore ? operation.old_email : operation.new_email;
  const verified = restore ? operation.old_email_verified : true;
  const updated = await client.query<{ email: string; email_verified: boolean; email_mutation_version: string }>(
    `UPDATE users SET email=$1, email_verified=$3, updated_at=NOW() WHERE workos_user_id=$2
     RETURNING email, email_verified, email_mutation_version`, [email, operation.workos_user_id, verified],
  );
  exactOne(updated);
  const version = (BigInt(operation.expected_email_version) + 1n).toString();
  if (updated.rows[0].email !== email || updated.rows[0].email_verified !== verified || updated.rows[0].email_mutation_version !== version) throw new Error('Credential email write differs');
  const readback = await client.query('SELECT email, email_verified, email_mutation_version FROM users WHERE workos_user_id=$1', [operation.workos_user_id]);
  exactOne(readback);
  if (!isDeepStrictEqual(readback.rows[0], updated.rows[0])) throw new Error('Credential email readback differs');
  if (!restore) {
    const removed = await client.query('DELETE FROM user_email_aliases WHERE workos_user_id=$1 AND LOWER(email)=$2 AND verified_at IS NOT NULL RETURNING email', [operation.workos_user_id, operation.new_email.toLowerCase()]);
    exactOne(removed);
    const added = await client.query(
      `INSERT INTO user_email_aliases (workos_user_id,email,verified_at) VALUES ($1,$2,CASE WHEN $3 THEN NOW() ELSE NULL END)
       ON CONFLICT (workos_user_id,email) DO UPDATE SET verified_at=EXCLUDED.verified_at RETURNING email`,
      [operation.workos_user_id, operation.old_email, operation.old_email_verified],
    );
    exactOne(added);
  }
  await client.query('UPDATE organization_memberships SET email=$1, updated_at=NOW() WHERE workos_user_id=$2 AND email IS DISTINCT FROM $1', [email, operation.workos_user_id]);
  await client.query('UPDATE person_relationships SET email=$1, updated_at=NOW() WHERE workos_user_id=$2 AND email IS DISTINCT FROM $1', [email, operation.workos_user_id]);
  const stale = await client.query(
    `SELECT 1 FROM organization_memberships WHERE workos_user_id=$1 AND email IS DISTINCT FROM $2
     UNION ALL SELECT 1 FROM person_relationships WHERE workos_user_id=$1 AND email IS DISTINCT FROM $2 LIMIT 1`,
    [operation.workos_user_id, email],
  );
  if (stale.rowCount !== 0 || stale.rows.length !== 0) throw new Error('Email denormalizations differ');
  const aliases = await client.query<{ email: string; verified: boolean }>(
    `SELECT LOWER(email) AS email, verified_at IS NOT NULL AS verified FROM user_email_aliases
     WHERE workos_user_id=$1 AND LOWER(email)=ANY($2)`,
    [operation.workos_user_id, [operation.old_email.toLowerCase(), operation.new_email.toLowerCase()]],
  );
  if (restore) {
    if (!aliases.rows.some(alias => alias.email === operation.new_email.toLowerCase() && alias.verified)) throw new Error('Original verified alias is missing');
  } else if (aliases.rowCount !== 1 || aliases.rows.length !== 1
      || aliases.rows[0].email !== operation.old_email.toLowerCase() || aliases.rows[0].verified !== operation.old_email_verified) {
    throw new Error('Alias swap readback differs');
  }
  return version;
}
async function committedEvidence(operation: EmailMutation, allowLaterVersion = false): Promise<void> {
  // Independent connection: an old value is never evidence that COMMIT cannot
  // finish later. Only this exact terminal marker proves a completed outcome.
  const verifier = await getDedicatedClient();
  try {
    assertEvidence(await readOperation(verifier, operation.id), operation);
    const epoch = await verifier.query<{ epoch: string }>('SELECT epoch FROM authorization_epochs WHERE workos_user_id=$1', [operation.workos_user_id]);
    exactOne(epoch);
    if (operation.epoch_after === null || BigInt(epoch.rows[0].epoch) < BigInt(operation.epoch_after)) throw new Error('Committed epoch not proven');
    const user = await verifier.query<{ email_mutation_version: string; email: string; email_verified: boolean }>('SELECT email_mutation_version, email, email_verified FROM users WHERE workos_user_id=$1', [operation.workos_user_id]);
    exactOne(user);
    const expectedEmail = operation.state === 'succeeded' ? operation.new_email : operation.old_email;
    const expectedVerified = operation.state === 'succeeded' ? true : operation.old_email_verified;
    const currentVersion = BigInt(user.rows[0].email_mutation_version);
    const appliedVersion = BigInt(operation.applied_email_version ?? '-1');
    if (appliedVersion !== BigInt(operation.expected_email_version) + 1n || currentVersion < appliedVersion
        || (!allowLaterVersion && currentVersion !== appliedVersion)
        || (currentVersion === appliedVersion && (user.rows[0].email !== expectedEmail || user.rows[0].email_verified !== expectedVerified))) throw new Error('Committed email version not proven');
  } finally { await verifier.end(); }
}
async function terminal(client: PoolClient, operation: EmailMutation, restore: boolean, status: number, body: ResultBody, failureCode: string | null): Promise<EmailMutation> {
  let commitAttempted = false;
  try {
    await client.query('BEGIN');
    const applied = await localEmail(client, operation, restore);
    const epoch = await bumpEpoch(client, operation.workos_user_id);
    const finished: EmailMutation = { ...operation, state: restore ? 'compensated' : 'succeeded', failure_code: failureCode,
      result_status: status, result_body: body, applied_email_version: applied, epoch_after: epoch };
    await updateJournal(client, finished);
    commitAttempted = true;
    let acknowledged = false;
    try { acknowledged = (await client.query('COMMIT')).command === 'COMMIT'; } catch { /* Verify the durable marker below. */ }
    if (!acknowledged) await client.query('ROLLBACK').catch(() => undefined);
    try { await committedEvidence(finished); } catch { throw new CommitUnknown('Terminal commit outcome unproven'); }
    return finished;
  } catch (error) {
    if (commitAttempted) throw new CommitUnknown('Terminal commit outcome unproven');
    const rolledBack = await client.query('ROLLBACK').then(result => result.command === 'ROLLBACK', () => false);
    if (!rolledBack) throw new CommitUnknown('Local rollback outcome unproven');
    throw error;
  }
}
async function compensate(client: PoolClient, operation: EmailMutation): Promise<EmailMutation> {
  try {
    // Re-prove the durable intent immediately before a compensating provider write.
    const current = await readOperation(client, operation.id);
    if (!current || !['pending','reconciliation_required'].includes(current.state)) throw new Error('Compensation intent missing');
    assertEvidence(current, { ...operation, state: current.state, failure_code: current.failure_code, epoch_after: current.epoch_after });
    const restored = await getEmailMutationWorkos().userManagement.updateUser({ userId: operation.workos_user_id, email: operation.old_email, emailVerified: operation.old_email_verified });
    if (restored.id !== operation.workos_user_id || restored.email.toLowerCase() !== operation.old_email.toLowerCase() || restored.emailVerified !== operation.old_email_verified) throw new Error('Provider restore unproven');
    return await terminal(client, operation, true, 503, {
      error: 'Email change failed', message: 'Your previous email was restored with our sign-in provider. Please start a new request to try again later or contact support.', operation_id: operation.id, reconciliation_required: false,
    }, 'local_write_failed');
  } catch {
    await recordFailure(client, operation, 'compensation_failed');
    throw reconciliationError(operation.id);
  }
}

/** Exact-credential mutation. Unresolved operations have no support bypass. */
export async function setPrimaryEmail(input: { userId: string; email: unknown; operationId: unknown; actorUserId?: string }): Promise<{ primary_email: string; operation_id: string; status: string }> {
  if (typeof input.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.operationId)) throw new EmailMutationError(400, { error: 'A valid operation_id UUID is required' });
  if (typeof input.email !== 'string' || !input.email.trim()) throw new EmailMutationError(400, { error: 'Email is required' });
  const email = input.email.trim().toLowerCase();
  const at = email.indexOf('@'); const dot = email.lastIndexOf('.');
  if (email.length > 255 || /\s/.test(email) || at < 1 || at !== email.lastIndexOf('@') || dot <= at+1 || dot === email.length-1) throw new EmailMutationError(400, { error: 'Invalid email address' });
  const operationId = input.operationId.toLowerCase();
  return withCredentialLock(input.userId, async client => {
    const previous = await readOperation(client, operationId);
    if (previous) {
      if (previous.workos_user_id !== input.userId || previous.payload_hash !== emailMutationRequestFingerprint(previous.workos_user_id, email)) throw new EmailMutationError(409, { error: 'operation_id_reused', message: 'This request identifier belongs to a different email change.' });
      if (previous.state === 'pending') await recordFailure(client, previous, 'interrupted_request');
      return outcome(previous);
    }
    const unresolved = await getEmailMutationStatus(input.userId, client);
    if (unresolved.reconciliation_required) throw reconciliationError(unresolved.operation_id!);
    const local = await client.query<{ workos_user_id: string; email: string; email_verified: boolean; email_mutation_version: string }>('SELECT workos_user_id, email, email_verified, email_mutation_version FROM users WHERE workos_user_id=$1', [input.userId]);
    if (!local.rows[0]) throw new EmailMutationError(404, { error: 'User not found' });
    exactOne(local);
    if (local.rows[0].workos_user_id !== input.userId) throw new Error('Credential row does not match requested user');
    const payloadHash = emailMutationRequestFingerprint(local.rows[0].workos_user_id, email);
    if (local.rows[0].email.toLowerCase() === email) throw new EmailMutationError(400, { error: 'This is already your primary email' });
    const alias = await client.query<{ email: string }>('SELECT email FROM user_email_aliases WHERE workos_user_id=$1 AND LOWER(email)=$2 AND verified_at IS NOT NULL', [input.userId, email]);
    if (!alias.rows[0]) throw new EmailMutationError(404, { error: 'Email is not linked to your account' });
    exactOne(alias);
    const operation: EmailMutation = {
      id: operationId, workos_user_id: local.rows[0].workos_user_id, actor_user_id: input.actorUserId ?? input.userId, payload_hash: payloadHash,
      old_email: local.rows[0].email, old_email_verified: local.rows[0].email_verified, new_email: alias.rows[0].email,
      expected_email_version: local.rows[0].email_mutation_version, applied_email_version: null, epoch_after: null,
      state: 'pending', failure_code: null, result_status: 409, result_body: reconciliationError(operationId).body,
    };
    try { await insertIntent(client, operation); } catch {
      // Different credentials hold different locks. A concurrent UUID claimant
      // can win after our initial lookup but before this INSERT reaches its key.
      let existing: EmailMutation | undefined;
      try { existing = await readOperation(client, operation.id); } catch { /* Unknown remains unavailable. */ }
      if (existing && (existing.workos_user_id !== input.userId || existing.payload_hash !== payloadHash)) {
        throw new EmailMutationError(409, { error: 'operation_id_reused', message: 'This request identifier belongs to a different email change.' });
      }
      if (existing?.state === 'pending') {
        await recordFailure(client, existing, 'intent_confirmation_failed');
        throw reconciliationError(existing.id);
      }
      throw unrecordedError();
    }
    let original;
    try { original = await getEmailMutationWorkos().userManagement.getUser(input.userId); } catch {
      // An unavailable baseline cannot prove agreement with the provider. Keep
      // the credential unresolved instead of clearing the authority fence.
      await recordFailure(client, operation, 'provider_read_failed');
      throw reconciliationError(operation.id);
    }
    if (original.id !== input.userId || original.email.toLowerCase() !== operation.old_email.toLowerCase() || original.emailVerified !== operation.old_email_verified) {
      await recordFailure(client, operation, 'preexisting_provider_mismatch'); throw reconciliationError(operation.id);
    }
    // Recheck full durable evidence after the provider read and before mutation.
    try { assertEvidence(await readOperation(client, operation.id), operation); } catch { throw reconciliationError(operation.id); }
    let changed;
    try { changed = await getEmailMutationWorkos().userManagement.updateUser({ userId: input.userId, email: operation.new_email, emailVerified: true }); }
    catch (error) {
      if (!definitiveRejection(error)) { await recordFailure(client, operation, 'provider_outcome_unknown'); throw reconciliationError(operation.id); }
      try { return outcome(await terminal(client, operation, true, isEmailUnavailable(error) ? 409 : 502, { error: 'Sign-in provider rejected the email change', message: 'Your email was not changed. Please start a new request to try again later or contact support.', operation_id: operation.id, reconciliation_required: false }, 'provider_rejected')); }
      catch (localError) { if (localError instanceof EmailMutationError) throw localError; await recordFailure(client, operation, 'local_write_failed'); throw reconciliationError(operation.id); }
    }
    if (changed.id !== input.userId || changed.email.toLowerCase() !== email || changed.emailVerified !== true) { await recordFailure(client, operation, 'provider_response_mismatch'); throw reconciliationError(operation.id); }
    let completed;
    try { completed = await terminal(client, operation, false, 200, { status: 'primary_updated', primary_email: operation.new_email, operation_id: operation.id }, null); }
    catch (error) {
      if (error instanceof CommitUnknown) { await recordFailure(client, operation, 'local_commit_unknown'); throw reconciliationError(operation.id); }
      await recordFailure(client, operation, 'local_write_failed');
      completed = await compensate(client, operation);
    }
    return outcome(completed);
  });
}
