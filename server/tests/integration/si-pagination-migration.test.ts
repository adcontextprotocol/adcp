import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { SiDatabase } from '../../src/db/si-db.js';

const SESSION_ID = 'si_52900000-0000-4000-8000-000000000001';

describe('SI pagination and policy migration', () => {
  beforeAll(async () => {
    initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
    const pool = getPool();
    await pool.query(`DELETE FROM si_sessions WHERE session_id = $1`, [SESSION_ID]);
    await pool.query(
      `INSERT INTO si_sessions (session_id, host_type, host_identifier, brand_name, user_anonymous_id)
       VALUES ($1, 'addy', 'pagination-test', 'Acme', 'anon-pagination')`,
      [SESSION_ID],
    );
    for (let index = 1; index <= 5; index += 1) {
      await pool.query(
        `INSERT INTO si_session_messages (session_id, role, content, created_at)
         VALUES ($1, 'user', $2, $3)`,
        [SESSION_ID, `message-${index}`, new Date(`2026-01-01T00:00:0${index}Z`)],
      );
    }
    await pool.query(
      `INSERT INTO si_session_messages (id, session_id, role, content, created_at)
       VALUES
         ('52900000-0000-4000-8000-000000000010', $1, 'user', 'same-time-low-id', '2026-01-01T00:01:00Z'),
         ('52900000-0000-4000-8000-000000000020', $1, 'user', 'same-time-high-id', '2026-01-01T00:01:00Z')`,
      [SESSION_ID],
    );
  }, 30_000);

  afterAll(async () => {
    await getPool().query(`DELETE FROM si_sessions WHERE session_id = $1`, [SESSION_ID]);
    await closeDatabase();
  });

  it('returns newest pages in chronological order and honors offset', async () => {
    const db = new SiDatabase();
    expect((await db.getSessionMessages(SESSION_ID, 2, 0)).map((m) => m.content))
      .toEqual(['same-time-low-id', 'same-time-high-id']);
    expect((await db.getSessionMessages(SESSION_ID, 2, 2)).map((m) => m.content))
      .toEqual(['message-4', 'message-5']);
    expect(await db.getSessionMessages(SESSION_ID, 0, -10)).toHaveLength(1);
  });

  it('clears mutable SI prompts while retaining the rolling-deploy compatibility column', async () => {
    const column = await getPool().query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'member_profiles' AND column_name = 'si_prompt_template'`,
    );
    expect(column.rows).toHaveLength(1);
    const populated = await getPool().query(
      `SELECT 1 FROM member_profiles WHERE si_prompt_template IS NOT NULL LIMIT 1`,
    );
    expect(populated.rows).toHaveLength(0);
    const constraint = await getPool().query(
      `SELECT 1
       FROM pg_constraint
       WHERE conname = 'member_profiles_si_prompt_template_must_be_null'`,
    );
    expect(constraint.rows).toHaveLength(0);

    const fs = await import('node:fs/promises');
    const [dbSource, seedSource] = await Promise.all([
      fs.readFile(new URL('../../src/db/si-db.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../../src/db/seeds/si-test-data.sql', import.meta.url), 'utf8'),
    ]);
    expect(dbSource).not.toContain('si_prompt_template');
    expect(seedSource).not.toContain('si_prompt_template');
  });
});
