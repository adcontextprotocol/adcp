import fs from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

const migration = await fs.readFile(new URL('../../src/db/migrations/595_normalized_email_invariant.sql', import.meta.url), 'utf8');
const connectionString = process.env.DATABASE_URL || 'postgresql://adcp:localdev@127.0.0.1:5432/adcp_email_invariant_test';
const A = 'user_normalized_email_a', B = 'user_normalized_email_b';
const target = 'normalized-target@test.example';

describe('database-wide normalized credential email invariant', () => {
  let pool: Pool;
  beforeAll(async () => {
    // This suite only supports a deliberately selected disposable test DB.
    const url = new URL(connectionString);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.includes('test')) {
      throw new Error('Use a local disposable database whose name contains test');
    }
    pool = initializeDatabase({ connectionString });
    await runMigrations();
  }, 60000);
  beforeEach(async () => {
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[A, B]]);
    await pool.query('INSERT INTO users(workos_user_id,email) VALUES ($1,$2),($3,$4)', [A, 'normalized-a@test.example', B, 'normalized-b@test.example']);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [[A, B]]);
    await closeDatabase();
  });

  async function transaction(work: (client: PoolClient) => Promise<void>) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await work(client); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async function assertInvariant() {
    await pool.query('SELECT public.check_normalized_email_invariant()');
  }
  type Write = 'user insert' | 'user update' | 'alias insert' | 'alias update';
  async function prepare(kind: Write, owner: string) {
    if (kind === 'user insert') await pool.query('DELETE FROM users WHERE workos_user_id=$1', [owner]);
    if (kind === 'alias update') await pool.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES ($1,$2)', [owner, `${owner}@test.example`]);
  }
  async function write(client: Pick<PoolClient, 'query'>, kind: Write, owner: string, email = target) {
    if (kind === 'user insert') return client.query('INSERT INTO users(workos_user_id,email) VALUES ($1,$2)', [owner, email]);
    if (kind === 'user update') return client.query('UPDATE users SET email=$2 WHERE workos_user_id=$1', [owner, email]);
    if (kind === 'alias insert') return client.query('INSERT INTO user_email_aliases(workos_user_id,email) VALUES ($1,$2)', [owner, email]);
    return client.query('UPDATE user_email_aliases SET email=$2 WHERE workos_user_id=$1', [owner, email]);
  }
  const kinds: Write[] = ['user insert', 'user update', 'alias insert', 'alias update'];
  for (const first of kinds) for (const second of kinds) {
    it(`${first} versus ${second}: deterministic concurrent rejection and bounded retry`, async () => {
      await prepare(first, A); await prepare(second, B);
      const one = await pool.connect(), two = await pool.connect();
      try {
        await one.query('BEGIN'); await two.query('BEGIN');
        await write(one, first, A); // Barrier: first writer has completed its check and holds its lock.
        await expect(write(two, second, B, ` \t${target.toUpperCase()}\n`)).rejects.toMatchObject({ code: '55P03' });
        await two.query('ROLLBACK'); await one.query('COMMIT');
        // Retry only the whole rolled-back transaction, once, after owner commits.
        await expect(write(two, second, B, target)).rejects.toMatchObject({ code: '23505' });
        await assertInvariant();
      } finally { await one.query('ROLLBACK'); await two.query('ROLLBACK'); one.release(); two.release(); }
    });
  }

  it('permits precisely a credential/own-alias overlap needed by primary email swaps', async () => {
    await write(pool, 'alias insert', A);
    await transaction(async client => {
      await write(client, 'user update', A);
      expect((await client.query('DELETE FROM user_email_aliases WHERE workos_user_id=$1', [A])).rowCount).toBe(1);
      await write(client, 'alias insert', A, 'normalized-a@test.example');
    });
    await assertInvariant();
  });
  it('treats canonical siblings as different owners without changing bindings', async () => {
    await pool.query('UPDATE identity_workos_users SET is_primary=FALSE, identity_id=(SELECT identity_id FROM identity_workos_users WHERE workos_user_id=$1) WHERE workos_user_id=$2', [A, B]);
    await write(pool, 'alias insert', A);
    await expect(write(pool, 'user update', B)).rejects.toMatchObject({ code: '23505' });
  });
  it('rejects duplicate normalized aliases even for the same owner', async () => {
    await write(pool, 'alias insert', A);
    await expect(write(pool, 'alias insert', A, ` ${target} `)).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'])('rejects stale check snapshots at %s', async isolation => {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await client.query('SELECT count(*) FROM users');
      await write(pool, 'alias insert', A);
      await expect(write(client, 'user update', B)).rejects.toMatchObject({ code: isolation === 'READ COMMITTED' ? '23505' : '40001' });
      await client.query('ROLLBACK'); await assertInvariant();
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it.each(['COMMIT', 'ROLLBACK'])('does not release a deleted alias until transaction %s', async outcome => {
    await write(pool, 'alias insert', A);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('DELETE FROM user_email_aliases WHERE workos_user_id=$1', [A]);
      await expect(write(pool, 'user update', B)).rejects.toMatchObject({ code: '55P03' });
      await client.query(outcome);
      if (outcome === 'COMMIT') await write(pool, 'user update', B);
      else await expect(write(pool, 'user update', B)).rejects.toMatchObject({ code: '23505' });
      await assertInvariant();
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it.each(['COMMIT', 'ROLLBACK'])('holds user email and cascaded aliases through deletion %s', async outcome => {
    await write(pool, 'alias insert', A);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('DELETE FROM users WHERE workos_user_id=$1', [A]);
      await expect(write(pool, 'user update', B)).rejects.toMatchObject({ code: '55P03' });
      await client.query(outcome);
      if (outcome === 'COMMIT') {
        await write(pool, 'user update', B);
        await write(pool, 'alias insert', B, 'normalized-a@test.example');
      } else await expect(write(pool, 'user update', B)).rejects.toMatchObject({ code: '23505' });
      await assertInvariant();
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('rolls back acquisition and permits reuse after a failed transaction', async () => {
    await expect(transaction(async client => { await write(client, 'alias insert', A); throw new Error('abort'); })).rejects.toThrow('abort');
    await write(pool, 'user update', B); await assertInvariant();
  });
  it('rejects the opposite-direction transaction before it can wait on the first writer', async () => {
    const one = await pool.connect(), two = await pool.connect();
    try {
      await one.query('BEGIN'); await two.query('BEGIN');
      await one.query('SELECT 1 FROM users WHERE workos_user_id=$1 FOR UPDATE', [A]);
      await write(two, 'alias insert', B);
      await expect(write(one, 'alias insert', A, 'normalized-opposite@test.example')).rejects.toMatchObject({ code: '55P03' });
      await one.query('ROLLBACK');
      await write(two, 'user update', A, 'normalized-opposite@test.example');
      await two.query('COMMIT'); await assertInvariant();
    } finally { await one.query('ROLLBACK'); await two.query('ROLLBACK'); one.release(); two.release(); }
  });
  it('handles multi-row cross-table CTE writes with one owner check', async () => {
    await expect(pool.query(`WITH inserted AS (INSERT INTO user_email_aliases(workos_user_id,email) VALUES ($1,$3))
      UPDATE users SET email=$3 WHERE workos_user_id=$2`, [A, B, target])).rejects.toMatchObject({ code: '23505' });
    await assertInvariant();
  });
  it('enforces MERGE and alias owner UPDATE automatically', async () => {
    await write(pool, 'alias insert', A);
    await expect(pool.query(`MERGE INTO users u USING (VALUES ($1::text,$2::text)) v(id,email)
      ON u.workos_user_id=v.id WHEN MATCHED THEN UPDATE SET email=v.email`, [B, target])).rejects.toMatchObject({ code: '23505' });
    await write(pool, 'user update', A);
    await expect(pool.query('UPDATE user_email_aliases SET workos_user_id=$2 WHERE workos_user_id=$1', [A, B])).rejects.toMatchObject({ code: '23505' });
  });
  it('enforces COPY without a route or application lock', async () => {
    await write(pool, 'alias insert', A);
    await pool.query('DELETE FROM users WHERE workos_user_id=$1', [B]);
    // Static test-only local printf supplies COPY input inside disposable PG.
    await expect(pool.query(`COPY users(workos_user_id,email) FROM PROGRAM
      'printf "user_normalized_email_b\\tnormalized-target@test.example\\n"'`)).rejects.toMatchObject({ code: '23505' });
    await assertInvariant();
  });
  it('holds TRUNCATE reuse until rollback and keeps savepoint lock ownership', async () => {
    await write(pool, 'alias insert', A);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SAVEPOINT before_truncate');
      await client.query('TRUNCATE user_email_aliases');
      await expect(write(pool, 'user update', B)).rejects.toMatchObject({ code: '55P03' });
      await client.query('ROLLBACK TO SAVEPOINT before_truncate');
      await client.query('ROLLBACK');
      await expect(write(pool, 'user update', B)).rejects.toMatchObject({ code: '23505' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('retains enforcement when low-privilege callers cannot read aliases or the epoch', async () => {
    await write(pool, 'alias insert', A);
    await expect(transaction(async client => {
      await client.query(`CREATE ROLE normalized_email_test_writer NOLOGIN;
        GRANT USAGE ON SCHEMA public TO normalized_email_test_writer;
        GRANT SELECT, UPDATE ON users TO normalized_email_test_writer;
        SET LOCAL ROLE normalized_email_test_writer`);
      await write(client, 'user update', B);
    })).rejects.toMatchObject({ code: '23505' });
  });
  it('enforces email mutations made by another trigger on an unrelated UPDATE', async () => {
    await write(pool, 'alias insert', A);
    await expect(transaction(async client => {
      await client.query(`CREATE FUNCTION test_normalized_email_rewrite() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN NEW.email := '${target}'; RETURN NEW; END $$;
        CREATE TRIGGER test_normalized_email_rewrite BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION test_normalized_email_rewrite()`);
      await client.query('UPDATE users SET first_name=first_name WHERE workos_user_id=$1', [B]);
    })).rejects.toMatchObject({ code: '23505' });
  });
  it('enforces replica writes and cannot be deferred with SET CONSTRAINTS', async () => {
    await write(pool, 'alias insert', A);
    await expect(transaction(async client => {
      await client.query("SET LOCAL session_replication_role='replica'; SET CONSTRAINTS ALL DEFERRED");
      await write(client, 'user update', B);
    })).rejects.toMatchObject({ code: '23505' });
  });
  it.each(['RAISE EXCEPTION \'storage failure\'', 'RETURN NULL'])('fails closed on serialization storage trigger: %s', async behavior => {
    await expect(transaction(async client => {
      await client.query(`CREATE FUNCTION test_normalized_email_storage() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN ${behavior}; END $$;
        CREATE TRIGGER test_normalized_email_storage BEFORE UPDATE ON normalized_email_serialization FOR EACH ROW EXECUTE FUNCTION test_normalized_email_storage()`);
      await write(client, 'alias insert', A);
    })).rejects.toThrow();
    expect((await pool.query('SELECT 1 FROM user_email_aliases WHERE workos_user_id=$1', [A])).rowCount).toBe(0);
  });
  it('fails closed when the serialization singleton is missing', async () => {
    await expect(transaction(async client => {
      await client.query('DELETE FROM normalized_email_serialization');
      await write(client, 'user update', B);
    })).rejects.toMatchObject({ code: '23514' });
  });
  it('uses qualified relations despite a hostile caller search_path', async () => {
    await write(pool, 'alias insert', A);
    await expect(transaction(async client => {
      await client.query('CREATE TEMP TABLE user_email_aliases(email TEXT); SET LOCAL search_path=pg_temp,public');
      await write(client, 'user update', B);
    })).rejects.toMatchObject({ code: '23505' });
  });

  it('matches production Node normalization for every mapped scalar, trim character and contextual sigma', async () => {
    expect(process.versions.unicode).toBe('17.0');
    const examples = ['ΟΣ', 'Οσ', 'İ', 'AΣ', 'AΣA', 'ʰΣ', 'AʰΣ', 'AΣʰA', '\u0345Σ', 'A\u0345Σ', 'AΣ\u0345A'];
    for (let n = 1; n <= 0x10ffff; n++) {
      if (n >= 0xd800 && n <= 0xdfff) continue;
      const ch = String.fromCodePoint(n);
      if (ch !== ch.toLowerCase() || ch.trim() === '') examples.push(ch, `${ch}AΣ${ch}`, `${ch}TEST@EXAMPLE.COM${ch}`);
    }
    for (let start = 0; start < examples.length; start += 300) {
      const batch = examples.slice(start, start + 300);
      const result = await pool.query('SELECT public.normalized_credential_email(value) AS email FROM unnest($1::text[]) value', [batch]);
      expect(result.rows.map(row => row.email)).toEqual(batch.map(value => value.trim().toLowerCase()));
    }
  });
  it('reruns idempotently without changing existing unambiguous rows', async () => {
    await write(pool, 'alias insert', A);
    const before = (await pool.query('SELECT * FROM users WHERE workos_user_id=ANY($1) ORDER BY workos_user_id', [[A, B]])).rows;
    await transaction(async client => { await client.query(migration); });
    expect((await pool.query('SELECT * FROM users WHERE workos_user_id=ANY($1) ORDER BY workos_user_id', [[A, B]])).rows).toEqual(before);
  });
  const productionSources = [
    '../../src/http.ts', '../../src/routes/workos-webhooks.ts', '../../src/routes/admin/users.ts',
    '../../src/mcp/oauth-provider.ts', '../../src/dev-setup.ts', '../../scripts/setup-sandbox.ts',
  ];
  for (const path of productionSources) {
    it(`covers actual INSERT SQL at the ${path} production database seam`, async () => {
      const source = await fs.readFile(new URL(path, import.meta.url), 'utf8');
      const statements = [...source.matchAll(/`(INSERT INTO users\s*\([\s\S]*?)`/g)].map(match => match[1]);
      expect(statements.length).toBeGreaterThan(0);
      await write(pool, 'alias insert', A);
      for (const sql of statements) {
        const columns = sql.match(/INSERT INTO users\s*\(([^)]+)\)/)![1].split(',').map(value => value.trim());
        const values = sql.match(/VALUES\s*\(([^;]*?)\)\s*(?:ON CONFLICT|$)/)![1].split(',').map(value => value.trim());
        const params: unknown[] = [];
        values.forEach((value, index) => {
          const placeholder = value.match(/^\$(\d+)$/);
          if (!placeholder) return;
          const column = columns[index];
          params[Number(placeholder[1]) - 1] = column === 'workos_user_id' ? B : column === 'email' ? target
            : column === 'email_verified' ? false : column.endsWith('_at') ? new Date().toISOString()
            : column === 'primary_organization_id' ? null : 'Test';
        });
        await pool.query('DELETE FROM users WHERE workos_user_id=$1', [B]);
        await expect(pool.query(sql, params)).rejects.toMatchObject({ code: '23505' });
        if (sql.includes('DO UPDATE')) {
          await pool.query('INSERT INTO users(workos_user_id,email) VALUES ($1,$2)', [B, 'normalized-b@test.example']);
          await expect(pool.query(sql, params)).rejects.toMatchObject({ code: '23505' });
        }
      }
      await assertInvariant();
    });
  }
  it('surfaces ambiguous legacy conflicts without deleting or reassigning any row', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE users DISABLE TRIGGER verify_normalized_email_writer');
      await write(client, 'user update', A); await write(client, 'user update', B, ` ${target.toUpperCase()} `);
      const before = (await client.query('SELECT workos_user_id,email FROM users WHERE workos_user_id=ANY($1) ORDER BY workos_user_id', [[A, B]])).rows;
      await client.query('SAVEPOINT install');
      await expect(client.query(migration)).rejects.toMatchObject({ code: '23505', constraint: 'normalized_email_owner', detail: expect.stringContaining(A) });
      await client.query('ROLLBACK TO SAVEPOINT install');
      expect((await client.query('SELECT workos_user_id,email FROM users WHERE workos_user_id=ANY($1) ORDER BY workos_user_id', [[A, B]])).rows).toEqual(before);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
