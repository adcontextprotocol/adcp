import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import * as database from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { bumpAuthorizationEpochs } from '../../src/db/authorization-epoch-db.js';
import { loadAuthorizationSnapshot } from '../../src/db/user-authorization-snapshot-db.js';
import { mutateCommitteeLeader } from '../../src/services/committee-leader-mutation.js';
import { createCommitteeLeaderToolHandlers } from '../../src/addie/mcp/committee-leader-tools.js';

const enforcementProvider = vi.hoisted(() => ({ membership: true, outage: false }));
const sideEffects = vi.hoisted(() => ({
  journey: vi.fn(async () => undefined),
  points: vi.fn(async () => undefined),
}));
vi.mock('../../src/auth/workos-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/workos-client.js')>();
  return {
    ...actual,
    getAuthorizationEnforcementWorkos: () => provider(enforcementProvider),
  };
});
vi.mock('../../src/addie/services/journey-computation.js', () => ({
  computeJourneyStage: sideEffects.journey,
}));
vi.mock('../../src/db/community-db.js', () => ({
  CommunityDatabase: class {
    awardPoints = sideEffects.points;
  },
}));

const CREDENTIAL_A = 'user_committee_exact_a';
const CREDENTIAL_B = 'user_committee_exact_b';
const TARGET = 'user_committee_exact_target';
const ORGANIZATION_ID = 'org_committee_exact';
const COMMITTEE_SLUG = 'committee-exact-authorization';
const SECOND_COMMITTEE_SLUG = 'committee-exact-authorization-second';
const SLACK_ACTOR = 'U_COMMITTEE_EXACT_ACTOR';
const SLACK_TARGET = 'U_COMMITTEE_EXACT_TARGET';
const USER_IDS = [CREDENTIAL_A, CREDENTIAL_B, TARGET];

function provider(options: { outage?: boolean; membership?: boolean } = {}) {
  return {
    userManagement: {
      listOrganizationMemberships: vi.fn(async ({ userId, organizationId }) => {
        if (options.outage) throw new Error('provider unavailable');
        return {
          data: options.membership === false ? [] : [{
            id: `membership_${userId}`,
            userId,
            organizationId,
            status: 'active',
            role: { slug: 'member' },
          }],
        };
      }),
    },
  } as any;
}

describe('committee leader exact-credential mutation authorization', () => {
  let pool: Pool;
  let committeeId: string;

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
  }, 60_000);

  async function cleanup() {
    await pool.query('DROP TRIGGER IF EXISTS committee_audit_drop_test ON registry_audit_log');
    await pool.query('DROP FUNCTION IF EXISTS committee_audit_drop_test()');
    await pool.query('DELETE FROM registry_audit_log WHERE workos_organization_id = $1', [ORGANIZATION_ID]);
    await pool.query('DELETE FROM working_groups WHERE slug = ANY($1)', [
      [COMMITTEE_SLUG, SECOND_COMMITTEE_SLUG],
    ]);
    await pool.query('DELETE FROM organization_credential_grants WHERE workos_organization_id = $1', [ORGANIZATION_ID]);
    await pool.query('DELETE FROM organization_memberships WHERE workos_organization_id = $1', [ORGANIZATION_ID]);
    await pool.query('DELETE FROM organizations WHERE workos_organization_id = $1', [ORGANIZATION_ID]);
    await pool.query(
      'DELETE FROM slack_user_mappings WHERE slack_user_id = ANY($1)',
      [[SLACK_ACTOR, SLACK_TARGET]],
    );
    const identities = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = ANY($1)',
      [USER_IDS],
    );
    await pool.query('DELETE FROM users WHERE workos_user_id = ANY($1)', [USER_IDS]);
    if (identities.rows.length > 0) {
      await pool.query('DELETE FROM identities WHERE id = ANY($1)', [identities.rows.map((row) => row.identity_id)]);
    }
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    sideEffects.journey.mockClear();
    sideEffects.points.mockClear();
    enforcementProvider.membership = true;
    enforcementProvider.outage = false;
    await cleanup();
    await pool.query(
      `INSERT INTO users (
         workos_user_id, email, email_verified, workos_created_at, workos_updated_at
       ) VALUES
         ($1, 'credential-a@example.test', true, NOW(), NOW()),
         ($2, 'credential-b@example.test', true, NOW(), NOW()),
         ($3, 'target@example.test', true, NOW(), NOW())`,
      USER_IDS,
    );
    await pool.query(
      `INSERT INTO organizations (workos_organization_id, name)
       VALUES ($1, 'Pinnacle Agency')`,
      [ORGANIZATION_ID],
    );
    const committee = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug, committee_type)
       VALUES ('Exact authorization committee', $1, 'working_group')
       RETURNING id`,
      [COMMITTEE_SLUG],
    );
    committeeId = committee.rows[0].id;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (pool) await cleanup();
    await closeDatabase();
  });

  async function link(primaryId: string, secondaryId: string) {
    const oldIdentity = await pool.query<{ identity_id: string }>(
      'SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1',
      [secondaryId],
    );
    await pool.query(
      `UPDATE identity_workos_users
          SET identity_id = (
                SELECT identity_id FROM identity_workos_users WHERE workos_user_id = $1
              ),
              is_primary = FALSE
        WHERE workos_user_id = $2`,
      [primaryId, secondaryId],
    );
    await pool.query('DELETE FROM identities WHERE id = $1', [oldIdentity.rows[0].identity_id]);
  }

  async function snapshot(userId: string) {
    const value = await loadAuthorizationSnapshot(userId, ORGANIZATION_ID);
    expect(value).not.toBeNull();
    return value!;
  }

  async function insertSlackMapping(input: {
    slackUserId: string;
    workosUserId: string | null;
    status?: 'mapped' | 'unmapped' | 'pending_verification';
    deleted?: boolean | null;
    bot?: boolean | null;
  }) {
    await pool.query(
      `INSERT INTO slack_user_mappings (
         slack_user_id, workos_user_id, mapping_status, mapping_source,
         slack_is_deleted, slack_is_bot
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.slackUserId,
        input.workosUserId,
        input.status ?? 'mapped',
        input.status === 'mapped' ? 'user_claimed' : null,
        input.deleted ?? false,
        input.bot ?? false,
      ],
    );
  }

  async function waitUntilConnectionBlocksAnother(blockerPid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
         ) AS blocked`,
        [blockerPid],
      );
      if (result.rows[0].blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`mutation did not reach the expected lock barrier for backend ${blockerPid}`);
  }

  it.each([
    { name: 'canonical leader cannot elevate linked non-leader', primary: CREDENTIAL_A, secondary: CREDENTIAL_B, leader: CREDENTIAL_A, denied: CREDENTIAL_B },
    { name: 'linked exact leader does not lose authority through non-leader canonical identity', primary: CREDENTIAL_A, secondary: CREDENTIAL_B, leader: CREDENTIAL_B, denied: CREDENTIAL_A },
  ])('$name', async ({ primary, secondary, leader, denied }) => {
    await link(primary, secondary);
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, leader],
    );

    const deniedHandler = createCommitteeLeaderToolHandlers(
      { workos_user: { workos_user_id: primary } },
      undefined,
      {
        principal: {
          id: primary,
          authWorkosUserId: denied,
          authorizationSnapshot: await snapshot(denied),
        },
        surface: 'web',
      },
    ).get('add_committee_co_leader')!;
    expect(await deniedHandler({
      committee_slug: COMMITTEE_SLUG,
      organization_id: ORGANIZATION_ID,
      user_id: TARGET,
    })).toContain('not authorized');
    expect((await pool.query(
      'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [committeeId, TARGET],
    )).rowCount).toBe(0);

    const leaderHandler = createCommitteeLeaderToolHandlers(
      { workos_user: { workos_user_id: primary } },
      undefined,
      {
        principal: {
          id: primary,
          authWorkosUserId: leader,
          authorizationSnapshot: await snapshot(leader),
        },
        surface: 'web',
      },
    ).get('add_committee_co_leader')!;
    expect(await leaderHandler({
      committee_slug: COMMITTEE_SLUG,
      organization_id: ORGANIZATION_ID,
      user_id: TARGET,
    })).toContain('Successfully added');
    expect(sideEffects.journey).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      'leadership_change',
      `working_group:${committeeId}`,
    );
    expect(sideEffects.points).toHaveBeenCalledWith(
      TARGET,
      'wg_leadership',
      30,
      committeeId,
      'working_group',
    );

    const audit = await pool.query<{
      workos_user_id: string;
      details: Record<string, string>;
    }>(
      `SELECT workos_user_id, details
         FROM registry_audit_log
        WHERE workos_organization_id = $1
          AND action = 'add_committee_co_leader'`,
      [ORGANIZATION_ID],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].workos_user_id).toBe(leader);
    expect(audit.rows[0].details).toMatchObject({
      actor_authenticated_workos_user_id: leader,
      actor_identity_id: (await snapshot(leader)).identityId,
      actor_canonical_workos_user_id: primary,
      target_workos_user_id: TARGET,
      target_authorization_epoch: '1',
      committee_slug: COMMITTEE_SLUG,
    });
    expect((await snapshot(TARGET)).authorizationEpoch).toBe('1');
  });

  it('removes a co-leader and bumps the target credential epoch in the same commit', async () => {
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2), ($1, $3)`,
      [committeeId, CREDENTIAL_A, TARGET],
    );
    await insertSlackMapping({ slackUserId: SLACK_ACTOR, workosUserId: CREDENTIAL_A });
    const result = await mutateCommitteeLeader({
      action: 'remove', principal: await snapshot(CREDENTIAL_A),
      selectedOrganizationId: ORGANIZATION_ID, committeeSlug: COMMITTEE_SLUG,
      targetUserId: TARGET, surface: 'slack', slackActorUserId: SLACK_ACTOR,
    }, { getWorkos: () => provider() });
    expect(result).toMatchObject({ status: 'mutated', action: 'removed' });
    expect((await pool.query(
      'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [committeeId, TARGET],
    )).rowCount).toBe(0);
    expect((await snapshot(TARGET)).authorizationEpoch).toBe('1');
  });

  it('accepts a live mapped Slack target and bumps that exact WorkOS credential once', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    await insertSlackMapping({ slackUserId: SLACK_TARGET, workosUserId: TARGET });

    const result = await mutateCommitteeLeader({
      action: 'add', principal: await snapshot(CREDENTIAL_A),
      selectedOrganizationId: ORGANIZATION_ID, committeeSlug: COMMITTEE_SLUG,
      targetUserId: SLACK_TARGET, surface: 'web',
    }, { getWorkos: () => provider() });

    expect(result).toMatchObject({
      status: 'mutated', action: 'added', targetWorkosUserId: TARGET,
    });
    expect((await snapshot(TARGET)).authorizationEpoch).toBe('1');
    expect((await pool.query(
      'SELECT epoch FROM authorization_epochs WHERE workos_user_id = $1',
      [TARGET],
    )).rows).toEqual([{ epoch: '1' }]);
  });

  it('accepts an explicit exact-credential grant only after a successful provider consultation', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    await pool.query(
      `INSERT INTO organization_credential_grants (
         workos_user_id, workos_organization_id, role, granted_by_workos_user_id
       ) VALUES ($1, $2, 'member', $1)`,
      [CREDENTIAL_A, ORGANIZATION_ID],
    );
    const result = await mutateCommitteeLeader({
      action: 'add', principal: await snapshot(CREDENTIAL_A),
      selectedOrganizationId: ORGANIZATION_ID, committeeSlug: COMMITTEE_SLUG,
      targetUserId: TARGET, surface: 'web',
    }, { getWorkos: () => provider({ membership: false }) });
    expect(result).toMatchObject({ status: 'mutated', action: 'added' });
    const audit = await pool.query<{ details: Record<string, string> }>(
      `SELECT details FROM registry_audit_log
        WHERE workos_organization_id = $1 AND action = 'add_committee_co_leader'`,
      [ORGANIZATION_ID],
    );
    expect(audit.rows[0].details.authorization_source).toBe('credential_grant');
  });

  it('requires an explicit organization and never chooses one from cached membership state', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    const principal = await snapshot(CREDENTIAL_A);
    const result = await mutateCommitteeLeader({
      action: 'add', principal, selectedOrganizationId: '', committeeSlug: COMMITTEE_SLUG,
      targetUserId: TARGET, surface: 'web',
    }, { getWorkos: () => provider() });
    expect(result).toEqual({ status: 'forbidden', reason: 'organization_required' });
  });

  it('fails closed as typed unavailable on provider and database outages', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    const principal = await snapshot(CREDENTIAL_A);
    const providerFailure = await mutateCommitteeLeader({
      action: 'add', principal, selectedOrganizationId: ORGANIZATION_ID,
      committeeSlug: COMMITTEE_SLUG, targetUserId: TARGET, surface: 'web',
    }, { getWorkos: () => provider({ outage: true }) });
    expect(providerFailure).toEqual({ status: 'unavailable', source: 'workos' });

    vi.spyOn(database, 'getPool').mockImplementation(() => {
      throw new Error('database unavailable');
    });
    const databaseFailure = await mutateCommitteeLeader({
      action: 'add', principal, selectedOrganizationId: ORGANIZATION_ID,
      committeeSlug: COMMITTEE_SLUG, targetUserId: TARGET, surface: 'web',
    }, { getWorkos: () => provider() });
    expect(databaseFailure).toEqual({ status: 'unavailable', source: 'database' });
  });

  it('rechecks WorkOS after the provider barrier and denies a membership revoked in between', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    const principal = await snapshot(CREDENTIAL_A);
    let membership = true;
    const statefulProvider = provider();
    statefulProvider.userManagement.listOrganizationMemberships.mockImplementation(
      async ({ userId, organizationId }: { userId: string; organizationId: string }) => ({
        data: membership ? [{
          id: `membership_${userId}`,
          userId,
          organizationId,
          status: 'active',
          role: { slug: 'member' },
        }] : [],
      }),
    );
    const result = await mutateCommitteeLeader({
      action: 'add', principal, selectedOrganizationId: ORGANIZATION_ID,
      committeeSlug: COMMITTEE_SLUG, targetUserId: TARGET, surface: 'web',
    }, {
      getWorkos: () => statefulProvider,
      afterProviderAuthorization: async () => { membership = false; },
    });
    expect(result).toEqual({ status: 'forbidden', reason: 'organization_forbidden' });
    expect(statefulProvider.userManagement.listOrganizationMemberships).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [committeeId, TARGET],
    )).rowCount).toBe(0);
  });

  it('fails closed when WorkOS becomes unavailable at the final provider recheck', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    const principal = await snapshot(CREDENTIAL_A);
    const statefulProvider = provider();
    let calls = 0;
    statefulProvider.userManagement.listOrganizationMemberships.mockImplementation(
      async ({ userId, organizationId }: { userId: string; organizationId: string }) => {
        calls += 1;
        if (calls === 2) throw new Error('provider unavailable at final recheck');
        return {
          data: [{
            id: `membership_${userId}`,
            userId,
            organizationId,
            status: 'active',
            role: { slug: 'member' },
          }],
        };
      },
    );
    const result = await mutateCommitteeLeader({
      action: 'add', principal, selectedOrganizationId: ORGANIZATION_ID,
      committeeSlug: COMMITTEE_SLUG, targetUserId: TARGET, surface: 'web',
    }, {
      getWorkos: () => statefulProvider,
      afterProviderAuthorization: async () => undefined,
    });
    expect(result).toEqual({ status: 'unavailable', source: 'workos' });
    expect((await pool.query(
      'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [committeeId, TARGET],
    )).rowCount).toBe(0);
  });

  it('serializes Slack actor provenance and denies a reassignment/replay that wins the barrier', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, SLACK_ACTOR],
    );
    await insertSlackMapping({ slackUserId: SLACK_ACTOR, workosUserId: CREDENTIAL_A });
    const principal = await snapshot(CREDENTIAL_A);
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      const blockerPid = Number((await revoker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0].pid);
      await revoker.query(
        'SELECT 1 FROM slack_user_mappings WHERE slack_user_id = $1 FOR UPDATE',
        [SLACK_ACTOR],
      );
      const pendingMutation = mutateCommitteeLeader({
        action: 'add', principal, selectedOrganizationId: ORGANIZATION_ID,
        committeeSlug: COMMITTEE_SLUG, targetUserId: TARGET, surface: 'slack',
        slackActorUserId: SLACK_ACTOR,
      }, { getWorkos: () => provider() });

      await waitUntilConnectionBlocksAnother(blockerPid);

      await revoker.query(
        `UPDATE slack_user_mappings
            SET workos_user_id = $1, updated_at = NOW()
          WHERE slack_user_id = $2`,
        [CREDENTIAL_B, SLACK_ACTOR],
      );
      await revoker.query('COMMIT');

      expect(await pendingMutation).toEqual({ status: 'forbidden', reason: 'authorization_changed' });
      expect((await pool.query(
        'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
        [committeeId, TARGET],
      )).rowCount).toBe(0);
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }
  });

  it.each([
    {
      name: 'revoked/unmapped actor',
      mapping: { workosUserId: null, status: 'unmapped' as const },
    },
    {
      name: 'pending actor status',
      mapping: { workosUserId: CREDENTIAL_A, status: 'pending_verification' as const },
    },
    {
      name: 'deleted actor',
      mapping: { workosUserId: CREDENTIAL_A, deleted: true },
    },
    {
      name: 'bot actor',
      mapping: { workosUserId: CREDENTIAL_A, bot: true },
    },
    {
      name: 'mapped actor without a credential',
      mapping: { workosUserId: null, status: 'mapped' as const },
    },
  ])('rejects $name under the transaction mapping lock', async ({ mapping }) => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, SLACK_ACTOR],
    );
    await insertSlackMapping({ slackUserId: SLACK_ACTOR, ...mapping });
    const result = await mutateCommitteeLeader({
      action: 'add', principal: await snapshot(CREDENTIAL_A),
      selectedOrganizationId: ORGANIZATION_ID, committeeSlug: COMMITTEE_SLUG,
      targetUserId: TARGET, surface: 'slack', slackActorUserId: SLACK_ACTOR,
    }, { getWorkos: () => provider() });

    expect(result).toEqual({ status: 'forbidden', reason: 'authorization_changed' });
    expect((await pool.query(
      'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [committeeId, TARGET],
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log
        WHERE workos_organization_id = $1 AND action = 'add_committee_co_leader'`,
      [ORGANIZATION_ID],
    )).rowCount).toBe(0);
  });

  it.each([
    { name: 'arbitrary id', mapping: null },
    {
      name: 'unmapped Slack id',
      mapping: { workosUserId: TARGET, status: 'unmapped' as const },
    },
    {
      name: 'deleted Slack id',
      mapping: { workosUserId: TARGET, deleted: true },
    },
    {
      name: 'bot Slack id',
      mapping: { workosUserId: TARGET, bot: true },
    },
    {
      name: 'inconsistent mapped Slack id',
      mapping: { workosUserId: null, status: 'mapped' as const },
    },
  ])('rejects a non-live target: $name', async ({ mapping }) => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    if (mapping) {
      await insertSlackMapping({ slackUserId: SLACK_TARGET, ...mapping });
    }
    const result = await mutateCommitteeLeader({
      action: 'add', principal: await snapshot(CREDENTIAL_A),
      selectedOrganizationId: ORGANIZATION_ID, committeeSlug: COMMITTEE_SLUG,
      targetUserId: mapping ? SLACK_TARGET : 'not-a-live-workos-credential', surface: 'web',
    }, { getWorkos: () => provider() });

    expect(result).toEqual({ status: 'forbidden', reason: 'target_invalid' });
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log
        WHERE workos_organization_id = $1 AND action = 'add_committee_co_leader'`,
      [ORGANIZATION_ID],
    )).rowCount).toBe(0);
  });

  it.each([
    { name: 'direct credential', linked: false },
    { name: 'linked credential on the same identity', linked: true },
  ])('never commits self-removal for a $name', async ({ linked }) => {
    if (linked) await link(CREDENTIAL_A, CREDENTIAL_B);
    const actorId = linked ? CREDENTIAL_B : CREDENTIAL_A;
    const targetId = CREDENTIAL_A;
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
      [committeeId, actorId, targetId],
    );

    const result = await mutateCommitteeLeader({
      action: 'remove', principal: await snapshot(actorId),
      selectedOrganizationId: ORGANIZATION_ID, committeeSlug: COMMITTEE_SLUG,
      targetUserId: targetId, surface: 'web',
    }, { getWorkos: () => provider() });
    expect(result).toEqual({ status: 'forbidden', reason: 'self_removal_forbidden' });

    const committedRead = await pool.query(
      'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [committeeId, targetId],
    );
    expect(committedRead.rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log
        WHERE workos_organization_id = $1 AND action = 'remove_committee_co_leader'`,
      [ORGANIZATION_ID],
    )).rowCount).toBe(0);
  });

  it('rolls back mutation, membership, epoch, and side effects when audit insertion is suppressed', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    await pool.query(`
      CREATE FUNCTION committee_audit_drop_test() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'add_committee_co_leader' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await pool.query(`
      CREATE TRIGGER committee_audit_drop_test
      BEFORE INSERT ON registry_audit_log
      FOR EACH ROW EXECUTE FUNCTION committee_audit_drop_test()
    `);

    const result = await mutateCommitteeLeader({
      action: 'add', principal: await snapshot(CREDENTIAL_A),
      selectedOrganizationId: ORGANIZATION_ID, committeeSlug: COMMITTEE_SLUG,
      targetUserId: TARGET, surface: 'web',
    }, { getWorkos: () => provider() });
    expect(result).toEqual({ status: 'unavailable', source: 'database' });
    expect((await pool.query(
      'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
      [committeeId, TARGET],
    )).rowCount).toBe(0);
    expect((await pool.query(
      'SELECT 1 FROM working_group_memberships WHERE working_group_id = $1 AND workos_user_id = $2',
      [committeeId, TARGET],
    )).rowCount).toBe(0);
    expect((await snapshot(TARGET)).authorizationEpoch).toBe('0');
    expect((await pool.query(
      `SELECT 1 FROM registry_audit_log
        WHERE workos_organization_id = $1 AND action = 'add_committee_co_leader'`,
      [ORGANIZATION_ID],
    )).rowCount).toBe(0);
    expect(sideEffects.journey).not.toHaveBeenCalled();
    expect(sideEffects.points).not.toHaveBeenCalled();
  });

  it('follows resource-then-epoch order and denies a grant revocation that wins the barrier', async () => {
    await pool.query(
      'INSERT INTO working_group_leaders (working_group_id, user_id) VALUES ($1, $2)',
      [committeeId, CREDENTIAL_A],
    );
    const grant = await pool.query<{ id: string }>(
      `INSERT INTO organization_credential_grants (
         workos_user_id, workos_organization_id, role, granted_by_workos_user_id
       ) VALUES ($1, $2, 'member', $1)
       RETURNING id`,
      [CREDENTIAL_A, ORGANIZATION_ID],
    );
    const principal = await snapshot(CREDENTIAL_A);
    const revoker = await pool.connect();
    try {
      await revoker.query('BEGIN');
      const blockerPid = Number((await revoker.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )).rows[0].pid);
      await revoker.query(
        'SELECT 1 FROM organization_credential_grants WHERE id = $1 FOR UPDATE',
        [grant.rows[0].id],
      );
      const pendingMutation = mutateCommitteeLeader({
        action: 'add', principal, selectedOrganizationId: ORGANIZATION_ID,
        committeeSlug: COMMITTEE_SLUG, targetUserId: TARGET, surface: 'web',
      }, { getWorkos: () => provider({ membership: false }) });

      await waitUntilConnectionBlocksAnother(blockerPid);

      await revoker.query(
        `UPDATE organization_credential_grants
            SET revoked_at = NOW(), revoked_by_workos_user_id = $1
          WHERE id = $2`,
        [CREDENTIAL_B, grant.rows[0].id],
      );
      await bumpAuthorizationEpochs(revoker, [CREDENTIAL_A]);
      await revoker.query('COMMIT');

      expect(await pendingMutation).toEqual({ status: 'forbidden', reason: 'authorization_changed' });
      expect((await pool.query(
        'SELECT 1 FROM working_group_leaders WHERE working_group_id = $1 AND user_id = $2',
        [committeeId, TARGET],
      )).rowCount).toBe(0);
    } finally {
      await revoker.query('ROLLBACK').catch(() => undefined);
      revoker.release();
    }
  });

  it('serializes opposite actor/target credentials in one deterministic order', async () => {
    const secondCommittee = await pool.query<{ id: string }>(
      `INSERT INTO working_groups (name, slug, committee_type)
       VALUES ('Second exact authorization committee', $1, 'working_group')
       RETURNING id`,
      [SECOND_COMMITTEE_SLUG],
    );
    await pool.query(
      `INSERT INTO working_group_leaders (working_group_id, user_id)
       VALUES ($1, $2), ($3, $4)`,
      [committeeId, CREDENTIAL_A, secondCommittee.rows[0].id, CREDENTIAL_B],
    );
    const [principalA, principalB] = await Promise.all([
      snapshot(CREDENTIAL_A),
      snapshot(CREDENTIAL_B),
    ]);

    const results = await Promise.all([
      mutateCommitteeLeader({
        action: 'add', principal: principalA, selectedOrganizationId: ORGANIZATION_ID,
        committeeSlug: COMMITTEE_SLUG, targetUserId: CREDENTIAL_B, surface: 'web',
      }, { getWorkos: () => provider() }),
      mutateCommitteeLeader({
        action: 'add', principal: principalB, selectedOrganizationId: ORGANIZATION_ID,
        committeeSlug: SECOND_COMMITTEE_SLUG, targetUserId: CREDENTIAL_A, surface: 'web',
      }, { getWorkos: () => provider() }),
    ]);

    expect(results.filter((result) => result.status === 'mutated')).toHaveLength(1);
    expect(results.filter((result) =>
      result.status === 'forbidden' && result.reason === 'authorization_changed'
    )).toHaveLength(1);
  });
});
