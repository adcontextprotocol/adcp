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

/**
 * Execution plan types
 */
export type ExecutionPlan =
  | { action: 'ignore'; reason: string }
  | { action: 'react'; emoji: string; reason: string }
  | { action: 'clarify'; question: string; reason: string }
  | { action: 'respond'; tools: string[]; reason: string };

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
}

/**
 * Tool definitions for routing
 * These must match the actual registered tools in claude-client
 */
export const AVAILABLE_TOOLS = {
  // Knowledge tools
  search_docs: 'Search AdCP documentation',
  search_repos: 'Search code repositories (salesagent, clients)',
  search_slack: 'Search Slack discussions',
  search_resources: 'Search external resources and news',
  validate_adagents: 'Validate adagents.json files',

  // Member tools
  get_my_profile: 'Get user profile information',
  update_my_profile: 'Update user profile',
  list_working_groups: 'List available working groups',
  join_working_group: 'Join a working group',

  // Built-in
  web_search: 'Search the web for external information',
} as const;

export type ToolName = keyof typeof AVAILABLE_TOOLS;

/**
 * Routing rules - code-managed, not user-editable
 *
 * These rules define when Addie should respond and what tools to use.
 * They're kept in code because tool names must match actual implementations
 * and some rules have conditional logic.
 */
export const ROUTING_RULES = {
  /**
   * Topics Addie can help with (and the tools to use)
   */
  expertise: {
    adcp_protocol: {
      patterns: ['adcp', 'protocol', 'schema', 'specification', 'signals', 'media buy', 'creative'],
      tools: ['search_docs', 'validate_adagents'],
      description: 'AdCP protocol questions',
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
    adagents_json: {
      patterns: ['adagents.json', 'agent manifest', 'agent configuration'],
      tools: ['validate_adagents', 'search_docs'],
      description: 'Agent manifest validation',
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
    external_protocols: {
      patterns: ['mcp', 'model context protocol', 'a2a', 'agent to agent'],
      tools: ['web_search'],
      description: 'External protocols (MCP, A2A) - web search only',
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
 * Build the routing prompt based on context
 */
function buildRoutingPrompt(ctx: RoutingContext): string {
  const isAdmin = ctx.memberContext?.org_membership?.role === 'admin';
  const isMember = !!ctx.memberContext?.workos_user?.workos_user_id;
  const isLinked = isMember;

  // Build expertise section
  const expertiseList = Object.entries(ROUTING_RULES.expertise)
    .map(([key, rule]) => `- ${rule.description}: tools=[${rule.tools.join(', ')}]`)
    .join('\n');

  // Build react patterns
  const reactList = Object.entries(ROUTING_RULES.reactWith)
    .map(([key, rule]) => `- ${key}: emoji=${rule.emoji}`)
    .join('\n');

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

## Topics Addie Can Help With (and tools to use)
${expertiseList}

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
   - List specific tools from the expertise list above
   - Empty array [] means respond without tools (general knowledge)

Respond with ONLY the JSON object, no other text.`;
}

/**
 * Parse the router response into an ExecutionPlan
 */
function parseRouterResponse(response: string): ExecutionPlan {
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
      // Validate tool names
      const validTools = Object.keys(AVAILABLE_TOOLS);
      const tools = Array.isArray(parsed.tools)
        ? parsed.tools.filter((t: string) => validTools.includes(t))
        : [];
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
/**
 * Export routing rules in a format suitable for database sync
 */
export function getRoutingRulesForSync(): Array<{
  rule_type: string;
  rule_key: string;
  description: string;
  patterns: string[];
  tools?: string[];
  emoji?: string;
}> {
  const rules: Array<{
    rule_type: string;
    rule_key: string;
    description: string;
    patterns: string[];
    tools?: string[];
    emoji?: string;
  }> = [];

  // Export expertise rules
  for (const [key, rule] of Object.entries(ROUTING_RULES.expertise)) {
    rules.push({
      rule_type: 'expertise',
      rule_key: key,
      description: rule.description,
      patterns: [...rule.patterns],
      tools: [...rule.tools],
    });
  }

  // Export react rules
  for (const [key, rule] of Object.entries(ROUTING_RULES.reactWith)) {
    rules.push({
      rule_type: 'react',
      rule_key: key,
      description: `React with ${rule.emoji} emoji`,
      patterns: [...rule.patterns],
      emoji: rule.emoji,
    });
  }

  // Export ignore patterns
  rules.push({
    rule_type: 'ignore',
    rule_key: 'acknowledgments',
    description: 'Simple acknowledgments and casual responses',
    patterns: [...ROUTING_RULES.ignore.patterns],
  });

  return rules;
}

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

      const plan = parseRouterResponse(text);

      logger.debug({
        source: ctx.source,
        action: plan.action,
        reason: plan.reason,
        durationMs: Date.now() - startTime,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      }, 'Router: Execution plan generated');

      return plan;
    } catch (error) {
      logger.error({ error }, 'Router: Failed to generate execution plan');
      // On error, default to respond (safe fallback - don't miss important messages)
      return { action: 'respond', tools: [], reason: 'Router error - defaulting to general response' };
    }
  }

  /**
   * Quick check for obvious patterns (before hitting the LLM)
   *
   * This is an optimization - catches simple cases without an API call.
   * Returns null if no quick match, meaning the full router should run.
   */
  quickMatch(ctx: RoutingContext): ExecutionPlan | null {
    const text = ctx.message.toLowerCase().trim();

    // Check for simple acknowledgments to ignore
    for (const pattern of ROUTING_RULES.ignore.patterns) {
      if (text === pattern || text === pattern + '.') {
        return { action: 'ignore', reason: 'Simple acknowledgment' };
      }
    }

    // Check for greeting patterns to react
    for (const [key, rule] of Object.entries(ROUTING_RULES.reactWith)) {
      for (const pattern of rule.patterns) {
        // Only match if the message is very short (likely just a greeting)
        if (text.length < 20 && text.includes(pattern.toLowerCase())) {
          return { action: 'react', emoji: rule.emoji, reason: `Matched ${key} pattern` };
        }
      }
    }

    // No quick match - need full router
    return null;
  }
}
