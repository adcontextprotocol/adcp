import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const { getUser, updateUser } = vi.hoisted(() => ({ getUser: vi.fn(), updateUser: vi.fn() }));
vi.mock('../../src/auth/workos-client.js', () => ({
  getEmailMutationWorkos: () => ({ userManagement: { getUser, updateUser } }),
}));
import { getEmailMutationStatus, reconcileEmailMutation, setPrimaryEmail } from '../../src/services/email-mutation.js';

const userId = 'user_email_mutation_test';
const otherUserId = 'user_email_mutation_other';
const oldEmail = 'email-mutation-old@test.example';
const newEmail = 'email-mutation-new@test.example';

describe('email mutation provider compensation with PostgreSQL', () => {
  let pool: Pool;
  let provider: { id: string; email: string; emailVerified: boolean };

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  async function cleanup() {
    await pool.query('DELETE FROM email_mutations WHERE workos_user_id = $1', [userId]);
    await pool.query('DELETE FROM person_relationships WHERE workos_user_id = ANY($1)', [[userId, otherUserId]]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE workos_user_id = $1', [userId]);
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, email_verified, workos_created_at, workos_updated_at)
       VALUES ($1, $2, false, NOW(), NOW())`, [userId, oldEmail],
    );
    await pool.query('INSERT INTO user_email_aliases (workos_user_id, email) VALUES ($1, $2)', [userId, newEmail]);
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, workos_membership_id, email, role)
       VALUES ($1, 'org_email_mutation_test', 'om_email_mutation_test', $2, 'owner')`, [userId, oldEmail],
    );
    await pool.query('INSERT INTO person_relationships (workos_user_id, email) VALUES ($1, $2)', [userId, oldEmail]);
    provider = { id: userId, email: oldEmail, emailVerified: false };
    getUser.mockReset().mockImplementation(async () => ({ ...provider }));
    updateUser.mockReset().mockImplementation(async ({ email, emailVerified }) => {
      provider = { id: userId, email, emailVerified };
      return { ...provider };
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanup();
    await closeDatabase();
  });

  async function localState() {
    return {
      users: (await pool.query('SELECT email, email_verified FROM users WHERE workos_user_id = $1', [userId])).rows,
      aliases: (await pool.query('SELECT email, verified_at IS NOT NULL AS verified FROM user_email_aliases WHERE workos_user_id = $1 ORDER BY email', [userId])).rows,
      memberships: (await pool.query('SELECT workos_user_id, workos_organization_id, workos_membership_id, role, email FROM organization_memberships WHERE workos_user_id = $1', [userId])).rows,
      people: (await pool.query('SELECT email FROM person_relationships WHERE workos_user_id = $1', [userId])).rows,
    };
  }

  async function journal() {
    return (await pool.query('SELECT * FROM email_mutations WHERE workos_user_id = $1 ORDER BY created_at DESC', [userId])).rows;
  }

  async function failAfterLocalWrites() {
    // The final person update violates this real unique index after the user,
    // aliases and membership email have already been updated in the transaction.
    await pool.query('INSERT INTO person_relationships (workos_user_id, email) VALUES ($1, $2)', [otherUserId, newEmail]);
  }

  it('commits the credential, aliases and email denormalizations atomically and retries idempotently', async () => {
    const before = await localState();
    await expect(setPrimaryEmail({ userId, email: newEmail })).resolves.toMatchObject({ primary_email: newEmail });
    const after = await localState();
    expect(after.users).toEqual([{ email: newEmail, email_verified: true }]);
    expect(after.aliases).toEqual([{ email: oldEmail, verified: false }]);
    expect(after.memberships).toEqual(before.memberships.map(membership => ({ ...membership, email: newEmail })));
    expect(after.people).toEqual([{ email: newEmail }]);
    expect((await journal())[0].state).toBe('succeeded');
    await expect(setPrimaryEmail({ userId, email: newEmail })).resolves.toEqual({ primary_email: newEmail });
    expect(updateUser).toHaveBeenCalledOnce();
    expect(await getEmailMutationStatus(userId)).toEqual({ reconciliation_required: false });
  });

  it('persists intent before calling the provider', async () => {
    updateUser.mockImplementationOnce(async ({ email, emailVerified }) => {
      expect((await journal())[0]).toMatchObject({ state: 'pending', old_email: oldEmail, new_email: newEmail });
      provider = { id: userId, email, emailVerified };
      return { ...provider };
    });
    await setPrimaryEmail({ userId, email: newEmail });
  });

  it.each([
    ['credential id', { id: otherUserId }],
    ['email', { email: 'different-provider@test.example' }],
    ['verification', { emailVerified: true }],
  ])('blocks an already-primary retry when provider %s differs from local state', async (_field, different) => {
    const before = await localState();
    provider = { ...provider, ...different };
    await expect(setPrimaryEmail({ userId, email: oldEmail })).rejects.toMatchObject({
      status: 409, body: { reconciliation_required: true },
    });
    expect(await localState()).toEqual(before);
    expect(updateUser).not.toHaveBeenCalled();
    expect((await journal())[0]).toMatchObject({ state: 'reconciliation_required', failure_code: 'preexisting_provider_mismatch' });
    expect(await getEmailMutationStatus(userId)).toMatchObject({ reconciliation_required: true });
  });

  it('does not claim an already-primary retry succeeded when the provider cannot be read', async () => {
    const before = await localState();
    getUser.mockRejectedValueOnce(new Error('sensitive provider diagnostic'));
    await expect(setPrimaryEmail({ userId, email: oldEmail })).rejects.toMatchObject({
      status: 503, body: { message: 'Your email was not changed. Please try again later.' },
    });
    expect(await localState()).toEqual(before);
    expect(await journal()).toEqual([]);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('does not infer alias repair from a preexisting provider mismatch during reconciliation', async () => {
    const before = await localState();
    provider.email = newEmail;
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    const [operation] = await journal();
    await expect(reconcileEmailMutation({
      operationId: operation.id, actorUserId: 'support_test', providerTerminalConfirmed: true, evidenceReference: 'support/6827/terminal',
    })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(await localState()).toEqual(before);
    expect(updateUser).not.toHaveBeenCalled();
    expect(await getEmailMutationStatus(userId)).toMatchObject({ reconciliation_required: true });
  });

  it('persists the mismatch repair guard atomically if the initial intent response is lost', async () => {
    provider.email = newEmail;
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      vi.spyOn(client, 'query').mockImplementation(async (...args: any[]) => {
        const result = await (query as any)(...args);
        if (String(args[0]).includes('INSERT INTO email_mutations')) throw new Error('intent response lost');
        return result;
      });
      return client;
    });
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toThrow('intent response lost');
    const [operation] = await journal();
    expect(operation).toMatchObject({ state: 'reconciliation_required', failure_code: 'preexisting_provider_mismatch' });
    await expect(reconcileEmailMutation({
      operationId: operation.id, actorUserId: 'support_test', providerTerminalConfirmed: true, evidenceReference: 'support/6827/terminal',
    })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('verifies ownership of a different target alias before reading the provider', async () => {
    await expect(setPrimaryEmail({ userId, email: 'not-linked@test.example' })).rejects.toMatchObject({ status: 404 });
    expect(getUser).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('does not mutate local data when the provider read fails before any writes', async () => {
    const before = await localState();
    getUser.mockRejectedValueOnce(new Error('provider secret must not escape'));
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ status: 503 });
    expect(await localState()).toEqual(before);
    expect(await journal()).toEqual([]);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('does not mutate local data after a definitive provider rejection', async () => {
    const before = await localState();
    updateUser.mockRejectedValueOnce(Object.assign(new Error('provider secret must not escape'), { status: 422 }));
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({
      status: 502, body: { message: 'Your email was not changed. Please try again later or contact support.' },
    });
    expect(await localState()).toEqual(before);
    expect((await journal())[0]).toMatchObject({ state: 'compensated', failure_code: 'provider_rejected' });
    expect(await getEmailMutationStatus(userId)).toEqual({ reconciliation_required: false });
  });

  it('rolls back actual local writes and restores original provider email and verification flag', async () => {
    await failAfterLocalWrites();
    const before = await localState();
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ status: 503 });
    expect(updateUser).toHaveBeenNthCalledWith(2, { userId, email: oldEmail, emailVerified: false });
    expect(provider).toEqual({ id: userId, email: oldEmail, emailVerified: false });
    expect(await localState()).toEqual(before);
    expect((await journal())[0]).toMatchObject({ state: 'compensated', failure_code: 'local_write_failed' });
  });

  it('blocks compensation failures, preserves evidence, and reconciles idempotently after terminal assurance', async () => {
    await failAfterLocalWrites();
    const before = await localState();
    updateUser.mockImplementationOnce(async ({ email, emailVerified }) => {
      provider = { id: userId, email, emailVerified };
      return { ...provider };
    }).mockRejectedValueOnce(Object.assign(new Error('provider secret must not escape'), { status: 503 }));
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({
      status: 409, body: { reconciliation_required: true },
    });
    expect(await localState()).toEqual(before);
    expect(provider.email).toBe(newEmail);
    const [operation] = await journal();
    expect(operation).toMatchObject({ state: 'reconciliation_required', failure_code: 'compensation_failed' });
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ body: { operation_id: operation.id } });
    expect(updateUser).toHaveBeenCalledTimes(2);

    const repair = { operationId: operation.id, actorUserId: 'support_test', providerTerminalConfirmed: true as const, evidenceReference: 'support/6827/terminal' };
    await expect(reconcileEmailMutation(repair)).resolves.toEqual({ reconciled: true });
    await expect(reconcileEmailMutation(repair)).resolves.toEqual({ reconciled: true });
    expect(updateUser).toHaveBeenCalledTimes(3);
    expect(provider.email).toBe(oldEmail);
    expect(await localState()).toEqual(before);
    expect((await journal())[0]).toMatchObject({ state: 'compensated', failure_code: 'compensation_failed' });
    expect((await journal())[0].reconciliation_attempts).toEqual([
      expect.objectContaining({ actor_user_id: 'support_test', evidence_reference: 'support/6827/terminal' }),
    ]);
  });

  it('keeps timeout ambiguity blocked when an immediate GET is old and the provider completes later', async () => {
    const before = await localState();
    let finishRequest!: () => void;
    updateUser.mockImplementationOnce(async ({ email, emailVerified }) => {
      finishRequest = () => { provider = { id: userId, email, emailVerified }; };
      throw Object.assign(new Error('timed out: sensitive response'), { status: 408 });
    });
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect((await getUser(userId)).email).toBe(oldEmail);
    expect(await localState()).toEqual(before);
    expect(updateUser).toHaveBeenCalledOnce(); // No compensating write after ambiguity.
    const [operation] = await journal();
    expect(operation.failure_code).toBe('provider_outcome_unknown');

    finishRequest(); // Original timed-out request completes after the old-value GET.
    expect((await getUser(userId)).email).toBe(newEmail);
    expect(await getEmailMutationStatus(userId)).toMatchObject({ reconciliation_required: true, operation_id: operation.id });
    await expect(setPrimaryEmail({ userId, email: oldEmail })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(updateUser).toHaveBeenCalledOnce();
    await expect(reconcileEmailMutation({
      operationId: operation.id, actorUserId: 'support_test', providerTerminalConfirmed: false as true, evidenceReference: 'support/old-value-get',
    })).rejects.toMatchObject({ status: 400 });
    await reconcileEmailMutation({
      operationId: operation.id, actorUserId: 'support_test', providerTerminalConfirmed: true, evidenceReference: 'support/6827/request-terminal',
    });
    expect(provider.email).toBe(oldEmail);
    expect(await localState()).toEqual(before);
    expect(await getEmailMutationStatus(userId)).toEqual({ reconciliation_required: false });
  });

  it('treats a pending intent left by a crashed worker as reconciliation-required', async () => {
    await pool.query(
      `INSERT INTO email_mutations (id, workos_user_id, actor_user_id, old_email, old_email_verified, new_email, state)
       VALUES (gen_random_uuid(), $1, $1, $2, false, $3, 'pending')`, [userId, oldEmail, newEmail],
    );
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(getUser).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('blocks a concurrent request holding the same credential advisory lock', async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 6827))', [userId]);
      await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ body: { reconciliation_required: true } });
      expect(updateUser).not.toHaveBeenCalled();
    } finally {
      const unlocked = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 6827)) AS unlocked', [userId]);
      expect(unlocked.rows[0].unlocked).toBe(true);
      client.release();
    }
  });

  it('does not compensate after a lost COMMIT response when the local transaction committed', async () => {
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await connect();
      const query = client.query.bind(client);
      let loseCommit = true;
      vi.spyOn(client, 'query').mockImplementation(async (...args: any[]) => {
        const result = await (query as any)(...args);
        if (args[0] === 'COMMIT' && loseCommit) {
          loseCommit = false;
          throw new Error('commit response lost');
        }
        return result;
      });
      return client;
    });
    await expect(setPrimaryEmail({ userId, email: newEmail })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(updateUser).toHaveBeenCalledOnce();
    expect(provider.email).toBe(newEmail);
    expect((await localState()).users).toEqual([{ email: newEmail, email_verified: true }]);
    expect((await journal())[0].state).toBe('succeeded');
  });
});
