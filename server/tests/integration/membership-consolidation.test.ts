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
import { findSupersededMembershipOrganizations } from '../../src/db/membership-consolidation-db.js';

const TEST_USER_PREFIX = 'user_consolidation_test_';
const TEST_ORG_PREFIX = 'org_consolidation_test_';

describe('findSupersededMembershipOrganizations', () => {
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

  it('reports the organizations both credentials belong to', async () => {
    const targetId = await insertUser('overlap_target');
    const sourceId = await insertUser('overlap_source');
    await insertMembership(targetId, 'shared');
    await insertMembership(sourceId, 'shared');

    expect(await findSupersededMembershipOrganizations(sourceId, targetId)).toEqual([
      `${TEST_ORG_PREFIX}shared`,
    ]);
  });

  it('ignores memberships that would move forward intact', async () => {
    const targetId = await insertUser('solo_target');
    const sourceId = await insertUser('solo_source');
    await insertMembership(targetId, 'target_only');
    await insertMembership(sourceId, 'source_only');

    expect(await findSupersededMembershipOrganizations(sourceId, targetId)).toEqual([]);
  });

  it('reports only the overlap when the source holds both kinds', async () => {
    const targetId = await insertUser('mixed_target');
    const sourceId = await insertUser('mixed_source');
    await insertMembership(targetId, 'mixed_shared');
    await insertMembership(sourceId, 'mixed_shared');
    await insertMembership(sourceId, 'mixed_solo');

    expect(await findSupersededMembershipOrganizations(sourceId, targetId)).toEqual([
      `${TEST_ORG_PREFIX}mixed_shared`,
    ]);
  });

  it('is directional — the reverse check is independent', async () => {
    const targetId = await insertUser('directional_target');
    const sourceId = await insertUser('directional_source');
    await insertMembership(sourceId, 'directional_solo');

    expect(await findSupersededMembershipOrganizations(sourceId, targetId)).toEqual([]);
    expect(await findSupersededMembershipOrganizations(targetId, sourceId)).toEqual([]);
  });

  it('returns nothing when the source holds no memberships', async () => {
    const targetId = await insertUser('empty_target');
    const sourceId = await insertUser('empty_source');
    await insertMembership(targetId, 'empty_target_only');

    expect(await findSupersededMembershipOrganizations(sourceId, targetId)).toEqual([]);
  });
});
