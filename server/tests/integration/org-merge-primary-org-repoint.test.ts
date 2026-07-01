/**
 * Integration test for the users.primary_organization_id repoint added in
 * mergeOrganizations.
 *
 * Without the repoint, every user whose primary pointed at the secondary
 * org gets a dangling pointer after the merge — the secondary org row gets
 * deleted, the FK ON DELETE SET NULL nulls the column, and the resolver
 * has to re-derive on next read. Worse, if the user wasn't in any other
 * paying org, the resolver might pick a non-paying alternative even
 * though the merge intent was "treat them as part of primary."
 *
 * The repoint runs inside the merge transaction BEFORE the secondary org
 * row is deleted, so users land at the primary org directly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeDatabase, closeDatabase, getPool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeOrganizations } from '../../src/db/org-merge-db.js';
import type { Pool } from 'pg';
import type { WorkOS } from '@workos-inc/node';

const PRIMARY_ORG = 'org_merge_repoint_primary';
const SECONDARY_ORG = 'org_merge_repoint_secondary';
const THIRD_ORG = 'org_merge_repoint_third';
const USER_PRIMARY_AT_SECONDARY = 'user_merge_repoint_at_secondary';
const USER_PRIMARY_ELSEWHERE = 'user_merge_repoint_elsewhere';
const USER_NULL_PRIMARY = 'user_merge_repoint_null';
const MERGED_BY = 'user_merge_repoint_admin';

const workosStub = {
  organizations: {
    deleteOrganization: async (_id: string) => {},
  },
} as unknown as WorkOS;

describe('mergeOrganizations — users.primary_organization_id repoint', () => {
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
    await pool.query(
      `DELETE FROM organization_memberships WHERE workos_organization_id IN ($1, $2, $3)`,
      [PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG],
    );
    await pool.query(
      `DELETE FROM users WHERE workos_user_id IN ($1, $2, $3, $4)`,
      [USER_PRIMARY_AT_SECONDARY, USER_PRIMARY_ELSEWHERE, USER_NULL_PRIMARY, MERGED_BY],
    );
    await pool.query(
      `DELETE FROM organizations WHERE workos_organization_id IN ($1, $2, $3)`,
      [PRIMARY_ORG, SECONDARY_ORG, THIRD_ORG],
    );
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

  it('repoints users whose primary was the secondary org to the primary org', async () => {
    await seedUser(USER_PRIMARY_AT_SECONDARY, SECONDARY_ORG);
    await seedMembership(USER_PRIMARY_AT_SECONDARY, SECONDARY_ORG);

    const summary = await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ primary_organization_id: string | null }>(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
      [USER_PRIMARY_AT_SECONDARY],
    );
    expect(after.rows[0]?.primary_organization_id).toBe(PRIMARY_ORG);

    // Summary reports the repoint so admins running merges can audit it.
    const repointEntry = summary.tables_merged.find(
      (t) => t.table_name === 'users.primary_organization_id',
    );
    expect(repointEntry).toBeDefined();
    expect(repointEntry!.rows_moved).toBe(1);
  });

  it('does not touch users whose primary points at a different org', async () => {
    await seedUser(USER_PRIMARY_ELSEWHERE, THIRD_ORG);
    await seedMembership(USER_PRIMARY_ELSEWHERE, THIRD_ORG);
    await seedMembership(USER_PRIMARY_ELSEWHERE, SECONDARY_ORG);

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ primary_organization_id: string | null }>(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
      [USER_PRIMARY_ELSEWHERE],
    );
    expect(after.rows[0]?.primary_organization_id).toBe(THIRD_ORG);
  });

  it('does not touch users with null primary_organization_id', async () => {
    await seedUser(USER_NULL_PRIMARY, null);
    await seedMembership(USER_NULL_PRIMARY, SECONDARY_ORG);

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ primary_organization_id: string | null }>(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
      [USER_NULL_PRIMARY],
    );
    expect(after.rows[0]?.primary_organization_id).toBeNull();
  });

  it('repoint runs before the secondary org is deleted, so the FK SET NULL never fires for these rows', async () => {
    // Without the repoint, the FK ON DELETE SET NULL would fire when the
    // secondary org row is deleted at the end of the merge, dropping the
    // user's primary to NULL even though we just moved their membership
    // to the primary above. The repoint inside the merge transaction
    // takes precedence — assert the column lands at primary, not NULL.
    await seedUser(USER_PRIMARY_AT_SECONDARY, SECONDARY_ORG);
    await seedMembership(USER_PRIMARY_AT_SECONDARY, SECONDARY_ORG);

    await mergeOrganizations(PRIMARY_ORG, SECONDARY_ORG, MERGED_BY, workosStub);

    const after = await pool.query<{ primary_organization_id: string | null }>(
      'SELECT primary_organization_id FROM users WHERE workos_user_id = $1',
      [USER_PRIMARY_AT_SECONDARY],
    );
    // Specifically NOT null — the FK fired for any column that DIDN'T get
    // repointed, but we explicitly UPDATE'd this one before the DELETE.
    expect(after.rows[0]?.primary_organization_id).not.toBeNull();
    expect(after.rows[0]?.primary_organization_id).toBe(PRIMARY_ORG);

    // Confirm secondary org row was actually deleted (proves the FK
    // would have fired had the repoint not run first).
    const secondaryCheck = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM organizations WHERE workos_organization_id = $1',
      [SECONDARY_ORG],
    );
    expect(secondaryCheck.rows[0]?.count).toBe('0');
  });
});
