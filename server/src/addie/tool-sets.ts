/**
 * Tool Sets for Addie Router
 *
 * Defines categories of tools that can be selected by the Haiku router.
 * This allows Sonnet to receive a focused set of tools based on user intent,
 * reducing context size and improving response quality.
 *
 * Design principles:
 * - Router selects CATEGORIES (easier to get right) not individual tools
 * - Sonnet picks specific tools within categories (it knows best)
 * - Some tools are always available (escape hatches)
 * - Sonnet is told what sets are NOT available so it can redirect if needed
 */

/**
 * Tool set definitions
 * Each set has a name, description (for router), and list of tool names
 */
export interface ToolSet {
  name: string;
  description: string;
  tools: string[];
  /** If true, requires admin role */
  adminOnly?: boolean;
  /** If true, requires precision model (Opus) */
  requiresPrecision?: boolean;
}

/**
 * Tools that are ALWAYS available regardless of routing
 * These are escape hatches that should never be filtered out
 */
export const ALWAYS_AVAILABLE_TOOLS = [
  'escalate_to_admin',   // Can always ask for human help
  'get_account_link',    // Check user's linked status
  'capture_learning',    // Save insights from conversations
  'web_search',          // Built-in Claude tool, always available
];

/**
 * Tool set definitions
 */
export const TOOL_SETS: Record<string, ToolSet> = {
  knowledge: {
    name: 'knowledge',
    description: 'Search documentation, code repos, Slack history, curated resources, and validate JSON against AdCP schemas for protocol questions, implementation help, and community discussions',
    tools: [
      'search_docs',
      'get_doc',
      'search_repos',
      'search_slack',
      'get_channel_activity',
      'search_resources',
      'get_recent_news',
      'fetch_url',
      'read_slack_file',
      // Schema validation tools
      'validate_json',
      'get_schema',
      'list_schemas',
      'compare_schema_versions',
    ],
  },

  member: {
    name: 'member',
    description: 'Manage member profile, working groups, committees, content proposals, and account settings',
    tools: [
      'get_my_profile',
      'update_my_profile',
      'list_working_groups',
      'get_working_group',
      'join_working_group',
      'get_my_working_groups',
      'express_council_interest',
      'withdraw_council_interest',
      'get_my_council_interests',
      'list_perspectives',
      'create_working_group_post',
      'propose_content',
      'get_my_content',
      'bookmark_resource',
    ],
  },

  directory: {
    name: 'directory',
    description: 'Find member organizations, request introductions, search for vendors/partners, and explore the member directory',
    tools: [
      'search_members',
      'request_introduction',
      'get_my_search_analytics',
      'list_members',
      'get_member',
      'list_agents',
      'get_agent',
      'list_publishers',
      'lookup_domain',
    ],
  },

  agent_testing: {
    name: 'agent_testing',
    description: 'Validate and test AdCP agent implementations - check adagents.json, probe endpoints, verify publisher authorization, run compliance tests',
    tools: [
      'validate_adagents',
      'probe_adcp_agent',
      'check_publisher_authorization',
      'test_adcp_agent',
      'validate_agent',
    ],
  },

  adcp_operations: {
    name: 'adcp_operations',
    description: 'Execute AdCP protocol operations - discover products, create media buys, manage creatives, work with signals, and interact with sales/creative/signal agents',
    tools: [
      // Media Buy tools
      'get_products',
      'create_media_buy',
      'sync_creatives',
      'list_creative_formats',
      'list_authorized_properties',
      'get_media_buy_delivery',
      // Creative tools
      'build_creative',
      'preview_creative',
      // Signals tools
      'get_signals',
      'activate_signal',
      // Agent management
      'save_agent',
      'list_saved_agents',
      'remove_saved_agent',
      'setup_test_agent',
    ],
  },

  content: {
    name: 'content',
    description: 'Manage content workflows - draft GitHub issues, propose news sources, handle content approvals, manage committee documents',
    tools: [
      'draft_github_issue',
      'propose_news_source',
      'list_pending_content',
      'approve_content',
      'reject_content',
      'add_committee_document',
      'list_committee_documents',
      'update_committee_document',
      'delete_committee_document',
    ],
  },

  billing: {
    name: 'billing',
    description: 'Handle billing and payment operations - create payment links, send invoices, manage discounts and promotions',
    tools: [
      'find_membership_products',
      'create_payment_link',
      'send_invoice',
      'send_payment_request',
      'grant_discount',
      'remove_discount',
      'list_discounts',
      'create_promotion_code',
    ],
    requiresPrecision: true,
  },

  meetings: {
    name: 'meetings',
    description: 'Schedule meetings and manage calendar - check availability, create calendar events',
    tools: [
      'schedule_meeting',
      'check_availability',
    ],
  },

  committee_leadership: {
    name: 'committee_leadership',
    description: 'Manage committee co-leaders - add or remove co-leaders for committees you lead (working groups, councils, chapters, industry gatherings)',
    tools: [
      'add_committee_co_leader',
      'remove_committee_co_leader',
      'list_committee_co_leaders',
    ],
  },

  admin: {
    name: 'admin',
    description: 'Administrative operations - manage prospects, organizations, feeds, flagged conversations, insights (admin only)',
    tools: [
      'list_pending_invoices',
      'get_account',
      'add_prospect',
      'update_prospect',
      'enrich_company',
      'list_prospects',
      'prospect_search_lusha',
      'search_industry_feeds',
      'add_industry_feed',
      'get_feed_stats',
      'list_feed_proposals',
      'approve_feed_proposal',
      'reject_feed_proposal',
      'add_media_contact',
      'list_flagged_conversations',
      'review_flagged_conversation',
      'create_chapter',
      'list_chapters',
      'create_industry_gathering',
      'list_industry_gatherings',
      'add_committee_leader',
      'remove_committee_leader',
      'list_committee_leaders',
      'merge_organizations',
      'find_duplicate_orgs',
      'check_domain_health',
      'manage_organization_domains',
      'my_engaged_prospects',
      'my_followups_needed',
      'unassigned_prospects',
      'claim_prospect',
      'suggest_prospects',
      'set_reminder',
      'my_upcoming_tasks',
      'log_conversation',
      'get_insight_summary',
      'get_member_search_analytics',
      'list_organizations_by_users',
      'list_slack_users_by_org',
      'tag_insight',
      'list_pending_insights',
      'run_synthesis',
    ],
    adminOnly: true,
  },
};

/**
 * Get all tool names in a set
 */
export function getToolsInSet(setName: string): string[] {
  const set = TOOL_SETS[setName];
  return set ? set.tools : [];
}

/**
 * Get all tool names for multiple sets, including always-available tools
 */
export function getToolsForSets(setNames: string[], isAdmin: boolean = false): string[] {
  const tools = new Set<string>(ALWAYS_AVAILABLE_TOOLS);

  for (const setName of setNames) {
    const toolSet = TOOL_SETS[setName];
    if (toolSet) {
      // Skip admin-only sets if user is not admin
      if (toolSet.adminOnly && !isAdmin) {
        continue;
      }
      for (const tool of toolSet.tools) {
        tools.add(tool);
      }
    }
  }

  return Array.from(tools);
}

/**
 * Get tool set names that were NOT selected (for hinting to Sonnet)
 */
export function getUnavailableSets(selectedSets: string[], isAdmin: boolean = false): string[] {
  return Object.keys(TOOL_SETS).filter(setName => {
    // Don't mention admin set to non-admins
    if (TOOL_SETS[setName].adminOnly && !isAdmin) {
      return false;
    }
    return !selectedSets.includes(setName);
  });
}

/**
 * Build a hint message about unavailable tool sets
 * This helps Sonnet know it can redirect the user if needed
 */
export function buildUnavailableSetsHint(selectedSets: string[], isAdmin: boolean = false): string {
  const unavailable = getUnavailableSets(selectedSets, isAdmin);

  if (unavailable.length === 0) {
    return '';
  }

  const hints = unavailable.map(setName => {
    const set = TOOL_SETS[setName];
    return `- **${setName}**: ${set.description}`;
  });

  return `
## Tool Sets Not Currently Loaded

Based on the user's request, the following tool categories were not loaded. If the user's request actually needs these capabilities, suggest they clarify their intent:

${hints.join('\n')}
`;
}

/**
 * Check if any selected sets require precision mode
 */
export function requiresPrecision(selectedSets: string[]): boolean {
  return selectedSets.some(setName => {
    const set = TOOL_SETS[setName];
    return set?.requiresPrecision === true;
  });
}

/**
 * Get tool set descriptions for the router prompt
 */
export function getToolSetDescriptionsForRouter(isAdmin: boolean = false): string {
  return Object.entries(TOOL_SETS)
    .filter(([_, set]) => !set.adminOnly || isAdmin)
    .map(([name, set]) => `- **${name}**: ${set.description}`)
    .join('\n');
}
