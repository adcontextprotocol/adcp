import { createHash, createHmac, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { getAuthorizationFingerprint } from '../../src/db/authorization-epoch-db.js';

vi.hoisted(() => {
  vi.stubEnv('WORKOS_API_KEY', 'sk_test_writer_fence');
  vi.stubEnv('WORKOS_CLIENT_ID', 'client_writer_fence');
  vi.stubEnv('WORKOS_COOKIE_PASSWORD', 'writer-fence-cookie-password-at-least-32-characters');
  vi.stubEnv('WORKOS_WEBHOOK_SECRET', 'writer-fence-webhook-secret');
});
vi.mock('../../src/addie/error-notifier.js', () => ({ notifySystemError: vi.fn() }));
import { createWorkOSWebhooksRouter } from '../../src/routes/workos-webhooks.js';

const USER = 'user_email_writer_fence';
const OTHER = 'user_email_writer_fence_other';
const OLD = 'writer-fence-old@test.example';
const NEW = 'writer-fence-new@test.example';
const USER_IDS = [USER, OTHER];

// Uses actual PostgreSQL triggers and the signed HTTP webhook handler. No
// provider mutation service mock can hide a stale independent SQL writer.
describe('credential email writer fence and journal constraints', () => {
  let pool: Pool;
  const app = express();
  app.use('/api/webhooks', createWorkOSWebhooksRouter());

  async function cleanup() {
    await pool.query('DROP TRIGGER IF EXISTS test_email_writer_epoch ON authorization_epochs');
    await pool.query('DROP FUNCTION IF EXISTS test_email_writer_epoch()');
    await pool.query('DROP TRIGGER IF EXISTS zz_test_email_writer_journal ON email_mutations');
    await pool.query('DROP FUNCTION IF EXISTS test_email_writer_journal()');
    await pool.query('DELETE FROM email_mutations WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM person_relationships WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [USER_IDS]);
  }

  beforeAll(async () => {
    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@127.0.0.1:5432/adcp_member_fence_592' });
    await runMigrations();
  }, 60000);
  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO users (workos_user_id, email, email_verified, first_name, last_name)
       VALUES ($1, $3, FALSE, 'Alex', 'Reeves'), ($2, 'writer-fence-other@test.example', FALSE, 'Sam', 'Adeyemi')`,
      [USER, OTHER, OLD],
    );
    await pool.query('INSERT INTO user_email_aliases (workos_user_id, email) VALUES ($1, $2)', [USER, NEW]);
    await pool.query(
      `INSERT INTO email_link_tokens (token, primary_workos_user_id, target_email, expires_at)
       VALUES ('writer_fence_token', $1, $2, NOW() + INTERVAL '1 day')`, [USER, NEW],
    );
    await pool.query(
      `INSERT INTO organization_memberships (workos_user_id, workos_organization_id, email, role, workos_membership_id)
       VALUES ($1, 'org_email_writer_fence', $2, 'owner', 'om_writer_fence')`, [USER, OLD],
    );
    await pool.query('INSERT INTO person_relationships (workos_user_id, email) VALUES ($1, $2)', [USER, OLD]);
  });
  afterEach(async () => { await cleanup(); });
  afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

  async function intent(overrides: Record<string, unknown> = {}) {
    const current = (await pool.query('SELECT email, email_verified, email_mutation_version FROM users WHERE workos_user_id = $1', [USER])).rows[0];
    const id = randomUUID();
    const row = {
      id, workos_user_id: USER, actor_user_id: USER,
      payload_hash: createHash('sha256').update(JSON.stringify([USER, NEW])).digest('hex'),
      old_email: current.email, old_email_verified: current.email_verified,
      new_email: NEW, expected_email_version: current.email_mutation_version,
      state: 'pending', result_status: 409,
      result_body: { operation_id: id, reconciliation_required: true },
      ...overrides,
    };
    const fields = Object.keys(row);
    const values = Object.values(row);
    return (await pool.query(
      `INSERT INTO email_mutations (${fields.join(', ')}) VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, values,
    )).rows[0];
  }

  async function snapshot() {
    const results = await Promise.all([
      pool.query('SELECT email, email_verified, email_mutation_version FROM users WHERE workos_user_id = $1', [USER]),
      pool.query('SELECT id, workos_user_id, workos_organization_id, workos_membership_id, email, role FROM organization_memberships WHERE workos_user_id = $1', [USER]),
      pool.query('SELECT id, workos_user_id, email FROM person_relationships WHERE workos_user_id = $1', [USER]),
      pool.query('SELECT id, workos_user_id, email, verified_at FROM user_email_aliases WHERE workos_user_id = $1', [USER]),
      pool.query('SELECT id, primary_workos_user_id, target_email, status FROM email_link_tokens WHERE primary_workos_user_id = $1', [USER]),
    ]);
    return results.map((result) => result.rows);
  }

  async function writeLocal(client: PoolClient, operation: any, state: 'succeeded' | 'compensated') {
    await client.query("SELECT set_config('adcp.email_mutation_id', $1, true)", [operation.id]);
    const email = state === 'succeeded' ? operation.new_email : operation.old_email;
    const verified = state === 'succeeded' ? true : operation.old_email_verified;
    const changed = await client.query(
      'UPDATE users SET email = $2, email_verified = $3 WHERE workos_user_id = $1 RETURNING email_mutation_version',
      [USER, email, verified],
    );
    expect(changed.rowCount).toBe(1);
    await client.query('UPDATE organization_memberships SET email = $2 WHERE workos_user_id = $1', [USER, email]);
    await client.query('UPDATE person_relationships SET email = $2 WHERE workos_user_id = $1', [USER, email]);
    return changed.rows[0].email_mutation_version;
  }

  async function terminal(operation: any, state: 'succeeded' | 'compensated') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const version = await writeLocal(client, operation, state);
      const epoch = await client.query(
        `INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ($1, 1)
         ON CONFLICT (workos_user_id) DO UPDATE SET epoch = authorization_epochs.epoch + 1 RETURNING epoch`, [USER],
      );
      const body = state === 'succeeded'
        ? { operation_id: operation.id, primary_email: operation.new_email }
        : { operation_id: operation.id, error: 'Email change failed' };
      await client.query(
        `UPDATE email_mutations SET state = $2, applied_email_version = $3, epoch_after = $4,
           failure_code = $5, result_status = $6, result_body = $7 WHERE id = $1`,
        [operation.id, state, version, epoch.rows[0].epoch, state === 'succeeded' ? null : 'local_write_failed', state === 'succeeded' ? 200 : 503, body],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  it.each(['succeeded', 'compensated'] as const)('fences delayed original/compensation snapshots after %s, even with a newer provider timestamp', async (state) => {
    const operation = await intent();
    await terminal(operation, state);
    const before = await snapshot();
    const staleEmail = state === 'succeeded' ? OLD : NEW;
    const staleVerified = state !== 'succeeded';
    await expect(pool.query(
      `INSERT INTO users (workos_user_id, email, email_verified, workos_updated_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day') ON CONFLICT (workos_user_id) DO UPDATE
         SET email = EXCLUDED.email, email_verified = EXCLUDED.email_verified, workos_updated_at = EXCLUDED.workos_updated_at`,
      [USER, staleEmail, staleVerified],
    )).rejects.toMatchObject({ code: '23514' });
    // WorkOS denormalizations run independently of its users upsert.
    await pool.query('UPDATE organization_memberships SET email = $2 WHERE workos_user_id = $1', [USER, staleEmail]);
    await pool.query('UPDATE person_relationships SET email = $2 WHERE workos_user_id = $1', [USER, staleEmail]);
    expect(await snapshot()).toEqual(before);
    expect(before[0][0].email_mutation_version).toBe('1');
  });

  it('rejects an actual signed delayed user.updated webhook after compensation', async () => {
    const operation = await intent();
    await terminal(operation, 'compensated');
    const before = await snapshot();
    const rawBody = JSON.stringify({
      id: 'event_writer_fence_delayed', event: 'user.updated', created_at: new Date().toISOString(),
      data: { id: USER, email: NEW, email_verified: true, first_name: 'Alex', last_name: 'Reeves',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2099-01-01T00:00:00Z' },
    });
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', 'writer-fence-webhook-secret').update(`${timestamp}.${rawBody}`).digest('hex');
    await request(app).post('/api/webhooks/workos').set('Content-Type', 'application/json')
      .set('WorkOS-Signature', `t=${timestamp}, v1=${signature}`).send(rawBody).expect(500);
    expect(await snapshot()).toEqual(before);
  });

  it.each(['pending', 'reconciliation_required'] as const)('lets signed user.deleted revoke a %s credential through FK cascades while retaining its journal', async (state) => {
    const operation = await intent();
    await pool.query('INSERT INTO authorization_epochs (workos_user_id, epoch) VALUES ($1, 3)', [USER]);
    if (state === 'reconciliation_required') {
      Object.assign(operation, (await pool.query(
        `UPDATE email_mutations SET state = 'reconciliation_required', failure_code = 'provider_outcome_unknown',
           epoch_after = 3 WHERE id = $1 RETURNING *`, [operation.id],
      )).rows[0]);
    }
    const beforeFingerprint = await getAuthorizationFingerprint([USER]);
    expect(beforeFingerprint).toBe(`${USER}:3`);
    // Ordinary direct deletion is still refused while the parent exists.
    await expect(pool.query('DELETE FROM user_email_aliases WHERE workos_user_id = $1', [USER]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM email_link_tokens WHERE primary_workos_user_id = $1', [USER]))
      .rejects.toMatchObject({ code: '23514' });
    const rawBody = JSON.stringify({
      id: 'event_writer_fence_deleted', event: 'user.deleted', created_at: new Date().toISOString(),
      data: { id: USER, email: OLD, email_verified: false, first_name: 'Alex', last_name: 'Reeves',
        created_at: '2026-01-01T00:00:00Z', updated_at: new Date().toISOString() },
    });
    const timestamp = Date.now().toString();
    const signature = createHmac('sha256', 'writer-fence-webhook-secret').update(`${timestamp}.${rawBody}`).digest('hex');
    await request(app).post('/api/webhooks/workos').set('Content-Type', 'application/json')
      .set('WorkOS-Signature', `t=${timestamp}, v1=${signature}`).send(rawBody).expect(200);
    for (const table of ['users', 'identity_workos_users', 'authorization_epochs', 'organization_memberships', 'user_email_aliases']) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE workos_user_id = $1`, [USER])).rowCount).toBe(0);
    }
    expect((await pool.query('SELECT 1 FROM email_link_tokens WHERE primary_workos_user_id = $1', [USER])).rowCount).toBe(0);
    expect(await getAuthorizationFingerprint([USER])).toBe('');
    expect(await getAuthorizationFingerprint([USER])).not.toBe(beforeFingerprint);
    expect((await pool.query('SELECT * FROM email_mutations WHERE id = $1', [operation.id])).rows).toEqual([operation]);
  });

  it('preserves role revocations and profile updates while protecting pending or terminal email', async () => {
    const operation = await intent();
    await pool.query("UPDATE organization_memberships SET role = 'member' WHERE workos_user_id = $1", [USER]);
    await pool.query("UPDATE users SET first_name = 'Sam' WHERE workos_user_id = $1", [USER]);
    await terminal(operation, 'succeeded');
    await pool.query("UPDATE organization_memberships SET email = $2, role = 'member' WHERE workos_user_id = $1", [USER, OLD]);
    expect((await snapshot())[1][0]).toMatchObject({ email: NEW, role: 'member', workos_membership_id: 'om_writer_fence' });
    expect((await pool.query('SELECT first_name FROM users WHERE workos_user_id = $1', [USER])).rows[0].first_name).toBe('Sam');
  });

  it('fails fast on a competing saga lock instead of deadlocking behind a row lock', async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 6827))', [USER]);
      await expect(pool.query('UPDATE users SET email = $2 WHERE workos_user_id = $1', [USER, NEW]))
        .rejects.toMatchObject({ code: '55P03' });
      await expect(pool.query('UPDATE person_relationships SET email = $2 WHERE workos_user_id = $1', [USER, NEW]))
        .rejects.toMatchObject({ code: '55P03' });
      await expect(pool.query('UPDATE organization_memberships SET workos_user_id = $2 WHERE workos_user_id = $1', [USER, OTHER]))
        .rejects.toMatchObject({ code: '55P03' });
      const result = await client.query('SELECT 1 FROM users WHERE workos_user_id = $1 FOR UPDATE', [USER]);
      expect(result.rowCount).toBe(1);
    } finally {
      const unlock = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 6827)) AS unlocked', [USER]);
      expect(unlock.rows[0].unlocked).toBe(true);
      client.release();
    }
  });

  it('makes an ordinary external writer retain the same advisory lock until commit', async () => {
    const writer = await pool.connect();
    const saga = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('UPDATE users SET email = $2 WHERE workos_user_id = $1', [USER, NEW]);
      expect((await saga.query('SELECT pg_try_advisory_lock(hashtextextended($1, 6827)) AS locked', [USER])).rows[0].locked).toBe(false);
      await writer.query('COMMIT');
      expect((await saga.query('SELECT pg_try_advisory_lock(hashtextextended($1, 6827)) AS locked', [USER])).rows[0].locked).toBe(true);
      expect((await saga.query('SELECT pg_advisory_unlock(hashtextextended($1, 6827)) AS unlocked', [USER])).rows[0].unlocked).toBe(true);
      expect((await snapshot())[0][0]).toMatchObject({ email: NEW, email_mutation_version: '1' });
      expect((await pool.query('SELECT epoch FROM authorization_epochs WHERE workos_user_id = $1', [USER])).rows[0].epoch).toBe('1');
    } finally { await writer.query('ROLLBACK'); writer.release(); saga.release(); }
  });

  it.each(['skip', 'stale'] as const)('rolls back an ordinary email writer when an epoch trigger returns %s evidence', async (mode) => {
    await pool.query(`CREATE FUNCTION test_email_writer_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${mode === 'skip' ? 'RETURN NULL;' : 'NEW.epoch := 0; RETURN NEW;'} END; $$`);
    await pool.query('CREATE TRIGGER test_email_writer_epoch BEFORE INSERT OR UPDATE ON authorization_epochs FOR EACH ROW EXECUTE FUNCTION test_email_writer_epoch()');
    const before = await snapshot();
    await expect(pool.query('UPDATE users SET email = $2 WHERE workos_user_id = $1', [USER, NEW])).rejects.toMatchObject({ code: '23514' });
    expect(await snapshot()).toEqual(before);
  });

  it('blocks pending alias/token deletion and reassignment from either credential direction', async () => {
    await pool.query('INSERT INTO user_email_aliases (workos_user_id, email) VALUES ($1, $2)', [OTHER, 'writer-fence-other-alias@test.example']);
    await intent();
    const before = await snapshot();
    for (const owner of [USER, OTHER]) {
      await expect(pool.query('UPDATE user_email_aliases SET workos_user_id = $2 WHERE workos_user_id = $1', [owner, owner === USER ? OTHER : USER]))
        .rejects.toMatchObject({ code: '23514' });
    }
    await expect(pool.query('DELETE FROM user_email_aliases WHERE workos_user_id = $1', [USER])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM email_link_tokens WHERE primary_workos_user_id = $1', [USER])).rejects.toMatchObject({ code: '23514' });
    expect(await snapshot()).toEqual(before);
  });

  it('rejects boolean or wrong-operation GUC bypasses and unauthorized target pairs', async () => {
    const operation = await intent();
    const client = await pool.connect();
    try {
      for (const operationId of ['true', randomUUID(), operation.id]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('adcp.email_mutation_id', $1, true)", [operationId]);
        await expect(client.query('UPDATE users SET email = $2, email_verified = TRUE WHERE workos_user_id = $1', [USER, 'unapproved@test.example']))
          .rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK');
      }
    } finally { client.release(); }
  });

  it('requires terminal journal evidence even if local user and denormalization writes succeeded', async () => {
    const operation = await intent();
    const before = await snapshot();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await writeLocal(client, operation, 'succeeded');
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a trigger that invents terminal journal evidence without a local mutation', async () => {
    await pool.query(`CREATE FUNCTION test_email_writer_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      NEW.state := 'succeeded'; NEW.applied_email_version := NEW.expected_email_version + 1;
      NEW.epoch_after := 1; NEW.result_status := 200;
      NEW.result_body := jsonb_build_object('operation_id', NEW.id::text, 'primary_email', NEW.new_email);
      RETURN NEW; END; $$`);
    await pool.query('CREATE TRIGGER zz_test_email_writer_journal BEFORE INSERT ON email_mutations FOR EACH ROW EXECUTE FUNCTION test_email_writer_journal()');
    await expect(intent()).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query('SELECT id FROM email_mutations WHERE workos_user_id = $1', [USER])).rows).toEqual([]);
  });

  it.each([
    { payload_hash: 'not-a-hash' }, { reconciliation_attempts: {} },
    { failure_code: 'unexpected' }, { result_status: 200 },
    { result_body: { reconciliation_required: true } },
    { result_body: [] }, { expected_email_version: -1 },
  ])('rejects malformed durable intent %j', async (badFields) => {
    await expect(intent(badFields)).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps caller operation IDs unique and terminal replay evidence immutable', async () => {
    const operation = await intent();
    await expect(intent({ id: operation.id, result_body: operation.result_body })).rejects.toMatchObject({ code: '23505' });
    await terminal(operation, 'succeeded');
    await expect(pool.query("UPDATE email_mutations SET result_body = result_body || '{\"primary_email\":\"other@test.example\"}'::jsonb WHERE id = $1", [operation.id]))
      .rejects.toMatchObject({ code: '23514' });
    expect((await pool.query('SELECT payload_hash, result_body FROM email_mutations WHERE id = $1', [operation.id])).rows[0])
      .toMatchObject({ payload_hash: operation.payload_hash, result_body: { operation_id: operation.id, primary_email: NEW } });
  });
});
