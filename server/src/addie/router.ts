/**
 * Addie Router
 *
 * Fast routing layer that determines how to handle incoming messages.
 * Uses Claude Haiku for quick classification, generating an execution plan
 * that determines the response path.
 *
 * Execution plans:
 * - ignore: Do nothing (not relevant to Addie)
 * - react: Add an emoji reaction (greetings, welcomes)
 * - respond: Generate a full response with specific tools
 *
 * Routing rules are code-managed (not user-editable) because:
 * - Tool names must align with actual registered tools
 * - Conditional logic (e.g., "if admin") requires code
 * - Consistency between prod/dev environments
 */

import { createLogger } from "../logger.js";

const logger = createLogger("addie-router");
import { ModelConfig } from "../config/models.js";
import type { MemberContext } from "./member-context.js";
import type { AddieTool } from "./types.js";
import { KNOWLEDGE_TOOLS } from "./mcp/knowledge-search.js";
import { MEMBER_TOOLS } from "./mcp/member-tools.js";
import { trackApiCall, ApiPurpose } from "./services/api-tracker.js";
import {
  collectModelResponse,
  InvalidModelEventStreamError,
} from "./model-providers/events.js";
import type {
  ModelFinishReason,
  ModelMessageContent,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  PreparedModelInvocation,
} from "./model-providers/model-provider.js";
import {
  UnexpectedModelIdentityError,
  UnsupportedModelCapabilityError,
} from "./model-providers/model-provider.js";
import { AnthropicRouterProvider } from "./model-providers/anthropic-router-provider.js";
import {
  ProviderCircuitOpenError,
  ProviderHealthController,
} from "./model-providers/provider-health.js";
import {
  getToolSetDescriptionsForRouter,
  getValidToolSetNames,
  requiresPrecision as checkPrecision,
} from "./tool-sets.js";

/**
 * Execution plan types
 */
export type ExecutionPlanBase = {
  /** How the decision was made: 'quick_match' (pattern) or 'llm' (Claude Haiku) */
  decision_method: "quick_match" | "llm";
  /** Time spent making the routing decision (ms) */
  latency_ms?: number;
  /** Tokens used (only for LLM decisions) */
  tokens_input?: number;
  tokens_output?: number;
  /** Model used (only for LLM decisions) */
  model?: string;
  /** When true, use a more capable model (Opus) for this query - for billing, financial, or precision-critical tasks */
  requires_precision?: boolean;
  /** When true, use a more capable model (Opus) for depth - protocol design, schema architecture, technical discussions */
  requires_depth?: boolean;
};

/** Response confidence tier — how sure Addie is that she can add value */
export type ConfidenceTier = "high" | "suggest" | "low";

export type ExecutionPlan = ExecutionPlanBase &
  (
    | { action: "ignore"; reason: string }
    | { action: "react"; emoji: string; reason: string }
    | {
        action: "respond";
        tool_sets: string[];
        reason: string;
        confidence: ConfidenceTier;
      }
  );

/**
 * Context for routing decisions
 */
export interface RoutingContext {
  /** The message text to route */
  message: string;
  /** Source of the message */
  source: "dm" | "mention" | "channel";
  /** User's member context (if available) */
  memberContext?: MemberContext | null;
  /** Whether this is in a thread */
  isThread?: boolean;
  /** Channel name (if available) */
  channelName?: string;
  /** Whether the user is an AAO platform admin (checked via aao-admin working group) */
  isAAOAdmin?: boolean;
  /** Recent thread messages for context (compact "Speaker: text" lines) */
  threadMessages?: string[];
}

/**
 * Routing rules - code-managed, not user-editable
 *
 * These rules define when Addie should respond and what tools to use.
 * They're kept in code because tool names must match actual implementations
 * and some rules have conditional logic.
 */

/**
 * All available tools for routing context
 * Combines knowledge tools and member tools
 */
const ALL_TOOLS: AddieTool[] = [...KNOWLEDGE_TOOLS, ...MEMBER_TOOLS];

/**
 * Build tool descriptions for router from the tool definitions.
 * Uses usage_hints (for router) combined with description (for context).
 * This ensures tool descriptions are defined once with the tools themselves.
 */
function buildToolDescriptions(): Record<string, string> {
  const descriptions: Record<string, string> = {};

  for (const tool of ALL_TOOLS) {
    // Use usage_hints if available, otherwise fall back to first sentence of description
    if (tool.usage_hints) {
      descriptions[tool.name] = tool.usage_hints;
    } else {
      // Extract first sentence as fallback
      const firstSentence = tool.description.split(".")[0];
      descriptions[tool.name] = firstSentence;
    }
  }

  // Add web_search which is a built-in Claude tool not in our tool arrays
  descriptions["web_search"] =
    "search the web for external protocols (MCP, A2A), current events, things not in our docs";

  return descriptions;
}

/**
 * Tool descriptions for router context - built from tool definitions
 */
export const TOOL_DESCRIPTIONS = buildToolDescriptions();

export const ROUTING_RULES = {
  /**
   * Topics Addie can help with (and the tools to use).
   * Note: patterns are used for config version hashing and analytics,
   * not for direct routing. The LLM router uses tool set descriptions
   * from getToolSetDescriptionsForRouter() to make routing decisions.
   */
  expertise: {
    capabilities: {
      patterns: [
        "what can you do",
        "what can you help with",
        "how can you help me",
        "what do you do",
        "what are you capable of",
        "what are you",
        "what kinds of things",
        "your capabilities",
      ],
      tools: [], // No tools needed - respond from system prompt knowledge
      description:
        "Questions about what Addie can help with - respond with capability overview",
    },
    adcp_protocol: {
      patterns: [
        "adcp",
        "protocol",
        "schema",
        "specification",
        "signals",
        "media buy",
        "creative",
        "targeting",
        "brief",
        "sponsored intelligence",
        "si chat",
        "ai platform",
        "ai ad network",
        "ai assistant",
        "sponsored response",
        "ad network",
        "aggregator",
        "migration",
        "upgrade",
        "breaking change",
        "v2 to v3",
        "deprecated",
        "what changed",
        "reversed data flow",
        "catalog sync",
        "buy ads",
        "buying ads",
        "advertise on",
        "advertising on",
        "brand safety",
        "content standards",
        "product feed",
        "shopify",
        "agency buying",
        "agency integration",
        "brand identity",
      ],
      tools: ["search_docs"],
      description:
        "AdCP protocol questions - understanding how things work, migration, Sponsored Intelligence",
    },
    salesagent: {
      patterns: [
        "salesagent",
        "sales agent",
        "open source agent",
        "reference implementation",
      ],
      tools: ["search_repos", "search_docs"],
      description: "Salesagent setup and usage",
    },
    client_libraries: {
      patterns: [
        "client",
        "sdk",
        "npm",
        "pip",
        "javascript",
        "python",
        "typescript",
      ],
      tools: ["search_repos", "search_docs"],
      description: "Client library usage",
    },
    adagents_validation: {
      patterns: ["validate", "check my", "debug", "test my", "verify"],
      tools: [
        "validate_adagents",
        "get_agent_status",
        "check_publisher_authorization",
      ],
      description:
        "Validation and debugging requests - checking setups, testing configs",
    },
    adagents_json: {
      patterns: [
        "adagents.json",
        "agent manifest",
        "agent configuration",
        "well-known",
      ],
      tools: ["search_docs", "validate_adagents"],
      description: "Learning about adagents.json format and setup",
    },
    membership: {
      patterns: [
        "member",
        "join",
        "signup",
        "account",
        "profile",
        "working group",
        "api key",
        "api keys",
        "api token",
      ],
      tools: [
        "get_my_profile",
        "update_my_profile",
        "get_company_listing",
        "update_company_listing",
        "list_working_groups",
        "join_working_group",
      ],
      description: "AgenticAdvertising.org membership and API key management",
    },
    find_help: {
      patterns: [
        "find someone",
        "looking for",
        "who can help",
        "need help with",
        "vendor",
        "consultant",
        "partner",
        "service provider",
        "implementation",
        "managed service",
        "run a",
        "operate a",
        "introduce me",
        "connect me",
        "dsp",
        "ssp",
        "programmatic",
        "ctv",
        "measurement",
        "attribution",
        "creative optimization",
      ],
      tools: ["search_members", "request_introduction"],
      description:
        "Find member organizations who can help with specific needs - searching for vendors, partners, consultants",
    },
    sponsored_intelligence_agent: {
      patterns: [
        "si agent",
        "brand agent",
        "connect to a brand",
        "talk to a brand",
        "continue brand conversation",
      ],
      tools: [
        "get_si_availability",
        "list_si_agents",
        "connect_to_si_agent",
        "send_to_si_agent",
        "end_si_session",
        "get_si_session_status",
      ],
      description:
        "Discover, connect to, and converse with Sponsored Intelligence brand agents",
    },
    community_directory: {
      patterns: [
        "community directory",
        "community profile",
        "people directory",
        "community hub",
        "coffee chat",
        "connection request",
        "connect with",
      ],
      tools: ["get_my_profile", "update_my_profile"],
      description:
        "Community directory, personal profiles, connections, and coffee chats",
    },
    company_listing: {
      patterns: [
        "company listing",
        "company tagline",
        "company profile",
        "directory listing",
        "our tagline",
        "company description",
        "company offerings",
      ],
      tools: ["get_company_listing", "update_company_listing"],
      description:
        "Company directory listing — tagline, description, offerings, contact info",
    },
    community: {
      patterns: [
        "community",
        "discussion",
        "slack",
        "chat history",
        "what did",
        "who said",
      ],
      tools: ["search_slack"],
      description: "Community discussions",
    },
    ad_tech_protocols: {
      patterns: [
        "openrtb",
        "open rtb",
        "adcom",
        "vast",
        "opendirect",
        "prebid",
        "header bidding",
        "rtb",
        "real-time bidding",
        "iab",
        "tcf",
        "transparency consent",
        "gpp",
        "global privacy",
        "ccpa",
        "us privacy",
        "uid2",
        "unified id",
        "ads.cert",
        "adscert",
        "artf",
        "agentic rtb",
        "ucp",
        "user context protocol",
      ],
      tools: ["search_repos", "search_docs"],
      description:
        "IAB Tech Lab specs and ad tech protocols - we have these indexed!",
    },
    agent_protocols: {
      patterns: [
        "mcp",
        "model context protocol",
        "a2a",
        "agent to agent",
        "langgraph",
        "langchain",
      ],
      tools: ["search_repos"],
      description:
        "Agent protocols (MCP, A2A, LangGraph) - we have these indexed!",
    },
    industry_news: {
      patterns: ["news", "industry", "announcement", "latest", "trend"],
      tools: ["search_resources", "web_search"],
      description: "Industry news and trends",
    },
    certification: {
      patterns: [
        "certification",
        "certify",
        "certified",
        "certificate",
        "academy",
        "training",
        "course",
        "module",
        "lesson",
        "exam",
        "learn adcp",
        "get certified",
        "capstone",
        "badge",
        "assess my level",
        "placement test",
        "test out",
      ],
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
        "set_my_name",
        "find_membership_products",
      ],
      description:
        "AdCP Academy — learning modules, exercises, placement assessment, and exams",
    },
  },

  /**
   * Message types that get emoji reactions instead of responses
   */
  reactWith: {
    greeting: {
      patterns: [
        "hi",
        "hello",
        "hey",
        "good morning",
        "good afternoon",
        "howdy",
      ],
      emoji: "wave",
    },
    welcome: {
      patterns: [
        "welcome",
        "glad to have",
        "excited to join",
        "new here",
        "just joined",
      ],
      emoji: "tada",
    },
    thanks: {
      patterns: ["thanks", "thank you", "appreciate", "helpful"],
      emoji: "heart",
    },
  },

  /**
   * Messages to ignore
   */
  ignore: {
    patterns: [
      "ok",
      "okay",
      "k",
      "got it",
      "cool",
      "nice",
      "lol",
      "haha",
      "sounds good",
      "will do",
      "on it",
      "done",
      "working on it",
    ],
    reasons: [
      "simple acknowledgment",
      "casual conversation not needing response",
      "message directed at specific person",
      "sufficient responses already provided",
    ],
  },
} as const;

/**
 * Build the routing prompt based on context
 */
export function buildRoutingPrompt(ctx: RoutingContext): string {
  const isAAOAdmin = ctx.isAAOAdmin ?? false;
  const isMember = ctx.memberContext?.is_member ?? false;
  const isLinked = !!ctx.memberContext?.workos_user?.workos_user_id;

  // Build tool SET descriptions - router selects categories, not individual tools
  const toolSetsSection = getToolSetDescriptionsForRouter(isAAOAdmin);
  const validToolSetList = [...getValidToolSetNames(isAAOAdmin)].join(', ');

  // Build react patterns
  const reactList = Object.entries(ROUTING_RULES.reactWith)
    .map(([key, rule]) => `- ${key}: emoji=${rule.emoji}`)
    .join("\n");

  // Conditional rules based on user context
  let conditionalRules = "";
  if (!isLinked) {
    conditionalRules += `
The user has NOT linked their Slack account to AgenticAdvertising.org.
- If they ask about membership features, include the "member" tool set`;
  }
  if (isAAOAdmin) {
    conditionalRules += `
The user is an ADMIN.
- They have access to bounded admin domain sets for system operations
- Be more direct and technical in responses
- Select only the admin domains needed for this request. Do not add an admin domain merely because the user is an admin or the conversation is in an admin channel.`;
  } else {
    conditionalRules += `
The user is NOT an admin.
- The current member can handle membership pricing, payment links, invoice creation, and their organization's billing portal with "member_billing".
- Refunds, payment disputes, failed charges, and requests to act on another organization require human support → respond with [] (no routed tools) and use escalate_to_admin. Never route a non-admin to the admin-only "billing" set.`;
  }

  const channelLine = ctx.channelName ? `- Channel: #${ctx.channelName}` : "";
  // Community/social channels by name pattern (city chapters, general, introductions, etc.)
  const isCommunityChannel = ctx.channelName
    ? /\b(collective|general|introductions|announcements|random|social|london|nyc|sf|chicago|boston|austin|seattle|la)\b/i.test(
        ctx.channelName,
      )
    : false;
  const communityChannelGuidance = isCommunityChannel
    ? `\n## Channel Context\nThis message is in #${ctx.channelName}, a community social channel. Apply an even higher threshold — community introductions, event mentions, and social updates should be reacted to with an emoji.`
    : "";

  // Detect whether "addie" in the message is a direct address (talking TO Addie)
  // vs a third-person reference (talking ABOUT Addie, e.g. "addie could redirect").
  // Third-person patterns: "addie could redirect" but NOT "addie could you help"
  const mentionsAddie = /\baddie\b/i.test(ctx.message);
  const thirdPersonAddie =
    /\baddie\s+(could|would|should|is|was|will|can|has|does|might)\s+(?!you\b)/i.test(
      ctx.message,
    ) || /\b(let|have|make|get)\s+addie\b/i.test(ctx.message);
  const explicitlyNamedAddie = mentionsAddie && !thirdPersonAddie;
  const channelNameOverride =
    explicitlyNamedAddie && ctx.source === "channel"
      ? `\n## Direct Request\nThe user named "Addie" in their message. Treat this as a direct request — respond if you can help, regardless of channel policy.\n`
      : "";

  // Channel messages require a much higher bar for responding
  const channelResponseGuidance =
    ctx.source === "channel" && !explicitlyNamedAddie
      ? `
## Channel Response Policy
You are reading a message in a channel. Addie should NOT respond to most channel messages. Default to "ignore" or "react" unless ALL of these are true:
1. **High-confidence expertise**: Addie has a specific, authoritative answer (not a vague "here's what I found"). If the question is outside Addie's core expertise (AdCP protocol, membership, certification, member directory), ignore it.
2. **Explicitly requested OR uniquely positioned**: Someone asked Addie by name, OR no human is better positioned to answer (e.g., a protocol question only Addie's docs can answer). If a human in the channel likely knows the answer, let them answer.
3. **Actionable**: Addie can provide a concrete answer, take a specific action, or suggest a specific person/organization who can help. "I'm not sure but..." is not a valid response.

If Addie cannot meet these criteria but knows WHO might be able to help (a specific member, working group, or team), use "respond" with the directory or member tools to suggest a connection. Otherwise, ignore or react.

Examples of when to IGNORE:
- General questions to the channel ("does anyone know...") — let humans answer
- Scheduling/logistics ("can we move the meeting") — not Addie's domain
- Legal/compliance questions — Addie is not qualified
- Questions where a human expert is likely in the channel
- Conversational messages, opinions, debates`
      : "";

  return `You are Addie's router. Analyze this message and select the appropriate tool SETS.

## User Context
- Source: ${ctx.source}
${channelLine}
- Is member: ${isMember}
- Is admin: ${isAAOAdmin}
- In thread: ${ctx.isThread ?? false}
${conditionalRules}
${communityChannelGuidance}
${channelResponseGuidance}
${channelNameOverride}

## Available Tool Sets
Select which CATEGORIES of tools will be needed. Each set contains multiple related tools.
${toolSetsSection}

## Tool Set Selection Guidelines
${
  ctx.source === "channel" && !explicitlyNamedAddie
    ? 'These guidelines apply ONLY when you have already decided to "respond" (not for channel messages where the default is "ignore").\n'
    : ""
}IMPORTANT: Select tool SETS based on the user's INTENT:
- Questions about AdCP, protocols, implementation → ["knowledge"]
- Questions about member profile, working groups, account → ["member"]
- Looking for companies/vendors/service providers/implementation partners or managing brand-registry canonical documents → ["directory"]
- Testing/validating AdCP agent implementations or auditing publisher/property catalog setup → ["agent_testing"]
- Actually executing AdCP operations (media buys, creatives, signals) → ["adcp_operations"]
- Discovering, connecting to, or continuing a conversation with a Sponsored Intelligence brand agent → ["sponsored_intelligence"]
- Committee documents and news-source proposals → ["content"]
- Submitting or reviewing articles/perspectives, reading a Google Doc for publication, or managing a published cover illustration → ["publishing"]
- Reading a specific GitHub issue/PR, drafting a bug or feature request, or creating a confirmed issue → ["github"]
- Explicit diagram/image requests, or substantive explanations that materially benefit from a visual → ["illustrations"]
- Questions about working group documents, brand guidelines, uploaded files → ["knowledge", "member"]
- Membership pricing or the current member's own payment link, invoice creation, or billing portal → ["member_billing"]
${isAAOAdmin
    ? '- Admin billing for another organization, including payment requests, discounts, resending invoices, or Stripe customer relinks/customer ID updates → ["billing"]'
    : '- Refunds, disputes, failed charges, or billing actions for another organization → [] (use the always-available escalation tool)'}
- Upcoming events, event registrations, "am I registered", event details, register interest, who's coming/attending → ["events"]
- Scheduling meetings, calendar, covering topics, joining a call, meeting agendas → ["meetings"]
${isAAOAdmin ? `- Invite someone to an event, create/update events, manage registrations → ["events", "admin_events"]
- Prospect research, pipeline updates, claiming or triaging prospect domains → ["admin_prospects"]
- Industry feeds, feed proposals, or media contacts → ["admin_feeds"]
- Listing all members with payment/product/invoice status, organization domains, roles, profiles, or duplicate organizations → ["admin_organizations"]
- Task management, marking tasks done, checking tasks, reminders, logging conversations, flagged-conversation review, or community analytics → ["admin_workflows"]
- Escalations and pending requests → [] (list_escalations and resolve_escalation are always available to admins)` : ''}
- Managing co-leaders for your own committee (non-admin) → ["committee_leadership"]
${isAAOAdmin ? `- Adding/removing committee or working group leaders, managing group memberships, chapters, or gatherings (admin action) → ["admin_groups"]
- Brand-logo review, registry gaps, community mirrors, ownership transfers, or orphaned brands → ["admin_brands"]
- Outreach history, sending outreach, person lookup, contacts, or action items → ["outreach"]
- Community-wide engagement ranking, most engaged members overall, top contributors, who to invite to events, lifecycle stage analytics → ["admin_workflows"]` : ''}
- Multiple intents? Include multiple sets: ["knowledge", "agent_testing"]
- General questions needing no tools → []

**directory note**: The directory lists MEMBER ORGANIZATIONS (companies), not individual people. If a user asks for "a contact in [role/department]" without specifying what service or capability they need, route to "respond" with ["directory"] — the handler can ask follow-up questions with full context.

## Messages to React To (emoji only, standalone channel messages)
Use these for short social messages with some context. Exact bare acknowledgments
such as "thanks" remain in the ignore category below.
${reactList}

## Messages to Ignore
- Simple acknowledgments: ok, got it, cool, thanks, etc.
- Casual conversation unrelated to AdCP or AgenticAdvertising.org
- Messages clearly directed at specific people (e.g., start with "<@USERID> ..." in Slack format)
- Off-topic discussions
- Community introductions, announcements, or social updates where the author is NOT asking a question and NOT requesting help from Addie — even if the topic relates to AdCP or events. Examples: "Hi everyone, I'm James from X, looking forward to the event", "We hosted an AdCP meetup last week", "Will register for the summit". React to these with an emoji instead.
- Open questions to the channel ("does anyone know...", "has anyone tried...", "thoughts on...") — these are addressed to humans, not Addie
- Opinion polls or community discussion prompts ("what do you all think about...", "what does everyone think about...") — even when the topic involves ad tech standards, IAB guidelines, or industry news. Exception: if the question is specifically about an AdCP protocol detail or schema that only Addie's docs can answer, apply the Channel Response Policy criteria above instead
- Questions outside Addie's core expertise (legal, HR, scheduling, general business) — even if tangentially related to ad tech
- Questions where a knowledgeable human in the workspace is likely better positioned to answer

${
  ctx.threadMessages && ctx.threadMessages.length > 0
    ? `## Thread Context
Recent messages in this thread (oldest first):
${ctx.threadMessages.join("\n")}

`
    : ""
}## Message
"${ctx.message}"

## Instructions
Respond with a JSON object for the execution plan. Choose ONE action:
${
  ctx.source === "channel" && !explicitlyNamedAddie
    ? `
**CRITICAL — CHANNEL SOURCE**: This message was posted in a channel, NOT sent to Addie directly. You MUST default to "ignore" unless the question is squarely within Addie's unique expertise (AdCP protocol details, membership tools, certification). Most channel messages should be "ignore" — let humans talk to each other. Meeting scheduling, logistics, legal questions, general industry discussion (including opinions about IAB or other standards, "what do you all think about X" — except when X is a specific AdCP protocol or schema question only Addie can answer), and anything humans can answer themselves must be "ignore". When in doubt, ignore.`
    : ""
}

1. {"action": "ignore", "reason": "brief reason"}
   - For messages that don't need Addie's response${
     ctx.source === "channel" && !explicitlyNamedAddie
       ? " — THIS IS THE DEFAULT FOR CHANNEL MESSAGES"
       : ""
   }

2. {"action": "react", "emoji": "emoji_name", "reason": "brief reason"}
   - For greetings, welcomes, thanks (use emoji name like "wave", "tada", "heart")

3. {"action": "respond", "tool_sets": ["set1", "set2"], "confidence": "high", "requires_depth": false, "reason": "brief reason"}
   - When you can help - select the tool SET(S) that will be needed
   - Valid sets: ${validToolSetList}
   - Empty array [] means respond without tools (general knowledge)
   - **confidence** (required): How sure you are that Addie's tools will return a DEFINITIVE answer:
     - "high": Addie's docs/tools contain the answer. Schema questions, documented protocol flows, membership actions, directory lookups — things where the answer EXISTS in our systems.
     - "suggest": The topic relates to AdCP but the answer is NOT definitively in Addie's docs — it's an open question, evolving standard, policy/governance decision, commercial/business terms not yet codified, or something a specific person/working group is better positioned to answer. Addie can point to the right people or group. Examples: "who pays the signal provider?", "does an AI impression count?", "what's the governance model?"
     - "low": Adjacent to Addie's domain but she has no verified answer and no specific person to point to.
   - Set "requires_depth": true when the discussion involves protocol design, schema architecture, technical implementation details, standards discussion, or multi-stakeholder governance decisions. NOT for simple lookup questions or basic "what is X" questions.

Respond with ONLY the JSON object, no other text.`;
}

/**
 * Build the provider-neutral request used by the production router.
 * Prompt-parity evaluations use this exact request contract as well.
 */
export function buildRouterModelRequest(
  ctx: RoutingContext,
  model = ModelConfig.fast,
  reasoning?: ModelRequest['reasoning'],
): ModelRequest {
  return {
    model,
    system: [],
    messages: [{
      role: "user",
      content: [{ type: "text", text: buildRoutingPrompt(ctx) }],
    }],
    tools: [],
    maxOutputTokens: 300,
    ...(reasoning && { reasoning }),
  };
}

function deepFreezeRouterValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeRouterValue(child);
  return Object.freeze(value);
}

/** Preserve the router's historical rule: only the first response block counts. */
export function extractRouterResponseText(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  const first = content[0];
  return first?.type === "text" && typeof first.text === "string"
    ? first.text
    : "";
}

function classifyRouterError(error: unknown):
  | "invalid_json"
  | "schema_invalid"
  | "refusal"
  | "truncated"
  | "incomplete"
  | "unexpected_model_identity"
  | "invalid_provider_event_stream"
  | "unsupported_provider_capability"
  | "provider_error" {
  if (error instanceof RouterPlanParseError) return error.category;
  if (error instanceof RouterTerminalResponseError) return error.category;
  if (error instanceof UnexpectedModelIdentityError) {
    return "unexpected_model_identity";
  }
  if (error instanceof InvalidModelEventStreamError) {
    return "invalid_provider_event_stream";
  }
  if (error instanceof UnsupportedModelCapabilityError) {
    return "unsupported_provider_capability";
  }
  return "provider_error";
}

class RouterTerminalResponseError extends Error {
  constructor(readonly category: 'refusal' | 'truncated' | 'incomplete') {
    super(`Router response was not terminal: ${category}`);
    this.name = 'RouterTerminalResponseError';
  }
}

/**
 * Partial execution plan without metadata (used during parsing)
 */
type ParsedPlan =
  | { action: "ignore"; reason: string }
  | { action: "react"; emoji: string; reason: string }
  | {
      action: "respond";
      tool_sets: string[];
      reason: string;
      requires_depth?: boolean;
      confidence: ConfidenceTier;
    };

export type RouterAction = "ignore" | "react" | "respond";

/** A router plan accepted without production's compatibility fallbacks. */
export interface StrictRouterPlan {
  action: RouterAction;
  reason: string;
  emoji?: string;
  tool_sets?: string[];
  confidence?: ConfidenceTier;
  requires_depth?: boolean;
}

export class RouterPlanParseError extends Error {
  constructor(
    readonly category: "invalid_json" | "schema_invalid",
    message: string,
    readonly unauthorizedToolSetAttempt = false,
    readonly invalidToolSetAttempt = false,
  ) {
    super(message);
    this.name = "RouterPlanParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict parser shared by offline evaluations and production shadow evidence.
 * It never substitutes a fallback plan for malformed or unauthorized output.
 */
export function parseStrictRouterPlan(
  response: string,
  isAdmin: boolean,
): StrictRouterPlan {
  let parsed: unknown;
  try {
    let jsonText = response.trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    }
    parsed = JSON.parse(jsonText);
  } catch {
    throw new RouterPlanParseError("invalid_json", "Router response is not JSON");
  }

  if (
    !isRecord(parsed)
    || typeof parsed.action !== "string"
    || typeof parsed.reason !== "string"
    || !parsed.reason.trim()
  ) {
    throw new RouterPlanParseError("schema_invalid", "Router response has invalid base fields");
  }

  const keys = Object.keys(parsed).sort();
  const fullShape = keys.join(",") === "action,confidence,emoji,reason,requires_depth,tool_sets";
  if (parsed.action === "ignore") {
    if (
      keys.join(",") !== "action,reason"
      && !(
        fullShape
        && parsed.emoji === null
        && Array.isArray(parsed.tool_sets)
        && parsed.tool_sets.length === 0
        && parsed.confidence === null
        && parsed.requires_depth === null
      )
    ) {
      throw new RouterPlanParseError("schema_invalid", "Ignore response has invalid fields");
    }
    return { action: "ignore", reason: parsed.reason };
  }

  if (parsed.action === "react") {
    const sparse = keys.join(",") === "action,emoji,reason";
    const full = fullShape
      && Array.isArray(parsed.tool_sets)
      && parsed.tool_sets.length === 0
      && parsed.confidence === null
      && parsed.requires_depth === null;
    if ((!sparse && !full) || typeof parsed.emoji !== "string" || !parsed.emoji.trim()) {
      throw new RouterPlanParseError("schema_invalid", "React response is invalid");
    }
    return { action: "react", emoji: parsed.emoji, reason: parsed.reason };
  }

  if (parsed.action !== "respond") {
    throw new RouterPlanParseError("schema_invalid", "Unknown router action");
  }
  const sparseRespond = keys.join(",")
    === "action,confidence,reason,requires_depth,tool_sets";
  if (!sparseRespond && !(fullShape && parsed.emoji === null)) {
    throw new RouterPlanParseError("schema_invalid", "Respond response has invalid fields");
  }
  if (
    !Array.isArray(parsed.tool_sets)
    || parsed.tool_sets.some((tool) => typeof tool !== "string")
    || new Set(parsed.tool_sets).size !== parsed.tool_sets.length
    || !["high", "suggest", "low"].includes(String(parsed.confidence))
    || typeof parsed.requires_depth !== "boolean"
  ) {
    throw new RouterPlanParseError("schema_invalid", "Respond response is invalid");
  }

  const allowed = getValidToolSetNames(isAdmin);
  if (parsed.tool_sets.some((tool) => !allowed.has(tool))) {
    const allKnown = getValidToolSetNames(true);
    const invalidToolSetAttempt = parsed.tool_sets.some((tool) => !allKnown.has(tool));
    const unauthorizedToolSetAttempt = !isAdmin
      && parsed.tool_sets.some((tool) => allKnown.has(tool) && !allowed.has(tool));
    throw new RouterPlanParseError(
      "schema_invalid",
      "Respond response requests an unauthorized or unknown tool set",
      unauthorizedToolSetAttempt,
      invalidToolSetAttempt,
    );
  }

  return {
    action: "respond",
    tool_sets: parsed.tool_sets as string[],
    confidence: parsed.confidence as ConfidenceTier,
    requires_depth: parsed.requires_depth,
    reason: parsed.reason,
  };
}

/**
 * Parse the router response into a partial ExecutionPlan
 */
export function parseRouterResponse(response: string): ParsedPlan {
  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
    }

    const parsed = JSON.parse(jsonStr);

    // Validate and normalize the response
    if (parsed.action === "ignore") {
      return {
        action: "ignore",
        reason: parsed.reason || "No reason provided",
      };
    }
    if (parsed.action === "react") {
      return {
        action: "react",
        emoji: parsed.emoji || "wave",
        reason: parsed.reason || "Greeting or acknowledgment",
      };
    }
    if (parsed.action === "clarify") {
      // Clarify is no longer a router action — route to the main handler
      // which can ask for clarification with full context and tools
      return {
        action: "respond",
        tool_sets: ["knowledge"],
        confidence: "suggest" as ConfidenceTier,
        reason: parsed.reason || "Needs clarification",
      };
    }
    if (parsed.action === "respond") {
      // Accept tool set names as-is
      const toolSets = Array.isArray(parsed.tool_sets) ? parsed.tool_sets : [];
      const confidence: ConfidenceTier =
        parsed.confidence === "suggest" || parsed.confidence === "low"
          ? parsed.confidence
          : "high"; // default to high for backward compatibility
      return {
        action: "respond",
        tool_sets: toolSets,
        reason: parsed.reason || "Can help with this topic",
        confidence,
        ...(parsed.requires_depth && { requires_depth: true }),
      };
    }

    // Default to ignore if unknown action
    logger.warn("Router: Unknown action, defaulting to ignore");
    return { action: "ignore", reason: "Unknown action type" };
  } catch {
    logger.warn(
      { responseBytes: Buffer.byteLength(response, "utf8") },
      "Router: Failed to parse response, using knowledge fallback",
    );
    // On parse error, default to respond with knowledge tools (safe fallback)
    return {
      action: "respond",
      tool_sets: ["knowledge"],
      confidence: "high",
      reason: "Parse error - defaulting to knowledge tools",
    };
  }
}

function strictPlanToParsedPlan(plan: StrictRouterPlan): ParsedPlan {
  if (plan.action === 'ignore') return { action: 'ignore', reason: plan.reason };
  if (plan.action === 'react') {
    if (!plan.emoji) throw new RouterPlanParseError('schema_invalid', 'React response has no emoji');
    return { action: 'react', emoji: plan.emoji, reason: plan.reason };
  }
  if (!plan.tool_sets || !plan.confidence || typeof plan.requires_depth !== 'boolean') {
    throw new RouterPlanParseError('schema_invalid', 'Respond response is incomplete');
  }
  return {
    action: 'respond',
    tool_sets: plan.tool_sets,
    confidence: plan.confidence,
    requires_depth: plan.requires_depth,
    reason: plan.reason,
  };
}

export interface RouterModelObservation {
  canonicalRequest: ModelRequest;
  primaryInvocation: PreparedModelInvocation | null;
  isAdmin: boolean;
  productionPlan: ExecutionPlan;
  rawResponseText: string | null;
  responseContent: ReadonlyArray<ModelMessageContent>;
  finishReason: ModelFinishReason | null;
  primaryErrorCategory: ReturnType<typeof classifyRouterError> | null;
  requestedProvider: ModelProvider["id"];
  requestedModel: string;
  returnedProvider: ModelProvider["id"] | null;
  returnedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  latencyMs: number;
}

export interface RouterRouteOptions {
  /**
   * Detached, best-effort observation of a completed primary model route.
   * It cannot change or delay the production decision.
   */
  observer?: (observation: RouterModelObservation) => void | Promise<void>;
  /** Used by a higher-level canary boundary so it can invoke the fallback provider. */
  failureMode?: 'safe_fallback' | 'throw';
  /** Cancels the provider request without changing the default fallback behavior. */
  signal?: AbortSignal;
}

export interface AddieRouterProviderOptions {
  model?: string;
  reasoning?: ModelRequest['reasoning'];
  /** Reject malformed, incomplete, or unauthorized plans instead of normalizing them. */
  strictOutput?: boolean;
}

function queueRouterObserver(
  observer: RouterRouteOptions["observer"],
  observation: RouterModelObservation,
): void {
  if (!observer) return;
  setImmediate(() => {
    try {
      void Promise.resolve(observer(observation)).catch(() => {
        logger.warn("Router: detached observer failed");
      });
    } catch {
      logger.warn("Router: detached observer failed");
    }
  });
}

/**
 * Addie Router class
 *
 * Uses Claude Haiku for fast routing decisions
 */
export class AddieRouter {
  private readonly provider: ModelProvider;
  private readonly providerHealth: ProviderHealthController;
  private readonly model: string;
  private readonly reasoning?: ModelRequest['reasoning'];
  private readonly strictOutput: boolean;

  constructor(
    apiKey: string,
    provider?: ModelProvider,
    providerHealth: ProviderHealthController = new ProviderHealthController(),
    options: AddieRouterProviderOptions = {},
  ) {
    this.provider = provider ?? new AnthropicRouterProvider(apiKey, {
      maxRetries: 2,
    });
    this.providerHealth = providerHealth;
    this.model = options.model ?? ModelConfig.fast;
    this.reasoning = options.reasoning;
    this.strictOutput = options.strictOutput ?? false;
  }

  /**
   * Route a message and return an execution plan
   *
   * @param ctx - Routing context with message and metadata
   * @returns Execution plan determining how to handle the message
   */
  async route(
    ctx: RoutingContext,
    options: RouterRouteOptions = {},
  ): Promise<ExecutionPlan> {
    const startTime = Date.now();
    const canonicalRequest = deepFreezeRouterValue(
      buildRouterModelRequest(ctx, this.model, this.reasoning),
    );
    let primaryInvocation: PreparedModelInvocation | null = null;
    let primaryResponse: ModelResponse | null = null;
    let rawResponseText: string | null = null;

    try {
      const availability = this.providerHealth.acquire(this.provider.id, 'router');
      if (!availability.allowed) throw new ProviderCircuitOpenError(availability);
      const response = await collectModelResponse(
        this.provider.respond(canonicalRequest, {
          // This callback is deliberately assignment-only. Shadow evidence can
          // never throw before or otherwise interfere with Haiku dispatch.
          beforeDispatch: (prepared) => {
            primaryInvocation = prepared;
          },
          signal: options.signal,
        }),
        this.provider.id,
      );
      primaryResponse = response;
      const text = extractRouterResponseText(response.content);
      rawResponseText = text;

      if (this.strictOutput && response.finishReason !== 'stop') {
        throw new RouterTerminalResponseError(
          response.finishReason === 'length'
            ? 'truncated'
            : response.finishReason === 'refusal'
              ? 'refusal'
              : 'incomplete',
        );
      }

      const parsedPlan = this.strictOutput
        ? strictPlanToParsedPlan(parseStrictRouterPlan(text, ctx.isAAOAdmin ?? false))
        : parseRouterResponse(text);
      this.providerHealth.recordSuccess(this.provider.id, 'router');
      const latencyMs = Date.now() - startTime;

      // Filter tool sets to only valid/permitted sets for this user
      if (parsedPlan.action === "respond") {
        const validSets = getValidToolSetNames(ctx.isAAOAdmin ?? false);
        const filtered = parsedPlan.tool_sets.filter((s) => validSets.has(s));
        if (filtered.length !== parsedPlan.tool_sets.length) {
          logger.warn(
            {
              requestedCount: parsedPlan.tool_sets.length,
              allowed: filtered,
              strippedCount: parsedPlan.tool_sets.length - filtered.length,
            },
            "Router: stripped invalid tool sets from LLM response",
          );
        }
        parsedPlan.tool_sets = filtered;
      }

      // Check if any selected tool sets require precision mode (billing, financial)
      let requiresPrecisionMode = false;
      let requiresDepthMode = false;
      if (parsedPlan.action === "respond") {
        requiresPrecisionMode = checkPrecision(parsedPlan.tool_sets);
        requiresDepthMode = !!parsedPlan.requires_depth;
      }

      const plan: ExecutionPlan = {
        ...parsedPlan,
        decision_method: "llm",
        latency_ms: latencyMs,
        tokens_input: response.usage.inputTokens,
        tokens_output: response.usage.outputTokens,
        model: this.model,
        requires_precision: requiresPrecisionMode,
        requires_depth: requiresDepthMode,
      };

      logger.debug(
        {
          source: ctx.source,
          action: plan.action,
          toolSets:
            parsedPlan.action === "respond" ? parsedPlan.tool_sets : undefined,
          confidence:
            parsedPlan.action === "respond" ? parsedPlan.confidence : undefined,
          durationMs: latencyMs,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          requiresPrecision: requiresPrecisionMode,
          requiresDepth: requiresDepthMode,
        },
        "Router: Execution plan generated",
      );

      // Track for performance metrics (fire-and-forget, errors handled internally)
      void trackApiCall({
        model: this.model,
        purpose: ApiPurpose.ROUTER,
        tokens_input: response.usage.inputTokens,
        tokens_output: response.usage.outputTokens,
        latency_ms: latencyMs,
      });

      queueRouterObserver(options.observer, {
        canonicalRequest,
        primaryInvocation,
        isAdmin: ctx.isAAOAdmin ?? false,
        productionPlan: plan,
        rawResponseText: text,
        responseContent: response.content,
        finishReason: response.finishReason,
        primaryErrorCategory: null,
        requestedProvider: this.provider.id,
        requestedModel: this.model,
        returnedProvider: response.provider,
        returnedModel: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens ?? null,
        cacheWriteTokens: response.usage.cacheWriteTokens ?? null,
        latencyMs,
      });

      return plan;
    } catch (error) {
      if (!(error instanceof ProviderCircuitOpenError)) {
        this.providerHealth.recordFailure(this.provider.id, 'router', error);
      }
      const category = classifyRouterError(error);
      logger.error(
        { category },
        "Router: Failed to generate execution plan",
      );
      // On error, default to respond with knowledge tools (safe fallback - don't miss important messages)
      const fallbackPlan: ExecutionPlan = {
        action: "respond",
        tool_sets: ["knowledge"],
        confidence: "high",
        reason: "Router error - defaulting to knowledge tools",
        decision_method: "llm",
        latency_ms: Date.now() - startTime,
      };
      queueRouterObserver(options.observer, {
        canonicalRequest,
        primaryInvocation,
        isAdmin: ctx.isAAOAdmin ?? false,
        productionPlan: fallbackPlan,
        rawResponseText,
        responseContent: primaryResponse?.content ?? [],
        finishReason: primaryResponse?.finishReason ?? null,
        primaryErrorCategory: category,
        requestedProvider: this.provider.id,
        requestedModel: this.model,
        returnedProvider: primaryResponse?.provider ?? null,
        returnedModel: primaryResponse?.model ?? null,
        inputTokens: primaryResponse?.usage.inputTokens ?? null,
        outputTokens: primaryResponse?.usage.outputTokens ?? null,
        cacheReadTokens: primaryResponse?.usage.cacheReadTokens ?? null,
        cacheWriteTokens: primaryResponse?.usage.cacheWriteTokens ?? null,
        latencyMs: Date.now() - startTime,
      });
      if (options.failureMode === 'throw') throw error;
      return fallbackPlan;
    }
  }

  /**
   * Quick check for obvious patterns (before hitting the LLM)
   *
   * This is an optimization - catches simple cases without an API call.
   * Returns null if no quick match, meaning the full router should run.
   */
  quickMatch(ctx: RoutingContext): ExecutionPlan | null {
    const startTime = Date.now();
    // Normalize smart quotes (Slack converts ' to \u2018/\u2019 and " to \u201C/\u201D)
    const text = ctx.message
      .toLowerCase()
      .trim()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"');

    // In threads, brief messages ("yes", "done", "ok") are responses to
    // something Addie said — let the LLM router see them with thread context.
    // Only auto-ignore in standalone (non-thread) messages.
    const isInThread = ctx.isThread === true;
    if (!isInThread) {
      for (const pattern of ROUTING_RULES.ignore.patterns) {
        if (text === pattern || text === pattern + ".") {
          return {
            action: "ignore",
            reason: "Simple acknowledgment",
            decision_method: "quick_match",
            latency_ms: Date.now() - startTime,
          };
        }
      }
    }

    // Event attendee queries - "who's coming to X", "attendee list for X"
    const eventAttendeePattern =
      /who(?:'s|\s+is)\s+(coming\s+to|going\s+to\s+(?:the|cannes|ces|dmexco)|registered\s+for|attending|signed\s+up\s+for)|attendee\s+list|guest\s+list|who\s+will\s+be\s+(?:at\s+the|there\s+(?:at|for)|coming\s+to)/i;
    if (eventAttendeePattern.test(text)) {
      return {
        action: "respond",
        tool_sets: ["events"],
        confidence: "high",
        reason: "Event attendee query",
        decision_method: "quick_match",
        latency_ms: Date.now() - startTime,
      };
    }

    // Admin engagement/analytics queries - route to admin tools
    if (ctx.isAAOAdmin) {
      const adminOutreachPattern = /outreach\s+stats|action\s+items/i;
      if (adminOutreachPattern.test(text)) {
        return {
          action: "respond",
          tool_sets: ["outreach"],
          confidence: "high",
          reason: "Admin outreach query",
          decision_method: "quick_match",
          latency_ms: Date.now() - startTime,
        };
      }

      const adminAnalyticsPattern =
        /engagement\s+(score|users|members|ranking|top|analytics|stats)|most\s+engaged|top\s+contributors|lifecycle\s+stage|who\s+to\s+invite|engagement\s+analytics/i;
      if (adminAnalyticsPattern.test(text)) {
        return {
          action: "respond",
          tool_sets: ["admin_workflows"],
          confidence: "high",
          reason: "Admin engagement/analytics query",
          decision_method: "quick_match",
          latency_ms: Date.now() - startTime,
        };
      }

      // Admin task management - "my tasks", "what's on my plate", "that X task is done", "mark X complete"
      const adminTaskPattern =
        /\bmy\s+tasks\b|what'?s\s+on\s+my\s+plate|(?:that|this)\s+(?:\S+\s+){0,3}(?:task|reminder|follow.?up)\s+(?:is\s+)?done\b|mark\s+\S.{0,40}?(?:complete|done)|(?:complete|done\s+with)\s+(?:the\s+)?(?:task|reminder)|set\s+(?:a\s+)?reminder/i;
      if (adminTaskPattern.test(text)) {
        return {
          action: "respond",
          tool_sets: ["admin_workflows"],
          confidence: "high",
          reason: "Admin task management",
          decision_method: "quick_match",
          latency_ms: Date.now() - startTime,
        };
      }

      // Admin outreach logging - "I emailed X", "spoke with X", "had a call with X", etc.
      const outreachLogPattern =
        /\b(?:emailed|contacted|called|dm[\u2018\u2019']?d|dmed|messaged)\s+\w|(?:spoke|talked|caught\s+up|met)\s+with\s+\w|had\s+(?:a\s+)?(?:call|meeting|conversation|chat)\s+with\s+\w|(?:reached\s+out|followed\s+up)\s+(?:with|to)\s+\w/i;
      if (outreachLogPattern.test(text)) {
        return {
          action: "respond",
          tool_sets: ["admin_workflows"],
          confidence: "high",
          reason: "Admin outreach logging",
          decision_method: "quick_match",
          latency_ms: Date.now() - startTime,
        };
      }
    }

    // Check for greeting/thanks patterns to react (standalone channel messages only —
    // in DMs these should fall through to the LLM for a real response)
    const isStandaloneChannelMessage = ctx.source === "channel" && !isInThread;
    if (isStandaloneChannelMessage) {
      for (const [key, rule] of Object.entries(ROUTING_RULES.reactWith)) {
        for (const pattern of rule.patterns) {
          if (text.length < 20 && text.includes(pattern.toLowerCase())) {
            return {
              action: "react",
              emoji: rule.emoji,
              reason: `Matched ${key} pattern`,
              decision_method: "quick_match",
              latency_ms: Date.now() - startTime,
            };
          }
        }
      }
    }

    // No quick match - need full router
    return null;
  }
}
