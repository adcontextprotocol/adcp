import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, type Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import * as databaseClient from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
const { getUser, updateUser, invalidate } = vi.hoisted(() => ({ getUser: vi.fn(), updateUser: vi.fn(), invalidate: vi.fn() }));
vi.mock('../../src/auth/workos-client.js', () => ({ getEmailMutationWorkos: () => ({ userManagement: { getUser, updateUser } }) }));
vi.mock('../../src/middleware/auth.js', () => ({ invalidateSessionsForUsers: invalidate }));
import { setPrimaryEmail } from '../../src/services/email-mutation.js';
const userId = 'user_email_mutation_test';
const otherUserId = 'user_email_mutation_other';
const oldEmail = 'email-mutation-old@test.example';
const newEmail = 'email-mutation-new@test.example';
const thirdEmail = 'email-mutation-third@test.example';

describe('durable exact-credential email mutation', () => {
  let pool: Pool;
  let provider: { id: string; email: string; emailVerified: boolean };
  const mutate = (operationId = randomUUID(), email = newEmail) => setPrimaryEmail({ userId, email, operationId });
  const journal = async () => (await pool.query('SELECT * FROM email_mutations WHERE workos_user_id=$1 ORDER BY created_at', [userId])).rows;
  const epoch = async () => Number((await pool.query('SELECT epoch FROM authorization_epochs WHERE workos_user_id=$1', [userId])).rows[0]?.epoch ?? 0);
  async function state() {
    return {
      user: (await pool.query('SELECT email,email_verified FROM users WHERE workos_user_id=$1', [userId])).rows,
      aliases: (await pool.query('SELECT email,verified_at IS NOT NULL AS verified FROM user_email_aliases WHERE workos_user_id=$1 ORDER BY email', [userId])).rows,
      memberships: (await pool.query('SELECT workos_user_id,workos_organization_id,workos_membership_id,role,email FROM organization_memberships WHERE workos_user_id=$1', [userId])).rows,
      people: (await pool.query('SELECT email FROM person_relationships WHERE workos_user_id=$1', [userId])).rows,
    };
  }
  async function clearFault() {
    await pool.query('DROP FUNCTION IF EXISTS test_email_mutation_fault() CASCADE');
    await pool.query('DROP SEQUENCE IF EXISTS test_email_mutation_fault_counter');
  }
  async function fault(table: string, event: string, body: string, timing = 'BEFORE') {
    await pool.query(`CREATE FUNCTION test_email_mutation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER zz_test_email_mutation_fault ${timing} ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION test_email_mutation_fault()`);
  }
  async function cleanup() {
    await clearFault();
    await pool.query('DELETE FROM email_mutations WHERE workos_user_id=ANY($1)', [[userId, otherUserId]]);
    await pool.query('DELETE FROM person_relationships WHERE workos_user_id=ANY($1)', [[userId, otherUserId]]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id=$1', [userId]);
    await pool.query('DELETE FROM users WHERE workos_user_id=ANY($1)', [[userId, otherUserId]]);
  }
  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test' });
    await runMigrations();
  }, 60_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    await pool.query('INSERT INTO users(workos_user_id,email,email_verified,workos_created_at,workos_updated_at) VALUES($1,$2,false,NOW(),NOW())', [userId, oldEmail]);
    await pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [userId, newEmail]);
    await pool.query("INSERT INTO organization_memberships(workos_user_id,workos_organization_id,workos_membership_id,email,role) VALUES($1,'org_email_mutation_test','om_email_mutation_test',$2,'owner')", [userId, oldEmail]);
    await pool.query('INSERT INTO person_relationships(workos_user_id,email) VALUES($1,$2)', [userId, oldEmail]);
    provider = { id: userId, email: oldEmail, emailVerified: false };
    getUser.mockReset().mockImplementation(async () => ({ ...provider }));
    updateUser.mockReset().mockImplementation(async ({ email, emailVerified }) => { provider = { id: userId, email, emailVerified }; return { ...provider }; });
    invalidate.mockReset();
  });
  afterAll(async () => { vi.restoreAllMocks(); await cleanup(); await closeDatabase(); });

  it('atomically commits aliases, denormalizations and exact credential epoch before invalidating sessions', async () => {
    const before = await state();
    const id = randomUUID();
    expect(await mutate(id)).toEqual({ status: 'primary_updated', primary_email: newEmail, operation_id: id });
    const after = await state();
    expect(after.user).toEqual([{ email: newEmail, email_verified: true }]);
    expect(after.aliases).toEqual([{ email: oldEmail, verified: false }]);
    expect(after.memberships).toEqual(before.memberships.map(row => ({ ...row, email: newEmail })));
    expect(after.people).toEqual([{ email: newEmail }]);
    expect(await epoch()).toBe(1);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith([userId]);
    expect((await journal())[0]).toMatchObject({ state: 'succeeded', epoch_after: '1', applied_email_version: '1', result_status: 200 });
    expect((await journal())[0].payload_hash).toBe('01e362c4211926d68027f1a1124c941eead66480c7accd5e53126cc9dc31c3da');
  });
  it('replays the same normalized payload and original result after a later different operation without provider retry', async () => {
    const id = randomUUID();
    const first = await mutate(id);
    await pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [userId, thirdEmail]);
    await mutate(randomUUID(), thirdEmail);
    expect(await mutate(id, newEmail.toUpperCase())).toEqual(first);
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(updateUser).toHaveBeenCalledTimes(2);
    expect(provider.email).toBe(thirdEmail);
    await mutate(randomUUID(), newEmail);
    const records = await journal();
    expect(records[0].payload_hash).toBe(records[2].payload_hash);
    expect(records[0].payload_hash).not.toBe(records[1].payload_hash);
  });
  it('uses a different durable request fingerprint for the same email on another credential', async () => {
    await mutate();
    await pool.query('INSERT INTO users(workos_user_id,email,email_verified,workos_created_at,workos_updated_at) VALUES($1,$2,true,NOW(),NOW())', [otherUserId, thirdEmail]);
    await pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [otherUserId, newEmail]);
    getUser.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(setPrimaryEmail({ userId: otherUserId, email: newEmail, operationId: randomUUID() })).rejects.toMatchObject({ body: { reconciliation_required: true } });
    const other = await pool.query('SELECT payload_hash FROM email_mutations WHERE workos_user_id=$1', [otherUserId]);
    expect(other.rows[0].payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(other.rows[0].payload_hash).not.toBe((await journal())[0].payload_hash);
  });
  it('rejects reuse with different payload or credential without replaying private results', async () => {
    const id = randomUUID(); await mutate(id);
    await expect(mutate(id, thirdEmail)).rejects.toMatchObject({ status: 409, body: { error: 'operation_id_reused' } });
    const error = await setPrimaryEmail({ userId: otherUserId, operationId: id, email: newEmail }).catch(error => error);
    expect(error.body).toEqual({ error: 'operation_id_reused', message: 'This request identifier belongs to a different email change.' });
    expect(updateUser).toHaveBeenCalledOnce();
  });
  it('returns a conflict for concurrent cross-credential UUID reuse after both initial lookups', async () => {
    const otherEmail = 'other-base@test.example';
    await pool.query('INSERT INTO users(workos_user_id,email,email_verified,workos_created_at,workos_updated_at) VALUES($1,$2,true,NOW(),NOW())', [otherUserId, otherEmail]);
    await pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [otherUserId, thirdEmail]);
    const providers = new Map([[userId, { ...provider }], [otherUserId, { id: otherUserId, email: otherEmail, emailVerified: true }]]);
    getUser.mockImplementation(async id => ({ ...providers.get(id)! }));
    updateUser.mockImplementation(async ({ userId: id, email, emailVerified }) => {
      const changed = { id, email, emailVerified }; providers.set(id, changed); return changed;
    });
    const id = randomUUID();
    let release!: () => void;
    const overlap = new Promise<void>(resolve => { release = resolve; });
    let absentReads = 0;
    const query = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]) {
      const result = (query as any).apply(this, args);
      if (args[0] === 'SELECT * FROM email_mutations WHERE id = $1' && args[1]?.[0] === id && absentReads < 2) {
        return Promise.resolve(result).then(async response => {
          expect(response.rowCount).toBe(0);
          absentReads += 1;
          if (absentReads === 2) release();
          await overlap;
          return response;
        });
      }
      return result;
    });
    const results = await Promise.allSettled([mutate(id), setPrimaryEmail({ userId: otherUserId, email: thirdEmail, operationId: id })]);
    expect(absentReads).toBe(2);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, body: { error: 'operation_id_reused' } });
    expect(getUser).toHaveBeenCalledOnce(); expect(updateUser).toHaveBeenCalledOnce();
  });
  it('confirms durable intent before provider reads and writes', async () => {
    getUser.mockImplementationOnce(async () => { expect((await journal())[0].state).toBe('pending'); return { ...provider }; });
    updateUser.mockImplementationOnce(async ({ email, emailVerified }) => { expect((await journal())[0].state).toBe('pending'); provider = { id: userId, email, emailVerified }; return provider; });
    await mutate();
  });
  it('validates verified ownership and rejects a new operation for the current primary before provider work', async () => {
    await expect(mutate(randomUUID(), 'unlinked@test.example')).rejects.toMatchObject({ status: 404 });
    await expect(mutate(randomUUID(), oldEmail)).rejects.toMatchObject({ status: 400 });
    expect(getUser).not.toHaveBeenCalled(); expect(updateUser).not.toHaveBeenCalled(); expect(await journal()).toEqual([]);
  });
  it('stores and replays a provider rejection with explicit retryable terminal state and no secret leakage', async () => {
    const before = await state(); const id = randomUUID();
    updateUser.mockRejectedValueOnce(Object.assign(new Error('secret provider diagnostic'), { status: 422 }));
    const first = await mutate(id).catch(error => error);
    const second = await mutate(id).catch(error => error);
    expect(second.body).toEqual(first.body); expect(second.status).toBe(first.status);
    expect(first.body.reconciliation_required).toBe(false);
    expect(JSON.stringify(first.body)).not.toContain('secret');
    expect(await state()).toEqual(before); expect(await epoch()).toBe(1);
    expect(getUser).toHaveBeenCalledOnce(); expect(updateUser).toHaveBeenCalledOnce();
  });
  it('keeps an unreadable provider baseline unresolved on every retry without claiming compensation', async () => {
    const before = await state(); const id = randomUUID();
    getUser.mockRejectedValueOnce(new Error('secret provider diagnostic'));
    const first = await mutate(id).catch(error => error);
    const second = await mutate(id).catch(error => error);
    expect(first).toMatchObject({ status: 409, body: { reconciliation_required: true, operation_id: id } });
    expect(second.body).toEqual(first.body); expect(second.status).toBe(first.status);
    expect(JSON.stringify(first.body)).not.toContain('secret');
    expect(await state()).toEqual(before); expect(await epoch()).toBe(1);
    expect((await journal())[0]).toMatchObject({ state: 'reconciliation_required', failure_code: 'provider_read_failed', applied_email_version: null, epoch_after: '1' });
    expect(getUser).toHaveBeenCalledOnce(); expect(updateUser).not.toHaveBeenCalled();
  });
  it('rolls back writes and compensates provider state, while bumping epochs for reconciliation and compensation', async () => {
    await pool.query('INSERT INTO person_relationships(workos_user_id,email) VALUES($1,$2)', [otherUserId, newEmail]);
    const before = await state();
    await expect(mutate()).rejects.toMatchObject({ status: 503, body: { reconciliation_required: false } });
    expect(provider).toEqual({ id: userId, email: oldEmail, emailVerified: false });
    expect(await state()).toEqual(before);
    expect(updateUser).toHaveBeenNthCalledWith(2, { userId, email: oldEmail, emailVerified: false });
    expect(await epoch()).toBe(2);
    expect((await journal())[0]).toMatchObject({ state: 'compensated', epoch_after: '2' });
  });
  it('keeps compensation failure permanently blocked with no exported support mutation bypass', async () => {
    await pool.query('INSERT INTO person_relationships(workos_user_id,email) VALUES($1,$2)', [otherUserId, newEmail]);
    updateUser.mockImplementationOnce(async ({ email, emailVerified }) => { provider = { id: userId, email, emailVerified }; return provider; }).mockRejectedValueOnce(new Error('timeout'));
    const id = randomUUID(); await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } });
    await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } });
    await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(updateUser).toHaveBeenCalledTimes(2);
    expect((await import('../../src/services/email-mutation.js'))).not.toHaveProperty('reconcileEmailMutation');
  });
  it('blocks timed-out writes even when GET is old and the original request completes later', async () => {
    let complete!: () => void;
    updateUser.mockImplementationOnce(async ({ email, emailVerified }) => { complete = () => { provider = { id: userId, email, emailVerified }; }; throw Object.assign(new Error('secret timeout'), { status: 408 }); });
    const id = randomUUID(); await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect((await getUser()).email).toBe(oldEmail); complete(); expect((await getUser()).email).toBe(newEmail);
    await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(updateUser).toHaveBeenCalledOnce(); expect(await epoch()).toBe(1);
  });
  it('reconciles a crashed pending intent with one epoch bump and never retries the provider', async () => {
    const id = randomUUID();
    const body = { operation_id: id, error: 'Email reconciliation required', message: 'Support required', reconciliation_required: true };
    await pool.query(`INSERT INTO email_mutations(id,workos_user_id,actor_user_id,payload_hash,old_email,old_email_verified,new_email,expected_email_version,state,result_status,result_body)
      VALUES($1,$2,$2,$3,$4,false,$5,0,'pending',409,$6)`, [id,userId,createHmac('sha256', 'adcp:member-primary-email:idempotency:v1').update(JSON.stringify([userId,newEmail])).digest('hex'),oldEmail,newEmail,body]);
    await expect(mutate(id)).rejects.toMatchObject({ status: 409, body });
    await expect(mutate(id)).rejects.toMatchObject({ status: 409, body });
    expect(getUser).not.toHaveBeenCalled(); expect(updateUser).not.toHaveBeenCalled(); expect(await epoch()).toBe(1);
  });
  it('reports contention as retryable busy without a nonexistent reconciliation operation', async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,6827))', [userId]);
      const error = await mutate().catch(error => error);
      expect(error.body).toEqual({ error: 'credential_busy', message: 'An email change is already in progress. Please retry.', retryable: true });
      expect(await journal()).toEqual([]);
    } finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,6827))', [userId]); client.release(); }
  });
  it.each(['null', 'after-delete'])('does not call the provider after an intent INSERT %s fault', async kind => {
    if (kind === 'null') await fault('email_mutations', 'INSERT', 'RETURN NULL;');
    else await fault('email_mutations', 'INSERT', 'DELETE FROM email_mutations WHERE id=NEW.id;', 'AFTER');
    const id = randomUUID(); await expect(mutate(id)).rejects.toMatchObject({ status: 503 });
    expect(getUser).not.toHaveBeenCalled(); expect(updateUser).not.toHaveBeenCalled(); expect(await journal()).toEqual([]);
    await clearFault(); await mutate(id); expect(updateUser).toHaveBeenCalledOnce();
  });
  it.each(['null', 'after-delete'])('cannot claim a terminal outcome after a journal UPDATE %s fault', async kind => {
    if (kind === 'null') await fault('email_mutations', 'UPDATE', "IF NEW.state IN ('succeeded','compensated') THEN RETURN NULL; END IF;");
    else await fault('email_mutations', 'UPDATE', "IF NEW.state IN ('succeeded','compensated') THEN DELETE FROM email_mutations WHERE id=NEW.id; END IF;", 'AFTER');
    const before = await state(); await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(await state()).toEqual(before); expect(provider.email).toBe(oldEmail);
    expect((await journal())[0].state).toBe('reconciliation_required');
  });
  it('leaves the durable pending intent when reconciliation journal UPDATE is skipped', async () => {
    await fault('email_mutations', 'UPDATE', "IF NEW.state='reconciliation_required' THEN RETURN NULL; END IF;");
    updateUser.mockRejectedValueOnce(new Error('timeout'));
    const id = randomUUID(); await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect((await journal())[0].state).toBe('pending'); expect(await epoch()).toBe(0); expect(invalidate).not.toHaveBeenCalled();
    await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } }); expect(updateUser).toHaveBeenCalledOnce();
  });
  it('rolls back reconciliation epoch and journal when an AFTER UPDATE deletes its marker', async () => {
    await fault('email_mutations', 'UPDATE', "IF NEW.state='reconciliation_required' THEN DELETE FROM email_mutations WHERE id=NEW.id; END IF;", 'AFTER');
    updateUser.mockRejectedValueOnce(new Error('timeout'));
    await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect((await journal())[0].state).toBe('pending'); expect(await epoch()).toBe(0); expect(invalidate).not.toHaveBeenCalled();
  });
  it.each(['users','organization_memberships','person_relationships'])('detects suppressed %s local writes instead of reporting success', async table => {
    await fault(table, 'UPDATE', 'RETURN NULL;');
    const before = await state(); const result = await mutate().catch(error => error);
    expect(result).toHaveProperty('status'); expect(result.status).not.toBe(200); expect(await state()).toEqual(before);
    expect(provider.email).toBe(oldEmail);
  });
  it.each(['INSERT','DELETE'])('detects suppressed alias %s writes', async event => {
    await fault('user_email_aliases', event, 'RETURN NULL;');
    const before = await state(); const result = await mutate().catch(error => error);
    expect(result.status).not.toBe(200); expect(await state()).toEqual(before); expect(provider.email).toBe(oldEmail);
  });
  it.each(['INSERT','UPDATE'])('cannot claim success or compensation after a suppressed epoch %s', async event => {
    if (event === 'UPDATE') await pool.query('INSERT INTO authorization_epochs(workos_user_id,epoch) VALUES($1,7)', [userId]);
    await fault('authorization_epochs', event, 'RETURN NULL;');
    const before = await state(); await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(await state()).toEqual(before); expect(await epoch()).toBe(event === 'UPDATE' ? 7 : 0); expect(invalidate).not.toHaveBeenCalled();
  });
  it('detects an epoch trigger that returns a row without advancing its value', async () => {
    await pool.query('INSERT INTO authorization_epochs(workos_user_id,epoch) VALUES($1,7)', [userId]);
    await fault('authorization_epochs', 'UPDATE', 'NEW.epoch := OLD.epoch;');
    await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: true } }); expect(await epoch()).toBe(7);
  });
  it('compensates the provider when only the first epoch write is suppressed', async () => {
    await pool.query('CREATE SEQUENCE test_email_mutation_fault_counter');
    await fault('authorization_epochs', 'INSERT OR UPDATE', "IF nextval('test_email_mutation_fault_counter')=1 THEN RETURN NULL; END IF;");
    const before = await state();
    await expect(mutate()).rejects.toMatchObject({ status: 503, body: { reconciliation_required: false } });
    expect(updateUser).toHaveBeenCalledTimes(2); expect(provider.email).toBe(oldEmail); expect(await state()).toEqual(before);
    expect((await journal())[0]).toMatchObject({ state: 'compensated', epoch_after: '2' }); expect(await epoch()).toBe(2);
  });
  it.each(['lost', 'rollback', 'unknown-marker'])('requires independent marker evidence after an intent COMMIT %s response', async mode => {
    const verifier = vi.spyOn(databaseClient, 'getDedicatedClient');
    if (mode === 'unknown-marker') verifier.mockResolvedValueOnce({
      query: vi.fn().mockRejectedValue(new Error('marker unavailable')), end: vi.fn().mockResolvedValue(undefined),
    } as any);
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await connect(); const query = client.query.bind(client); let injected = false;
      vi.spyOn(client, 'query').mockImplementation(async (...args: any[]) => {
        if (args[0] === 'COMMIT' && !injected) {
          injected = true;
          if (mode === 'rollback') return query('ROLLBACK');
          await (query as any)(...args); throw new Error('intent commit response lost');
        }
        return (query as any)(...args);
      });
      return client;
    });
    if (mode === 'lost') {
      await expect(mutate()).resolves.toMatchObject({ primary_email: newEmail });
      expect(updateUser).toHaveBeenCalledOnce();
      expect((await journal())[0].state).toBe('succeeded');
    } else {
      await expect(mutate()).rejects.toMatchObject({ status: mode === 'unknown-marker' ? 409 : 503 });
      expect(getUser).not.toHaveBeenCalled(); expect(updateUser).not.toHaveBeenCalled();
      expect((await journal()).map(row => row.state)).toEqual(mode === 'unknown-marker' ? ['reconciliation_required'] : []);
    }
    expect(verifier).toHaveBeenCalled();
  });
  it.each(['lost', 'rollback'])('does not compensate when terminal COMMIT %s lacks a matching committed marker', async mode => {
    const before = await state();
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await connect(); const query = client.query.bind(client); let commits = 0;
      vi.spyOn(client, 'query').mockImplementation(async (...args: any[]) => {
        if (args[0] === 'COMMIT' && ++commits === 2) {
          if (mode === 'rollback') return query('ROLLBACK');
          throw new Error('terminal commit outcome unknown');
        }
        return (query as any)(...args);
      });
      return client;
    });
    await expect(mutate()).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(await state()).toEqual(before); expect(provider.email).toBe(newEmail); expect(updateUser).toHaveBeenCalledOnce();
    expect((await journal())[0]).toMatchObject({ state: 'reconciliation_required', failure_code: 'local_commit_unknown' });
  });
  it.each([{ id: otherUserId }, { email: 'unexpected@test.example' }, { emailVerified: true }])('blocks an inconsistent provider baseline %j without writing to the provider', async difference => {
    getUser.mockResolvedValueOnce({ ...provider, ...difference });
    const id = randomUUID(); await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } });
    await expect(mutate(id)).rejects.toMatchObject({ body: { reconciliation_required: true } });
    expect(updateUser).not.toHaveBeenCalled(); expect(await epoch()).toBe(1);
  });
  it('serializes actual concurrent requests while the provider mutation is pending', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    updateUser.mockImplementationOnce(async ({ email, emailVerified }) => { await waiting; provider = { id: userId, email, emailVerified }; return provider; });
    const first = mutate();
    try {
      await vi.waitFor(() => expect(updateUser).toHaveBeenCalledOnce());
      await expect(mutate()).rejects.toMatchObject({ body: { error: 'credential_busy', retryable: true } });
      expect(await journal()).toHaveLength(1);
    } finally { finish(); }
    await first; expect(updateUser).toHaveBeenCalledOnce(); expect(await epoch()).toBe(1);
  });
  it('uses a fresh committed marker to recover a lost COMMIT response without provider compensation', async () => {
    const connect = pool.connect.bind(pool);
    vi.spyOn(pool, 'connect').mockImplementationOnce(async () => {
      const client = await connect(); const query = client.query.bind(client); let commits = 0;
      vi.spyOn(client, 'query').mockImplementation(async (...args: any[]) => { const result = await (query as any)(...args); if (args[0] === 'COMMIT' && ++commits === 2) throw new Error('commit response lost'); return result; });
      return client;
    });
    const id = randomUUID(); const result = await mutate(id); expect(result.primary_email).toBe(newEmail);
    expect(await mutate(id)).toEqual(result); expect(updateUser).toHaveBeenCalledOnce(); expect(await epoch()).toBe(1);
  });
  it('does not change a durable result when postcommit session eviction fails', async () => {
    invalidate.mockImplementation(() => { throw new Error('secret local cache error'); });
    const id = randomUUID(); const first = await mutate(id); expect(await mutate(id)).toEqual(first);
    expect(updateUser).toHaveBeenCalledOnce(); expect(await epoch()).toBe(1);
  });
});
