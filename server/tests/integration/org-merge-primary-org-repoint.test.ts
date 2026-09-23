/**
 * users.primary_organization_id under the contained organization merge (#6827).
 *
 * These fixtures previously proved the repoint mergeOrganizations performed:
 * users whose primary pointed at the secondary org landed at the primary org
 * inside the merge transaction, before the secondary row was deleted and the
 * FK ON DELETE SET NULL could null the column. Merge execution is now
 * contained, so the same fixtures prove the stronger property instead — the
 * contained service refuses and no user pointer, membership or organization
 * row moves at all. Restore the repoint assertions together with a reviewed
 * merge lifecycle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeOrganizations } from '../../src/db/org-merge-db.js';
import { OrganizationMergeUnavailableError } from '../../src/db/org-merge-containment.js';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';

const PRIMARY_ORG = 'org_merge_repoint_primary';
const SECONDARY_ORG = 'org_merge_repoint_secondary';
const THIRD_ORG = 'org_merge_repoint_third';
const USER_PRIMARY_AT_SECONDARY = 'user_merge_repoint_at_secondary';
const USER_PRIMARY_ELSEWHERE = 'user_merge_repoint_elsewhere';
const USER_NULL_PRIMARY = 'user_merge_repoint_null';
const MERGED_BY = 'user_merge_repoint_admin';

// Records rather than no-ops: the contained service must never reach it.
const deleteCalls: string[] = [];
const workosStub = {
  organizations: {
    deleteOrganization: async (id: string) => { deleteCalls.push(id); },
  },
} as unknown as WorkOS;

async function expectMergeRefused(pool: Pool) {
  deleteCalls.length = 0;
  await expect(mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub))
    .rejects.toThrow(OrganizationMergeUnavailableError);
  expect(deleteCalls).toEqual([]);
  // The secondary organization is never deleted, so the FK never fires.
  const secondary = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM organizations WHERE workos_organization_id = $1',
    [SECONDARY_ORG],
  );
  expect(secondary.rows[0]?.count).toBe('1');
}

describe('contained mergeOrganizations — users keep their primary organization', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, created_at, updated_at)
       VALUES ($1, 'Primary', NOW(), NOW()),
              ($2, 'Secondary', NOW(), NOW()),
              ($3, 'Third', NOW(), NOW())`,
      [PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG],
    );
  });

  async function cleanup() {
    const actors = [USER_PRIMARY_AT_SECONDARY, USER_PRIMARY_ELSEWHERE, USER_NULL_PRIMARY, MERGED_BY];
    // The users insert trigger creates one identities row per seeded user, and
    // identities do not cascade from users, so capture the ids before the user
    // rows (and their cascading link rows) go away. Scoped to these exact ids so
    // the cleanup cannot reach another suite's rows.
    const identities = (await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)`,
      [actors],
    )).rows.map((row) => row.identity_id);
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id IN ($1, $2, $3)`,
      [PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG],
    );
    await pool.query(`DELETE FROM users WHERE workos_user_id = ANY($1)`, [actors]);
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id IN ($1, $2, $3)`,
      [PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG],
    );
    if (identities.length) {
      await pool.query(`DELETE FROM identities WHERE id = ANY($1)`, [identities]);
    }
  }

  async function seedUser(userId: string, primaryOrgId: string | null) {
    await pool.query(
      `INSERT INTO users (workos_user_id, email, primary_organization_id, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [userId, `${userId}@test.com`, primaryOrgId],
    );
  }

  async function seedMembership(userId: string, orgId: string) {
    await pool.query(
      `INSERT INTO organization_memberships (
         workos_user_id, workos_organization_id, workos_membership_id, email,
         role, seat_type, synced_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'member', 'community_only', NOW(), NOW(), NOW())`,
      [userId, orgId, `om_${userId}_${orgId}`, `${userId}@test.com`],
    );
  }

  it('refuses and leaves every primary_organization_id and membership as it was', async () => {
    // One case rather than four: after an unconditional refusal there is no
    // code path that could treat a secondary-pointing, third-pointing or NULL
    // primary differently, so seed all three and assert the whole set.
    await seedUser(USER_PRIMARY_AT_SECONDARY, SECONDARY_ORG);
    await seedMembership(USER_PRIMARY_AT_SECONDARY, SECONDARY_ORG);
    await seedUser(USER_PRIMARY_ELSEWHERE, THIRD_ORG);
    await seedMembership(USER_PRIMARY_ELSEWHERE, THIRD_ORG);
    await seedMembership(USER_PRIMARY_ELSEWHERE, SECONDARY_ORG);
    await seedUser(USER_NULL_PRIMARY, null);
    await seedMembership(USER_NULL_PRIMARY, SECONDARY_ORG);

    await expectMergeRefused(pool);

    const users = await pool.query<{ workos_user_id: string; primary_organization_id: string | null }>(
      `SELECT workos_user_id, primary_organization_id FROM users
       WHERE workos_user_id = ANY($1) ORDER BY workos_user_id`,
      [[USER_PRIMARY_AT_SECONDARY, USER_PRIMARY_ELSEWHERE, USER_NULL_PRIMARY]],
    );
    expect(
      Object.fromEntries(users.rows.map(row => [row.workos_user_id, row.primary_organization_id])),
    ).toEqual({
      [USER_PRIMARY_AT_SECONDARY]: SECONDARY_ORG,
      [USER_PRIMARY_ELSEWHERE]: THIRD_ORG,
      [USER_NULL_PRIMARY]: null,
    });

    // No membership was moved to the primary organization either. Compared as a
    // set so the assertion does not encode a database collation order.
    const memberships = await pool.query<{ workos_user_id: string; workos_organization_id: string }>(
      `SELECT workos_user_id, workos_organization_id FROM organization_memberships
       WHERE workos_organization_id = ANY($1)`,
      [[PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG]],
    );
    const asSet = (pairs: [string, string][]) =>
      pairs.map(pair => pair.join('|')).sort();
    expect(
      asSet(memberships.rows.map(row => [row.workos_user_id, row.workos_organization_id])),
    ).toEqual(asSet([
      [USER_NULL_PRIMARY, SECONDARY_ORG],
      [USER_PRIMARY_AT_SECONDARY, SECONDARY_ORG],
      [USER_PRIMARY_ELSEWHERE, SECONDARY_ORG],
      [USER_PRIMARY_ELSEWHERE, THIRD_ORG],
    ]));
    // Nothing at all landed on the primary organization.
    expect(memberships.rows.filter(row => row.workos_organization_id === PRIMARY_ORG)).toEqual([]);
  });
});
