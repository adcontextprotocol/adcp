import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminToolHandlers } from '../../src/addie/mcp/admin-tools.js';
import { checkMilestones } from '../../src/addie/services/journey-computation.js';
import { inferPersonaForOrg } from '../../src/addie/services/persona-inference.js';
import { closeDatabase, initializeDatabase, query } from '../../src/db/client.js';
import { getDigestEmailRecipients } from '../../src/db/digest-db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { OrganizationDatabase } from '../../src/db/organization-db.js';
import { getMemberCapabilities } from '../../src/db/outbound-db.js';
import { evaluateStageTransitions, getRelationship } from '../../src/db/relationship-db.js';
import { assembleOrgHealth } from '../../src/services/org-health.js';

const ORG_ID = 'org-archived-wg-derived-metrics';
const USER_ID = 'user-archived-wg-derived-metrics';
const USER_EMAIL = 'archived-wg-derived-metrics@test.example.com';
const ORG_NAME = 'Archived WG Derived Metrics Test Org';
const ACTIVE_WG_SLUG = 'creative-active-derived-test';
const ARCHIVED_WG_SLUG = 'technical-standards-archived-derived-test';
const INACTIVE_MEMBERSHIP_WG_SLUG = 'inactive-membership-derived-test';
const ACTIVE_COUNCIL_SLUG = 'active-council-derived-test';
const ARCHIVED_COUNCIL_SLUG = 'archived-council-derived-test';
const TEST_GROUP_SLUGS = [
  ACTIVE_WG_SLUG,
  ARCHIVED_WG_SLUG,
  INACTIVE_MEMBERSHIP_WG_SLUG,
  ACTIVE_COUNCIL_SLUG,
  ARCHIVED_COUNCIL_SLUG,
];

async function groupId(slug: string): Promise<string> {
  const result = await query<{ id: string }>('SELECT id FROM working_groups WHERE slug = $1', [slug]);
  if (!result.rows[0]) throw new Error(`Missing test working group: ${slug}`);
  return result.rows[0].id;
}

async function cleanup(): Promise<void> {
  await query('DELETE FROM org_knowledge WHERE workos_organization_id = $1', [ORG_ID]);
  await query('DELETE FROM person_relationships WHERE workos_user_id = $1', [USER_ID]);
  await query('DELETE FROM community_points WHERE workos_user_id = $1', [USER_ID]);
  await query(
    'DELETE FROM user_email_category_preferences WHERE user_preference_id IN (SELECT id FROM user_email_preferences WHERE workos_user_id = $1)',
    [USER_ID],
  );
  await query('DELETE FROM user_email_preferences WHERE workos_user_id = $1', [USER_ID]);
  await query(
    `DELETE FROM working_group_leaders
     WHERE working_group_id IN (SELECT id FROM working_groups WHERE slug = ANY($1::text[]))`,
    [TEST_GROUP_SLUGS],
  );
  await query(
    `DELETE FROM working_group_memberships
     WHERE working_group_id IN (SELECT id FROM working_groups WHERE slug = ANY($1::text[]))`,
    [TEST_GROUP_SLUGS],
  );
  await query('DELETE FROM organization_memberships WHERE workos_user_id = $1', [USER_ID]);
  await query('DELETE FROM users WHERE workos_user_id = $1', [USER_ID]);
  await query('DELETE FROM working_groups WHERE slug = ANY($1::text[])', [TEST_GROUP_SLUGS]);
  await query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG_ID]);
}

async function seed(): Promise<void> {
  await query(
    `INSERT INTO organizations (workos_organization_id, name, is_personal, created_at)
     VALUES ($1, $2, FALSE, NOW() - INTERVAL '120 days')`,
    [ORG_ID, ORG_NAME],
  );
  await query(
    `INSERT INTO users (workos_user_id, email, first_name, last_name, primary_organization_id)
     VALUES ($1, $2, 'Active', 'Control', $3)`,
    [USER_ID, USER_EMAIL, ORG_ID],
  );
  await query(
    `INSERT INTO organization_memberships
       (workos_organization_id, workos_user_id, email, first_name, last_name, role, seat_type)
     VALUES ($1, $2, $3, 'Active', 'Control', 'member', 'contributor')`,
    [ORG_ID, USER_ID, USER_EMAIL],
  );
  await query(
    `INSERT INTO user_email_preferences
       (workos_user_id, email, unsubscribe_token, marketing_opt_in, marketing_opt_in_at)
     VALUES ($1, $2, $3, TRUE, NOW())`,
    [USER_ID, USER_EMAIL, `token-${USER_ID}`],
  );
  await query(
    `INSERT INTO community_points (workos_user_id, action, points)
     VALUES ($1, 'test_fixture', 100)`,
    [USER_ID],
  );
  await query(
    `INSERT INTO working_groups (name, slug, status, committee_type)
     VALUES
       ('Active creative group', $1, 'active', 'working_group'),
       ('Archived technical standards group', $2, 'archived', 'working_group'),
       ('Inactive membership group', $3, 'active', 'working_group'),
       ('Active council', $4, 'active', 'council'),
       ('Archived council', $5, 'archived', 'council')`,
    TEST_GROUP_SLUGS,
  );

  const activeWgId = await groupId(ACTIVE_WG_SLUG);
  const archivedWgId = await groupId(ARCHIVED_WG_SLUG);
  const inactiveMembershipWgId = await groupId(INACTIVE_MEMBERSHIP_WG_SLUG);
  const activeCouncilId = await groupId(ACTIVE_COUNCIL_SLUG);
  const archivedCouncilId = await groupId(ARCHIVED_COUNCIL_SLUG);

  await query(
    `INSERT INTO working_group_memberships
       (working_group_id, workos_user_id, user_email, workos_organization_id, status)
     VALUES
       ($1, $6, $7, $8, 'active'),
       ($2, $6, $7, $8, 'active'),
       ($3, $6, $7, $8, 'inactive'),
       ($4, $6, $7, $8, 'active'),
       ($5, $6, $7, $8, 'active')`,
    [activeWgId, archivedWgId, inactiveMembershipWgId, activeCouncilId, archivedCouncilId, USER_ID, USER_EMAIL, ORG_ID],
  );
  await query(
    `INSERT INTO working_group_leaders (working_group_id, user_id)
     VALUES ($1, $3), ($2, $3)`,
    [activeWgId, archivedWgId, USER_ID],
  );
  await query(
    `INSERT INTO person_relationships (workos_user_id, email, display_name, stage)
     VALUES ($1, $2, 'Active Control', 'exploring')`,
    [USER_ID, USER_EMAIL],
  );
}

describe('archived working groups in derived current-state metrics', () => {
  beforeAll(async () => {
    initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:51734/adcp_registry',
    });
    await runMigrations();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  beforeEach(async () => {
    await cleanup();
    await seed();
  });

  it('counts only active parent groups and active memberships in Addie-facing metrics', async () => {
    const milestones = await checkMilestones(ORG_ID);
    expect(milestones).toMatchObject({ has_working_groups: true, has_leadership: true });

    const recipient = (await getDigestEmailRecipients()).find(row => row.workos_user_id === USER_ID);
    expect(recipient?.wg_count).toBe(2);

    const capabilities = await getMemberCapabilities('unused-slack-id', USER_ID);
    expect(capabilities).toMatchObject({
      working_group_count: 1,
      council_count: 1,
      is_committee_leader: true,
    });

    const inferred = await inferPersonaForOrg(ORG_ID);
    expect(inferred?.persona).toBe('molecule_builder');
    expect(inferred?.reasons).toContain(`working group: ${ACTIVE_WG_SLUG}`);
    expect(inferred?.reasons).not.toContain(`working group: ${ARCHIVED_WG_SLUG}`);
  });

  it('omits archived names from health and admin summaries while keeping the active control', async () => {
    const health = await assembleOrgHealth(ORG_ID);
    expect(health.people).toHaveLength(1);
    expect(health.people[0].working_groups).toHaveLength(2);
    expect(health.people[0].working_groups).toEqual(
      expect.arrayContaining(['Active creative group', 'Active council']),
    );
    expect(health.health_breakdown.leadership_roles).toBe(1);

    const signals = await new OrganizationDatabase().getEngagementSignals(ORG_ID);
    expect(signals.working_group_count).toBe(2);

    const getAccount = createAdminToolHandlers().get('get_account');
    if (!getAccount) throw new Error('get_account handler not registered');
    const summary = await getAccount({ query: ORG_NAME });
    expect(summary).toContain('Active creative group');
    expect(summary).toContain('Active council');
    expect(summary).not.toContain('Archived technical standards group');
    expect(summary).not.toContain('Archived council');
  });

  it('does not progress a relationship from archived or inactive rows', async () => {
    await query(
      `UPDATE working_group_memberships
       SET status = 'inactive'
       WHERE workos_user_id = $1 AND working_group_id IN (
         SELECT id FROM working_groups WHERE status = 'active'
       )`,
      [USER_ID],
    );
    await query(
      `DELETE FROM working_group_leaders
       WHERE user_id = $1 AND working_group_id IN (
         SELECT id FROM working_groups WHERE status = 'active'
       )`,
      [USER_ID],
    );

    const milestones = await checkMilestones(ORG_ID);
    expect(milestones).toMatchObject({ has_working_groups: false, has_leadership: false });

    const relationshipId = (await query<{ id: string }>(
      'SELECT id FROM person_relationships WHERE workos_user_id = $1',
      [USER_ID],
    )).rows[0].id;
    await evaluateStageTransitions(relationshipId);
    const relationship = await getRelationship(relationshipId);
    expect(relationship?.stage).toBe('exploring');
  });
});
