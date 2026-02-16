/**
 * Token limiting utilities for Anthropic API calls
 *
 * Provides functions to estimate token counts and trim conversation
 * history to stay within Claude's context limits.
 *
 * Uses a conservative character-based estimate for fast local calculations.
 * For exact counts, use Anthropic's messages.countTokens API.
 */

import { logger } from '../logger.js';

/**
 * Model context limits (input tokens)
 * These are the maximum input tokens allowed before the API rejects the request.
 * Reserve buffer space for system prompt, tools, and response generation.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4-20250514': 200000,
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  // Default for unknown models
  default: 200000,
};

/**
 * Buffer sizes for different components that contribute to context
 *
 * IMPORTANT: These buffers must account for worst-case scenarios.
 * Tool definitions are the biggest variable - admin users can have 100+ tools
 * with complex schemas and descriptions.
 *
 * Actual measured tool sizes (Jan 2026):
 * - ADMIN_TOOLS: ~50 tools, ~15K tokens
 * - MEMBER_TOOLS: ~38 tools, ~10K tokens
 * - KNOWLEDGE_TOOLS: ~8 tools, ~2.5K tokens
 * - DIRECTORY_TOOLS: ~7 tools, ~1.2K tokens
 * - EVENT_TOOLS: ~5 tools, ~1.8K tokens
 * - MEETING_TOOLS: ~8 tools, ~1.6K tokens
 * - URL_TOOLS: ~2 tools, ~0.5K tokens
 * Admin user total: ~33K tokens for tools alone
 */
export const TOKEN_BUFFERS = {
  /** System prompt typically 8-15K tokens */
  systemPrompt: 20000,
  /**
   * Tool definitions - admin users can have 100+ tools
   * Increased from 15K to 45K to prevent prompt overflow errors
   */
  toolDefinitions: 45000,
  /**
   * Member context, channel context, and insight goals prepended to user message.
   * These are added before conversation trimming so must be reserved separately.
   */
  prependedContext: 10000,
  /** Reserve space for response generation */
  responseBuffer: 5000,
  /** Safety margin for any miscalculation */
  safetyMargin: 10000,
};

/**
 * Total reserved tokens (not available for conversation history)
 */
export const RESERVED_TOKENS =
  TOKEN_BUFFERS.systemPrompt +
  TOKEN_BUFFERS.toolDefinitions +
  TOKEN_BUFFERS.prependedContext +
  TOKEN_BUFFERS.responseBuffer +
  TOKEN_BUFFERS.safetyMargin;

/**
 * Estimate tokens for tool definitions based on tool count.
 * Uses ~300 tokens per tool as a conservative estimate based on measured data.
 *
 * @param toolCount - Number of tools being used
 * @returns Estimated token count for tool definitions
 */
export function estimateToolTokens(toolCount: number): number {
  // Based on measurements: ~300 tokens per tool on average
  // This accounts for name, description, and input_schema
  return toolCount * 300;
}

/**
 * Get the effective limit for conversation history
 *
 * @param model - Model name (for looking up context limit)
 * @param toolCount - Optional actual tool count for more accurate estimation
 * @returns Maximum tokens available for conversation history
 */
export function getConversationTokenLimit(model?: string, toolCount?: number): number {
  const limit = MODEL_CONTEXT_LIMITS[model ?? 'default'] ?? MODEL_CONTEXT_LIMITS.default;

  // If tool count is provided, use dynamic calculation
  if (toolCount !== undefined) {
    const toolTokens = estimateToolTokens(toolCount);
    const reserved =
      TOKEN_BUFFERS.systemPrompt +
      toolTokens +
      TOKEN_BUFFERS.prependedContext +
      TOKEN_BUFFERS.responseBuffer +
      TOKEN_BUFFERS.safetyMargin;
    return limit - reserved;
  }

  // Fall back to default static buffer
  return limit - RESERVED_TOKENS;
}

/**
 * Estimate token count from text using a character-based heuristic.
 *
 * Claude uses a BPE tokenizer where:
 * - English text averages ~4 characters per token
 * - Code and structured data can be 3-5 chars per token
 * - We use 3.5 to be conservative (overestimate slightly)
 *
 * This is NOT exact but is fast for local estimation.
 * Use Anthropic's API for precise counts when needed.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Conservative estimate: ~3.5 characters per token
  // This slightly overestimates which is safer than underestimating
  return Math.ceil(text.length / 3.5);
}

/**
 * Message turn structure (matches prompts.ts)
 */
export interface MessageTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Result of trimming conversation history
 */
export interface TrimResult {
  /** Trimmed messages that fit within limit */
  messages: MessageTurn[];
  /** Estimated token count of trimmed messages */
  estimatedTokens: number;
  /** Number of messages removed */
  messagesRemoved: number;
  /** Whether any trimming occurred */
  wasTrimmed: boolean;
}

/**
 * Trim conversation history to fit within token limit.
 *
 * Strategy:
 * 1. Always keep the most recent message (current turn)
 * 2. Remove oldest messages first until we fit
 * 3. If even one message exceeds limit, truncate it
 *
 * @param messages - Conversation history (newest last)
 * @param tokenLimit - Maximum tokens allowed for messages
 * @returns Trimmed messages and metadata
 */
export function trimConversationHistory(
  messages: MessageTurn[],
  tokenLimit: number
): TrimResult {
  if (messages.length === 0) {
    return {
      messages: [],
      estimatedTokens: 0,
      messagesRemoved: 0,
      wasTrimmed: false,
    };
  }

  const originalCount = messages.length;

  // Estimate tokens for each message
  const messagesWithTokens = messages.map(msg => ({
    message: msg,
    tokens: estimateTokens(msg.content),
  }));

  // Start from the end (most recent) and work backwards
  let totalTokens = 0;
  const includedMessages: MessageTurn[] = [];

  // Always try to include the most recent message (current user turn)
  // Work backwards from the end
  for (let i = messagesWithTokens.length - 1; i >= 0; i--) {
    const { message, tokens } = messagesWithTokens[i];

    if (totalTokens + tokens <= tokenLimit) {
      // Fits within limit - add to front (to maintain order)
      includedMessages.unshift(message);
      totalTokens += tokens;
    } else if (includedMessages.length === 0) {
      // Even the most recent message doesn't fit - truncate it
      const availableChars = Math.floor(tokenLimit * 3.5);
      const truncateAt = Math.max(0, availableChars - 100);
      const truncatedContent = message.content.substring(0, truncateAt) +
        '\n\n[Message truncated due to length]';

      logger.warn(
        {
          originalTokens: tokens,
          truncatedTo: estimateTokens(truncatedContent),
          tokenLimit,
        },
        'Token limiter: Truncated single message that exceeded limit'
      );

      includedMessages.unshift({
        role: message.role,
        content: truncatedContent,
      });
      totalTokens = estimateTokens(truncatedContent);
      break; // Can't include any more
    } else {
      // Message doesn't fit and we have some messages - stop here
      break;
    }
  }

  const messagesRemoved = originalCount - includedMessages.length;
  const wasTrimmed = messagesRemoved > 0;

  if (wasTrimmed) {
    logger.info(
      {
        originalMessages: originalCount,
        keptMessages: includedMessages.length,
        messagesRemoved,
        estimatedTokens: totalTokens,
        tokenLimit,
      },
      'Token limiter: Trimmed conversation history to fit context limit'
    );
  }

  return {
    messages: includedMessages,
    estimatedTokens: totalTokens,
    messagesRemoved,
    wasTrimmed,
  };
}

/**
 * Check if a request is likely to exceed context limits.
 *
 * This is a fast local check using estimates. For critical operations,
 * use Anthropic's messages.countTokens API.
 *
 * @param systemPromptTokens - Estimated tokens in system prompt
 * @param messagesTokens - Estimated tokens in conversation messages
 * @param toolsTokens - Estimated tokens in tool definitions
 * @param model - Model name (for looking up context limit)
 * @returns Object with check result and details
 */
export function checkContextLimit(
  systemPromptTokens: number,
  messagesTokens: number,
  toolsTokens: number = 0,
  model?: string
): {
  withinLimit: boolean;
  estimatedTotal: number;
  modelLimit: number;
  headroom: number;
} {
  const modelLimit = MODEL_CONTEXT_LIMITS[model ?? 'default'] ?? MODEL_CONTEXT_LIMITS.default;
  const estimatedTotal = systemPromptTokens + messagesTokens + toolsTokens + TOKEN_BUFFERS.prependedContext + TOKEN_BUFFERS.responseBuffer;
  const headroom = modelLimit - estimatedTotal;

  return {
    withinLimit: headroom > TOKEN_BUFFERS.safetyMargin,
    estimatedTotal,
    modelLimit,
    headroom,
  };
}

/**
 * Format a token count for logging (e.g., "150K")
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return String(tokens);
}
