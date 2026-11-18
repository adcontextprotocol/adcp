// COMMITTEE_LEADER_TOOLS: the tool definitions of committee-leader-tools.ts, moved here verbatim so that
// readers of the catalog (the router, tool sets, eval harnesses) do not load
// the handlers and their service, database and SDK dependencies.
import type { AddieTool } from '../types.js';

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
