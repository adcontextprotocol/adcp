import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { detectGoogleAliasAccount } from '../../src/services/google-alias-detection.js';

const USER_IDS = ['user_alias_authority_gmail', 'user_alias_authority_googlemail'];
const EMAILS = ['alias.authority.test@gmail.com', 'alias.authority.test@googlemail.com'];
const ORG_IDS = ['org_alias_authority_member', 'org_alias_authority_owner'];
const GROUP_SLUG = 'alias-authority-private-committee';

describe('Google aliases never union credential authority', () => {
  let pool: Pool;

  async function cleanup() {
    await pool.query('DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM working_groups WHERE slug = $1', [GROUP_SLUG]);
    await pool.query('DELETE FROM registry_audit_log WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [USER_IDS]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = ANY($1)', [ORG_IDS]);
  }

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
    for (let index = 0; index < 2; index++) {
      await pool.query(
        `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified)
         VALUES ($1, $2, 'Alex', 'Reeves', TRUE)`, [USER_IDS[index], EMAILS[index]],
      );
      await pool.query(
        `INSERT INTO organizations (workos_organization_id, name, subscription_status)
         VALUES ($1, 'Pinnacle Agency', $2)`, [ORG_IDS[index], index ? 'active' : null],
      );
      await pool.query(
        `INSERT INTO organization_memberships
           (workos_user_id, workos_organization_id, email, role, seat_type,
            workos_membership_id, provisioning_source)
         VALUES ($1, $2, $3, $4, $5, $6, 'invited')`,
        [USER_IDS[index], ORG_IDS[index], EMAILS[index], index ? 'owner' : 'member',
          index ? 'contributor' : 'community_only', `om_alias_authority_${index}`],
      );
    }
    const group = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug, is_private)
       VALUES ('Private committee', $1, TRUE) RETURNING id`,
      [GROUP_SLUG],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)`,
      [group.rows[0].id, USER_IDS[1]],
    );
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, added_by_user_id)
       VALUES ($1, $2, $2)`, [group.rows[0].id, USER_IDS[1]],
    );
    const adminMembership = await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, added_by_user_id)
       SELECT id, $1, $1 FROM working_groups WHERE slug = 'aao-admin'`, [USER_IDS[1]],
    );
    expect(adminMembership.rowCount).toBe(1);
  });

  async function snapshot() {
    const results = await Promise.all([
      pool.query('SELECT * FROM users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USER_IDS]),
      pool.query('SELECT * FROM identity_workos_users WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USER_IDS]),
      pool.query('SELECT * FROM organization_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USER_IDS]),
      pool.query('SELECT * FROM organizations WHERE workos_organization_id = ANY($1) ORDER BY workos_organization_id', [ORG_IDS]),
      pool.query('SELECT * FROM working_groups WHERE slug = $1', [GROUP_SLUG]),
      pool.query('SELECT * FROM working_group_leaders WHERE user_id = ANY($1) ORDER BY user_id', [USER_IDS]),
      pool.query('SELECT * FROM working_group_memberships WHERE workos_user_id = ANY($1) ORDER BY workos_user_id, working_group_id', [USER_IDS]),
      pool.query('SELECT * FROM user_email_aliases WHERE workos_user_id = ANY($1) ORDER BY workos_user_id', [USER_IDS]),
    ]);
    return results.map((result) => result.rows);
  }

  it.each([0, 1])('preserves all authority and routing when credential %i signs in, including retries', async (index) => {
    const before = await snapshot();
    const mutate = vi.fn(() => { throw new Error('Automatic authority mutation forbidden'); });
    const provider = {
      listUsers: vi.fn(), createOrganizationMembership: mutate, updateUser: mutate, deleteUser: mutate,
    };

    for (let retry = 0; retry < 2; retry++) {
      expect(await detectGoogleAliasAccount({ id: USER_IDS[index], email: EMAILS[index] }, provider))
        .toBe(EMAILS[1 - index]);
    }

    expect(await snapshot()).toEqual(before);
    expect(mutate).not.toHaveBeenCalled();
    expect(provider.listUsers).not.toHaveBeenCalled();
    // The same join used by authentication still routes each sign-in to itself.
    const routing = await pool.query(
      `SELECT credential.workos_user_id, primary_credential.workos_user_id AS canonical_user_id,
              EXISTS (
                SELECT 1 FROM working_group_memberships membership
                JOIN working_groups group_row ON group_row.id = membership.working_group_id
                WHERE membership.workos_user_id = primary_credential.workos_user_id
                  AND group_row.slug = 'aao-admin' AND membership.status = 'active'
              ) AS is_platform_admin
         FROM identity_workos_users credential
         JOIN identity_workos_users primary_credential
           ON primary_credential.identity_id = credential.identity_id AND primary_credential.is_primary
        WHERE credential.workos_user_id = ANY($1) ORDER BY credential.workos_user_id`,
      [USER_IDS],
    );
    expect(routing.rows).toEqual(USER_IDS.map((id, i) => ({
      workos_user_id: id, canonical_user_id: id, is_platform_admin: i === 1,
    })));
    const audit = await pool.query(
      `SELECT action, workos_user_id, resource_id, details FROM registry_audit_log WHERE workos_user_id = $1`,
      [USER_IDS[index]],
    );
    expect(audit.rows).toEqual(Array.from({ length: 2 }, () => ({
      action: 'google_alias_detected', workos_user_id: USER_IDS[index], resource_id: USER_IDS[1 - index],
      details: { outcome: 'support_review_required' },
    })));
  });
});
