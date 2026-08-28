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
  /** If false, retained only for compatibility with an older routed plan. */
  routerVisible?: boolean;
  /** If true, requires precision model (Opus) */
  requiresPrecision?: boolean;
}

/**
 * Tools that are ALWAYS available regardless of routing
 * These are escape hatches that should never be filtered out
 */
export const ALWAYS_AVAILABLE_TOOLS = [
  "escalate_to_admin", // Can always ask for human help
  "get_escalation_status", // Can always check on their escalations
  "get_account_link", // Check user's linked status
  "capture_learning", // Save insights from conversations
  "web_search", // Built-in Claude tool, always available
  "set_outreach_preference", // Users can always opt out of proactive outreach
  "search_image_library", // Illustrations to enrich explanations — not topic-dependent
  "draft_github_issue", // Bug reports & feature requests should always be possible
  "create_github_issue", // Paired with draft — if a member wants it filed directly, keep it reachable
  "get_github_issue", // Users paste GitHub links in any conversation; reading should never be routed away
  // Content submission is a first-class action — a member sharing a draft in
  // any channel (editorial, admin, DM) should land in pending_review, not an
  // escalation. Permission gating happens inside the handlers.
  "propose_content",
  "get_my_content",
  "list_pending_content",
  "approve_content",
  "reject_content",
  "request_revisions",
  // Members routinely share Google Doc links as drafts. Reading the doc is
  // the precondition for calling propose_content, so it should be available
  // in any channel regardless of router intent selection. The handler is
  // gated on GOOGLE_* credentials at registration, so environments without
  // Google integration don't expose it anyway.
  "read_google_doc",
  // Illustration tools — members ask for covers on their own posts from
  // any channel. Handler gates on author-of-perspective + monthly quota
  // + tool-call rate limit. #2783.
  "check_illustration_status",
  "generate_perspective_illustration",
];

/**
 * Tools always available for admins regardless of routing.
 * Escalation resolution is a quick action that admins trigger in any thread
 * context — routing often misses it because the message is brief.
 */
export const ALWAYS_AVAILABLE_ADMIN_TOOLS = [
  "resolve_escalation",
  "list_escalations",
];

/**
 * Tools excluded from ALWAYS_AVAILABLE in public channels
 * to prevent enrollment pitching where it doesn't belong
 */
const ENROLLMENT_TOOLS = ["get_account_link"];

/**
 * Bounded admin domains exposed to the router. These retain the existing
 * atomic tool names, schemas, handlers, authorization, confirmation, and
 * audit behavior while preventing every admin turn from receiving the old
 * monolithic surface.
 */
export const ADMIN_DOMAIN_TOOL_SETS = {
  admin_events: [
    "create_event",
    "update_event",
    "manage_event_registrations",
    "check_person_event_status",
    "invite_to_event",
  ],
  admin_prospects: [
    "add_prospect",
    "update_prospect",
    "enrich_company",
    "query_prospects",
    "prospect_search_lusha",
    "claim_prospect",
    "triage_prospect_domain",
    "suggest_prospects",
  ],
  admin_feeds: [
    "search_industry_feeds",
    "add_industry_feed",
    "get_feed_stats",
    "list_feed_proposals",
    "approve_feed_proposal",
    "reject_feed_proposal",
    "add_media_contact",
  ],
  admin_groups: [
    "create_chapter",
    "list_chapters",
    "create_industry_gathering",
    "list_industry_gatherings",
    "list_working_groups",
    "get_working_group",
    "add_committee_leader",
    "remove_committee_leader",
    "list_committee_leaders",
    "add_working_group_member",
    "remove_working_group_member",
    "rename_working_group",
  ],
  admin_organizations: [
    "merge_organizations",
    "find_duplicate_orgs",
    "check_domain_health",
    "manage_organization_domains",
    "update_org_member_role",
    "list_slack_users_by_org",
    "list_paying_members",
    "update_member_logo",
    "update_member_profile",
  ],
  admin_workflows: [
    "query_admin_analytics",
    "list_flagged_conversations",
    "review_flagged_conversation",
    "set_reminder",
    "my_upcoming_tasks",
    "complete_task",
    "log_conversation",
  ],
  admin_brands: [
    "list_missing_brands",
    "list_missing_properties",
    "list_pending_brand_logos",
    "list_brand_logos",
    "review_brand_logo",
    "list_pending_community_mirrors",
    "transfer_brand_ownership",
    "list_orphaned_brands",
  ],
} as const;

const LEGACY_ADMIN_BILLING_TOOLS = [
  "list_pending_invoices",
  "get_account",
  "resend_invoice",
  "update_billing_email",
];

const LEGACY_ADMIN_OUTREACH_TOOLS = [
  "get_outreach_stats",
  "get_outreach_history",
  "send_outreach",
  "lookup_person",
  "get_action_items",
  "create_contact",
];

/**
 * Exact compatibility union for plans created before the admin-domain split.
 * It is deliberately hidden from new router prompts and validation.
 */
export const LEGACY_ADMIN_TOOLS = [
  ...Object.values(ADMIN_DOMAIN_TOOL_SETS).flat(),
  ...LEGACY_ADMIN_BILLING_TOOLS,
  ...LEGACY_ADMIN_OUTREACH_TOOLS,
];

/**
 * Tool set definitions
 */
export const TOOL_SETS: Record<string, ToolSet> = {
  knowledge: {
    name: "knowledge",
    description:
      "Search documentation, code repos, Slack history, curated resources, GitHub issues/PRs, and validate JSON against AdCP schemas for protocol questions, implementation help, roadmap/RFC lookups, and community discussions",
    tools: [
      "search_docs",
      "get_doc",
      "search_repos",
      "search_slack",
      "get_channel_activity",
      "search_resources",
      "get_recent_news",
      "fetch_url",
      "read_slack_file",
      // GitHub read tools — list/search issues, PRs, RFCs, epics.
      // NOTE: get_github_issue is intentionally NOT listed here — it lives in
      // ALWAYS_AVAILABLE_TOOLS and is reachable regardless of routing. Keeping
      // it here caused Sonnet to hallucinate that reading individual issues was
      // unavailable when `knowledge` wasn't selected. See #2998.
      "list_github_issues",
      // Schema validation tools
      "validate_json",
      "get_schema",
      "list_schemas",
      "compare_schema_versions",
    ],
  },

  member: {
    name: "member",
    // NOTE: propose_content, get_my_content, and set_outreach_preference are
    // intentionally NOT listed here — neither in the description nor the tools
    // array. They live in ALWAYS_AVAILABLE_TOOLS and are reachable in every
    // conversation. Duplicating them here caused Sonnet to hallucinate that
    // content submission/retrieval and outreach preferences were unavailable
    // when the router didn't pick `member`. See #2998.
    description:
      "Manage member profile, working groups, committees, and account settings. Includes listing working group documents, attaching assets to content, and updating the company logo or brand color.",
    tools: [
      "get_my_profile",
      "update_my_profile",
      "get_company_listing",
      "update_company_listing",
      "update_company_logo",
      "request_brand_domain_challenge",
      "verify_brand_domain_challenge",
      "list_working_groups",
      "get_working_group",
      "join_working_group",
      "request_working_group_invitation",
      "get_my_working_groups",
      "express_council_interest",
      "withdraw_council_interest",
      "get_my_council_interests",
      "list_perspectives",
      "create_working_group_post",
      "attach_content_asset",
      "bookmark_resource",
      "draft_social_posts",
      "list_committee_documents",
    ],
  },

  directory: {
    name: "directory",
    // NOTE: This tool set is a superset of DIRECTORY_TOOLS in directory-tools.ts.
    // Anonymous web/MCP users get only the DIRECTORY_TOOLS subset (read-only public lookups).
    // This set adds member-scoped tools (search_members, request_introduction) and brand tools.
    description:
      "The searchable partner/vendor directory — find partners, vendors, consultants, service providers, and member organizations. Also: request introductions, browse the member directory, research brands, look up brand assets, and find registry gaps",
    tools: [
      "search_members",
      "request_introduction",
      "get_my_search_analytics",
      "list_members",
      "get_member",
      "list_agents",
      "get_agent",
      "list_publishers",
      "lookup_domain",
      "research_brand",
      "resolve_brand",
      "save_brand",
      "list_brands",
      "list_missing_brands",
      "upload_brand_logo",
      "publish_brand_canonical_document",
      "add_to_brand_refs",
      "check_mutual_assertion",
      "notify_pending_verification",
    ],
  },

  agent_testing: {
    name: "agent_testing",
    description:
      'Publisher and agent setup, verification, and testing — validate adagents.json, check brand.json, verify publisher authorization, resolve properties, probe agent endpoints, run compliance tests, grade RFC 9421 request signing, and diagnose OAuth handshakes. Use for any "my agent can\'t see properties", "authorization not working", "is my signing setup correct?", "diagnose OAuth", or publisher setup questions.',
    tools: [
      "validate_adagents",
      "resolve_brand",
      "get_agent_status",
      "check_publisher_authorization",
      "test_adcp_agent",
      "evaluate_agent_quality",
      "grade_agent_signing",
      "diagnose_agent_auth",
      "compare_media_kit",
      "test_rfp_response",
      "test_io_execution",
      "validate_agent",
      "resolve_property",
      "save_property",
      "list_properties",
      "list_missing_properties",
      "check_property_list",
      "enhance_property",
      "resolve_catalog",
      "browse_catalog",
      "dispute_catalog_entry",
    ],
  },

  agent_conformance: {
    name: "agent_conformance",
    description:
      "Run AdCP compliance storyboards against the user's own dev/staging MCP server via Addie's Socket Mode channel — outbound WebSocket from the adopter to Addie, no public DNS or ngrok needed. Use when the user wants to test their own AdCP agent during development. Requires the user to be mapped to a WorkOS organization. Tools issue a session-bound token and then run a storyboard against the connected adopter agent.",
    tools: ["issue_conformance_token", "run_conformance_against_my_agent"],
  },

  adcp_operations: {
    name: "adcp_operations",
    description:
      "Execute AdCP protocol operations - discover documentation, execute tasks against agents, check agent capabilities. Covers media buy, creative, signals, governance, SI, and brand protocol.",
    tools: [
      // Meta-tools (replace 43 individual AdCP tools)
      "ask_about_adcp_task",
      "call_adcp_task",
      "get_adcp_capabilities",
      // Agent management (unchanged, from member-tools.ts)
      "save_agent",
      "list_saved_agents",
      "remove_saved_agent",
      "setup_test_agent",
    ],
  },

  sponsored_intelligence: {
    name: "sponsored_intelligence",
    description:
      "Discover and connect to member brand agents that support Sponsored Intelligence, check offer availability, and continue or end an active brand-agent conversation",
    tools: [
      "get_si_availability",
      "list_si_agents",
      "connect_to_si_agent",
      "send_to_si_agent",
      "end_si_session",
      "get_si_session_status",
    ],
  },

  content: {
    name: "content",
    // NOTE: GitHub issue filing lives in ALWAYS_AVAILABLE_TOOLS and is
    // intentionally NOT listed here — neither in the description nor the tools
    // array. Duplicating it caused Addie to hallucinate "I can't file GitHub
    // issues" when the router didn't pick `content`.
    //
    // NOTE: list_pending_content, approve_content, and reject_content are also
    // intentionally NOT listed here. They live in ALWAYS_AVAILABLE_TOOLS so
    // content review is reachable in every conversation. Keeping them here
    // (and saying "handle content approvals" in the description) caused Sonnet
    // to hallucinate that approval tools were unavailable when `content` wasn't
    // selected. See #2998.
    description:
      "Manage content workflows — propose news sources, add or update committee documents (admin actions)",
    tools: [
      "propose_news_source",
      "add_committee_document",
      "update_committee_document",
      "delete_committee_document",
    ],
  },

  member_billing: {
    name: "member_billing",
    description:
      "Handle the current member's own billing - find membership pricing, create a payment link, preview and confirm an invoice, or open the organization's billing portal",
    tools: [
      "find_membership_products",
      "create_payment_link",
      "send_invoice",
      "confirm_send_invoice",
      "get_billing_portal",
    ],
    requiresPrecision: true,
  },

  billing: {
    name: "billing",
    description:
      "Administer billing for other organizations - send payment requests, manage discounts and promotions, resend invoices, update billing identity, and inspect pending accounts",
    tools: [
      "send_payment_request",
      "grant_discount",
      "remove_discount",
      "list_discounts",
      "create_promotion_code",
      "resend_invoice",
      "update_billing_email",
      "preview_org_stripe_customer_update",
      "confirm_org_stripe_customer_update",
      "list_pending_invoices",
      "get_account",
    ],
    adminOnly: true,
    requiresPrecision: true,
  },

  events: {
    name: "events",
    description:
      "Browse upcoming events, check event registrations, get event details, see who is coming, and register interest in events — available to all members",
    tools: [
      "list_events",
      "get_event_details",
      "list_event_attendees",
      "register_event_interest",
    ],
  },

  meetings: {
    name: "meetings",
    description:
      "Schedule, list, update, and cancel meetings - add or remove attendees, RSVP, manage recurring series, handle calendar invites and Zoom links",
    tools: [
      "schedule_meeting",
      "list_upcoming_meetings",
      "get_my_meetings",
      "get_meeting_details",
      "rsvp_to_meeting",
      "cancel_meeting",
      "cancel_meeting_series",
      "update_meeting",
      "add_meeting_attendee",
      "update_topic_subscriptions",
      "manage_committee_topics",
    ],
  },

  committee_leadership: {
    name: "committee_leadership",
    description:
      "Manage committees you lead: co-leaders plus event management for working groups, councils, chapters, and industry gatherings",
    tools: [
      "add_committee_co_leader",
      "remove_committee_co_leader",
      "list_committee_co_leaders",
      "list_working_groups",
      "create_event",
      "update_event",
      "manage_event_registrations",
      "check_person_event_status",
      "invite_to_event",
    ],
  },

  admin_events: {
    name: "admin_events",
    description:
      "Administer events: create or update events, manage registrations, check a person's status, and send invitations (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_events],
    adminOnly: true,
  },

  admin_prospects: {
    name: "admin_prospects",
    description:
      "Manage the prospect pipeline: add, update, enrich, search, claim, triage, and suggest prospect organizations (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_prospects],
    adminOnly: true,
  },

  admin_feeds: {
    name: "admin_feeds",
    description:
      "Manage industry news feeds and media contacts, including review of proposed feeds (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_feeds],
    adminOnly: true,
  },

  admin_groups: {
    name: "admin_groups",
    description:
      "Manage chapters, gatherings, committees, working groups, leaders, memberships, and group names (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_groups],
    adminOnly: true,
  },

  admin_organizations: {
    name: "admin_organizations",
    description:
      "Manage member organizations, domains, roles, directory profiles, and duplicate organizations (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_organizations],
    adminOnly: true,
  },

  admin_workflows: {
    name: "admin_workflows",
    description:
      "Run internal analytics, flagged-conversation review, reminders, tasks, and conversation logging (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_workflows],
    adminOnly: true,
  },

  admin_brands: {
    name: "admin_brands",
    description:
      "Review brand and property registry gaps, logo submissions, community mirrors, and orphaned brand ownership (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_brands],
    adminOnly: true,
  },

  // Compatibility only: a plan already carrying the old `admin` set can
  // finish without losing tools, but new router prompts cannot select it.
  admin: {
    name: "admin",
    description: "Legacy monolithic admin compatibility surface",
    tools: [...LEGACY_ADMIN_TOOLS],
    adminOnly: true,
    routerVisible: false,
  },

  outreach: {
    name: "outreach",
    description:
      "SDR outreach operations — view outreach stats, check history, send outreach, look up people, manage action items (admin only)",
    tools: [
      "get_outreach_stats",
      "get_outreach_history",
      "send_outreach",
      "lookup_person",
      "get_action_items",
      "get_account",
      "create_contact",
    ],
    adminOnly: true,
  },

  collaboration: {
    name: "collaboration",
    description:
      "Send direct messages to other AgenticAdvertising.org members, forward conversation context, and collaborate across the community",
    tools: ["send_member_dm"],
  },

  certification: {
    name: "certification",
    description:
      "AdCP Academy — list tracks, teach modules, run exercises, placement assessment, and track learner progress",
    tools: [
      "list_certification_tracks",
      "get_certification_module",
      "start_certification_module",
      "complete_certification_module",
      "get_learner_progress",
      "test_out_modules",
      "start_certification_exam",
      "complete_certification_exam",
      "check_credentials",
      "checkpoint_teaching_progress",
      "get_build_phase_instructions",
      "save_learner_feedback",
      // Credential issuance can require the learner to supply a display name.
      // Keep the recovery pair on the same routed surface.
      "set_my_name",
      // Certification paywalls direct learners to the read-only product lookup.
      "find_membership_products",
      // AdCP tasks (route to training agent during certification via call_adcp_task)
      "call_adcp_task",
    ],
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
export function getToolsForSets(
  setNames: string[],
  isAAOAdmin: boolean = false,
  isPublicChannel: boolean = false,
): string[] {
  const alwaysAvailable = isPublicChannel
    ? ALWAYS_AVAILABLE_TOOLS.filter((t) => !ENROLLMENT_TOOLS.includes(t))
    : ALWAYS_AVAILABLE_TOOLS;
  const tools = new Set<string>(alwaysAvailable);

  if (isAAOAdmin) {
    for (const tool of ALWAYS_AVAILABLE_ADMIN_TOOLS) {
      tools.add(tool);
    }
  }

  for (const setName of setNames) {
    const toolSet = TOOL_SETS[setName];
    if (toolSet) {
      // Skip admin-only sets if user is not admin
      if (toolSet.adminOnly && !isAAOAdmin) {
        continue;
      }
      // Skip enrollment and financial actions in public channels.
      if (isPublicChannel && (setName === "member_billing" || setName === "billing")) {
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
export function getUnavailableSets(
  selectedSets: string[],
  isAAOAdmin: boolean = false,
): string[] {
  return Object.keys(TOOL_SETS).filter((setName) => {
    if (TOOL_SETS[setName].routerVisible === false) {
      return false;
    }
    // Don't mention admin set to non-admins
    if (TOOL_SETS[setName].adminOnly && !isAAOAdmin) {
      return false;
    }
    return !selectedSets.includes(setName);
  });
}

/**
 * Build a hint message about unavailable tool sets
 * This helps Sonnet know it can redirect the user if needed
 */
export function buildUnavailableSetsHint(
  selectedSets: string[],
  isAAOAdmin: boolean = false,
): string {
  const unavailable = getUnavailableSets(selectedSets, isAAOAdmin);

  if (unavailable.length === 0) {
    return "";
  }

  const hints = unavailable.map((setName) => {
    const set = TOOL_SETS[setName];
    return `- **${setName}**: ${set.description}`;
  });

  // Remind Claude which escape-hatch tools bypass set routing. Without this,
  // the model sometimes reads an unavailable-set description that overlaps
  // with an always-available capability (e.g., GitHub issue filing) and
  // hallucinates that the capability is off. Keep this list tight — only the
  // tools users explicitly ask for by name.
  //
  // NOTE: each key MUST exist in ALWAYS_AVAILABLE_TOOLS. A test enforces this
  // so a renamed/removed tool can't silently rot into a lying hint.
  const ALWAYS_AVAILABLE_BLURBS: Record<string, string> = {
    draft_github_issue:
      "filing bugs / feature requests as a pre-filled GitHub link",
    create_github_issue:
      "filing an issue directly under the member's GitHub account (if connected)",
    get_github_issue: "reading a GitHub issue or PR by number or URL",
    escalate_to_admin: "handing the thread to a human admin",
    get_escalation_status:
      "checking the status of an escalation the member filed",
    propose_content: "submitting a content draft for publication",
    get_my_content: "viewing the member's own submitted content and proposals",
    list_pending_content: "listing content items awaiting review",
    approve_content: "approving a pending content item (admin)",
    reject_content: "rejecting a pending content item (admin)",
    set_outreach_preference: "opting out of proactive outreach messages",
  };
  const alwaysAvailableReminder = Object.entries(ALWAYS_AVAILABLE_BLURBS)
    .filter(([tool]) => ALWAYS_AVAILABLE_TOOLS.includes(tool))
    .map(([tool, blurb]) => `${tool} — ${blurb}`);

  return `
## Capabilities Not Available in This Conversation

The following capabilities are not available right now. If the user asks for something in these areas, explain what you can't help with in plain, natural language and suggest an alternative (e.g., direct them to the right person, page, or channel). Do NOT use technical terms like "tool sets", "not loaded", or "tool categories" — describe capabilities naturally (e.g., "I don't have access to scheduling features right now" rather than "meeting tools aren't loaded").

${hints.join("\n")}

## Capabilities That ARE Always Available

These tools are callable in every conversation. If you're about to tell the user you can't do one of these, call it instead:
${alwaysAvailableReminder.map((l) => `- ${l}`).join("\n")}
`;
}

/**
 * Check if any selected sets require precision mode
 */
export function requiresPrecision(selectedSets: string[]): boolean {
  return selectedSets.some((setName) => {
    const set = TOOL_SETS[setName];
    return set?.requiresPrecision === true;
  });
}

/**
 * Get the set of valid tool set names for a given user context.
 * Used to filter LLM routing output against actual permitted sets.
 */
export function getValidToolSetNames(isAAOAdmin: boolean = false): Set<string> {
  return new Set(
    Object.entries(TOOL_SETS)
      .filter(([_, set]) => set.routerVisible !== false)
      .filter(([_, set]) => !set.adminOnly || isAAOAdmin)
      .map(([name]) => name),
  );
}

/**
 * Get tool set descriptions for the router prompt
 */
export function getToolSetDescriptionsForRouter(
  isAAOAdmin: boolean = false,
): string {
  return Object.entries(TOOL_SETS)
    .filter(([_, set]) => set.routerVisible !== false)
    .filter(([_, set]) => !set.adminOnly || isAAOAdmin)
    .map(([name, set]) => `- **${name}**: ${set.description}`)
    .join("\n");
}
