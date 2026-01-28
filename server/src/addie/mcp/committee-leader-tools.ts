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
import type { MemberContext } from '../member-context.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { getPool } from '../../db/client.js';
import { invalidateWebAdminStatusCache } from './admin-tools.js';

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
        user_id: {
          type: 'string',
          description: 'WorkOS user ID or Slack user ID of the person to add',
        },
        user_email: {
          type: 'string',
          description: 'Email address of the person to add (optional, helps identify them)',
        },
      },
      required: ['committee_slug', 'user_id'],
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
        user_id: {
          type: 'string',
          description: 'WorkOS user ID or Slack user ID of the person to remove',
        },
      },
      required: ['committee_slug', 'user_id'],
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
      },
      required: ['committee_slug'],
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
  memberContext?: MemberContext | null,
  slackUserId?: string
): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  /**
   * Get the current user's WorkOS ID from context or Slack mapping
   */
  const getCurrentUserWorkosId = async (): Promise<string | null> => {
    // Try to get from member context first
    if (memberContext?.workos_user?.workos_user_id) {
      return memberContext.workos_user.workos_user_id;
    }

    // Fall back to Slack mapping
    if (slackUserId) {
      const mapping = await slackDb.getBySlackUserId(slackUserId);
      return mapping?.workos_user_id || null;
    }

    return null;
  };

  /**
   * Check if the current user leads the specified committee
   */
  const checkUserLeadsCommittee = async (committeeSlug: string): Promise<{ allowed: boolean; error?: string; committee?: { id: string; name: string; committee_type: string } }> => {
    const workosUserId = await getCurrentUserWorkosId();
    if (!workosUserId) {
      return {
        allowed: false,
        error: 'You need to link your Slack account to your AgenticAdvertising.org account to manage committee leadership.',
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

    return { allowed: true, committee: { id: committee.id, name: committee.name, committee_type: committee.committee_type } };
  };

  // ============================================
  // ADD COMMITTEE CO-LEADER
  // ============================================
  handlers.set('add_committee_co_leader', async (input) => {
    const committeeSlug = (input.committee_slug as string)?.trim();
    let userId = (input.user_id as string)?.trim();
    const userEmail = input.user_email as string | undefined;

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug (e.g., "india-chapter", "creative-wg").';
    }

    if (!userId) {
      return '❌ Please provide a user_id (WorkOS user ID or Slack user ID).';
    }

    // Check permission
    const permCheck = await checkUserLeadsCommittee(committeeSlug);
    if (!permCheck.allowed) {
      return `⚠️ ${permCheck.error}`;
    }
    const committee = permCheck.committee!;

    try {
      // Resolve to canonical ID for consistent comparison
      // The DB methods also resolve, but we need the canonical ID for the "already a leader" check
      const canonicalUserId = await wgDb.resolveToCanonicalUserId(userId);

      // Check if already a leader
      const leaders = await wgDb.getLeaders(committee.id);
      if (leaders.some((l) => l.canonical_user_id === canonicalUserId)) {
        return `ℹ️ This person is already a leader of ${committee.name}.`;
      }

      // Add as leader (DB method also resolves IDs, but we pass canonical for consistency)
      await wgDb.addLeader(committee.id, canonicalUserId);

      // Invalidate cache after adding as leader (leadership affects permissions)
      invalidateWebAdminStatusCache(canonicalUserId);

      // Also ensure they're a member
      const memberships = await wgDb.getMembershipsByWorkingGroup(committee.id);
      if (!memberships.some(m => m.workos_user_id === canonicalUserId)) {
        await wgDb.addMembership({
          working_group_id: committee.id,
          workos_user_id: canonicalUserId,
          user_email: userEmail,
        });
      }

      logger.info({ committeeSlug, committeeName: committee.name, userId: canonicalUserId, userEmail, addedBy: slackUserId }, 'Added committee co-leader');

      const emailInfo = userEmail ? ` (${userEmail})` : '';
      const typeLabel = formatCommitteeType(committee.committee_type);
      return `✅ Successfully added ${userId}${emailInfo} as a co-leader of **${committee.name}**.

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
    let userId = (input.user_id as string)?.trim();

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug (e.g., "india-chapter", "creative-wg").';
    }

    if (!userId) {
      return '❌ Please provide a user_id (WorkOS user ID or Slack user ID).';
    }

    // Check permission
    const permCheck = await checkUserLeadsCommittee(committeeSlug);
    if (!permCheck.allowed) {
      return `⚠️ ${permCheck.error}`;
    }
    const committee = permCheck.committee!;

    try {
      // Resolve to canonical ID for consistent comparison
      const canonicalUserId = await wgDb.resolveToCanonicalUserId(userId);

      // Get current user's WorkOS ID
      const currentUserWorkosId = await getCurrentUserWorkosId();

      // Prevent removing yourself - compare canonical IDs to prevent bypass
      if (canonicalUserId === currentUserWorkosId) {
        return `⚠️ You cannot remove yourself as a leader. If you want to step down from leading ${committee.name}, please contact an admin.`;
      }

      // Check if they are a leader
      const leaders = await wgDb.getLeaders(committee.id);
      if (!leaders.some((l) => l.canonical_user_id === canonicalUserId)) {
        return `ℹ️ This person is not a leader of ${committee.name}.`;
      }

      await wgDb.removeLeader(committee.id, canonicalUserId);
      invalidateWebAdminStatusCache(canonicalUserId);

      logger.info({ committeeSlug, committeeName: committee.name, userId: canonicalUserId, removedBy: slackUserId }, 'Removed committee co-leader');

      return `✅ Successfully removed as a leader of **${committee.name}**.

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

    if (!committeeSlug) {
      return '❌ Please provide a committee_slug (e.g., "india-chapter", "creative-wg").';
    }

    // Check permission
    const permCheck = await checkUserLeadsCommittee(committeeSlug);
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
