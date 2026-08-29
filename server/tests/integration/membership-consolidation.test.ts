/**
 * Consolidation overlap detection (#6827).
 *
 * The promote endpoint runs the same consolidation as link-credential, which
 * deletes the outgoing credential's membership wherever the incoming one
 * already belongs to the organization. Only that overlap warrants refusing
 * the operation — non-overlapping memberships move forward intact.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { initializeDatabase, closeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { findSupersededMemberships } from '../../src/db/membership-consolidation-db.js';

const TEST_USER_PREFIX = 'user_consolidation_test_';
const TEST_ORG_PREFIX = 'org_consolidation_test_';
const TEST_WG_PREFIX = 'wg-consolidation-test-';

describe('findSupersededMemberships', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(cleanup);

  async function cleanup() {
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id LIKE $1`, [
      `${TEST_USER_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM working_group_memberships WHERE workos_user_id LIKE $1`, [
      `${TEST_USER_PREFIX}%`,
    ]);
    await pool.query(`DELETE FROM working_groups WHERE slug LIKE $1`, [`${TEST_WG_PREFIX}%`]);
    await pool.query(`DELETE FROM users WHERE workos_user_id LIKE $1`, [`${TEST_USER_PREFIX}%`]);
  }

  async function insertUser(suffix: string): Promise<string> {
    const userId = `${TEST_USER_PREFIX}${suffix}`;
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          workos_created_at, workos_updated_at, created_at, updated_at)
       VALUES ($1, $2, 'Test', 'User', true, NOW(), NOW(), NOW(), NOW())`,
      [userId, `${suffix}@consolidation.test`]
    );
    return userId;
  }

  async function insertMembership(userId: string, orgSuffix: string): Promise<string> {
    const orgId = `${TEST_ORG_PREFIX}${orgSuffix}`;
    await pool.query(
      `INSERT INTO organization_memberships (
         workos_user_id, workos_organization_id, workos_membership_id, email, role, seat_type
       ) VALUES ($1, $2, $3, $4, 'member', 'community_only')`,
      [userId, orgId, `om_${userId}_${orgSuffix}`, `${userId}@consolidation.test`]
    );
    return orgId;
  }

  async function insertWorkingGroup(suffix: string): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug) VALUES ($1, $2) RETURNING id`,
      [`Consolidation Test ${suffix}`, `${TEST_WG_PREFIX}${suffix}`]
    );
    return result.rows[0].id;
  }

  async function insertWorkingGroupMembership(userId: string, workingGroupId: string) {
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, user_email)
       VALUES ($1, $2, $3)`,
      [workingGroupId, userId, `${userId}@consolidation.test`]
    );
  }

  it('reports the organizations both credentials belong to', async () => {
    const targetId = await insertUser('overlap_target');
    const sourceId = await insertUser('overlap_source');
    await insertMembership(targetId, 'shared');
    await insertMembership(sourceId, 'shared');

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [`${TEST_ORG_PREFIX}shared`],
      workingGroupIds: [],
    });
  });

  it('ignores memberships that would move forward intact', async () => {
    const targetId = await insertUser('solo_target');
    const sourceId = await insertUser('solo_source');
    await insertMembership(targetId, 'target_only');
    await insertMembership(sourceId, 'source_only');

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [],
      workingGroupIds: [],
    });
  });

  it('reports only the overlap when the source holds both kinds', async () => {
    const targetId = await insertUser('mixed_target');
    const sourceId = await insertUser('mixed_source');
    await insertMembership(targetId, 'mixed_shared');
    await insertMembership(sourceId, 'mixed_shared');
    await insertMembership(sourceId, 'mixed_solo');

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [`${TEST_ORG_PREFIX}mixed_shared`],
      workingGroupIds: [],
    });
  });

  it('is directional — the reverse check is independent', async () => {
    const targetId = await insertUser('directional_target');
    const sourceId = await insertUser('directional_source');
    await insertMembership(sourceId, 'directional_solo');

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [],
      workingGroupIds: [],
    });
    expect(await findSupersededMemberships(targetId, sourceId)).toEqual({
      organizationIds: [],
      workingGroupIds: [],
    });
  });

  it('reports working groups both credentials belong to', async () => {
    const targetId = await insertUser('wg_target');
    const sourceId = await insertUser('wg_source');
    const sharedGroupId = await insertWorkingGroup('shared');
    await insertWorkingGroupMembership(targetId, sharedGroupId);
    await insertWorkingGroupMembership(sourceId, sharedGroupId);

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [],
      workingGroupIds: [sharedGroupId],
    });
  });

  it('ignores a working group only the source belongs to', async () => {
    const targetId = await insertUser('wg_solo_target');
    const sourceId = await insertUser('wg_solo_source');
    const groupId = await insertWorkingGroup('solo');
    await insertWorkingGroupMembership(sourceId, groupId);

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [],
      workingGroupIds: [],
    });
  });

  it('reports an organization and a working group overlap together', async () => {
    const targetId = await insertUser('both_target');
    const sourceId = await insertUser('both_source');
    await insertMembership(targetId, 'both_shared');
    await insertMembership(sourceId, 'both_shared');
    const sharedGroupId = await insertWorkingGroup('both');
    await insertWorkingGroupMembership(targetId, sharedGroupId);
    await insertWorkingGroupMembership(sourceId, sharedGroupId);

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [`${TEST_ORG_PREFIX}both_shared`],
      workingGroupIds: [sharedGroupId],
    });
  });

  it('returns nothing when the source holds no memberships', async () => {
    const targetId = await insertUser('empty_target');
    const sourceId = await insertUser('empty_source');
    await insertMembership(targetId, 'empty_target_only');

    expect(await findSupersededMemberships(sourceId, targetId)).toEqual({
      organizationIds: [],
      workingGroupIds: [],
    });
  });
});
