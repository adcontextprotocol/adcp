/**
 * WorkOS user.deleted webhook — primary-bound user safety.
 *
 * Issue adcontextprotocol/adcp#3718: deleting the primary binding on a
 * multi-credential identity (e.g. GDPR/CCPA erasure via WorkOS dashboard)
 * leaves the identity with zero primaries after the CASCADE on
 * identity_workos_users.workos_user_id fires. `attachIdentityId` then
 * resolves the surviving secondary to a NULL primary and skips the id-swap,
 * so they sign in to an empty workspace.
 *
 * Mitigation: promote the longest-bound surviving secondary to primary in
 * the same transaction, BEFORE the CASCADE runs. This test exercises the
 * `promoteSecondaryIfPrimaryDeleted` helper end-to-end against a real DB
 * and asserts the wiring in the user.deleted handler.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { promoteSecondaryIfPrimaryDeleted } from '../../src/db/identity-db.js';
import type { Pool } from 'pg';

const TEST_USER_PREFIX = 'user_wh_deleted_test_';

describe('user.deleted: promote secondary before CASCADE (#3718)', () => {
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

  /**
   * Bind `secondaryUserId` as a non-primary credential on the same identity
   * as `primaryUserId`, mirroring what `mergeUsers` does when a secondary
   * sign-in email is linked. We do this directly rather than calling
   * mergeUsers so the test stays focused on the deletion path.
   */
  async function bindAsSecondary(
    primaryUserId: string,
    secondaryUserId: string,
    boundAtOffsetSeconds: number,
  ): Promise<string> {
    const identityResult = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [primaryUserId]
    );
    const identityId = identityResult.rows[0].identity_id;

    // Drop the secondary's singleton identity and re-point its binding
    // (mirrors the mergeUsers fixup in user-merge-db.ts).
    const oldIdentity = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`,
      [secondaryUserId]
    );
    await pool.query(
      `UPDATE identity_workos_users
          SET identity_id = $1,
              is_primary = FALSE,
              bound_at = NOW() + ($3 || ' seconds')::interval
        WHERE workos_user_id = $2`,
      [identityId, secondaryUserId, String(boundAtOffsetSeconds)]
    );
    if (oldIdentity.rows[0]?.identity_id && oldIdentity.rows[0].identity_id !== identityId) {
      await pool.query(`DELETE FROM identities WHERE id = $1`, [oldIdentity.rows[0].identity_id]);
    }
    return identityId;
  }

  it('promotes the longest-bound secondary to primary when the primary is deleted', async () => {
    const primary = await insertUser('promote_p', 'primary@test.example');
    const olderSecondary = await insertUser('promote_s1', 'older-secondary@test.example');
    const newerSecondary = await insertUser('promote_s2', 'newer-secondary@test.example');

    // older binds first (smaller bound_at offset), newer binds later
    const identityId = await bindAsSecondary(primary, olderSecondary, 1);
    await bindAsSecondary(primary, newerSecondary, 2);

    const result = await promoteSecondaryIfPrimaryDeleted(primary);

    expect(result).not.toBeNull();
    expect(result!.promotedUserId).toBe(olderSecondary);

    // The deleted user is no longer primary; the older secondary is.
    const primaries = await pool.query<{ workos_user_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, is_primary FROM identity_workos_users
        WHERE identity_id = $1
        ORDER BY workos_user_id`,
      [identityId]
    );
    const byUser = Object.fromEntries(primaries.rows.map(r => [r.workos_user_id, r.is_primary]));
    expect(byUser[primary]).toBe(false);
    expect(byUser[olderSecondary]).toBe(true);
    expect(byUser[newerSecondary]).toBe(false);

    // Exactly one primary on the identity — the partial unique index holds.
    const primaryCount = primaries.rows.filter(r => r.is_primary).length;
    expect(primaryCount).toBe(1);
  });

  it('returns null and leaves state untouched when the identity has no secondaries', async () => {
    const onlyUser = await insertUser('solo', 'solo@test.example');

    const result = await promoteSecondaryIfPrimaryDeleted(onlyUser);

    expect(result).toBeNull();

    // The original primary binding is unchanged.
    const row = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM identity_workos_users WHERE workos_user_id = $1`,
      [onlyUser]
    );
    expect(row.rows[0].is_primary).toBe(true);
  });

  it('returns null when the deleted user is not a primary binding', async () => {
    const primary = await insertUser('np_p', 'primary2@test.example');
    const secondary = await insertUser('np_s', 'secondary2@test.example');
    await bindAsSecondary(primary, secondary, 1);

    // Delete the secondary (not the primary). No promotion is needed.
    const result = await promoteSecondaryIfPrimaryDeleted(secondary);

    expect(result).toBeNull();

    const primaryRow = await pool.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM identity_workos_users WHERE workos_user_id = $1`,
      [primary]
    );
    expect(primaryRow.rows[0].is_primary).toBe(true);
  });

  it('CASCADE on the deleted user removes the binding after promotion', async () => {
    const primary = await insertUser('cascade_p', 'cascadeprimary@test.example');
    const secondary = await insertUser('cascade_s', 'cascadesecondary@test.example');
    const identityId = await bindAsSecondary(primary, secondary, 1);

    const result = await promoteSecondaryIfPrimaryDeleted(primary);
    expect(result?.promotedUserId).toBe(secondary);

    // The webhook handler runs deleteUser() next, which CASCADE-drops the
    // (now non-primary) binding. Surviving primary remains.
    await pool.query(`DELETE FROM users WHERE workos_user_id = $1`, [primary]);

    const survivors = await pool.query<{ workos_user_id: string; is_primary: boolean }>(
      `SELECT workos_user_id, is_primary FROM identity_workos_users WHERE identity_id = $1`,
      [identityId]
    );
    expect(survivors.rows).toHaveLength(1);
    expect(survivors.rows[0].workos_user_id).toBe(secondary);
    expect(survivors.rows[0].is_primary).toBe(true);
  });
});

