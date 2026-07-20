import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRelationshipContext } from '../../src/addie/services/relationship-context.js';
import { closeDatabase, initializeDatabase, query } from '../../src/db/client.js';
import { CommunityDatabase } from '../../src/db/community-db.js';
import { runMigrations } from '../../src/db/migrate.js';
import { resolvePersonId } from '../../src/db/relationship-db.js';
import { assembleUserJourney } from '../../src/services/user-journey.js';

const ORG_ID = 'org_archived_wg_member_context';
const USER_ID = 'user_archived_wg_member_context';
const ACTIVE_COLLEAGUE_ID = 'user_active_wg_colleague';
const ARCHIVED_COLLEAGUE_ID = 'user_archived_wg_colleague';
const ACTIVE_GROUP_ID = '59300000-0000-4000-8000-000000000001';
const ARCHIVED_GROUP_ID = '59300000-0000-4000-8000-000000000002';
const ACTIVE_GROUP_NAME = 'Current Context Working Group';
const ARCHIVED_GROUP_NAME = 'Archived Context Working Group';

async function cleanup(): Promise<void> {
  await query('DELETE FROM person_relationships WHERE workos_user_id = $1', [USER_ID]);
  await query(
    'DELETE FROM organization_memberships WHERE workos_user_id = ANY($1::text[])',
    [[USER_ID, ACTIVE_COLLEAGUE_ID, ARCHIVED_COLLEAGUE_ID]],
  );
  await query(
    'DELETE FROM users WHERE workos_user_id = ANY($1::text[])',
    [[USER_ID, ACTIVE_COLLEAGUE_ID, ARCHIVED_COLLEAGUE_ID]],
  );
  await query('DELETE FROM working_groups WHERE id = ANY($1::uuid[])', [
    [ACTIVE_GROUP_ID, ARCHIVED_GROUP_ID],
  ]);
  await query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORG_ID]);
}

describe('archived working groups on member and Addie current-state context', () => {
  let personId: string;

  beforeAll(async () => {
    initializeDatabase({
      connectionString:
        process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:53198/adcp_test',
    });
    await runMigrations();
    await cleanup();

    await query(
      `INSERT INTO organizations (
         workos_organization_id, name, subscription_status, created_at, updated_at
       ) VALUES ($1, 'Context Test Organization', 'active', NOW(), NOW())`,
      [ORG_ID],
    );
    await query(
      `INSERT INTO users (
         workos_user_id, email, first_name, last_name, primary_organization_id,
         slug, is_public, created_at, updated_at
       ) VALUES
         ($1, 'member@archived-wg-context.test', 'Main', 'Member', $4, 'archived-wg-main', true, NOW(), NOW()),
         ($2, 'active@archived-wg-context.test', 'Active', 'Colleague', $4, 'archived-wg-active', true, NOW(), NOW()),
         ($3, 'archived@archived-wg-context.test', 'Archived', 'Colleague', $4, 'archived-wg-archived', true, NOW(), NOW())`,
      [USER_ID, ACTIVE_COLLEAGUE_ID, ARCHIVED_COLLEAGUE_ID, ORG_ID],
    );
    await query(
      `INSERT INTO organization_memberships (
         workos_user_id, workos_organization_id, email, role, seat_type, created_at
       ) VALUES
         ($1, $4, 'member@archived-wg-context.test', 'member', 'community_only', NOW()),
         ($2, $4, 'active@archived-wg-context.test', 'member', 'community_only', NOW()),
         ($3, $4, 'archived@archived-wg-context.test', 'member', 'community_only', NOW())`,
      [USER_ID, ACTIVE_COLLEAGUE_ID, ARCHIVED_COLLEAGUE_ID, ORG_ID],
    );
    await query(
      `INSERT INTO working_groups (id, name, slug, status)
       VALUES
         ($1, $3, 'current-context-working-group', 'active'),
         ($2, $4, 'archived-context-working-group', 'archived')`,
      [ACTIVE_GROUP_ID, ARCHIVED_GROUP_ID, ACTIVE_GROUP_NAME, ARCHIVED_GROUP_NAME],
    );
    await query(
      `INSERT INTO working_group_memberships (
         working_group_id, workos_user_id, workos_organization_id, status
       ) VALUES
         ($1, $3, $5, 'active'),
         ($2, $3, $5, 'active'),
         ($1, $4, $5, 'active'),
         ($2, $6, $5, 'active')`,
      [
        ACTIVE_GROUP_ID,
        ARCHIVED_GROUP_ID,
        USER_ID,
        ACTIVE_COLLEAGUE_ID,
        ORG_ID,
        ARCHIVED_COLLEAGUE_ID,
      ],
    );

    personId = await resolvePersonId({ email: 'member@archived-wg-context.test' });
    await query('UPDATE person_relationships SET workos_user_id = $1 WHERE id = $2', [
      USER_ID,
      personId,
    ]);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  it('omits archived memberships from community profile and hub working groups', async () => {
    const communityDb = new CommunityDatabase();

    const profile = await communityDb.getPersonBySlug('archived-wg-main');
    expect(profile?.working_groups.map((group) => group.name)).toEqual([ACTIVE_GROUP_NAME]);

    const hub = await communityDb.getHubData(USER_ID);
    expect(hub.working_groups.map((group) => group.name)).toEqual([ACTIVE_GROUP_NAME]);
    expect(Number(hub.working_groups[0].member_count)).toBe(2);
  });

  it('only uses active parent groups for shared-working-group suggestions', async () => {
    const suggestions = await new CommunityDatabase().getSuggestedConnections(USER_ID, 10);
    const activeColleague = suggestions.find(
      (suggestion) => suggestion.workos_user_id === ACTIVE_COLLEAGUE_ID,
    );
    const archivedColleague = suggestions.find(
      (suggestion) => suggestion.workos_user_id === ARCHIVED_COLLEAGUE_ID,
    );

    expect(activeColleague?.suggestion_context).toBe('Shared working group');
    expect(archivedColleague?.suggestion_context).not.toBe('Shared working group');
  });

  it('omits archived memberships from the user journey and Addie relationship context', async () => {
    const journey = await assembleUserJourney(USER_ID);
    expect(journey.working_groups.map((group) => group.name)).toEqual([ACTIVE_GROUP_NAME]);

    const relationship = await loadRelationshipContext(personId);
    expect(relationship.journey?.working_groups).toEqual([ACTIVE_GROUP_NAME]);
    expect(relationship.journey?.notable_colleagues).toEqual([
      {
        name: 'Active Colleague',
        highlights: [`In ${ACTIVE_GROUP_NAME}`],
      },
    ]);

    const archivedMembership = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM working_group_memberships
       WHERE working_group_id = $1 AND workos_user_id = $2`,
      [ARCHIVED_GROUP_ID, USER_ID],
    );
    expect(archivedMembership.rows[0]?.count).toBe('1');
  });
});
