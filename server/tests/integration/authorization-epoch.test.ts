/**
 * Persisted authorization epoch (#6827) integration tests.
 *
 * Exercises migration 565 and the transactional bump against a real
 * PostgreSQL instance:
 *   - an un-bumped credential set has an empty fingerprint
 *   - bumping is monotonic per credential
 *   - a CASCADE delete moves the fingerprint (so callers must compare for
 *     inequality, not ordering)
 *   - refused generic merges and promotions leave fingerprints untouched
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  bumpAuthorizationEpochs,
  getAuthorizationFingerprint,
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

  it('preserves both fingerprints when generic merging is refused', async () => {
    const primaryId = await insertUser('merge_primary');
    const secondaryId = await insertUser('merge_secondary');
    await bumpAuthorizationEpochs(pool, [primaryId, secondaryId]);
    const before = await getAuthorizationFingerprint([primaryId, secondaryId]);

    await expect(mergeUsers(primaryId, secondaryId, primaryId)).rejects.toMatchObject({
      code: 'identity_mutation_disabled',
    });

    expect(await getAuthorizationFingerprint([primaryId, secondaryId])).toBe(before);
  });

  it('preserves every bound fingerprint when automatic promotion is refused', async () => {
    const primaryId = await insertUser('fanout_primary');
    const successorId = await insertUser('fanout_successor');
    const bystanderId = await insertUser('fanout_bystander');
    const credentials = [primaryId, successorId, bystanderId];
    // Model a historical multi-credential identity without invoking the
    // disabled generic merge as test setup.
    const original = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)`,
      [[successorId, bystanderId]],
    );
    await pool.query(
      `UPDATE identity_workos_users
          SET identity_id = (SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1),
              is_primary = FALSE
        WHERE workos_user_id = ANY($2)`,
      [primaryId, [successorId, bystanderId]],
    );
    await pool.query(`DELETE FROM identities WHERE id = ANY($1)`, [original.rows.map((row) => row.identity_id)]);
    await bumpAuthorizationEpochs(pool, credentials);
    const before = await getAuthorizationFingerprint(credentials);

    await expect(promoteSecondaryIfPrimaryDeleted(primaryId)).rejects.toMatchObject({
      code: 'identity_mutation_disabled',
    });

    expect(await getAuthorizationFingerprint(credentials)).toBe(before);
  });

  it('refuses before checking for a missing primary or changing the fingerprint', async () => {
    const secondaryId = await insertUser('missing_secondary');
    await expect(mergeUsers(`${TEST_USER_PREFIX}missing_primary`, secondaryId, secondaryId)).rejects.toMatchObject({
      code: 'identity_mutation_disabled',
    });
    expect(await getAuthorizationFingerprint([secondaryId])).toBe('');
  });
});
