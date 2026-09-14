/**
 * Committee Leader Tools
 *
 * Tools for committee leaders to manage co-leaders of their own committees.
 * Works for all committee types: working groups, councils, chapters, and industry gatherings.
 *
 * Permission model:
 * - Leaders can add/remove co-leaders to committees they lead
 * - Leaders can list leaders of committees they lead
 * - Leaders cannot manage committees they don't lead
 * - Leaders cannot remove themselves (must contact admin)
 */

import { createLogger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { getPool } from '../../db/client.js';
import { invalidateWebAdminStatusCache } from './admin-tools.js';
import { inviteToChannel } from '../../slack/client.js';
import type { WorkOSUser } from '../../types.js';
import {
  mutateCommitteeLeader,
  resolveCommitteeLeaderPrincipal,
  type CommitteeLeaderPrincipalResolution,
} from '../../services/committee-leader-mutation.js';
import { getAuthorizationEnforcementWorkos } from '../../auth/workos-client.js';
import { resolveUserOrgAuthorization } from '../../utils/resolve-user-org-authorization.js';

const logger = createLogger('committee-leader-tools');
const wgDb = new WorkingGroupDatabase();
const slackDb = new SlackDatabase();

/**
 * Committee Leader Tool Definitions
 */
export const COMMITTEE_LEADER_TOOLS: AddieTool[] = [
  {
    name: 'add_committee_co_leader',
    description: `Add a co-leader to a committee you lead. Use this when a committee leader wants to add another person to help lead their committee.

Works for working groups, councils, chapters, and industry gatherings.

IMPORTANT: You can only add co-leaders to committees where you are already a leader.

Example uses:
- "Add Sarah as a co-leader for the India Chapter"
- "I want to add John to help lead the Creative Working Group"
- "Add Maria to the CTV Council leadership"`,
    usage_hints: 'Committee leaders adding co-leaders to their own committees',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: {
          type: 'string',
          description: 'Committee slug (e.g., "india-chapter", "creative-wg", "ctv-council")',
        },
        organization_id: {
          type: 'string',
          description: 'Explicitly selected WorkOS organization ID for this action',
        },
        user_id: {
          type: 'string',
          description: 'WorkOS user ID or Slack user ID of the person to add',
        },
        user_email: {
          type: 'string',
          description: 'Email address of the person to add (optional, helps identify them)',
        },
      },
      required: ['committee_slug', 'organization_id', 'user_id'],
    },
  },
  {
    name: 'remove_committee_co_leader',
    description: `Remove a co-leader from a committee you lead. The person will remain a member but lose leadership access.

Works for working groups, councils, chapters, and industry gatherings.

IMPORTANT: You can only remove co-leaders from committees where you are a leader.
You cannot remove yourself as a leader (contact admin for that).`,
    usage_hints: 'Committee leaders removing co-leaders from their own committees',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: {
          type: 'string',
          description: 'Committee slug (e.g., "india-chapter", "creative-wg", "ctv-council")',
        },
        organization_id: {
          type: 'string',
          description: 'Explicitly selected WorkOS organization ID for this action',
        },
        user_id: {
          type: 'string',
          description: 'WorkOS user ID or Slack user ID of the person to remove',
        },
      },
      required: ['committee_slug', 'organization_id', 'user_id'],
    },
  },
  {
    name: 'list_committee_co_leaders',
    description: `List all current leaders of a committee you lead. Shows who has leadership access.

Works for working groups, councils, chapters, and industry gatherings.`,
    usage_hints: 'View co-leaders of committees you lead',
    input_schema: {
      type: 'object',
      properties: {
        committee_slug: {
          type: 'string',
          description: 'Committee slug (e.g., "india-chapter", "creative-wg", "ctv-council")',
        },
        organization_id: {
          type: 'string',
          description: 'Explicitly selected WorkOS organization ID for this request',
        },
      },
      required: ['committee_slug', 'organization_id'],
    },
  },
];

/**
 * Check if a user leads any committees
 */
export async function isCommitteeLeader(slackUserId: string): Promise<boolean> {
  try {
    // Get the user's WorkOS ID
    const slackMapping = await slackDb.getBySlackUserId(slackUserId);
    if (!slackMapping?.workos_user_id) {
      return false;
    }

    const pool = getPool();
    // Check if user leads any committee
    const result = await pool.query(
      `SELECT 1 FROM working_group_leaders wgl
       JOIN working_groups wg ON wg.id = wgl.working_group_id
       LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
       WHERE (wgl.user_id = $1 OR sm.workos_user_id = $1)
       LIMIT 1`,
      [slackMapping.workos_user_id]
    );
    return result.rows.length > 0;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Error checking if user is committee leader');
    return false;
  }
}

type CommitteeLeaderImmutablePrincipal = Pick<
  WorkOSUser,
  'id' | 'authWorkosUserId' | 'authorizationSnapshot'
>;

export type CommitteeLeaderHandlerOptions =
  | {
      /** Web callers must supply the immutable authenticated request principal. */
      surface: 'web';
      principal: CommitteeLeaderImmutablePrincipal;
    }
  | {
      /** Slack binds its signed actor id to one live mapping, then revalidates it in-transaction. */
      surface: 'slack';
      principal?: CommitteeLeaderImmutablePrincipal;
    };

function isLiveSlackCredentialMapping(mapping: {
  workos_user_id?: string | null;
  mapping_status?: string | null;
  slack_is_deleted?: boolean | null;
  slack_is_bot?: boolean | null;
} | null): mapping is {
  workos_user_id: string;
  mapping_status: 'mapped';
  slack_is_deleted: false;
  slack_is_bot: false;
} {
  return mapping?.mapping_status === 'mapped'
    && mapping.slack_is_deleted === false
    && mapping.slack_is_bot === false
    && typeof mapping.workos_user_id === 'string'
    && mapping.workos_user_id.length > 0;
}

/**
 * Get the committees a user leads
 */
async function getCommitteesLedByUser(workosUserId: string): Promise<Array<{ id: string; slug: string; name: string; committee_type: string }>> {
  const pool = getPool();
  const result = await pool.query<{ id: string; slug: string; name: string; committee_type: string }>(
    `SELECT wg.id, wg.slug, wg.name, wg.committee_type
     FROM working_group_leaders wgl
     JOIN working_groups wg ON wg.id = wgl.working_group_id
     LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
     WHERE (wgl.user_id = $1 OR sm.workos_user_id = $1)`,
    [workosUserId]
  );
  return result.rows;
}

/**
 * Format committee type for display
 */
function formatCommitteeType(type: string): string {
  const typeMap: Record<string, string> = {
    working_group: 'working group',
    council: 'council',
    chapter: 'chapter',
    governance: 'governance committee',
    industry_gathering: 'industry gathering',
  };
  return typeMap[type] || type;
}

/**
 * Create committee leader tool handlers
 *
 * These handlers check that the user is a leader of the specified committee
 * before allowing them to modify leadership.
 */
export function createCommitteeLeaderToolHandlers(
  _memberContext: unknown | undefined,
  slackUserId: string | undefined,
  options: CommitteeLeaderHandlerOptions,
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  /** Resolve exact authentication provenance; MemberContext never grants authority. */
  const resolvePrincipal = async (): Promise<CommitteeLeaderPrincipalResolution> => {
    const requestSnapshot = options.principal?.authorizationSnapshot;
    if (requestSnapshot) {
      return { status: 'resolved', snapshot: requestSnapshot };
    }

    const requestCredentialId = options.principal
      ? options.principal.authWorkosUserId ?? options.principal.id
      : null;
    if (requestCredentialId) {
      return resolveCommitteeLeaderPrincipal(requestCredentialId);
    }

    if (options.surface !== 'slack' || !slackUserId) {
      return { status: 'forbidden', reason: 'principal_missing' };
    }
    try {
      const mapping = await slackDb.getBySlackUserId(slackUserId);
      if (!isLiveSlackCredentialMapping(mapping)) {
        return { status: 'forbidden', reason: 'credential_revoked' };
      }
      return resolveCommitteeLeaderPrincipal(mapping.workos_user_id);
    } catch (error) {
      logger.warn({ err: error }, 'Slack credential mapping unavailable for committee leader tool');
      return { status: 'unavailable', source: 'database' };
    }
  };

  /**
   * Check if the current user leads the specified committee
   */
  const checkUserLeadsCommittee = async (committeeSlug: string, organizationId: string): Promise<{ allowed: boolean; unavailable?: boolean; error?: string; committee?: { id: string; name: string; committee_type: string; slack_channel_id?: string | null } }> => {
    const principal = await resolvePrincipal();
    if (principal.status === 'unavailable') {
      return {
        allowed: false,
        unavailable: true,
        error: 'Committee authorization is temporarily unavailable. Please try again.',
      };
    }
    if (principal.status === 'forbidden') {
      return {
        allowed: false,
        error: 'You need to link your Slack account to your AgenticAdvertising.org account to manage committee leadership.',
      };
    }
    if (principal.snapshot.selectedOrganizationId
        && principal.snapshot.selectedOrganizationId !== organizationId) {
      return {
        allowed: false,
        error: 'Select the same organization for the authenticated session and this committee request.',
      };
    }
    let orgAuthorization;
    try {
      orgAuthorization = await resolveUserOrgAuthorization(
        getAuthorizationEnforcementWorkos(),
        {
          id: principal.snapshot.canonicalUserId,
          authWorkosUserId: principal.snapshot.authenticatedUserId,
          authorizationSnapshot: principal.snapshot,
        },
        organizationId,
      );
    } catch (error) {
      logger.warn({ err: error }, 'Committee leader organization authorization unavailable');
      return {
        allowed: false,
        unavailable: true,
        error: 'Committee authorization is temporarily unavailable. Please try again.',
      };
    }
    if (orgAuthorization.status === 'unavailable'
        || (orgAuthorization.status === 'authorized' && !orgAuthorization.complete)) {
      return {
        allowed: false,
        unavailable: true,
        error: 'Committee authorization is temporarily unavailable. Please try again.',
      };
    }
    if (orgAuthorization.status !== 'authorized') {
      return {
        allowed: false,
        error: 'This authenticated credential is not authorized for the selected organization.',
      };
    }

    // Get the committee
    const committee = await wgDb.getWorkingGroupBySlug(committeeSlug);
    if (!committee) {
      return {
        allowed: false,
        error: `Committee "${committeeSlug}" not found. Check the slug and try again.`,
      };
    }

    // Check if user is a leader
    const workosUserId = principal.snapshot.authenticatedUserId;
    const isLeader = await wgDb.isLeader(committee.id, workosUserId);
    if (!isLeader) {
      // Get committees they do lead to give helpful context
      const ledCommittees = await getCommitteesLedByUser(workosUserId);
      if (ledCommittees.length > 0) {
        const committeeNames = ledCommittees.map(c => c.name).join(', ');
        return {
          allowed: false,
          error: `You are not a leader of ${committee.name}. You can manage leadership for: ${committeeNames}.`,
        };
      }
      return {
        allowed: false,
        error: `You are not a leader of ${committee.name}. Only committee leaders can add or remove co-leaders.`,
      };
    }

    return { allowed: true, committee: { id: committee.id, name: committee.name, committee_type: committee.committee_type, slack_channel_id: committee.slack_channel_id } };
  };

  // ============================================
  // ADD COMMITTEE CO-LEADER
  // ============================================
  handlers.set('add_committee_co_leader', async (input) => {
    const committeeSlug = (input.committee_slug as string)?.trim();
    const organizationId = (input.organization_id as string)?.trim();
    const userId = (input.user_id as string)?.trim();
    const userEmail = input.user_email as string | undefined;

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug (e.g., "india-chapter", "creative-wg").';
    }

    if (!userId) {
      return '❌ Please provide a user_id (WorkOS user ID or Slack user ID).';
    }
    if (!organizationId) {
      return '⚠️ Please explicitly select an organization_id before changing committee leadership.';
    }
    if (committeeSlug === 'aao-admin') {
      return '⚠️ AAO site-admin membership must be changed through the dedicated audited admin workflow.';
    }

    try {
      const principal = await resolvePrincipal();
      if (principal.status === 'unavailable') {
        return '❌ Committee authorization is temporarily unavailable. No changes were made.';
      }
      if (principal.status === 'forbidden') {
        return '⚠️ This authenticated credential is not authorized to change committee leadership.';
      }
      const result = await mutateCommitteeLeader({
        action: 'add',
        principal: principal.snapshot,
        selectedOrganizationId: organizationId,
        committeeSlug,
        targetUserId: userId,
        targetEmail: userEmail,
        surface: options.surface,
        slackActorUserId: slackUserId,
      });
      if (result.status === 'unavailable') {
        return '❌ Committee authorization is temporarily unavailable. No changes were made.';
      }
      if (result.status === 'forbidden') {
        if (result.reason === 'organization_required' || result.reason === 'organization_mismatch') {
          return '⚠️ Select the same organization for the authenticated session and this committee action.';
        }
        if (result.reason === 'committee_not_found') {
          return `⚠️ Committee "${committeeSlug}" not found. Check the slug and try again.`;
        }
        return '⚠️ This authenticated credential is not authorized to change leadership for that committee.';
      }
      if (result.status === 'unchanged') {
        return `ℹ️ This person is already a leader of ${result.committeeName}.`;
      }

      invalidateWebAdminStatusCache(result.targetWorkosUserId);

      // Auto-invite to the group's Slack channel (fire-and-forget)
      if (result.slackChannelId) {
        slackDb.getByWorkosUserId(result.targetWorkosUserId).then(mapping => {
          if (mapping?.slack_user_id) {
            return inviteToChannel(result.slackChannelId!, [mapping.slack_user_id]);
          }
        }).catch(err => {
          logger.error({ err, userId: result.targetWorkosUserId, channelId: result.slackChannelId }, 'Failed to auto-invite co-leader to Slack channel');
        });
      }

      logger.info({ committeeSlug, committeeName: result.committeeName, userId: result.targetWorkosUserId, userEmail, addedBy: slackUserId }, 'Added committee co-leader');

      const emailInfo = userEmail ? ` (${userEmail})` : '';
      const typeLabel = formatCommitteeType(result.committeeType);
      return `✅ Successfully added ${userId}${emailInfo} as a co-leader of **${result.committeeName}**.

They now have management access to:
- Create and manage ${typeLabel} events
- Create and manage ${typeLabel} posts
- Add or remove other co-leaders

Management page: https://agenticadvertising.org/working-groups/${committeeSlug}/manage`;
    } catch (error) {
      logger.error({ error, committeeSlug, userId }, 'Error adding committee co-leader');
      return '❌ Failed to add committee co-leader. Please try again.';
    }
  });

  // ============================================
  // REMOVE COMMITTEE CO-LEADER
  // ============================================
  handlers.set('remove_committee_co_leader', async (input) => {
    const committeeSlug = (input.committee_slug as string)?.trim();
    const organizationId = (input.organization_id as string)?.trim();
    const userId = (input.user_id as string)?.trim();

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug (e.g., "india-chapter", "creative-wg").';
    }

    if (!userId) {
      return '❌ Please provide a user_id (WorkOS user ID or Slack user ID).';
    }
    if (!organizationId) {
      return '⚠️ Please explicitly select an organization_id before changing committee leadership.';
    }

    try {
      const principal = await resolvePrincipal();
      if (principal.status === 'unavailable') {
        return '❌ Committee authorization is temporarily unavailable. No changes were made.';
      }
      if (principal.status === 'forbidden') {
        return '⚠️ This authenticated credential is not authorized to change committee leadership.';
      }
      const result = await mutateCommitteeLeader({
        action: 'remove',
        principal: principal.snapshot,
        selectedOrganizationId: organizationId,
        committeeSlug,
        targetUserId: userId,
        surface: options.surface,
        slackActorUserId: slackUserId,
      });
      if (result.status === 'unavailable') {
        return '❌ Committee authorization is temporarily unavailable. No changes were made.';
      }
      if (result.status === 'forbidden') {
        if (result.reason === 'self_removal_forbidden') {
          return '⚠️ You cannot remove your own linked identity as a leader. Please contact an admin.';
        }
        if (result.reason === 'organization_required' || result.reason === 'organization_mismatch') {
          return '⚠️ Select the same organization for the authenticated session and this committee action.';
        }
        return '⚠️ This authenticated credential is not authorized to change leadership for that committee.';
      }
      if (result.status === 'unchanged') {
        return `ℹ️ This person is not a leader of ${result.committeeName}.`;
      }

      invalidateWebAdminStatusCache(result.targetWorkosUserId);

      logger.info({ committeeSlug, committeeName: result.committeeName, userId: result.targetWorkosUserId, removedBy: slackUserId }, 'Removed committee co-leader');

      return `✅ Successfully removed as a leader of **${result.committeeName}**.

They are still a member but no longer have management access.`;
    } catch (error) {
      logger.error({ error, committeeSlug, userId }, 'Error removing committee co-leader');
      return '❌ Failed to remove committee co-leader. Please try again.';
    }
  });

  // ============================================
  // LIST COMMITTEE CO-LEADERS
  // ============================================
  handlers.set('list_committee_co_leaders', async (input) => {
    const committeeSlug = (input.committee_slug as string)?.trim();
    const organizationId = (input.organization_id as string)?.trim();

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug (e.g., "india-chapter", "creative-wg").';
    }
    if (!organizationId) {
      return '⚠️ Please explicitly select an organization_id before listing committee leadership.';
    }

    // Check permission
    const permCheck = await checkUserLeadsCommittee(committeeSlug, organizationId);
    if (!permCheck.allowed) {
      return `⚠️ ${permCheck.error}`;
    }
    const committee = permCheck.committee!;

    try {
      const leaders = await wgDb.getLeaders(committee.id);

      if (leaders.length === 0) {
        return `ℹ️ **${committee.name}** has no assigned leaders.

Use add_committee_co_leader to add a co-leader.`;
      }

      const typeLabel = formatCommitteeType(committee.committee_type);
      let response = `## Leaders of ${committee.name}\n\n`;
      response += `**Type:** ${typeLabel}\n`;
      response += `**Slug:** ${committeeSlug}\n\n`;

      for (const leader of leaders) {
        response += `- **User ID:** ${leader.user_id}\n`;
        if (leader.name) {
          response += `  **Name:** ${leader.name}\n`;
        }
        if (leader.org_name) {
          response += `  **Org:** ${leader.org_name}\n`;
        }
        if (leader.created_at) {
          response += `  Added: ${new Date(leader.created_at).toLocaleDateString()}\n`;
        }
      }

      return response;
    } catch (error) {
      logger.error({ error, committeeSlug }, 'Error listing committee leaders');
      return '❌ Failed to list committee leaders. Please try again.';
    }
  });

  return handlers;
}
