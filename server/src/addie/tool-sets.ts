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
 * Safe read-only domains used when intent routing cannot provide a narrower
 * selection. This preserves the documentation, community, and schema access
 * that the pre-split knowledge set provided without enabling GitHub mutation
 * workflows through the broader github set.
 */
export const SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS = [
  "knowledge",
  "community_research",
  "schema_reference",
] as const;

/**
 * Direct chat may combine a primary and a closely related follow-up domain,
 * but never receives an unbounded router-selected union.
 */
export const MAX_DIRECT_ROUTED_TOOL_SET_COUNT = 2;

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
  admin_group_structure: [
    "create_chapter",
    "list_chapters",
    "create_industry_gathering",
    "list_industry_gatherings",
    "rename_working_group",
  ],
  admin_group_leadership: [
    "list_working_groups",
    "get_working_group",
    "add_committee_leader",
    "remove_committee_leader",
    "list_committee_leaders",
  ],
  admin_group_membership: [
    "list_working_groups",
    "get_working_group",
    "add_working_group_member",
    "remove_working_group_member",
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

/** Bounded member account/profile surface for new router plans. */
export const MEMBER_PROFILE_TOOLS = [
  "get_my_profile",
  "update_my_profile",
  "get_company_listing",
  "update_company_listing",
  "update_company_logo",
  "request_brand_domain_challenge",
  "verify_brand_domain_challenge",
] as const;

/** Bounded group participation and community contribution surface. */
export const COMMUNITY_GROUP_TOOLS = [
  "list_working_groups",
  "get_working_group",
  "join_working_group",
  "request_working_group_invitation",
  "get_my_working_groups",
  "express_council_interest",
  "withdraw_council_interest",
  "get_my_council_interests",
  "create_working_group_post",
  "bookmark_resource",
  "list_committee_documents",
] as const;

/** Author-owned submission, document import, asset, and cover-image workflow. */
export const PUBLISHING_AUTHOR_TOOLS = [
  "propose_content",
  "get_my_content",
  "read_google_doc",
  "check_illustration_status",
  "generate_perspective_illustration",
  "attach_content_asset",
] as const;

/** Committee-lead and admin editorial review workflow. */
export const PUBLISHING_REVIEW_TOOLS = [
  "list_pending_content",
  "approve_content",
  "reject_content",
  "request_revisions",
] as const;

/** Published-content discovery and member social-promotion workflow. */
export const PUBLISHING_PROMOTION_TOOLS = [
  "list_perspectives",
  "draft_social_posts",
] as const;

/** Low-risk certification discovery, progress, and credential recovery. */
export const CERTIFICATION_OVERVIEW_TOOLS = [
  "list_certification_tracks",
  "get_certification_module",
  "get_learner_progress",
  "check_credentials",
  "set_my_name",
] as const;

/** Standard module teaching, checkpoint, build, and completion workflow. */
export const CERTIFICATION_LEARNING_TOOLS = [
  "start_certification_module",
  "complete_certification_module",
  "get_learner_progress",
  "checkpoint_teaching_progress",
  "get_build_phase_instructions",
  "save_learner_feedback",
  "set_my_name",
  "check_credentials",
  "find_membership_products",
  "call_adcp_task",
] as const;

/** Placement assessment and specialist capstone workflow. */
export const CERTIFICATION_ASSESSMENT_TOOLS = [
  "get_learner_progress",
  "test_out_modules",
  "start_certification_exam",
  "complete_certification_exam",
  "checkpoint_teaching_progress",
  "set_my_name",
  "check_credentials",
  "find_membership_products",
  "call_adcp_task",
] as const;

/** Calendar lookup, RSVP, and invitation attendance workflow. */
export const MEETING_ATTENDANCE_TOOLS = [
  "list_upcoming_meetings",
  "get_my_meetings",
  "get_meeting_details",
  "rsvp_to_meeting",
  "add_meeting_attendee",
] as const;

/** Create, change, or cancel one scheduled meeting. */
export const MEETING_SCHEDULING_TOOLS = [
  "schedule_meeting",
  "list_upcoming_meetings",
  "cancel_meeting",
  "update_meeting",
] as const;

/** Recurring-series lifecycle and working-group invitation-topic administration. */
export const MEETING_SERIES_TOPIC_TOOLS = [
  "list_upcoming_meetings",
  "cancel_meeting_series",
  "update_topic_subscriptions",
  "manage_committee_topics",
] as const;

/**
 * One long cross-workflow meeting request; preserves the exact legacy union.
 * Kept as a literal because this router-visible set is statically cataloged.
 */
export const MEETING_FULL_ADMINISTRATION_TOOLS = [
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
] as const;

/** Exact compatibility union for explicit callers carrying the pre-split route. */
export const MEETING_TOOLS = MEETING_FULL_ADMINISTRATION_TOOLS;

/** Publisher registry, configuration, authorization, and cached-status checks. */
export const AGENT_REGISTRY_TOOLS = [
  "validate_adagents",
  "resolve_brand",
  "get_agent_status",
  "check_publisher_authorization",
  "validate_agent",
] as const;

/** Live agent quality and buyer-behavior testing. */
export const AGENT_QUALITY_TOOLS = [
  "evaluate_agent_quality",
  "test_rfp_response",
  "test_io_execution",
] as const;

/** Public OAuth and RFC 9421 request-signing diagnosis. */
export const AGENT_AUTHENTICATION_TOOLS = [
  "grade_agent_signing",
  "diagnose_agent_auth",
] as const;

/**
 * One-turn end-to-end diagnostic for a request that explicitly spans agent
 * registration, public authentication, and live buyer behavior. Keeping this
 * composite at ten tools lets the direct router retain the two-domain cap.
 */
export const AGENT_END_TO_END_TOOLS = [
  ...AGENT_REGISTRY_TOOLS,
  ...AGENT_QUALITY_TOOLS,
  ...AGENT_AUTHENTICATION_TOOLS,
] as const;

/**
 * Exact compatibility union for explicit non-router callers that still carry
 * the pre-split name. Router plans reject this hidden deprecated alias.
 */
export const AGENT_VALIDATION_TOOLS = [
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
] as const;

/** Bounded property-registry audit, enrichment, and catalog surface. */
export const PROPERTY_CATALOG_TOOLS = [
  "resolve_property",
  "save_property",
  "list_properties",
  "list_missing_properties",
  "check_property_list",
  "enhance_property",
  "resolve_catalog",
  "browse_catalog",
  "dispute_catalog_entry",
] as const;

/**
 * Tool set definitions
 */
export const TOOL_SETS: Record<string, ToolSet> = {
  knowledge: {
    name: "knowledge",
    description:
      "Search AdCP documentation and indexed ad tech specifications for protocol questions and implementation help",
    tools: [
      "search_docs",
      "get_doc",
      "search_repos",
    ],
  },

  community_research: {
    name: "community_research",
    description:
      "When requested, search Slack history, channel activity, curated industry resources, recent news, supplied web pages, and files shared in Slack",
    tools: [
      "search_slack",
      "get_channel_activity",
      "search_resources",
      "get_recent_news",
      "fetch_url",
      "read_slack_file",
    ],
  },

  schema_reference: {
    name: "schema_reference",
    description:
      "Inspect, compare, and validate JSON against versioned AdCP schemas",
    tools: [
      "validate_json",
      "get_schema",
      "list_schemas",
      "compare_schema_versions",
    ],
  },

  member_profile: {
    name: "member_profile",
    description:
      "Manage the current member's personal profile, company directory listing, logo and brand color, account settings, and organization brand-domain claim",
    tools: [...MEMBER_PROFILE_TOOLS],
  },

  community_groups: {
    name: "community_groups",
    description:
      "Browse and join working groups, manage the current member's group and council participation, create group posts, save community resources, and list committee documents",
    tools: [...COMMUNITY_GROUP_TOOLS],
  },

  directory: {
    name: "directory",
    // NOTE: This tool set is a superset of DIRECTORY_TOOLS in directory-tools.ts.
    // Anonymous web/MCP users get only the DIRECTORY_TOOLS subset (read-only public lookups).
    // This set adds member-scoped search and introduction tools, but deliberately
    // excludes brand-registry mutations and canonical-document workflows.
    description:
      "Search the member, agent, and publisher directory for organizations, partners, vendors, consultants, service providers, and introductions",
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
    ],
  },

  brand_registry: {
    name: "brand_registry",
    description:
      "Research and manage brand-registry entries, logos, canonical brand documents, reciprocal brand.json assertions, and registry gaps",
    tools: [
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

  agent_registry: {
    name: "agent_registry",
    description:
      "Validate publisher and agent registry configuration, brand resolution, authorization, and cached agent status.",
    tools: [...AGENT_REGISTRY_TOOLS],
  },

  agent_quality: {
    name: "agent_quality",
    description:
      "Evaluate an agent's live quality and buyer behavior, including protocol quality, RFP responses, and IO execution.",
    tools: [...AGENT_QUALITY_TOOLS],
  },

  agent_authentication: {
    name: "agent_authentication",
    description:
      "Diagnose an agent's public OAuth setup or grade RFC 9421 request-signing behavior.",
    tools: [...AGENT_AUTHENTICATION_TOOLS],
  },

  // A deliberately bounded composite for one long diagnostic request. It is
  // not a replacement for the three narrow domains above.
  agent_end_to_end: {
    name: "agent_end_to_end",
    description:
      "Run an end-to-end agent diagnosis across registry configuration, public authentication, and live RFP or IO behavior.",
    tools: [...AGENT_END_TO_END_TOOLS],
  },

  // Compatibility only for explicit callers. New and stored router plans use
  // the narrow domains or the bounded end-to-end composite.
  agent_validation: {
    name: "agent_validation",
    description: "Legacy combined agent-validation compatibility surface",
    tools: [...AGENT_VALIDATION_TOOLS],
    routerVisible: false,
  },

  property_catalog: {
    name: "property_catalog",
    description:
      'Audit, resolve, enrich, and manage publisher property-registry and catalog entries, including missing domains and correction disputes. Use for property visibility, property-list, registry, or catalog questions.',
    tools: [...PROPERTY_CATALOG_TOOLS],
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
    description:
      "Manage content workflows — propose news sources, add or update committee documents (admin actions)",
    tools: [
      "propose_news_source",
      "add_committee_document",
      "update_committee_document",
      "delete_committee_document",
    ],
  },

  publishing_author: {
    name: "publishing_author",
    description:
      "Submit and manage the current member's articles or perspectives, import Google Docs for publication, attach assets, and generate or check published cover illustrations",
    tools: [...PUBLISHING_AUTHOR_TOOLS],
  },

  publishing_review: {
    name: "publishing_review",
    description:
      "Review pending member content and approve, reject, or request revisions when the current member leads that collection or is an admin",
    tools: [...PUBLISHING_REVIEW_TOOLS],
  },

  publishing_promotion: {
    name: "publishing_promotion",
    description:
      "Browse published community perspectives and draft social posts promoting published content",
    tools: [...PUBLISHING_PROMOTION_TOOLS],
  },

  github: {
    name: "github",
    description:
      "Read a specific GitHub issue or pull request, draft a bug report or feature request, and create a confirmed issue",
    tools: [
      "draft_github_issue",
      "create_github_issue",
      "get_github_issue",
      "list_github_issues",
    ],
  },

  illustrations: {
    name: "illustrations",
    description:
      "Search the approved illustration library when a user requests a diagram or a substantive explanation would materially benefit from a visual",
    tools: ["search_image_library"],
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

  meeting_attendance: {
    name: "meeting_attendance",
    description:
      "Check meeting agendas, RSVP, and manage attendance",
    tools: [...MEETING_ATTENDANCE_TOOLS],
  },

  meeting_scheduling: {
    name: "meeting_scheduling",
    description:
      "Schedule, update, or cancel one meeting",
    tools: [...MEETING_SCHEDULING_TOOLS],
  },

  meeting_series_topics: {
    name: "meeting_series_topics",
    description:
      "Manage recurring series and invitation topics",
    tools: [...MEETING_SERIES_TOPIC_TOOLS],
  },

  // An explicit parity exception for one long request that genuinely spans
  // scheduling, attendance, and recurring-series/topic administration.
  meeting_full_administration: {
    name: "meeting_full_administration",
    description:
      "Handle one long request across meeting scheduling, attendance, and series or topics",
    tools: [...MEETING_FULL_ADMINISTRATION_TOOLS],
  },

  // Compatibility only for explicit callers carrying the pre-split route.
  // New router plans use the narrow domains or the explicit full exception above.
  meetings: {
    name: "meetings",
    description: "Legacy combined meetings compatibility surface",
    tools: [...MEETING_TOOLS],
    routerVisible: false,
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
      "Admin mutation companion for the events set: create or update events, manage registrations, check a person's status, and send invitations; always select together with events (admin only)",
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

  admin_group_structure: {
    name: "admin_group_structure",
    description:
      "Create or list chapters and industry gatherings, and rename working groups (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_group_structure],
    adminOnly: true,
  },

  admin_group_leadership: {
    name: "admin_group_leadership",
    description:
      "List working groups and manage their committee leaders (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_group_leadership],
    adminOnly: true,
  },

  admin_group_membership: {
    name: "admin_group_membership",
    description:
      "List working groups and add or remove working-group members (admin only)",
    tools: [...ADMIN_DOMAIN_TOOL_SETS.admin_group_membership],
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

  certification_overview: {
    name: "certification_overview",
    description:
      "AdCP Academy catalog, module previews, learner progress, and earned credential checks",
    tools: [...CERTIFICATION_OVERVIEW_TOOLS],
  },

  certification_learning: {
    name: "certification_learning",
    description:
      "AdCP Academy standard modules — start or continue teaching, checkpoint progress, run build exercises, and complete modules",
    tools: [...CERTIFICATION_LEARNING_TOOLS],
  },

  certification_assessment: {
    name: "certification_assessment",
    description:
      "AdCP Academy placement assessments and specialist capstones — test out modules, run exams, checkpoint, and complete credentials",
    tools: [...CERTIFICATION_ASSESSMENT_TOOLS],
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
 * The explicit read-only surface available when a direct-chat router result
 * cannot be trusted. This deliberately excludes the normal "always" tools:
 * several of those write user preferences, create escalations, or resolve
 * admin work and are appropriate only after a valid route has been selected.
 */
export function getSafeReadOnlyFallbackTools(): string[] {
  return Array.from(new Set([
    ...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS.flatMap(getToolsInSet),
    'web_search',
  ]));
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

  // Public-channel replies must not expose escalation records: even an admin
  // can retrieve member identities and private request context from them.
  // Keep those tools to direct/private surfaces only.
  if (isAAOAdmin && !isPublicChannel) {
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
 * Reinforce the request boundary when routing omits capability sets. The
 * authoritative catalog already describes every callable tool, so enumerating
 * omitted sets here would invite the model to expose routing internals or make
 * false global-availability claims.
 */
export function buildUnavailableSetsHint(
  selectedSets: string[],
  isAAOAdmin: boolean = false,
): string {
  const unavailable = getUnavailableSets(selectedSets, isAAOAdmin);

  if (unavailable.length === 0) {
    return "";
  }

  return `
## Request-Scoped Tool Boundary

The authoritative custom-tool catalog is the complete callable surface for this request. Do not call names that are absent, enumerate omitted capability groups, expose routing internals, or infer that a request-scoped omission means Addie lacks the capability on every surface. Describe practical supported options using the catalog and verified documentation.
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
