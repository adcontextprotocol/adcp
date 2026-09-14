import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const provider = vi.hoisted(() => ({ getUser: vi.fn(), updateUser: vi.fn() }));
vi.mock('../../src/auth/workos-client.js', () => ({ getEmailMutationWorkos: () => ({ userManagement: provider }) }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: vi.fn(), invalidateSessionsForUsers: vi.fn() }));
vi.mock('express-rate-limit', () => ({ default: () => (_req: any, _res: any, next: any) => next() }));
vi.mock('../../src/middleware/pg-rate-limit-store.js', () => ({ CachedPostgresStore: class {} }));
vi.mock('../../src/notifications/email.js', () => ({ sendEmailLinkVerification: vi.fn() }));
import { handleEmailLinkVerification } from '../../src/routes/account-linking.js';

const users = ['user_alias_atomicity_a', 'user_alias_atomicity_b', 'user_alias_atomicity_c'];
const email = 'alias-atomicity@example.test';
const app = express();
handleEmailLinkVerification(app);
const submit = (token: string) => request(app).post('/verify-email-link').type('form').send({ token }).then(response => response);
const success = (response: { text: string }) => response.text.includes('is now linked to your account.');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('alias verification transaction through the public HTTP callback', () => {
  let pool: Pool;
  let token: string;
  let identities: string[] = [];
  async function issue(owner = users[0], target = email, status = 'pending') {
    const value = randomUUID();
    await pool.query(`INSERT INTO email_link_tokens(token,primary_workos_user_id,target_email,status,expires_at)
      VALUES($1,$2,$3,$4,NOW()+INTERVAL '1 hour')`, [value, owner, target, status]);
    return value;
  }
  async function alias(owner = users[0], target = email) {
    await pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES($1,$2)', [owner, target]);
  }
  async function clearFault() { await pool.query('DROP FUNCTION IF EXISTS test_alias_atomicity_fault() CASCADE'); }
  async function fault(table: string, event: string, body: string, timing = 'BEFORE') {
    await pool.query(`CREATE FUNCTION test_alias_atomicity_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER zz_test_alias_atomicity_fault ${timing} ${event} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION test_alias_atomicity_fault()`);
  }
  async function state() {
    const result: Record<string, unknown> = {};
    // Whole-table snapshots prove the seam cannot move unrelated person or
    // membership/leadership authority. This suite runs serially in a local DB.
    for (const table of ['users', 'user_email_aliases', 'email_link_tokens', 'authorization_epochs',
      'identity_workos_users', 'identities', 'organization_memberships', 'working_group_memberships', 'working_group_leaders',
      'person_relationships', 'registry_audit_log', 'email_mutations', 'test_alias_atomicity_effects']) {
      result[table] = (await pool.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
    }
    return result;
  }
  async function cleanup() {
    await clearFault();
    await pool.query('DELETE FROM email_mutations WHERE workos_user_id=ANY($1)', [users]);
    await pool.query('DELETE FROM person_relationships WHERE workos_user_id=ANY($1)', [users]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id=ANY($1)', [users]);
    const bindings = await pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=ANY($1)', [users]);
    identities = [...new Set([...identities, ...bindings.rows.map(row => row.identity_id)])];
    await pool.query('DELETE FROM users WHERE workos_user_id=ANY($1)', [users]);
    await pool.query('DELETE FROM identities WHERE id=ANY($1)', [identities]);
    await pool.query('TRUNCATE test_alias_atomicity_effects');
  }
  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test' });
    await runMigrations();
    // Test-only transactional observations, not production audit/provenance.
    await pool.query('CREATE TABLE test_alias_atomicity_effects(event text NOT NULL)');
    await pool.query(`CREATE FUNCTION test_alias_atomicity_observe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO test_alias_atomicity_effects VALUES(TG_TABLE_NAME || ':' || TG_OP); RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER test_alias_atomicity_observe AFTER INSERT ON user_email_aliases
      FOR EACH ROW EXECUTE FUNCTION test_alias_atomicity_observe()`);
    await pool.query(`CREATE TRIGGER test_alias_atomicity_observe AFTER UPDATE ON email_link_tokens
      FOR EACH ROW EXECUTE FUNCTION test_alias_atomicity_observe()`);
  }, 60_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    await cleanup();
    for (const [index, id] of users.entries()) {
      await pool.query(`INSERT INTO users(workos_user_id,email,email_verified,workos_created_at,workos_updated_at)
        VALUES($1,$2,true,NOW(),NOW())`, [id, `alias-owner-${index}@example.test`]);
    }
    identities = (await pool.query('SELECT identity_id FROM identity_workos_users WHERE workos_user_id=ANY($1)', [users])).rows.map(row => row.identity_id);
    await pool.query(`INSERT INTO organization_memberships(workos_user_id,workos_organization_id,workos_membership_id,email,role)
      VALUES($1,'org_alias_atomicity','om_alias_atomicity','alias-owner-0@example.test','owner')`, [users[0]]);
    await pool.query('INSERT INTO person_relationships(workos_user_id,email) VALUES($1,$2)', [users[0], 'alias-owner-0@example.test']);
    token = await issue();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (pool) {
      await cleanup();
      await pool.query('DROP FUNCTION IF EXISTS test_alias_atomicity_observe() CASCADE');
      await pool.query('DROP TABLE IF EXISTS test_alias_atomicity_effects');
      await closeDatabase();
    }
  });
  async function assertRollback(value = token) {
    const before = await state();
    const response = await submit(value);
    expect(response.status).toBe(200);
    expect(success(response)).toBe(false);
    expect(response.text).not.toContain('fault-secret');
    expect(await state()).toEqual(before);
    expect(provider.getUser).not.toHaveBeenCalled();
    expect(provider.updateUser).not.toHaveBeenCalled();
  }

  it('commits only the alias and token; replay has no new effects even after expiry', async () => {
    const before = await state();
    expect(success(await submit(token))).toBe(true);
    const after = await state();
    for (const table of Object.keys(before).filter(table => !['user_email_aliases', 'email_link_tokens', 'test_alias_atomicity_effects'].includes(table))) {
      expect(after[table], table).toEqual(before[table]);
    }
    expect((after.test_alias_atomicity_effects as unknown[]).length).toBe(2);
    await pool.query("UPDATE email_link_tokens SET expires_at=NOW()-INTERVAL '1 hour' WHERE token=$1", [token]);
    const replayBefore = await state();
    expect(success(await submit(token))).toBe(true);
    expect(await state()).toEqual(replayBefore);
    expect(provider.getUser).not.toHaveBeenCalled();
    expect(provider.updateUser).not.toHaveBeenCalled();
  });

  it('serializes independent same-token sessions and gives both the stable successful result', async () => {
    const locked = deferred();
    const release = deferred();
    const dispatched = deferred();
    let firstPid = 0;
    let secondPid = 0;
    let reads = 0;
    const query = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]) {
      const matching = typeof args[0] === 'string' && args[0].includes('WHERE token = $1 FOR UPDATE');
      const index = matching ? ++reads : 0;
      const result = (query as any).apply(this, args);
      if (index === 1) {
        firstPid = (this as any).processID;
        return Promise.resolve(result).then(async response => { locked.resolve(); await release.promise; return response; });
      }
      if (index === 2) { secondPid = (this as any).processID; dispatched.resolve(); }
      return result;
    });
    const first = submit(token);
    await locked.promise;
    const second = submit(token);
    try {
      await dispatched.promise;
      expect(secondPid).not.toBe(firstPid);
      await vi.waitFor(async () => {
        const blocked = await pool.query('SELECT pg_blocking_pids($1) AS pids', [secondPid]);
        expect(blocked.rows[0].pids).toContain(firstPid);
      });
    } finally { release.resolve(); }
    const responses = await Promise.all([first, second]);
    expect(responses.map(success)).toEqual([true, true]);
    expect((await pool.query('SELECT status FROM email_link_tokens WHERE token=$1', [token])).rows).toEqual([{ status: 'verified' }]);
    expect((await pool.query('SELECT * FROM test_alias_atomicity_effects')).rowCount).toBe(2);
  });

  it('races two credentials after both user rechecks; only the case-folded alias winner succeeds', async () => {
    const otherToken = await issue(users[1], email.toUpperCase());
    const ready = deferred();
    const release = deferred();
    const pids = new Set<number>();
    let checks = 0;
    const query = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]) {
      const result = (query as any).apply(this, args);
      if (typeof args[0] === 'string' && args[0].includes('FROM users WHERE LOWER(email)')) {
        pids.add((this as any).processID);
        return Promise.resolve(result).then(async response => {
          expect(response.rowCount).toBe(0);
          if (++checks === 2) ready.resolve();
          await release.promise;
          return response;
        });
      }
      return result;
    });
    const submissions = [submit(token), submit(otherToken)];
    try { await ready.promise; expect(pids.size).toBe(2); } finally { release.resolve(); }
    const responses = await Promise.all(submissions);
    expect(responses.filter(success)).toHaveLength(1);
    const winner = success(responses[0]) ? 0 : 1;
    expect((await pool.query('SELECT workos_user_id FROM user_email_aliases WHERE LOWER(email)=LOWER($1)', [email])).rows).toEqual([{ workos_user_id: users[winner] }]);
    const records = await pool.query('SELECT token,status FROM email_link_tokens ORDER BY token');
    expect(records.rows.find(row => row.token === [token, otherToken][winner]).status).toBe('verified');
    expect(records.rows.find(row => row.token === [token, otherToken][1 - winner]).status).toBe('pending');
    expect((await pool.query('SELECT * FROM test_alias_atomicity_effects')).rowCount).toBe(2);
    await assertRollback([token, otherToken][1 - winner]);
  });

  it.each(['pending', 'processing'])('recovers %s with the same existing owner without inserting another alias', async status => {
    await pool.query('UPDATE email_link_tokens SET status=$2 WHERE token=$1', [token, status]);
    await alias(users[0], email.toUpperCase());
    await pool.query('TRUNCATE test_alias_atomicity_effects');
    expect(success(await submit(token))).toBe(true);
    expect((await pool.query('SELECT * FROM test_alias_atomicity_effects')).rows).toEqual([{ event: 'email_link_tokens:UPDATE' }]);
  });
  it('recovers legacy processing without an alias', async () => {
    await pool.query("UPDATE email_link_tokens SET status='processing' WHERE token=$1", [token]);
    expect(success(await submit(token))).toBe(true);
  });
  it.each(['pending', 'processing', 'verified'])('fails closed for a conflicting %s owner, preserving historic state', async status => {
    await alias(users[1]);
    await pool.query("UPDATE email_link_tokens SET status=$2::varchar,verified_at=CASE WHEN $2='verified' THEN NOW() END WHERE token=$1", [token, status]);
    await assertRollback();
  });
  it('rejects replay after the alias is removed without recreating it', async () => {
    expect(success(await submit(token))).toBe(true);
    await pool.query('DELETE FROM user_email_aliases WHERE workos_user_id=$1', [users[0]]);
    await assertRollback();
  });
  it.each(['verified_at', 'merge_summary'])('rejects legacy processing with ambiguous %s evidence', async field => {
    await pool.query(`UPDATE email_link_tokens SET status='processing',${field}=${field === 'verified_at' ? 'NOW()' : "'{}'::jsonb"} WHERE token=$1`, [token]);
    await assertRollback();
  });
  it('rejects an unverified historic alias instead of inventing provenance', async () => {
    await alias();
    await pool.query('UPDATE user_email_aliases SET verified_at=NULL WHERE workos_user_id=$1', [users[0]]);
    await assertRollback();
  });
  it('rejects a users credential created since token issuance', async () => {
    await pool.query('UPDATE users SET email=$2 WHERE workos_user_id=$1', [users[1], email.toUpperCase()]);
    await assertRollback();
  });
  it('rejects a newly inserted users row for the token email', async () => {
    await pool.query('DELETE FROM users WHERE workos_user_id=$1', [users[2]]);
    await pool.query(`INSERT INTO users(workos_user_id,email,email_verified,workos_created_at,workos_updated_at)
      VALUES($1,$2,true,NOW(),NOW())`, [users[2], email.toUpperCase()]);
    await assertRollback();
  });
  it.each([users[0], users[1]])('rejects physically ambiguous historic alias rows with second owner %s', async secondOwner => {
    // Simulate historic corruption in this disposable test DB, restoring the
    // production uniqueness index even when the assertion fails.
    const definition = (await pool.query("SELECT pg_get_indexdef('idx_user_email_aliases_email_unique'::regclass) AS sql")).rows[0].sql;
    await pool.query('DROP INDEX idx_user_email_aliases_email_unique');
    try {
      await alias();
      await alias(secondOwner, email.toUpperCase());
      await assertRollback();
    } finally {
      await pool.query('DELETE FROM user_email_aliases WHERE LOWER(email)=LOWER($1)', [email]);
      await pool.query(definition);
    }
  });
  it('revokes a historic existing-account token without merging any accounts', async () => {
    await pool.query('UPDATE email_link_tokens SET target_workos_user_id=$2 WHERE token=$1', [token, users[1]]);
    const before = await state();
    const response = await submit(token);
    expect(success(response)).toBe(false);
    expect(response.text).toContain('admin assistance');
    expect((await pool.query('SELECT status FROM email_link_tokens WHERE token=$1', [token])).rows).toEqual([{ status: 'revoked' }]);
    const after = await state();
    for (const table of Object.keys(before).filter(table => !['email_link_tokens', 'test_alias_atomicity_effects'].includes(table))) expect(after[table]).toEqual(before[table]);
  });
  it.each(['expired', 'revoked'])('leaves terminal %s tokens untouched', async status => {
    await pool.query('UPDATE email_link_tokens SET status=$2 WHERE token=$1', [token, status]);
    await assertRollback();
  });
  it('expires a pending token without inserting an alias', async () => {
    await pool.query("UPDATE email_link_tokens SET expires_at=NOW()-INTERVAL '1 hour' WHERE token=$1", [token]);
    expect(success(await submit(token))).toBe(false);
    expect((await pool.query('SELECT status FROM email_link_tokens WHERE token=$1', [token])).rows).toEqual([{ status: 'expired' }]);
    expect((await pool.query('SELECT * FROM user_email_aliases WHERE workos_user_id=$1', [users[0]])).rowCount).toBe(0);
  });

  it.each([
    ['user_email_aliases', 'INSERT', "RAISE EXCEPTION 'fault-secret';"],
    ['user_email_aliases', 'INSERT', 'RETURN NULL;'],
    ['email_link_tokens', 'UPDATE', "RAISE EXCEPTION 'fault-secret';"],
    ['email_link_tokens', 'UPDATE', 'RETURN NULL;'],
    ['email_link_tokens', 'UPDATE', "NEW.status := 'pending';"],
    ['email_link_tokens', 'UPDATE', "NEW.target_email := 'tampered@example.test';"],
    ['email_link_tokens', 'UPDATE', "NEW.primary_workos_user_id := 'user_alias_atomicity_b';"],
    ['user_email_aliases', 'INSERT', "NEW.workos_user_id := 'user_alias_atomicity_b';"],
    ['user_email_aliases', 'INSERT', "NEW.email := 'tampered@example.test';"],
  ])('rolls back alias/token and all effects on %s %s fault: %s', async (table, event, body) => {
    await fault(table, event, body);
    await assertRollback();
  });
  it('rolls back legacy processing on terminal failure and can retry afterward', async () => {
    await pool.query("UPDATE email_link_tokens SET status='processing' WHERE token=$1", [token]);
    await fault('email_link_tokens', 'UPDATE', 'RETURN NULL;');
    await assertRollback();
    await clearFault();
    expect(success(await submit(token))).toBe(true);
  });
  it('rolls back an audit failure', async () => {
    await fault('test_alias_atomicity_effects', 'INSERT', "RAISE EXCEPTION 'fault-secret';");
    await assertRollback();
  });
  it('rolls back even epoch and audit effects made by a failing trigger', async () => {
    await fault('email_link_tokens', 'UPDATE', `INSERT INTO authorization_epochs(workos_user_id,epoch) VALUES(NEW.primary_workos_user_id,1)
      ON CONFLICT(workos_user_id) DO UPDATE SET epoch=authorization_epochs.epoch+1; RAISE EXCEPTION 'fault-secret';`);
    await assertRollback();
  });
  it('rejects an AFTER trigger tampering with the persisted terminal row', async () => {
    await fault('email_link_tokens', 'UPDATE', `IF pg_trigger_depth()=1 THEN
      UPDATE email_link_tokens SET status='pending' WHERE id=NEW.id; END IF;`, 'AFTER');
    await assertRollback();
  });
  it('rejects a token intent changed by the alias INSERT trigger', async () => {
    await fault('user_email_aliases', 'INSERT', `UPDATE email_link_tokens SET target_email='tampered@example.test'
      WHERE primary_workos_user_id=NEW.workos_user_id;`, 'AFTER');
    await assertRollback();
  });
  it('rejects a terminal trigger that removes the verified alias', async () => {
    await fault('email_link_tokens', 'UPDATE', `DELETE FROM user_email_aliases
      WHERE workos_user_id=NEW.primary_workos_user_id;`, 'AFTER');
    await assertRollback();
  });
  it('a stale GET expiry read cannot regress a terminal token', async () => {
    await pool.query("UPDATE email_link_tokens SET expires_at=NOW()-INTERVAL '1 hour' WHERE token=$1", [token]);
    const read = deferred();
    const release = deferred();
    const query = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]) {
      // pool.query uses the callback overload; pause delivery of its stale read.
      if (typeof args[0] === 'string' && args[0].includes('FROM email_link_tokens WHERE token = $1')
          && !args[0].includes('FOR UPDATE') && typeof args[2] === 'function') {
        const callback = args[2];
        args[2] = (error: unknown, result: unknown) => {
          read.resolve();
          void release.promise.then(() => callback(error, result));
        };
      }
      return (query as any).apply(this, args);
    });
    const page = request(app).get('/verify-email-link').query({ token }).then(response => response);
    try {
      await read.promise;
      await pool.query("UPDATE email_link_tokens SET status='verified',verified_at=NOW() WHERE token=$1", [token]);
    } finally { release.resolve(); }
    expect(success(await page)).toBe(false);
    expect((await pool.query('SELECT status FROM email_link_tokens WHERE token=$1', [token])).rows).toEqual([{ status: 'verified' }]);
  });
  it.each(['alias cardinality', 'token rowCount', 'principal cardinality'])('rejects inconsistent driver evidence: %s', async kind => {
    if (kind === 'alias cardinality') await alias();
    const query = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: any[]) {
      const result = (query as any).apply(this, args);
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if ((kind === 'alias cardinality' && sql.includes('FROM user_email_aliases') && sql.includes('FOR UPDATE'))
          || (kind === 'token rowCount' && sql.startsWith('UPDATE email_link_tokens SET status = $7'))
          || (kind === 'principal cardinality' && sql.includes('FOR KEY SHARE'))) {
        return Promise.resolve(result).then(response => kind === 'token rowCount'
          ? { ...response, rowCount: 0 }
          : { ...response, rowCount: 2, rows: [response.rows[0], response.rows[0]] });
      }
      return result;
    });
    await assertRollback();
  });
});
