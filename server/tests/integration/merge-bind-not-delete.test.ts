/**
 * Generic identity consolidation containment for #6827. The former merge
 * success contract must stay disabled until authority/provenance are preserved.
 * These fixtures deliberately include both conflicting and exclusive grants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { mergeUsers, previewUserMerge } from '../../src/db/user-merge-db.js';
import { promoteSecondaryIfPrimaryDeleted } from '../../src/db/identity-db.js';
import { bumpAuthorizationEpochs } from '../../src/db/authorization-epoch-db.js';

const JORDAN = 'user_containment_jordan';
const SAM = 'user_containment_sam';
const USERS = [JORDAN, SAM];
const PINNACLE = 'org_containment_pinnacle';
const PERSONAL = 'org_containment_sam';
const ORGS = [PINNACLE, PERSONAL];
const GROUP_SLUG = 'containment-governance';
const refusal = { code: 'identity_mutation_disabled' };

describe('generic identity mutation containment preserves authority', () => {
  let pool: Pool;
  let groupId: string;
  let adminGroupId: string;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    const adminGroup = await pool.query<{ id: string }>(`SELECT id FROM working_groups WHERE slug = 'aao-admin'`);
    expect(adminGroup.rows).toHaveLength(1);
    adminGroupId = adminGroup.rows[0].id;
  }, 60000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name, subscription_status, stripe_subscription_id)
       VALUES ($1, 'Pinnacle Agency', 'active', 'sub_containment_pinnacle'),
              ($2, 'Sam personal workspace', NULL, NULL)`, ORGS,
    );
    await pool.query(
      `INSERT INTO users (workos_user_id, email, first_name, last_name, email_verified,
                          primary_organization_id, workos_created_at, workos_updated_at)
       VALUES ($1, 'jordan@pinnacle.example', 'Jordan', 'Ochoa', true, $3, NOW(), NOW()),
              ($2, 'sam@pinnacle.example', 'Sam', 'Adeyemi', true, $4, NOW(), NOW())`,
      [JORDAN, SAM, PINNACLE, PERSONAL],
    );
    await pool.query(
      `INSERT INTO organization_memberships
         (workos_user_id, workos_organization_id, workos_membership_id, email, role)
       VALUES ($1, $3, 'om_containment_jordan', 'jordan@pinnacle.example', 'owner'),
              ($2, $3, 'om_containment_sam_member', 'sam@pinnacle.example', 'member'),
              ($2, $4, 'om_containment_sam_personal', 'sam@pinnacle.example', 'owner')`,
      [JORDAN, SAM, PINNACLE, PERSONAL],
    );
    const group = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug, is_private, committee_type)
       VALUES ('Governance containment fixture', $1, true, 'governance') RETURNING id`, [GROUP_SLUG],
    );
    groupId = group.rows[0].id;
    // The active aao-admin membership is the actual platform-admin grant.
    // Sam's inactive duplicate must never replace or absorb Jordan's grant.
    await pool.query(
      `INSERT INTO working_group_memberships (working_group_id, workos_user_id, status)
       VALUES ($1, $3, 'active'), ($1, $4, 'inactive'),
              ($2, $3, 'active'), ($2, $4, 'inactive')`,
      [adminGroupId, groupId, JORDAN, SAM],
    );
    await pool.query(
      `INSERT INTO aao_admin_access_events
         (event_type, actor_user_id, target_user_id, mechanism, actor_authorization_mechanism, reason)
       VALUES ('granted', $1, $1, 'aao_admin_working_group', 'development', 'Containment fixture grant')`,
      [JORDAN],
    );
    await pool.query(`INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)`, [groupId, JORDAN]);
    await pool.query(
      `INSERT INTO committee_interest (working_group_id, workos_user_id, interest_level)
       VALUES ($1, $2, 'leader'), ($1, $3, 'participant')`, [groupId, JORDAN, SAM],
    );
    await pool.query(
      `INSERT INTO working_group_topic_subscriptions (working_group_id, workos_user_id, topic_slugs)
       VALUES ($1, $2, ARRAY['governance']), ($1, $3, ARRAY['learning'])`, [groupId, JORDAN, SAM],
    );
    await pool.query(
      `INSERT INTO subscription_line_items
         (workos_organization_id, stripe_subscription_id, stripe_subscription_item_id, price_id, quantity)
       VALUES ($1, 'sub_containment_pinnacle', 'si_containment_pinnacle', 'price_containment', 10)`, [PINNACLE],
    );
    await pool.query(
      `INSERT INTO user_email_aliases (workos_user_id, email)
       VALUES ($1, 'jordan-alias@pinnacle.example'), ($2, 'sam-alias@pinnacle.example')`, USERS,
    );
    await pool.query(
      `INSERT INTO learner_progress (workos_user_id, module_id, status)
       VALUES ($1, 'B1', 'completed'), ($2, 'B1', 'not_started')`, USERS,
    );
    await bumpAuthorizationEpochs(pool, USERS);
  });

  async function cleanup() {
    await pool.query(`DELETE FROM aao_admin_access_events WHERE target_user_id = ANY($1)`, [USERS]);
    await pool.query(`DELETE FROM working_group_memberships WHERE workos_user_id = ANY($1)`, [USERS]);
    await pool.query(`DELETE FROM working_groups WHERE slug = $1`, [GROUP_SLUG]);
    await pool.query(`DELETE FROM organization_memberships WHERE workos_user_id = ANY($1)`, [USERS]);
    await pool.query(`DELETE FROM users WHERE workos_user_id = ANY($1)`, [USERS]);
    await pool.query(`DELETE FROM organizations WHERE workos_organization_id = ANY($1)`, [ORGS]);
  }

  async function snapshot() {
    const tables: Record<string, unknown> = {};
    const selections: [string, string, string[]][] = [
      ['users', 'workos_user_id = ANY($1)', USERS],
      ['identities', 'id IN (SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1))', USERS],
      ['identity_workos_users', 'workos_user_id = ANY($1)', USERS],
      ['authorization_epochs', 'workos_user_id = ANY($1)', USERS],
      ['organization_memberships', 'workos_user_id = ANY($1)', USERS],
      ['organizations', 'workos_organization_id = ANY($1)', ORGS],
      ['working_group_memberships', 'workos_user_id = ANY($1)', USERS],
      ['working_group_leaders', 'user_id = ANY($1)', USERS],
      ['committee_interest', 'workos_user_id = ANY($1)', USERS],
      ['working_group_topic_subscriptions', 'workos_user_id = ANY($1)', USERS],
      ['subscription_line_items', 'workos_organization_id = ANY($1)', ORGS],
      ['aao_admin_access_events', 'target_user_id = ANY($1)', USERS],
      ['user_email_aliases', 'workos_user_id = ANY($1)', USERS],
      ['learner_progress', 'workos_user_id = ANY($1)', USERS],
    ];
    // Compare complete rows, including timestamps, ownership, roles and IDs.
    for (const [table, where, ids] of selections) {
      const result = await pool.query(
        `SELECT row_to_json(row) AS row FROM (SELECT * FROM ${table} WHERE ${where}) row
         ORDER BY row_to_json(row)::text`, [ids],
      );
      tables[table] = result.rows.map(({ row }) => row);
      expect(result.rows.length, `${table} fixture must exercise real rows`).toBeGreaterThan(0);
    }
    return tables;
  }

  it.each([
    ['privilege gain', SAM, JORDAN],
    ['privilege loss', JORDAN, SAM],
  ])('refuses the %s direction without moving or deleting any authority', async (_direction, primary, secondary) => {
    const before = await snapshot();
    await expect(mergeUsers(primary, secondary, JORDAN)).rejects.toMatchObject(refusal);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['privileged to ordinary', JORDAN, SAM],
    ['ordinary to privileged', SAM, JORDAN],
  ])('refuses automatic promotion from %s with historical bindings', async (_direction, primary, secondary) => {
    const original = await pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1`, [secondary],
    );
    // Historical bindings are fixture input, not permission to transfer grants.
    await pool.query(
      `UPDATE identity_workos_users
          SET identity_id = (SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1),
              is_primary = FALSE
        WHERE workos_user_id = $2`, [primary, secondary],
    );
    await pool.query(`DELETE FROM identities WHERE id = $1`, [original.rows[0].identity_id]);
    const before = await snapshot();

    await expect(promoteSecondaryIfPrimaryDeleted(primary)).rejects.toMatchObject(refusal);

    expect(await snapshot()).toEqual(before);
  });

  it('does not permit explicit consolidation or primary-promotion options to bypass refusal', async () => {
    const before = await snapshot();
    await expect(mergeUsers(SAM, JORDAN, JORDAN, {
      ensurePrimaryFlag: true,
      auditContext: { consolidation_confirmed: true, consolidate: true },
    })).rejects.toMatchObject(refusal);
    expect(await snapshot()).toEqual(before);
  });

  it('preserves all authority under concurrent, reversed and replayed calls', async () => {
    const before = await snapshot();
    const attempts = Array.from({ length: 12 }, (_, index) => index % 3 === 0
      ? promoteSecondaryIfPrimaryDeleted(index % 2 ? SAM : JORDAN)
      : mergeUsers(index % 2 ? SAM : JORDAN, index % 2 ? JORDAN : SAM, JORDAN, { ensurePrimaryFlag: true }));
    for (const result of await Promise.allSettled(attempts)) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') expect(result.reason).toMatchObject(refusal);
    }
    await expect(mergeUsers(SAM, JORDAN, JORDAN)).rejects.toMatchObject(refusal);
    expect(await snapshot()).toEqual(before);
  });

  it('keeps read-only detection available without changing authority', async () => {
    const before = await snapshot();
    const preview = await previewUserMerge(SAM, JORDAN);
    expect(preview.tables).toContainEqual({ table_name: 'organization_memberships', row_count: 1 });
    expect(preview.tables).toContainEqual({ table_name: 'working_group_memberships', row_count: 2 });
    expect(await snapshot()).toEqual(before);
  });
});
