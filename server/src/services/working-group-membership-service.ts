/**
 * Working-group membership service.
 *
 * Shared by:
 *  - POST /api/working-groups/:slug/join                (web/API)
 *  - POST /api/working-groups/:slug/interest            (web/API)
 *  - DELETE /api/working-groups/:slug/interest          (web/API)
 *  - join_working_group Addie tool                      (chat)
 *  - express_council_interest Addie tool                (chat)
 *  - withdraw_council_interest Addie tool               (chat)
 *
 * Centralizes the business logic so the route and the Addie tool produce
 * identical outcomes (membership rows, side effects, error variants) and
 * can't drift apart over time. Replaces a previous server-to-self HTTP
 * loopback in `callApi` that was silently rejected by CSRF middleware
 * (issue #3736); the route adapters and Addie adapters now both consume
 * this module instead of routing through HTTP.
 *
 * Side effects (community points, badge checks, leader notifications,
 * Slack channel auto-invite, Addie welcome DM) live here — they're part
 * of "joining a working group", not part of "responding to an HTTP
 * request" — so they fire regardless of caller surface.
 */

import { getPool, query } from '../db/client.js';
import { createLogger } from '../logger.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import type { WorkingGroupMembership } from '../types.js';
import { CommunityDatabase } from '../db/community-db.js';
import { SlackDatabase } from '../db/slack-db.js';
import { invalidateMemberContextCache } from '../addie/member-context-cache.js';
import { invalidateWebAdminStatusCache } from '../addie/admin-status-cache.js';
import { notifyUser } from '../notifications/notification-service.js';
import { inviteToChannel } from '../slack/client.js';
import { sendWgWelcomeMessage } from '../addie/services/wg-welcome.js';
import { getUserSeatType } from '../db/organization-db.js';
import { getWorkos } from '../auth/workos-client.js';

const logger = createLogger('working-group-membership-service');

const workingGroupDb = new WorkingGroupDatabase();

/**
 * Caller identity. Both route (`req.user`) and Addie tool
 * (`memberContext.workos_user`) shape into this; the service doesn't
 * care which surface invoked it.
 */
export interface WorkingGroupServiceUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * Discriminated error codes — adapters render each to the right HTTP
 * status / markdown reply. Avoids HTTP-status guessing on the consumer
 * side, which is what bit us in the loopback bug.
 */
export type WorkingGroupMembershipErrorCode =
  | 'group_not_found'
  | 'group_private'
  | 'community_only_seat_blocked'
  | 'already_member'
  | 'no_interest_recorded';

export interface WorkingGroupMembershipErrorMetaByCode {
  group_not_found: { slug: string };
  group_private: { slug: string; groupName: string };
  community_only_seat_blocked: {
    slug: string;
    groupName: string;
    workingGroupId: string;
    resourceType: 'council' | 'working_group';
    userOrgId: string | null;
  };
  already_member: { slug: string; groupName: string };
  no_interest_recorded: { slug: string; groupName: string };
}

export class WorkingGroupMembershipError<
  C extends WorkingGroupMembershipErrorCode = WorkingGroupMembershipErrorCode,
> extends Error {
  constructor(
    public readonly code: C,
    message: string,
    public readonly meta: WorkingGroupMembershipErrorMetaByCode[C],
  ) {
    super(message);
    this.name = 'WorkingGroupMembershipError';
  }

  is<K extends WorkingGroupMembershipErrorCode>(
    code: K,
  ): this is WorkingGroupMembershipError<K> & { meta: WorkingGroupMembershipErrorMetaByCode[K] } {
    return (this.code as WorkingGroupMembershipErrorCode) === code;
  }
}

interface UserOrgContext {
  orgId: string | undefined;
  orgName: string | undefined;
}

/**
 * Resolve the user's primary WorkOS organization, if any. Best-effort —
 * a missing/erroring WorkOS lookup returns undefined for both fields and
 * the caller proceeds (org context is decorative on memberships and
 * notification copy).
 */
async function resolvePrimaryOrgContext(userId: string): Promise<UserOrgContext> {
  let workos;
  try {
    workos = getWorkos();
  } catch {
    return { orgId: undefined, orgName: undefined };
  }
  try {
    const memberships = await workos.userManagement.listOrganizationMemberships({ userId });
    if (memberships.data.length === 0) return { orgId: undefined, orgName: undefined };
    const org = await workos.organizations.getOrganization(memberships.data[0].organizationId);
    return { orgId: org.id, orgName: org.name };
  } catch {
    return { orgId: undefined, orgName: undefined };
  }
}

function userDisplayName(user: WorkingGroupServiceUser): string {
  if (user.firstName && user.lastName) return `${user.firstName} ${user.lastName}`;
  return user.email;
}

export interface JoinWorkingGroupInput {
  user: WorkingGroupServiceUser;
  slug: string;
}

export interface JoinWorkingGroupResult {
  membership: WorkingGroupMembership;
  groupId: string;
  groupName: string;
  groupSlug: string;
}

/**
 * Add the caller to a public working group.
 * Throws `WorkingGroupMembershipError` for every domain-level failure;
 * unexpected errors propagate up and are handled by the caller.
 */
export async function joinWorkingGroup({ user, slug }: JoinWorkingGroupInput): Promise<JoinWorkingGroupResult> {
  const group = await workingGroupDb.getWorkingGroupBySlug(slug);
  if (!group || group.status !== 'active') {
    throw new WorkingGroupMembershipError('group_not_found', `No working group found with slug: ${slug}`, { slug });
  }

  if (group.is_private) {
    throw new WorkingGroupMembershipError('group_private', 'This working group is private and requires an invitation', {
      slug: group.slug,
      groupName: group.name,
    });
  }

  // Community-only seats cannot join working groups or councils — they
  // need a contributor seat upgrade. Surface enough metadata for the
  // route to render a seat-request payload and the Addie tool to render
  // a "ask your org admin" CTA.
  const seatType = await getUserSeatType(user.id);
  if (seatType === 'community_only') {
    const orgRow = await query<{ workos_organization_id: string }>(
      'SELECT workos_organization_id FROM organization_memberships WHERE workos_user_id = $1 LIMIT 1',
      [user.id],
    );
    const userOrgId = orgRow.rows[0]?.workos_organization_id ?? null;
    throw new WorkingGroupMembershipError(
      'community_only_seat_blocked',
      'Working group membership requires a contributor seat',
      {
        slug: group.slug,
        groupName: group.name,
        workingGroupId: group.id,
        resourceType: group.committee_type === 'council' ? 'council' : 'working_group',
        userOrgId,
      },
    );
  }

  const existingMembership = await workingGroupDb.getMembership(group.id, user.id);
  if (existingMembership && existingMembership.status === 'active') {
    throw new WorkingGroupMembershipError('already_member', 'Already a member', {
      slug: group.slug,
      groupName: group.name,
    });
  }

  const { orgId, orgName } = await resolvePrimaryOrgContext(user.id);
  const userName = userDisplayName(user);

  const membership = await workingGroupDb.addMembership({
    working_group_id: group.id,
    workos_user_id: user.id,
    user_email: user.email,
    user_name: userName,
    workos_organization_id: orgId,
    user_org_name: orgName,
    added_by_user_id: user.id,
  });

  invalidateMemberContextCache();
  invalidateWebAdminStatusCache(user.id);

  // Fire-and-forget side effects — these are part of the join action
  // semantically, but a failure in any of them must not roll back the
  // membership row. Each one logs its own error.
  const communityDb = new CommunityDatabase();
  communityDb.awardPoints(user.id, 'wg_joined', 10, group.id, 'working_group').catch((err) => {
    logger.error({ err, userId: user.id }, 'Failed to award WG join points');
  });
  communityDb.checkAndAwardBadges(user.id, 'wg').catch((err) => {
    logger.error({ err, userId: user.id }, 'Failed to check WG badges');
  });

  if (group.leaders) {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    void (async () => {
      const otherWgNames: string[] = [];
      try {
        const joinerGroups = await workingGroupDb.getWorkingGroupsForUser(user.id);
        for (const g of joinerGroups) {
          if (g.id !== group.id) otherWgNames.push(g.name);
        }
      } catch {
        // Non-critical — leaders still get notified, just without other-WG context.
      }
      const orgContext = orgName ? ` (${esc(orgName)})` : '';
      const wgContext = otherWgNames.length > 0 ? `. Also active in ${otherWgNames.map(esc).join(', ')}` : '';
      for (const leader of group.leaders!) {
        notifyUser({
          recipientUserId: leader.canonical_user_id,
          actorUserId: user.id,
          type: 'wg_member_joined',
          referenceId: group.id,
          referenceType: 'working_group',
          title: `${esc(userName)}${orgContext} joined ${esc(group.name)}${wgContext}`,
          url: `/working-groups/${group.slug}`,
        }).catch((err) => logger.error({ err }, 'Failed to send WG join notification'));
      }
    })().catch((err) => logger.error({ err }, 'Failed to build WG join notification context'));
  }

  if (group.slack_channel_id) {
    const slackDb = new SlackDatabase();
    slackDb
      .getByWorkosUserId(user.id)
      .then((mapping) => {
        if (mapping?.slack_user_id) {
          return inviteToChannel(group.slack_channel_id!, [mapping.slack_user_id]);
        }
      })
      .catch((err) => {
        logger.error({ err, userId: user.id, channelId: group.slack_channel_id }, 'Failed to auto-invite to Slack channel');
      });
  }

  sendWgWelcomeMessage({
    userId: user.id,
    userEmail: user.email,
    userName,
    workingGroupId: group.id,
    workingGroupSlug: group.slug,
    workingGroupName: group.name,
  }).catch((err) => {
    logger.error({ err, userId: user.id }, 'Failed to send WG welcome message');
  });

  return {
    membership,
    groupId: group.id,
    groupName: group.name,
    groupSlug: group.slug,
  };
}

export type CommitteeInterestLevel = 'participant' | 'leader';

export interface ExpressCommitteeInterestInput {
  user: WorkingGroupServiceUser;
  slug: string;
  /** Defaults to 'participant' on invalid/missing input. */
  interestLevel?: string;
}

export interface ExpressCommitteeInterestResult {
  groupId: string;
  groupName: string;
  groupSlug: string;
  interestLevel: CommitteeInterestLevel;
}

/**
 * Record the caller's interest in a launching committee. Idempotent
 * upsert — calling twice with different `interestLevel` updates the row.
 */
export async function expressCommitteeInterest({
  user,
  slug,
  interestLevel,
}: ExpressCommitteeInterestInput): Promise<ExpressCommitteeInterestResult> {
  const validLevels: CommitteeInterestLevel[] = ['participant', 'leader'];
  const level: CommitteeInterestLevel = validLevels.includes(interestLevel as CommitteeInterestLevel)
    ? (interestLevel as CommitteeInterestLevel)
    : 'participant';

  const group = await workingGroupDb.getWorkingGroupBySlug(slug);
  if (!group || group.status !== 'active') {
    throw new WorkingGroupMembershipError('group_not_found', `No committee found with slug: ${slug}`, { slug });
  }

  const { orgId, orgName } = await resolvePrimaryOrgContext(user.id);
  const userName = userDisplayName(user);

  const pool = getPool();
  await pool.query(
    `INSERT INTO committee_interest (
      working_group_id, workos_user_id, user_email, user_name,
      workos_organization_id, user_org_name, interest_level
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (working_group_id, workos_user_id) DO UPDATE SET
      interest_level = COALESCE(EXCLUDED.interest_level, committee_interest.interest_level),
      user_email = EXCLUDED.user_email,
      user_name = EXCLUDED.user_name,
      user_org_name = EXCLUDED.user_org_name`,
    [group.id, user.id, user.email, userName, orgId || null, orgName || null, level],
  );

  logger.info(
    { workingGroupId: group.id, userId: user.id, interestLevel: level },
    'User expressed interest in committee',
  );

  return {
    groupId: group.id,
    groupName: group.name,
    groupSlug: group.slug,
    interestLevel: level,
  };
}

export interface WithdrawCommitteeInterestInput {
  user: WorkingGroupServiceUser;
  slug: string;
}

export interface WithdrawCommitteeInterestResult {
  groupId: string;
  groupName: string;
  groupSlug: string;
}

export async function withdrawCommitteeInterest({
  user,
  slug,
}: WithdrawCommitteeInterestInput): Promise<WithdrawCommitteeInterestResult> {
  const group = await workingGroupDb.getWorkingGroupBySlug(slug);
  if (!group) {
    throw new WorkingGroupMembershipError('group_not_found', `No committee found with slug: ${slug}`, { slug });
  }

  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM committee_interest
     WHERE working_group_id = $1 AND workos_user_id = $2
     RETURNING id`,
    [group.id, user.id],
  );

  if (result.rowCount === 0) {
    throw new WorkingGroupMembershipError(
      'no_interest_recorded',
      'You have not expressed interest in this committee',
      { slug: group.slug, groupName: group.name },
    );
  }

  logger.info({ workingGroupId: group.id, userId: user.id }, 'User withdrew interest in committee');

  return {
    groupId: group.id,
    groupName: group.name,
    groupSlug: group.slug,
  };
}
