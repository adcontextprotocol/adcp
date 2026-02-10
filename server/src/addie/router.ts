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
 * - clarify: Ask a clarifying question before proceeding
 * - respond: Generate a full response with specific tools
 *
 * Routing rules are code-managed (not user-editable) because:
 * - Tool names must align with actual registered tools
 * - Conditional logic (e.g., "if admin") requires code
 * - Consistency between prod/dev environments
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import { ModelConfig } from '../config/models.js';
import type { MemberContext } from './member-context.js';
import type { AddieTool } from './types.js';
import { KNOWLEDGE_TOOLS } from './mcp/knowledge-search.js';
import { MEMBER_TOOLS } from './mcp/member-tools.js';
import { InsightsDatabase, type MemberInsight } from '../db/insights-db.js';
import { trackApiCall, ApiPurpose } from './services/api-tracker.js';
import {
  getToolSetDescriptionsForRouter,
  requiresPrecision as checkPrecision,
} from './tool-sets.js';

/**
 * Execution plan types
 */
export type ExecutionPlanBase = {
  /** How the decision was made: 'quick_match' (pattern) or 'llm' (Claude Haiku) */
  decision_method: 'quick_match' | 'llm';
  /** Time spent making the routing decision (ms) */
  latency_ms?: number;
  /** Tokens used (only for LLM decisions) */
  tokens_input?: number;
  tokens_output?: number;
  /** Model used (only for LLM decisions) */
  model?: string;
  /** When true, use a more capable model (Opus) for this query - for billing, financial, or precision-critical tasks */
  requires_precision?: boolean;
};

export type ExecutionPlan = ExecutionPlanBase & (
  | { action: 'ignore'; reason: string }
  | { action: 'react'; emoji: string; reason: string }
  | { action: 'clarify'; question: string; reason: string }
  | { action: 'respond'; tool_sets: string[]; reason: string }
);

/**
 * Context for routing decisions
 */
export interface RoutingContext {
  /** The message text to route */
  message: string;
  /** Source of the message */
  source: 'dm' | 'mention' | 'channel';
  /** User's member context (if available) */
  memberContext?: MemberContext | null;
  /** Whether this is in a thread */
  isThread?: boolean;
  /** Channel name (if available) */
  channelName?: string;
  /** Member insights (what we know about this user from past conversations) */
  memberInsights?: MemberInsight[];
  /** Whether the user is an AAO platform admin (checked via aao-admin working group) */
  isAAOAdmin?: boolean;
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
      const firstSentence = tool.description.split('.')[0];
      descriptions[tool.name] = firstSentence;
    }
  }

  // Add web_search which is a built-in Claude tool not in our tool arrays
  descriptions['web_search'] = 'search the web for external protocols (MCP, A2A), current events, things not in our docs';

  return descriptions;
}

/**
 * Tool descriptions for router context - built from tool definitions
 */
export const TOOL_DESCRIPTIONS = buildToolDescriptions();

export const ROUTING_RULES = {
  /**
   * Topics Addie can help with (and the tools to use)
   */
  expertise: {
    capabilities: {
      patterns: ['what can you do', 'what can you help with', 'how can you help me', 'what do you do', 'what are you capable of', 'what are you', 'what kinds of things', 'your capabilities'],
      tools: [], // No tools needed - respond from system prompt knowledge
      description: 'Questions about what Addie can help with - respond with capability overview',
    },
    adcp_protocol: {
      patterns: ['adcp', 'protocol', 'schema', 'specification', 'signals', 'media buy', 'creative', 'targeting', 'brief'],
      tools: ['search_docs'],
      description: 'AdCP protocol questions - understanding how things work',
    },
    salesagent: {
      patterns: ['salesagent', 'sales agent', 'open source agent', 'reference implementation'],
      tools: ['search_repos', 'search_docs'],
      description: 'Salesagent setup and usage',
    },
    client_libraries: {
      patterns: ['client', 'sdk', 'npm', 'pip', 'javascript', 'python', 'typescript'],
      tools: ['search_repos', 'search_docs'],
      description: 'Client library usage',
    },
    adagents_validation: {
      patterns: ['validate', 'check my', 'debug', 'test my', 'verify'],
      tools: ['validate_adagents', 'check_agent_health', 'check_publisher_authorization'],
      description: 'Validation and debugging requests - checking setups, testing configs',
    },
    adagents_json: {
      patterns: ['adagents.json', 'agent manifest', 'agent configuration', 'well-known'],
      tools: ['search_docs', 'validate_adagents'],
      description: 'Learning about adagents.json format and setup',
    },
    membership: {
      patterns: ['member', 'join', 'signup', 'account', 'profile', 'working group'],
      tools: ['get_my_profile', 'list_working_groups', 'join_working_group'],
      description: 'AgenticAdvertising.org membership',
    },
    find_help: {
      patterns: [
        'find someone',
        'looking for',
        'who can help',
        'need help with',
        'vendor',
        'consultant',
        'partner',
        'service provider',
        'implementation',
        'managed service',
        'run a',
        'operate a',
        'introduce me',
        'connect me',
        'dsp',
        'ssp',
        'programmatic',
        'ctv',
        'measurement',
        'attribution',
        'creative optimization',
      ],
      tools: ['search_members', 'request_introduction'],
      description: 'Find member organizations who can help with specific needs - searching for vendors, partners, consultants',
    },
    community: {
      patterns: ['community', 'discussion', 'slack', 'chat history', 'what did', 'who said'],
      tools: ['search_slack'],
      description: 'Community discussions',
    },
    ad_tech_protocols: {
      patterns: [
        'openrtb',
        'open rtb',
        'adcom',
        'vast',
        'opendirect',
        'prebid',
        'header bidding',
        'rtb',
        'real-time bidding',
        'iab',
        'tcf',
        'transparency consent',
        'gpp',
        'global privacy',
        'ccpa',
        'us privacy',
        'uid2',
        'unified id',
        'ads.cert',
        'adscert',
        'artf',
        'agentic rtb',
        'ucp',
        'user context protocol',
      ],
      tools: ['search_repos', 'search_docs'],
      description: 'IAB Tech Lab specs and ad tech protocols - we have these indexed!',
    },
    agent_protocols: {
      patterns: ['mcp', 'model context protocol', 'a2a', 'agent to agent', 'langgraph', 'langchain'],
      tools: ['search_repos'],
      description: 'Agent protocols (MCP, A2A, LangGraph) - we have these indexed!',
    },
    industry_news: {
      patterns: ['news', 'industry', 'announcement', 'latest', 'trend'],
      tools: ['search_resources', 'web_search'],
      description: 'Industry news and trends',
    },
  },

  /**
   * Message types that get emoji reactions instead of responses
   */
  reactWith: {
    greeting: {
      patterns: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'howdy'],
      emoji: 'wave',
    },
    welcome: {
      patterns: ['welcome', 'glad to have', 'excited to join', 'new here', 'just joined'],
      emoji: 'tada',
    },
    thanks: {
      patterns: ['thanks', 'thank you', 'appreciate', 'helpful'],
      emoji: 'heart',
    },
  },

  /**
   * Messages to ignore
   */
  ignore: {
    patterns: [
      'ok', 'okay', 'k', 'got it', 'cool', 'nice', 'lol', 'haha',
      'sounds good', 'will do', 'on it', 'done', 'working on it',
    ],
    reasons: [
      'simple acknowledgment',
      'casual conversation not needing response',
      'message directed at specific person',
      'sufficient responses already provided',
    ],
  },
} as const;

/**
 * Format member insights for the routing prompt
 */
function formatMemberInsights(insights: MemberInsight[] | undefined): string {
  if (!insights || insights.length === 0) {
    return '';
  }

  const insightLines = insights.map(i => {
    const typeName = i.insight_type_name || `type_${i.insight_type_id}`;
    return `- ${typeName}: ${i.value} (confidence: ${i.confidence})`;
  });

  return `
## What We Know About This User
These insights were gleaned from previous conversations:
${insightLines.join('\n')}

Use these insights to:
- Tailor tool selection to their role/expertise level
- Skip basic explanations if they're clearly technical
- Prioritize tools relevant to what they're building`;
}

/**
 * Build the routing prompt based on context
 */
function buildRoutingPrompt(ctx: RoutingContext): string {
  const isAAOAdmin = ctx.isAAOAdmin ?? false;
  const isMember = !!ctx.memberContext?.workos_user?.workos_user_id;
  const isLinked = isMember;

  // Build tool SET descriptions - router selects categories, not individual tools
  const toolSetsSection = getToolSetDescriptionsForRouter(isAAOAdmin);

  // Build react patterns
  const reactList = Object.entries(ROUTING_RULES.reactWith)
    .map(([key, rule]) => `- ${key}: emoji=${rule.emoji}`)
    .join('\n');

  // Format member insights for context
  const insightsSection = formatMemberInsights(ctx.memberInsights);

  // Conditional rules based on user context
  let conditionalRules = '';
  if (!isLinked) {
    conditionalRules += `
The user has NOT linked their Slack account to AgenticAdvertising.org.
- If they ask about membership features, include the "member" tool set`;
  }
  if (isAAOAdmin) {
    conditionalRules += `
The user is an ADMIN.
- They have access to the "admin" tool set for system operations
- Be more direct and technical in responses`;
  }

  return `You are Addie's router. Analyze this message and select the appropriate tool SETS.

## User Context
- Source: ${ctx.source}
- Is member: ${isMember}
- Is admin: ${isAAOAdmin}
- In thread: ${ctx.isThread ?? false}
${conditionalRules}
${insightsSection}

## Available Tool Sets
Select which CATEGORIES of tools will be needed. Each set contains multiple related tools.
${toolSetsSection}

## Tool Set Selection Guidelines
IMPORTANT: Select tool SETS based on the user's INTENT:
- Questions about AdCP, protocols, implementation → ["knowledge"]
- Questions about member profile, working groups, account → ["member"]
- Looking for vendors, partners, introductions → ["directory"]
- Testing/validating AdCP agent implementations → ["agent_testing"]
- Actually executing AdCP operations (media buys, creatives, signals) → ["adcp_operations"]
- Content workflows, GitHub issues, proposals → ["content"]
- Billing, invoices, payment links → ["billing"]
- Scheduling meetings, calendar → ["meetings"]
- Escalations, pending requests, user role changes, merging orgs → ["admin"]
- Multiple intents? Include multiple sets: ["knowledge", "agent_testing"]
- General questions needing no tools → []

## Messages to React To (emoji only, no response)
${reactList}

## Messages to Ignore
- Simple acknowledgments: ok, got it, cool, thanks, etc.
- Casual conversation unrelated to AdCP or AgenticAdvertising.org
- Messages clearly directed at specific people
- Off-topic discussions

## Message
"${ctx.message.substring(0, 500)}"

## Instructions
Respond with a JSON object for the execution plan. Choose ONE action:

1. {"action": "ignore", "reason": "brief reason"}
   - For messages that don't need Addie's response

2. {"action": "react", "emoji": "emoji_name", "reason": "brief reason"}
   - For greetings, welcomes, thanks (use emoji name like "wave", "tada", "heart")

3. {"action": "clarify", "question": "your clarifying question", "reason": "why clarification needed"}
   - When you need more information to help effectively
   - Use sparingly - only when truly ambiguous

4. {"action": "respond", "tool_sets": ["set1", "set2"], "reason": "brief reason"}
   - When you can help - select the tool SET(S) that will be needed
   - Valid sets: knowledge, member, directory, agent_testing, adcp_operations, content, billing, meetings${isAAOAdmin ? ', admin' : ''}
   - Empty array [] means respond without tools (general knowledge)

Respond with ONLY the JSON object, no other text.`;
}

/**
 * Partial execution plan without metadata (used during parsing)
 */
type ParsedPlan =
  | { action: 'ignore'; reason: string }
  | { action: 'react'; emoji: string; reason: string }
  | { action: 'clarify'; question: string; reason: string }
  | { action: 'respond'; tool_sets: string[]; reason: string };

/**
 * Parse the router response into a partial ExecutionPlan
 */
function parseRouterResponse(response: string): ParsedPlan {
  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonStr);

    // Validate and normalize the response
    if (parsed.action === 'ignore') {
      return { action: 'ignore', reason: parsed.reason || 'No reason provided' };
    }
    if (parsed.action === 'react') {
      return {
        action: 'react',
        emoji: parsed.emoji || 'wave',
        reason: parsed.reason || 'Greeting or acknowledgment',
      };
    }
    if (parsed.action === 'clarify') {
      return {
        action: 'clarify',
        question: parsed.question || 'Could you tell me more about what you need help with?',
        reason: parsed.reason || 'Needs clarification',
      };
    }
    if (parsed.action === 'respond') {
      // Accept tool set names as-is
      const toolSets = Array.isArray(parsed.tool_sets) ? parsed.tool_sets : [];
      return {
        action: 'respond',
        tool_sets: toolSets,
        reason: parsed.reason || 'Can help with this topic',
      };
    }

    // Default to ignore if unknown action
    logger.warn({ parsed }, 'Router: Unknown action, defaulting to ignore');
    return { action: 'ignore', reason: 'Unknown action type' };
  } catch (error) {
    logger.error({ error, response }, 'Router: Failed to parse response');
    // On parse error, default to respond with knowledge tools (safe fallback)
    return { action: 'respond', tool_sets: ['knowledge'], reason: 'Parse error - defaulting to knowledge tools' };
  }
}

/**
 * Addie Router class
 *
 * Uses Claude Haiku for fast routing decisions
 */
export class AddieRouter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Route a message and return an execution plan
   *
   * @param ctx - Routing context with message and metadata
   * @returns Execution plan determining how to handle the message
   */
  async route(ctx: RoutingContext): Promise<ExecutionPlan> {
    const startTime = Date.now();

    try {
      const prompt = buildRoutingPrompt(ctx);

      const response = await this.client.messages.create({
        model: ModelConfig.fast, // Haiku for speed
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].type === 'text'
        ? response.content[0].text
        : '';

      const parsedPlan = parseRouterResponse(text);
      const latencyMs = Date.now() - startTime;

      // Check if any selected tool sets require precision mode (billing, financial)
      let requiresPrecisionMode = false;
      if (parsedPlan.action === 'respond') {
        requiresPrecisionMode = checkPrecision(parsedPlan.tool_sets);
      }

      const plan: ExecutionPlan = {
        ...parsedPlan,
        decision_method: 'llm',
        latency_ms: latencyMs,
        tokens_input: response.usage?.input_tokens,
        tokens_output: response.usage?.output_tokens,
        model: ModelConfig.fast,
        requires_precision: requiresPrecisionMode,
      };

      logger.debug({
        source: ctx.source,
        action: plan.action,
        reason: plan.reason,
        toolSets: parsedPlan.action === 'respond' ? parsedPlan.tool_sets : undefined,
        durationMs: latencyMs,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        requiresPrecision: requiresPrecisionMode,
      }, 'Router: Execution plan generated');

      // Track for performance metrics (fire-and-forget, errors handled internally)
      void trackApiCall({
        model: ModelConfig.fast,
        purpose: ApiPurpose.ROUTER,
        tokens_input: response.usage?.input_tokens,
        tokens_output: response.usage?.output_tokens,
        latency_ms: latencyMs,
      });

      return plan;
    } catch (error) {
      logger.error({ error }, 'Router: Failed to generate execution plan');
      // On error, default to respond with knowledge tools (safe fallback - don't miss important messages)
      return {
        action: 'respond',
        tool_sets: ['knowledge'],
        reason: 'Router error - defaulting to knowledge tools',
        decision_method: 'llm',
        latency_ms: Date.now() - startTime,
      };
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
    const text = ctx.message.toLowerCase().trim();

    // Check for simple acknowledgments to ignore
    for (const pattern of ROUTING_RULES.ignore.patterns) {
      if (text === pattern || text === pattern + '.') {
        return {
          action: 'ignore',
          reason: 'Simple acknowledgment',
          decision_method: 'quick_match',
          latency_ms: Date.now() - startTime,
        };
      }
    }

    // Check for greeting patterns to react
    for (const [key, rule] of Object.entries(ROUTING_RULES.reactWith)) {
      for (const pattern of rule.patterns) {
        // Only match if the message is very short (likely just a greeting)
        if (text.length < 20 && text.includes(pattern.toLowerCase())) {
          return {
            action: 'react',
            emoji: rule.emoji,
            reason: `Matched ${key} pattern`,
            decision_method: 'quick_match',
            latency_ms: Date.now() - startTime,
          };
        }
      }
    }

    // No quick match - need full router
    return null;
  }
}
