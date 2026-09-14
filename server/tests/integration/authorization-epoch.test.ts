/**
 * Persisted authorization epoch (#6827) integration tests.
 *
 * Exercises migration 565 and the transactional bump against a real
 * PostgreSQL instance:
 *   - an un-bumped credential set has an empty fingerprint
 *   - bumping is monotonic per credential
 *   - a CASCADE delete moves the fingerprint (so callers must compare for
 *     inequality, not ordering)
 *   - mergeUsers bumps both credentials inside its own transaction
 *   - a failed mergeUsers leaves the fingerprint untouched
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  bumpAuthorizationEpochs,
  getAuthorizationFingerprint,
  withAuthorizationEpochBump,
} from '../../src/db/authorization-epoch-db.js';
import { mergeUsers } from '../../src/db/user-merge-db.js';
import { promoteSecondaryIfPrimaryDeleted } from '../../src/db/identity-db.js';

const TEST_USER_PREFIX = 'user_authz_epoch_test_';

describe('Authorization epoch (migration 565)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
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

  async function insertUser(suffix: string): Promise<string> {
    const userId = `${TEST_USER_PREFIX}${suffix}`;
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, 'Test', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [userId, `${suffix}@authz-epoch.test`]
    );
    return userId;
  }

  it('reads an empty fingerprint for credentials that were never bumped', async () => {
    const userId = await insertUser('never_bumped');
    expect(await getAuthorizationFingerprint([userId])).toBe('');
  });

  it('reads an empty fingerprint for an empty credential set', async () => {
    expect(await getAuthorizationFingerprint([])).toBe('');
  });

  it('bumps monotonically per credential', async () => {
    const userId = await insertUser('monotonic');

    await bumpAuthorizationEpochs(pool, [userId]);
    expect(await getAuthorizationFingerprint([userId])).toBe(`${userId}:1`);

    await bumpAuthorizationEpochs(pool, [userId]);
    expect(await getAuthorizationFingerprint([userId])).toBe(`${userId}:2`);
  });

  it('commits a credential email refresh and its epoch bump atomically', async () => {
    const userId = await insertUser('email_refresh');

    await withAuthorizationEpochBump([userId], (client) => client.query(
      `UPDATE users SET email = $2, updated_at = NOW() WHERE workos_user_id = $1`,
      [userId, 'refreshed@authz-epoch.test'],
    ));

    const user = await pool.query<{ email: string }>(
      `SELECT email FROM users WHERE workos_user_id = $1`,
      [userId],
    );
    expect(user.rows[0]?.email).toBe('refreshed@authz-epoch.test');
    expect(await getAuthorizationFingerprint([userId])).toBe(`${userId}:1`);
  });

  it('rolls back a credential email refresh when its epoch bump fails', async () => {
    const userId = await insertUser('email_refresh_rollback');
    const functionName = 'reject_credential_email_epoch_bump';
    try {
      await pool.query(`
        CREATE OR REPLACE FUNCTION ${functionName}() RETURNS trigger AS $$
        BEGIN
          IF NEW.workos_user_id = '${userId}' THEN
            RAISE EXCEPTION 'epoch bump unavailable';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${functionName}
          BEFORE INSERT OR UPDATE ON authorization_epochs
          FOR EACH ROW EXECUTE FUNCTION ${functionName}();
      `);

      await expect(withAuthorizationEpochBump([userId], (client) => client.query(
        `UPDATE users SET email = $2, updated_at = NOW() WHERE workos_user_id = $1`,
        [userId, 'must-rollback@authz-epoch.test'],
      ))).rejects.toThrow('epoch bump unavailable');

      const user = await pool.query<{ email: string }>(
        `SELECT email FROM users WHERE workos_user_id = $1`,
        [userId],
      );
      expect(user.rows[0]?.email).toBe('email_refresh_rollback@authz-epoch.test');
      expect(await getAuthorizationFingerprint([userId])).toBe('');
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${functionName} ON authorization_epochs`);
      await pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    }
  });

  it('ignores credentials with no users row instead of failing the transaction', async () => {
    const userId = await insertUser('partial_set');

    await bumpAuthorizationEpochs(pool, [userId, `${TEST_USER_PREFIX}absent`]);

    expect(await getAuthorizationFingerprint([userId])).toBe(`${userId}:1`);
  });

  it('changes the fingerprint when a bumped credential is deleted', async () => {
    const userId = await insertUser('cascade');
    await bumpAuthorizationEpochs(pool, [userId]);
    const before = await getAuthorizationFingerprint([userId]);

    await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [userId]);

    const after = await getAuthorizationFingerprint([userId]);
    expect(after).not.toBe(before);
    expect(after).toBe('');
  });

  it('bumps both credentials when mergeUsers binds them to one identity', async () => {
    const primaryId = await insertUser('merge_primary');
    const secondaryId = await insertUser('merge_secondary');

    await mergeUsers(primaryId, secondaryId, primaryId);

    expect(await getAuthorizationFingerprint([primaryId])).toBe(`${primaryId}:1`);
    expect(await getAuthorizationFingerprint([secondaryId])).toBe(`${secondaryId}:1`);
  });

  it('bumps both credentials when the primary is deleted and a secondary is promoted', async () => {
    const primaryId = await insertUser('promote_primary');
    const secondaryId = await insertUser('promote_secondary');
    await mergeUsers(primaryId, secondaryId, primaryId);

    const promoted = await promoteSecondaryIfPrimaryDeleted(primaryId);

    expect(promoted).toEqual({ promotedUserId: secondaryId });
    expect(await getAuthorizationFingerprint([primaryId])).toBe(`${primaryId}:2`);
    expect(await getAuthorizationFingerprint([secondaryId])).toBe(`${secondaryId}:2`);
  });

  it('bumps every bound credential on promotion, not just the successor', async () => {
    // Three credentials on one identity. Deleting the primary promotes the
    // longest-bound secondary; the third credential's canonical routing moves
    // to that successor too, so its sessions must be revalidated as well.
    const primaryId = await insertUser('fanout_primary');
    const successorId = await insertUser('fanout_successor');
    const bystanderId = await insertUser('fanout_bystander');
    await mergeUsers(primaryId, successorId, primaryId);
    await mergeUsers(primaryId, bystanderId, primaryId);

    const bystanderBefore = await getAuthorizationFingerprint([bystanderId]);

    const promoted = await promoteSecondaryIfPrimaryDeleted(primaryId);

    expect(promoted).toEqual({ promotedUserId: successorId });
    expect(await getAuthorizationFingerprint([bystanderId])).not.toBe(bystanderBefore);
  });

  it('leaves the fingerprint untouched when mergeUsers rolls back', async () => {
    const secondaryId = await insertUser('rollback_secondary');
    const missingPrimaryId = `${TEST_USER_PREFIX}rollback_missing_primary`;

    await expect(mergeUsers(missingPrimaryId, secondaryId, secondaryId)).rejects.toThrow(
      'Primary user does not exist'
    );

    expect(await getAuthorizationFingerprint([secondaryId])).toBe('');
  });
});
