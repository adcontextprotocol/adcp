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
};

export type ExecutionPlan = ExecutionPlanBase & (
  | { action: 'ignore'; reason: string }
  | { action: 'react'; emoji: string; reason: string }
  | { action: 'clarify'; question: string; reason: string }
  | { action: 'respond'; tools: string[]; reason: string }
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
  const isAdmin = ctx.memberContext?.org_membership?.role === 'admin';
  const isMember = !!ctx.memberContext?.workos_user?.workos_user_id;
  const isLinked = isMember;

  // Build tool descriptions section - this is key for proper tool selection
  const toolsSection = Object.entries(TOOL_DESCRIPTIONS)
    .map(([name, desc]) => `- **${name}**: ${desc}`)
    .join('\n');

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
- If they ask about membership features, suggest linking their account first
- Use tools: [get_my_profile] to check their status`;
  }
  if (isAdmin) {
    conditionalRules += `
The user is an ADMIN.
- They may ask about system configuration or analytics
- Be more direct and technical in responses`;
  }

  return `You are Addie's router. Analyze this message and determine the execution plan.

## User Context
- Source: ${ctx.source}
- Is member: ${isMember}
- Is admin: ${isAdmin}
- In thread: ${ctx.isThread ?? false}
${conditionalRules}
${insightsSection}

## Available Tools (with when to use each)
${toolsSection}

## Tool Selection Guidelines
IMPORTANT: Choose tools based on the user's INTENT, not just keywords:
- "How does X work?" / "What is X?" / "Explain X" → search_docs (learning/understanding)
- "Validate my adagents.json" / "Check example.com" / "Debug my setup" → validate_adagents (action/validation)
- "How do I use the SDK?" / "Salesagent setup" → search_repos (implementation help)
- "What did someone say about X?" → search_slack (community discussions)
- Questions about MCP, A2A, OpenRTB, AdCOM, TCF, GPP, UID2, Prebid, IAB specs → search_repos (we have these indexed!)
- "Is my agent working?" / "Test my endpoint" → check_agent_health (testing)
- Questions about topics NOT in our indexed repos → web_search (external info)

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

4. {"action": "respond", "tools": ["tool1", "tool2"], "reason": "brief reason"}
   - When you can help and know which tools to use
   - Select tools from the Available Tools list based on user intent
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
  | { action: 'respond'; tools: string[]; reason: string };

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
      // Accept tool names as-is - they come from ROUTING_RULES.expertise
      const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
      return {
        action: 'respond',
        tools,
        reason: parsed.reason || 'Can help with this topic',
      };
    }

    // Default to ignore if unknown action
    logger.warn({ parsed }, 'Router: Unknown action, defaulting to ignore');
    return { action: 'ignore', reason: 'Unknown action type' };
  } catch (error) {
    logger.error({ error, response }, 'Router: Failed to parse response');
    // On parse error, default to respond with no tools (safe fallback)
    return { action: 'respond', tools: [], reason: 'Parse error - defaulting to general response' };
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

      const plan: ExecutionPlan = {
        ...parsedPlan,
        decision_method: 'llm',
        latency_ms: latencyMs,
        tokens_input: response.usage?.input_tokens,
        tokens_output: response.usage?.output_tokens,
        model: ModelConfig.fast,
      };

      logger.debug({
        source: ctx.source,
        action: plan.action,
        reason: plan.reason,
        durationMs: latencyMs,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      }, 'Router: Execution plan generated');

      return plan;
    } catch (error) {
      logger.error({ error }, 'Router: Failed to generate execution plan');
      // On error, default to respond (safe fallback - don't miss important messages)
      return {
        action: 'respond',
        tools: [],
        reason: 'Router error - defaulting to general response',
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
