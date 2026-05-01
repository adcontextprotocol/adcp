/**
 * Identity layer (Phase 1) integration tests.
 *
 * Exercises migration 460_identities against a real PostgreSQL instance:
 *   - Backfill creates one identity per existing user, marked primary.
 *   - AFTER INSERT trigger creates a singleton identity for new users.
 *   - workos_user_id is unique across identity_workos_users (one user → one identity).
 *   - The "exactly one primary per identity" partial unique index holds.
 *   - Deleting a user CASCADE-removes its binding (identity row may orphan in
 *     Phase 1; Phase 2 cleans this up by changing mergeUsers to bind, not delete).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Pool } from 'pg';

const TEST_USER_PREFIX = 'user_identity_test_';

describe('Identity layer (migration 460)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
    await closeDatabase();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
  });

  async function insertUser(suffix: string, email: string): Promise<string> {
    const userId = `${TEST_USER_PREFIX}${suffix}`;
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, 'Test', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [userId, email]
    );
    return userId;
  }

  describe('backfill', () => {
    it('every existing user has exactly one identity_workos_users row marked primary', async () => {
      const result = await pool.query(`
        SELECT u.workos_user_id,
               COUNT(iwu.workos_user_id) AS binding_count,
               COUNT(*) FILTER (WHERE iwu.is_primary) AS primary_count
        FROM users u
        LEFT JOIN identity_workos_users iwu ON iwu.workos_user_id = u.workos_user_id
        GROUP BY u.workos_user_id
        HAVING COUNT(iwu.workos_user_id) <> 1 OR COUNT(*) FILTER (WHERE iwu.is_primary) <> 1
        LIMIT 5
      `);
      expect(result.rows).toEqual([]);
    });

    it('the transient backfill column has been dropped', async () => {
      const result = await pool.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'identities' AND column_name = '_backfill_workos_user_id'
      `);
      expect(result.rows).toEqual([]);
    });
  });

  describe('AFTER INSERT trigger', () => {
    it('creates a singleton identity for a newly inserted user', async () => {
      const userId = await insertUser('new1', 'new1@test.example');

      const result = await pool.query<{ identity_id: string; is_primary: boolean }>(
        `SELECT identity_id, is_primary FROM identity_workos_users WHERE workos_user_id = $1`,
        [userId]
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].is_primary).toBe(true);
      expect(result.rows[0].identity_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('does not double-create on idempotent re-upsert', async () => {
      const userId = await insertUser('upsert1', 'upsert1@test.example');

      // Same INSERT shape as upsertUser() in workos-webhooks.ts — ON CONFLICT
      // routes through AFTER UPDATE, not AFTER INSERT, so the trigger should
      // not fire again.
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                            workos_created_at, workos_updated_at, created_at, updated_at)
         VALUES ($1, $2, 'Test', 'User2', true, NOW(), NOW(), NOW(), NOW())
         ON CONFLICT (workos_user_id) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = NOW()`,
        [userId, 'upsert1@test.example']
      );

      const result = await pool.query(
        `SELECT COUNT(*)::int AS n FROM identity_workos_users WHERE workos_user_id = $1`,
        [userId]
      );
      expect(result.rows[0].n).toBe(1);
    });
  });

  describe('invariants', () => {
    it('rejects a second primary binding on the same identity', async () => {
      const userA = await insertUser('inv_a', 'inv_a@test.example');
      const userB = await insertUser('inv_b', 'inv_b@test.example');

      const aIdent = await pool.query<{ identity_id: string }>(
        `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
        [userA]
      );

      // Trying to bind userB to userA's identity as ALSO primary should violate
      // the partial unique index.
      await expect(
        pool.query(
          `UPDATE identity_workos_users SET identity_id = $1, is_primary = TRUE
           WHERE workos_user_id = $2`,
          [aIdent.rows[0].identity_id, userB]
        )
      ).rejects.toThrow(/idx_identity_workos_users_one_primary|unique/i);
    });

    it('CASCADE-removes the binding when a user is deleted', async () => {
      const userId = await insertUser('cascade1', 'cascade1@test.example');

      await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [userId]);

      const result = await pool.query(
        `SELECT 1 FROM identity_workos_users WHERE workos_user_id = $1`,
        [userId]
      );
      expect(result.rows).toEqual([]);
    });
  });
});
