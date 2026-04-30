/**
 * Claude client for Addie - handles LLM interactions with tool use
 *
 * System prompt is built from markdown rule files in ./rules/,
 * with tool reference always appended from code.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../logger.js';

const logger = createLogger('addie-claude-client');
import type { AddieTool } from './types.js';
import { ADDIE_FALLBACK_PROMPT, ADDIE_TOOL_REFERENCE, buildMessageTurnsWithMetadata } from './prompts.js';
import { AddieDatabase } from '../db/addie-db.js';
import { AddieModelConfig, getModelBetas } from '../config/models.js';
import { getCurrentConfigVersionId } from './config-version.js';
import { loadRules, invalidateRulesCache } from './rules/index.js';
import { isMultimodalContent, extractMultimodalContent, isAllowedImageType, type FileReadResult } from './mcp/url-tools.js';
import { withRetry, isRetryableError, RetriesExhaustedError, type RetryConfig } from '../utils/anthropic-retry.js';
import { formatTokenCount, getConversationTokenLimit, buildDroppedMessagesSummary, type MessageTurn } from '../utils/token-limiter.js';
import { notifyToolError } from './error-notifier.js';
import { ToolError } from './tool-error.js';
import { checkCostCap, recordCost, formatCapExceededMessage } from './claude-cost-tracker.js';
import { applyResponsePipeline } from './response-postprocess.js';

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/**
 * Convert MessageTurn[] into Anthropic.MessageParam[] with proper tool_use/tool_result
 * content blocks. When an assistant message has toolCalls, we:
 * 1. Build the assistant content as [text, tool_use, tool_use, ...]
 * 2. Insert a synthetic user message with [tool_result, tool_result, ...]
 *
 * This prevents the model from hallucinating tool calls as text (which happens when
 * tool results are flattened into plain text in conversation history).
 */
function toAnthropicMessages(turns: MessageTurn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let toolIdCounter = 0;

  for (const turn of turns) {
    if (turn.role === 'assistant' && turn.toolCalls && turn.toolCalls.length > 0) {
      // Build assistant content blocks: text + tool_use blocks
      const content: Anthropic.ContentBlockParam[] = [];
      if (turn.content.trim()) {
        content.push({ type: 'text', text: turn.content });
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const tc of turn.toolCalls) {
        const toolUseId = `hist_${toolIdCounter++}`;
        content.push({
          type: 'tool_use',
          id: toolUseId,
          name: tc.name,
          input: (tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input)) ? tc.input : {},
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: tc.result,
          is_error: tc.is_error ?? false,
        });
      }

      // Defensive: skip if no content blocks were produced
      if (content.length === 0) {
        messages.push({ role: turn.role, content: turn.content });
      } else {
        messages.push({ role: 'assistant', content });
        // Insert tool_result in a user turn (required by Anthropic API)
        messages.push({ role: 'user', content: toolResults });
      }
    } else {
      messages.push({ role: turn.role, content: turn.content });
    }
  }

  // Anthropic API requires alternating roles — merge consecutive same-role messages
  // The first merge (in buildMessageTurnsWithMetadata) handles raw MessageTurns for
  // token estimation. This second merge handles synthetic user messages (tool_result
  // blocks) that toAnthropicMessages inserts, which may collide with real user messages.
  const merged: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      const prev = merged[merged.length - 1];
      // Normalize both to arrays and concatenate
      const prevContent = Array.isArray(prev.content)
        ? prev.content
        : [{ type: 'text' as const, text: prev.content }];
      const newContent = Array.isArray(msg.content)
        ? msg.content
        : [{ type: 'text' as const, text: msg.content }];
      prev.content = [...prevContent, ...newContent];
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

/**
 * Build Claude content blocks from multimodal file content.
 * Returns null if the content cannot be converted to valid content blocks.
 */
function buildMultimodalContentBlocks(
  multimodal: FileReadResult
): { content: Anthropic.ToolResultBlockParam['content']; summary: string } | null {
  if (!multimodal.data) {
    return null;
  }

  const contentBlocks: Anthropic.ToolResultBlockParam['content'] = [];

  if (multimodal.type === 'image') {
    // Validate media type before using
    if (!isAllowedImageType(multimodal.media_type)) {
      logger.warn(
        { mediaType: multimodal.media_type },
        'Addie: Invalid image media type in multimodal content'
      );
      return null;
    }
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: multimodal.media_type,
        data: multimodal.data,
      },
    });
    contentBlocks.push({
      type: 'text',
      text: `[Image: ${multimodal.filename || 'uploaded image'}]`,
    });
  } else if (multimodal.type === 'document') {
    contentBlocks.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: multimodal.data,
      },
    });
    contentBlocks.push({
      type: 'text',
      text: `[PDF Document: ${multimodal.filename || 'uploaded document'}]`,
    });
  } else {
    // Unknown multimodal type
    return null;
  }

  const summary = `Loaded ${multimodal.type}: ${multimodal.filename || 'file'}`;
  return { content: contentBlocks, summary };
}

/**
 * Action-claiming patterns mapped to the tools that should back them up.
 * Hoisted to module scope to avoid re-allocation on every response.
 */
const HALLUCINATION_PATTERNS: ReadonlyArray<{ pattern: RegExp; expectedTools: string[] }> = [
  { pattern: /invoice\s+(?:resent|sent)\s+successfully/i, expectedTools: ['resend_invoice', 'send_invoice', 'send_payment_request'] },
  { pattern: /(?:successfully\s+)?resent\s+(?:the\s+)?invoice/i, expectedTools: ['resend_invoice', 'send_invoice', 'send_payment_request'] },
  { pattern: /(?:billing\s+)?email\s+(?:updated|changed)\s+successfully/i, expectedTools: ['update_billing_email'] },
  { pattern: /(?:I'?ve\s+|I\s+)?resolved\s+(?:the\s+)?escalation/i, expectedTools: ['resolve_escalation'] },
  { pattern: /escalation\s+#?\d+\s+(?:has been\s+)?resolved/i, expectedTools: ['resolve_escalation'] },
  { pattern: /meeting\s+(?:scheduled|created)\s+successfully/i, expectedTools: ['schedule_meeting'] },
  { pattern: /(?:I'?ve\s+|I\s+)?(?:created|generated|sent)\s+(?:a\s+)?payment\s+link/i, expectedTools: ['create_payment_link'] },
  { pattern: /(?:I'?ve\s+|I\s+)?(?:sent|delivered)\s+(?:a\s+)?(?:DM|direct message|notification)/i, expectedTools: ['send_member_dm', 'resolve_escalation'] },
  { pattern: /(?:I'?ve\s+|I\s+)?added\s+\S+(?:\s+\S+){0,5}\s+to\s+the\s+(?:meeting|call|series)/i, expectedTools: ['add_meeting_attendee'] },
];

/**
 * Detect possible hallucinated actions in response text.
 * Returns a flag reason if the text claims to have completed an action
 * but no corresponding tool was actually called AND succeeded.
 */
function detectHallucinatedAction(text: string, toolExecutions: ToolExecution[]): string | null {
  for (const { pattern, expectedTools } of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      // Check that a matching tool was called AND succeeded (not just called)
      const hasSuccessfulTool = expectedTools.some(t =>
        toolExecutions.some(exec => exec.tool_name === t && !exec.is_error)
      );
      if (!hasSuccessfulTool) {
        return `Possible hallucinated action: text matches "${pattern.source}" but none of [${expectedTools.join(', ')}] succeeded`;
      }
    }
  }

  return null;
}

/** Default max tool iterations for regular users */
export const DEFAULT_MAX_ITERATIONS = 10;

/** Elevated max tool iterations for certification sessions (teaching + assessment + exercises + completion + credentials) */
export const CERTIFICATION_MAX_ITERATIONS = 20;

/** Elevated max tool iterations for admin users doing bulk operations */
export const ADMIN_MAX_ITERATIONS = 25;

/**
 * Per-request tools that can be added dynamically
 */
export interface RequestTools {
  tools: AddieTool[];
  handlers: Map<string, ToolHandler>;
}

/**
 * Result from createUserScopedTools including admin status
 */
export interface UserScopedToolsResult {
  tools: RequestTools;
  isAAOAdmin: boolean;
}

/**
 * Options for message processing
 */
export interface ProcessMessageOptions {
  /** Maximum tool iterations (default: DEFAULT_MAX_ITERATIONS) */
  maxIterations?: number;
  /** Override the default model for this request (e.g., for billing queries requiring precision) */
  modelOverride?: string;
  /** Per-request context (member info, channel, goals) appended to system prompt */
  requestContext?: string;
  /** Override max messages for conversation history (default: 20, certification sessions use 50) */
  maxMessages?: number;
  /** Slack user ID — used for error notifications so admins know who was affected */
  slackUserId?: string;
  /** Fallback display name for error notifications when slackUserId is unavailable (e.g. web chat) */
  userDisplayName?: string;
  /** Thread ID — used for error notification links to admin view */
  threadId?: string;
  /**
   * User identity + tier for the per-user Anthropic cost cap (#2790).
   * Callers must pass either `costScope` (to apply the cap) OR
   * `uncapped: true` (to opt out explicitly for router / system
   * paths). When both are missing, claude-client logs a warn with
   * `event: 'cost_cap_unwired'` so observability catches future
   * callers that ship without either (#2950).
   */
  costScope?: {
    userId: string;
    tier: 'anonymous' | 'member_free' | 'member_paid';
  };
  /**
   * Explicit opt-out for system / router callers that shouldn't
   * count against a per-user budget.
   */
  uncapped?: true;
  /**
   * Display name of the speaker who sent `userMessage`. When set and the
   * thread has multiple distinct human speakers, every user-role turn —
   * including the current one — is prefixed with `[name]:` so the model
   * can tell speakers apart. Used for Slack channel threads where an
   * admin may reply mid-thread to a non-member's question.
   */
  currentSpeakerName?: string;
}

/**
 * Override for system prompt - used by eval framework to test proposed rules
 */
export interface RulesOverride {
  systemPrompt: string;
}

/**
 * Detailed record of a single tool execution
 */
export interface ToolExecution {
  tool_name: string;
  parameters: Record<string, unknown>;
  result: string;
  result_summary?: string;
  is_error: boolean;
  duration_ms: number;
  sequence: number;
}

export interface AddieResponse {
  text: string;
  tools_used: string[];
  /** Detailed execution log for each tool call */
  tool_executions: ToolExecution[];
  flagged: boolean;
  flag_reason?: string;
  /** Rule IDs that were active for this interaction (for logging/analysis) */
  active_rule_ids?: number[];
  /** Configuration version ID for this interaction */
  config_version_id?: number;
  /** Timing breakdown for each phase of processing */
  timing?: {
    system_prompt_ms: number;
    total_llm_ms: number;
    total_tool_execution_ms: number;
    iterations: number;
  };
  /** Token usage from Claude API */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Event types emitted during streaming
 */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_start'; tool_name: string; parameters: Record<string, unknown> }
  | { type: 'tool_end'; tool_name: string; result: string; is_error: boolean }
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | { type: 'done'; response: AddieResponse }
  | { type: 'error'; error: string };

interface PayloadDebugStats {
  model: string;
  iteration: number;
  system_block_count: number;
  system_chars: number;
  request_context_chars: number;
  tool_count: number;
  tool_chars: number;
  message_count: number;
  message_chars: number;
  largest_message?: { index: number; role: string; chars: number };
}

export class AddieClaudeClient {
  private client: Anthropic;
  private model: string;
  private tools: AddieTool[] = [];
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private addieDb: AddieDatabase;
  private webSearchEnabled: boolean = true; // Enable web search for external questions

  constructor(apiKey: string, model: string = AddieModelConfig.chat) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.addieDb = new AddieDatabase();
  }

  /**
   * Enable or disable web search capability
   */
  setWebSearchEnabled(enabled: boolean): void {
    this.webSearchEnabled = enabled;
  }

  /**
   * Get the system prompt from markdown rule files, with tool reference always appended.
   *
   * Rules are loaded from ./rules/*.md files (cached in memory after first read).
   * Tool reference (ADDIE_TOOL_REFERENCE) is always appended (tied to code).
   * Fallback prompt used only when rule files can't be read.
   */
  private getSystemPrompt(): { prompt: string } {
    try {
      const basePrompt = loadRules();
      const prompt = `${basePrompt}\n\n---\n\n${ADDIE_TOOL_REFERENCE}`;
      return { prompt };
    } catch (error) {
      logger.warn({ error }, 'Addie: Failed to load rules from files, using fallback prompt');
      const fallbackPrompt = `${ADDIE_FALLBACK_PROMPT}\n\n---\n\n${ADDIE_TOOL_REFERENCE}`;
      return { prompt: fallbackPrompt };
    }
  }

  private estimateMessageContentChars(content: Anthropic.MessageParam['content']): number {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return 0;

    let total = 0;
    for (const block of content) {
      if ('text' in block && typeof block.text === 'string') {
        total += block.text.length;
      }
      if ('name' in block && typeof block.name === 'string') {
        total += block.name.length;
      }
      if ('input' in block && block.input !== undefined) {
        total += JSON.stringify(block.input).length;
      }
      if ('content' in block && typeof block.content === 'string') {
        total += block.content.length;
      } else if ('content' in block && Array.isArray(block.content)) {
        total += JSON.stringify(block.content).length;
      }
      // Base64 image data
      if ('source' in block) {
        const source = (block as unknown as { source: { data?: string } }).source;
        if (typeof source?.data === 'string') {
          total += source.data.length;
        }
      }
    }
    return total;
  }

  private buildPayloadDebugStats(
    effectiveModel: string,
    systemBlocks: Anthropic.TextBlockParam[],
    customTools: Anthropic.Tool[],
    messages: Anthropic.MessageParam[],
    iteration: number = 0,
    extraToolCount: number = 0,
  ): PayloadDebugStats {
    const systemChars = systemBlocks.reduce((sum, block) => sum + block.text.length, 0);
    const requestContextChars = systemBlocks.slice(1).reduce((sum, block) => sum + block.text.length, 0);

    let largestMessage: PayloadDebugStats['largest_message'];
    let messageChars = 0;
    for (let i = 0; i < messages.length; i++) {
      const chars = this.estimateMessageContentChars(messages[i].content);
      messageChars += chars;
      if (!largestMessage || chars > largestMessage.chars) {
        largestMessage = { index: i, role: messages[i].role, chars };
      }
    }

    return {
      model: effectiveModel,
      iteration,
      system_block_count: systemBlocks.length,
      system_chars: systemChars,
      request_context_chars: requestContextChars,
      tool_count: customTools.length + extraToolCount,
      tool_chars: JSON.stringify(customTools).length,
      message_count: messages.length,
      message_chars: messageChars,
      largest_message: largestMessage,
    };
  }

  private isPromptOverflow(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('prompt is too long')) return true;
    // RetriesExhaustedError wraps the original — check .cause
    if (error instanceof RetriesExhaustedError) {
      const causeMsg = error.cause instanceof Error ? error.cause.message : String(error.cause);
      if (causeMsg.includes('prompt is too long')) return true;
    }
    return false;
  }

  private logPromptOverflow(error: unknown, payload: PayloadDebugStats, source: string): void {
    if (!this.isPromptOverflow(error)) return;

    const message = error instanceof Error ? error.message : String(error);
    // Parse actual token count from Anthropic error (e.g., "... 2457832 tokens ...")
    const tokenMatch = message.match(/(\d[\d,]+)\s*tokens/);
    const reportedTokens = tokenMatch ? parseInt(tokenMatch[1].replace(/,/g, ''), 10) : undefined;

    logger.error(
      {
        source,
        error: message,
        reported_tokens: reportedTokens,
        payload,
      },
      'Addie: Prompt overflow diagnostics'
    );
  }

  /**
   * Invalidate the cached system prompt (forces re-read of rule files)
   */
  invalidateCache(): void {
    invalidateRulesCache();
  }

  /**
   * Register a tool
   */
  registerTool(tool: AddieTool, handler: ToolHandler): void {
    this.tools.push(tool);
    this.toolHandlers.set(tool.name, handler);
  }

  /**
   * Process a message and return a response
   * Uses database-backed rules for the system prompt when available
   *
   * @param userMessage - The user's message
   * @param threadContext - Optional thread history
   * @param requestTools - Optional per-request tools (e.g., user-scoped member tools)
   * @param rulesOverride - Optional rules override for eval framework (bypasses DB lookup)
   * @param options - Optional processing options (e.g., maxIterations for admin users)
   */
  async processMessage(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>,
    requestTools?: RequestTools,
    rulesOverride?: RulesOverride,
    options?: ProcessMessageOptions
  ): Promise<AddieResponse> {
    // #2950: warn when a caller has neither `costScope` nor explicit
    // `uncapped: true`. Silent default meant a future user-facing
    // caller could ship uncapped and nobody would notice — this log
    // turns that into an observability signal. A hard throw would
    // break legitimate callers we haven't migrated yet; loud-log
    // lets audit rules alert on the event.
    if (!options?.costScope && !options?.uncapped) {
      logger.warn(
        { event: 'cost_cap_unwired', method: 'processMessage' },
        'claude-client called without costScope or uncapped:true — cost cap silently bypassed',
      );
    }

    // #2790: per-user Anthropic cost cap. Check at entry; when the
    // user has exhausted their daily budget, return a friendly
    // "try again later" response instead of firing another
    // (billable) Claude call. The caller's ProcessMessageOptions
    // carries both `userId` and `tier` so we don't have to resolve
    // the subscription tier here.
    if (options?.costScope) {
      const capResult = await checkCostCap(
        options.costScope.userId,
        options.costScope.tier,
      );
      if (!capResult.ok) {
        const message = formatCapExceededMessage(capResult);
        logger.warn(
          {
            userId: options.costScope.userId,
            tier: options.costScope.tier,
            spentCents: capResult.spentCents,
            retryAfterMs: capResult.retryAfterMs,
          },
          'Addie cost cap exceeded — refusing Claude call',
        );
        return {
          text: message,
          tools_used: [],
          tool_executions: [],
          flagged: true,
          flag_reason: 'cost_cap_exceeded',
        };
      }
    }

    const toolsUsed: string[] = [];
    const toolExecutions: ToolExecution[] = [];
    let executionSequence = 0;

    // Timing metrics
    const timingStart = Date.now();
    let systemPromptMs = 0;
    let totalLlmMs = 0;
    let totalToolExecutionMs = 0;

    // Token usage tracking (aggregated across iterations)
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;

    // Get system prompt - use override if provided, otherwise from rule files
    const promptStart = Date.now();
    let systemPrompt: string;

    if (rulesOverride) {
      systemPrompt = rulesOverride.systemPrompt;
      logger.debug('Addie: Using rules override');
    } else {
      const promptResult = this.getSystemPrompt();
      systemPrompt = promptResult.prompt;
    }
    systemPromptMs = Date.now() - promptStart;

    // Build system content as array: base prompt is cached, requestContext is not.
    // Separating them lets Anthropic cache the stable base while the dynamic
    // per-user context (member profile, channel, goals) is sent fresh each call.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    if (options?.requestContext?.trim()) {
      systemBlocks.push({ type: 'text', text: options.requestContext });
    }

    // Get config version ID for this interaction (skip for eval mode)
    const configVersionId = rulesOverride ? undefined : await getCurrentConfigVersionId();

    const maxIterations = options?.maxIterations ?? 10;
    const effectiveModel = options?.modelOverride ?? this.model;

    // Log if using precision model
    if (options?.modelOverride && options.modelOverride !== this.model) {
      logger.info({ model: effectiveModel, defaultModel: this.model }, 'Addie: Using precision model for billing/financial query');
    }

    // Combine global tools with per-request tools, deduplicating by name (last wins)
    // Calculate tool count first to inform token budget for conversation history
    const allToolsRaw = [...this.tools, ...(requestTools?.tools || [])];
    const allTools = [...new Map(allToolsRaw.map(t => [t.name, t])).values()];
    const allHandlers = new Map([...this.toolHandlers, ...(requestTools?.handlers || [])]);
    const toolCount = allTools.length + (this.webSearchEnabled ? 1 : 0);

    // Build proper message turns from thread context
    // This sends conversation history as actual user/assistant turns, not flattened text
    // Token-aware: automatically trims older messages if conversation exceeds limits
    // Compact old tool results in all conversations to reclaim context
    const messageTurnsResult = buildMessageTurnsWithMetadata(userMessage, threadContext, {
      model: effectiveModel,
      toolCount,
      maxMessages: options?.maxMessages,
      compactToolResults: true,
      currentSpeakerName: options?.currentSpeakerName,
    });

    if (messageTurnsResult.wasTrimmed) {
      logger.info(
        {
          messagesRemoved: messageTurnsResult.messagesRemoved,
          estimatedTokens: formatTokenCount(messageTurnsResult.estimatedTokens),
          tokenLimit: formatTokenCount(getConversationTokenLimit(effectiveModel, toolCount)),
          toolCount,
        },
        'Addie: Trimmed conversation history to fit context limit'
      );
      // Inject dropped conversation summary so Addie has context from earlier turns
      if (messageTurnsResult.messagesRemoved > 10) {
        const summary = messageTurnsResult.droppedMessages
          ? buildDroppedMessagesSummary(messageTurnsResult.droppedMessages)
          : null;
        const contextWarning = summary
          || `\n\n## Context Warning\n${messageTurnsResult.messagesRemoved} earlier messages were dropped from this conversation to fit the context window. If the user references something you don't recall, let them know and suggest starting a new thread for better accuracy.`;
        systemBlocks.push({ type: 'text', text: contextWarning });
      }
    }

    const messages: Anthropic.MessageParam[] = toAnthropicMessages(messageTurnsResult.messages);

    // Build tool list once — rebuilt every iteration is wasteful since tools don't change.
    // Mark the last custom tool with cache_control so Anthropic caches all tool definitions.
    const customTools: Anthropic.Tool[] = allTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
    }));
    if (customTools.length > 0) {
      customTools[customTools.length - 1] = {
        ...customTools[customTools.length - 1],
        cache_control: { type: 'ephemeral' },
      };
    }
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Use beta API to access web search
      const llmStart = Date.now();
      let response;
      try {
        response = await withRetry(
          () => this.client.beta.messages.create({
            model: effectiveModel,
            max_tokens: 4096,
            system: systemBlocks,
            tools: [
              ...customTools,
              // Add web search tool via beta API
              ...(this.webSearchEnabled ? [{
                type: 'web_search_20250305' as const,
                name: 'web_search' as const,
              }] : []),
            ],
            messages,
            betas: ['web-search-2025-03-05', ...getModelBetas(effectiveModel)],
          }),
          { maxRetries: 3, initialDelayMs: 1000 },
          'processMessage'
        );
      } catch (error) {
        const stats = this.buildPayloadDebugStats(effectiveModel, systemBlocks, customTools, messages, iteration, this.webSearchEnabled ? 1 : 0);
        this.logPromptOverflow(error, stats, 'processMessage');
        throw error;
      }

      const llmDuration = Date.now() - llmStart;
      totalLlmMs += llmDuration;

      // Track token usage from this iteration
      if (response.usage) {
        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
        // Cache tokens are optional and may not be present
        if ('cache_creation_input_tokens' in response.usage) {
          totalCacheCreationTokens += (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens || 0;
        }
        if ('cache_read_input_tokens' in response.usage) {
          totalCacheReadTokens += (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens || 0;
        }
      }

      logger.debug({
        stopReason: response.stop_reason,
        contentTypes: response.content.map(c => c.type),
        iteration,
        llmDurationMs: llmDuration,
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      }, 'Addie: Claude response received');

      // Check for web search results in the response (can appear even with end_turn)
      const earlyWebSearchResults = response.content.filter((c) => c.type === 'web_search_tool_result');
      // Also check for server_tool_use blocks to get the search query
      const earlyServerToolBlocks = response.content.filter((c) => c.type === 'server_tool_use');

      if (earlyWebSearchResults.length > 0) {
        for (const result of earlyWebSearchResults) {
          executionSequence++;
          toolsUsed.push('web_search');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const searchResult = result as any;
          const resultItems = searchResult.content?.filter((c: { type: string }) => c.type === 'web_search_result') || [];
          const resultCount = resultItems.length;
          const resultSummary = `Web search completed (${resultCount} results)`;

          // Try to find the corresponding server_tool_use to get the query
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const correspondingToolUse = earlyServerToolBlocks.find((b: any) => b.id === searchResult.tool_use_id) as any;
          const params: Record<string, unknown> = {};
          if (correspondingToolUse?.input?.query) {
            params.query = correspondingToolUse.input.query;
          } else if (correspondingToolUse?.input) {
            Object.assign(params, correspondingToolUse.input);
          }

          // Build detailed result with top URLs
          let detailedResult = resultSummary;
          if (resultItems.length > 0) {
            const topResults = resultItems.slice(0, 5);
            const urls = topResults.map((r: { url?: string; title?: string }) =>
              r.title ? `${r.title}: ${r.url}` : r.url
            ).join('\n');
            detailedResult = `${resultSummary}\n\nTop results:\n${urls}`;
          }

          toolExecutions.push({
            tool_name: 'web_search',
            parameters: params,
            result: detailedResult,
            result_summary: resultSummary,
            is_error: false,
            duration_ms: 0,
            sequence: executionSequence,
          });

          logger.debug({ resultCount, query: params.query }, 'Addie: Web search completed');
        }
      }

      // Done - no tool use, just text
      if (response.stop_reason === 'end_turn') {
        // Collect ALL text blocks (web search responses have multiple text blocks)
        const textBlocks = response.content.filter((c) => c.type === 'text');
        const rawText = textBlocks
          .map(block => block.type === 'text' ? block.text : '')
          .join('\n\n')
          .trim();
        const text = applyResponsePipeline(userMessage, rawText);

        // Calculate total tool execution time from tool_executions
        totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);

        // Detect possible hallucinated actions (text claims success without successful tool calls)
        const hallucinationReason = detectHallucinatedAction(text, toolExecutions);
        if (hallucinationReason) {
          logger.warn({ toolsUsed, reason: hallucinationReason }, 'Addie: Possible hallucinated action detected');
        }

        const finalUsage = {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          ...(totalCacheCreationTokens > 0 && { cache_creation_input_tokens: totalCacheCreationTokens }),
          ...(totalCacheReadTokens > 0 && { cache_read_input_tokens: totalCacheReadTokens }),
        };
        // Record the call against the user's daily budget (#2790).
        // Runs after the response is built so a successful charge
        // counts even if a downstream flag/logging failure occurs.
        // recordCost no-ops for missing userId / system users.
        if (options?.costScope) {
          await recordCost(
            options.costScope.userId,
            options?.modelOverride ?? AddieModelConfig.chat,
            finalUsage,
          );
        }

        return {
          text,
          tools_used: toolsUsed,
          tool_executions: toolExecutions,
          flagged: !!hallucinationReason,
          flag_reason: hallucinationReason ?? undefined,
          active_rule_ids: undefined,
          config_version_id: configVersionId ?? undefined,
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: iteration,
          },
          usage: finalUsage,
        };
      }

      // Handle tool use (both custom tools and server-managed tools like web_search)
      if (response.stop_reason === 'tool_use') {
        // Get custom tool use blocks (these need our handlers)
        const toolUseBlocks = response.content.filter((c) => c.type === 'tool_use');

        // Get server tool use blocks (web_search - handled by Anthropic)
        const serverToolBlocks = response.content.filter((c) => c.type === 'server_tool_use');

        // Get web search results (already executed by Anthropic)
        const webSearchResults = response.content.filter((c) => c.type === 'web_search_tool_result');

        // Track server-managed tool uses (web search)
        for (const block of serverToolBlocks) {
          if (block.type !== 'server_tool_use') continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const serverBlock = block as any;

          executionSequence++;
          toolsUsed.push(serverBlock.name);

          // Find corresponding result by matching tool_use_id
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const resultBlock = webSearchResults.find((r: any) => r.tool_use_id === serverBlock.id) as any;

          // Extract search results count and build summary
          let resultCount = 0;
          let resultSummary = 'Web search completed';
          if (resultBlock?.content && Array.isArray(resultBlock.content)) {
            // web_search_tool_result has content array with search results
            resultCount = resultBlock.content.filter((c: { type: string }) => c.type === 'web_search_result').length;
            resultSummary = `Web search completed (${resultCount} results)`;
          }

          // Build detailed parameters including the search query if available
          const params: Record<string, unknown> = {};
          if (serverBlock.input?.query) {
            params.query = serverBlock.input.query;
          } else if (serverBlock.input) {
            Object.assign(params, serverBlock.input);
          }

          // Build detailed result with URLs found
          let detailedResult = resultSummary;
          if (resultBlock?.content && Array.isArray(resultBlock.content)) {
            const searchResults = resultBlock.content
              .filter((c: { type: string }) => c.type === 'web_search_result')
              .slice(0, 5); // First 5 results
            if (searchResults.length > 0) {
              const urls = searchResults.map((r: { url?: string; title?: string }) =>
                r.title ? `${r.title}: ${r.url}` : r.url
              ).join('\n');
              detailedResult = `${resultSummary}\n\nTop results:\n${urls}`;
            }
          }

          toolExecutions.push({
            tool_name: serverBlock.name,
            parameters: params,
            result: detailedResult,
            result_summary: resultSummary,
            is_error: false,
            duration_ms: 0, // Server-managed, we don't have timing
            sequence: executionSequence,
          });

          logger.debug({
            toolName: serverBlock.name,
            input: serverBlock.input,
            resultCount
          }, 'Addie: Server tool executed (web_search)');
        }

        // If only server tools were used (no custom tools), continue the loop
        // The web search results are already in the response, we just need to continue
        if (toolUseBlocks.length === 0 && serverToolBlocks.length > 0) {
          // Add the response content (including web search results) to messages
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages.push({ role: 'assistant', content: response.content as any });
          continue;
        }

        if (toolUseBlocks.length === 0 && serverToolBlocks.length === 0) {
          const textContent = response.content.find((c) => c.type === 'text');
          const rawText = textContent && textContent.type === 'text' ? textContent.text : "I'm not sure how to help with that.";
          const text = applyResponsePipeline(userMessage, rawText);
          totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
          return {
            text,
            tools_used: toolsUsed,
            tool_executions: toolExecutions,
            flagged: false,
            active_rule_ids: undefined,
            config_version_id: configVersionId ?? undefined,
            timing: {
              system_prompt_ms: systemPromptMs,
              total_llm_ms: totalLlmMs,
              total_tool_execution_ms: totalToolExecutionMs,
              iterations: iteration,
            },
            usage: {
              input_tokens: totalInputTokens,
              output_tokens: totalOutputTokens,
              ...(totalCacheCreationTokens > 0 && { cache_creation_input_tokens: totalCacheCreationTokens }),
              ...(totalCacheReadTokens > 0 && { cache_read_input_tokens: totalCacheReadTokens }),
            },
          };
        }

        // Tool results can contain multimodal content (images, PDFs)
        type ToolResultContent = string | Anthropic.ToolResultBlockParam['content'];
        interface ToolResult {
          tool_use_id: string;
          content: ToolResultContent;
          is_error?: boolean;
        }

        const toolResults: ToolResult[] = [];

        for (const block of toolUseBlocks) {
          if (block.type !== 'tool_use') continue;

          const toolName = block.name;
          const toolInput = block.input as Record<string, unknown>;
          const toolUseId = block.id;
          const startTime = Date.now();

          logger.debug({ toolName, toolInput }, 'Addie: Calling tool');
          toolsUsed.push(toolName);
          executionSequence++;

          const handler = allHandlers.get(toolName);
          if (!handler) {
            const durationMs = Date.now() - startTime;
            toolResults.push({
              tool_use_id: toolUseId,
              content: `Error: Unknown tool "${toolName}"`,
              is_error: true,
            });
            toolExecutions.push({
              tool_name: toolName,
              parameters: toolInput,
              result: `Error: Unknown tool "${toolName}"`,
              is_error: true,
              duration_ms: durationMs,
              sequence: executionSequence,
            });
            continue;
          }

          try {
            const result = await handler(toolInput);
            const durationMs = Date.now() - startTime;

            // Check if result contains multimodal content (images, PDFs)
            if (isMultimodalContent(result)) {
              const multimodal = extractMultimodalContent(result);
              const multimodalBlocks = multimodal ? buildMultimodalContentBlocks(multimodal) : null;

              if (multimodalBlocks) {
                toolResults.push({ tool_use_id: toolUseId, content: multimodalBlocks.content });
                toolExecutions.push({
                  tool_name: toolName,
                  parameters: toolInput,
                  result: multimodalBlocks.summary,
                  result_summary: multimodalBlocks.summary,
                  is_error: false,
                  duration_ms: durationMs,
                  sequence: executionSequence,
                });
                logger.info({ toolName, multimodalType: multimodal?.type, filename: multimodal?.filename }, 'Addie: Processed multimodal tool result');
              } else {
                // Failed to parse or validate multimodal content
                toolResults.push({ tool_use_id: toolUseId, content: 'Error: Failed to process file content' });
                toolExecutions.push({
                  tool_name: toolName,
                  parameters: toolInput,
                  result: 'Error: Failed to process file content',
                  is_error: true,
                  duration_ms: durationMs,
                  sequence: executionSequence,
                });
              }
            } else {
              // Regular text result — always a success since tools throw on failure
              toolResults.push({ tool_use_id: toolUseId, content: result });
              toolExecutions.push({
                tool_name: toolName,
                parameters: toolInput,
                result,
                result_summary: this.summarizeToolResult(toolName, result),
                is_error: false,
                duration_ms: durationMs,
                sequence: executionSequence,
              });
            }
          } catch (error) {
            const durationMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            const isExpected = error instanceof ToolError;
            const errorResult = `Error: ${errorMessage}`;
            if (isExpected) {
              logger.warn({ toolName, toolInput, error: errorMessage, durationMs }, 'Addie: Tool returned expected error');
            } else {
              logger.error({ toolName, toolInput, error: errorMessage, durationMs }, 'Addie: Tool threw unexpected exception');
              notifyToolError({ toolName, errorMessage, toolInput, slackUserId: options?.slackUserId, userDisplayName: options?.userDisplayName, threadId: options?.threadId, threw: true });
            }
            toolResults.push({
              tool_use_id: toolUseId,
              content: errorResult,
              is_error: true,
            });
            toolExecutions.push({
              tool_name: toolName,
              parameters: toolInput,
              result: errorResult,
              is_error: true,
              duration_ms: durationMs,
              sequence: executionSequence,
            });
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages.push({ role: 'assistant', content: response.content as any });
        messages.push({
          role: 'user',
          content: toolResults.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.tool_use_id,
            content: r.content,
            is_error: r.is_error,
          })),
        });
      }
    }

    logger.warn('Addie: Hit max tool iterations');
    totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
    const maxIterationsUsage = {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      ...(totalCacheCreationTokens > 0 && { cache_creation_input_tokens: totalCacheCreationTokens }),
      ...(totalCacheReadTokens > 0 && { cache_read_input_tokens: totalCacheReadTokens }),
    };
    // Still charge the user for tokens actually consumed on the way
    // to hitting max-iterations — those bytes DID go to Anthropic
    // and DID cost money, regardless of whether the session converged.
    if (options?.costScope) {
      await recordCost(
        options.costScope.userId,
        options?.modelOverride ?? AddieModelConfig.chat,
        maxIterationsUsage,
      );
    }
    return {
      text: "I'm having trouble completing that request. Could you try rephrasing?",
      tools_used: toolsUsed,
      tool_executions: toolExecutions,
      flagged: true,
      flag_reason: 'Max tool iterations reached',
      active_rule_ids: undefined,
      config_version_id: configVersionId ?? undefined,
      timing: {
        system_prompt_ms: systemPromptMs,
        total_llm_ms: totalLlmMs,
        total_tool_execution_ms: totalToolExecutionMs,
        iterations: maxIterations,
      },
      usage: maxIterationsUsage,
    };
  }

  /**
   * Process a message with streaming - yields events as they occur
   *
   * Note: Tool use temporarily pauses text streaming while the tool executes,
   * then resumes with the response. The final 'done' event includes the complete response.
   *
   * @param userMessage - The user's message
   * @param threadContext - Optional thread history
   * @param requestTools - Optional per-request tools (e.g., user-scoped member tools)
   * @param options - Optional processing options (e.g., maxIterations for admin users)
   */
  async *processMessageStream(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>,
    requestTools?: RequestTools,
    options?: ProcessMessageOptions
  ): AsyncGenerator<StreamEvent> {
    // #2950: matching fail-closed warn on the stream path.
    if (!options?.costScope && !options?.uncapped) {
      logger.warn(
        { event: 'cost_cap_unwired', method: 'processMessageStream' },
        'claude-client stream called without costScope or uncapped:true — cost cap silently bypassed',
      );
    }

    // #2790: per-user Anthropic cost cap (streaming path). Same
    // contract as `processMessage` — yield a `done` event with the
    // friendly cap-exceeded text and return early instead of firing
    // another billable Claude call.
    if (options?.costScope) {
      const capResult = await checkCostCap(
        options.costScope.userId,
        options.costScope.tier,
      );
      if (!capResult.ok) {
        const message = formatCapExceededMessage(capResult);
        logger.warn(
          {
            userId: options.costScope.userId,
            tier: options.costScope.tier,
            spentCents: capResult.spentCents,
            retryAfterMs: capResult.retryAfterMs,
          },
          'Addie cost cap exceeded — refusing Claude stream',
        );
        yield {
          type: 'done',
          response: {
            text: message,
            tools_used: [],
            tool_executions: [],
            flagged: true,
            flag_reason: 'cost_cap_exceeded',
          },
        };
        return;
      }
    }

    const toolsUsed: string[] = [];
    const toolExecutions: ToolExecution[] = [];
    let executionSequence = 0;
    let fullText = '';

    // Timing metrics
    const timingStart = Date.now();
    let systemPromptMs = 0;
    let totalLlmMs = 0;
    let totalToolExecutionMs = 0;

    // Token usage tracking (aggregated across iterations)
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;

    // Get system prompt from rule files (or fallback)
    const promptStart = Date.now();
    const { prompt: systemPrompt } = this.getSystemPrompt();
    systemPromptMs = Date.now() - promptStart;

    // Build system content as array: base prompt is cached, requestContext is not.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ];
    if (options?.requestContext?.trim()) {
      systemBlocks.push({ type: 'text', text: options.requestContext });
    }

    // Get config version ID for this interaction (for tracking/analysis)
    const configVersionId = await getCurrentConfigVersionId();

    // Determine effective model (support precision mode override for billing/financial)
    const effectiveModel = options?.modelOverride ?? this.model;
    if (options?.modelOverride && options.modelOverride !== this.model) {
      logger.info({ model: effectiveModel, defaultModel: this.model }, 'Addie Stream: Using precision model for billing/financial query');
    }

    // Combine global tools with per-request tools, deduplicating by name (last wins)
    // Calculate tool count first to inform token budget for conversation history
    const allToolsRaw = [...this.tools, ...(requestTools?.tools || [])];
    const allTools = [...new Map(allToolsRaw.map(t => [t.name, t])).values()];
    const allHandlers = new Map([...this.toolHandlers, ...(requestTools?.handlers || [])]);
    const toolCount = allTools.length; // Note: streaming doesn't use web search

    // Build proper message turns from thread context
    // This sends conversation history as actual user/assistant turns, not flattened text
    // Token-aware: automatically trims older messages if conversation exceeds limits
    // Compact old tool results in all conversations to reclaim context
    const messageTurnsResult = buildMessageTurnsWithMetadata(userMessage, threadContext, {
      model: effectiveModel,
      toolCount,
      maxMessages: options?.maxMessages,
      compactToolResults: true,
      currentSpeakerName: options?.currentSpeakerName,
    });

    if (messageTurnsResult.wasTrimmed) {
      logger.info(
        {
          messagesRemoved: messageTurnsResult.messagesRemoved,
          estimatedTokens: formatTokenCount(messageTurnsResult.estimatedTokens),
          tokenLimit: formatTokenCount(getConversationTokenLimit(effectiveModel, toolCount)),
          toolCount,
        },
        'Addie Stream: Trimmed conversation history to fit context limit'
      );
      // Inject dropped conversation summary so Addie has context from earlier turns
      if (messageTurnsResult.messagesRemoved > 10) {
        const summary = messageTurnsResult.droppedMessages
          ? buildDroppedMessagesSummary(messageTurnsResult.droppedMessages)
          : null;
        const contextWarning = summary
          || `\n\n## Context Warning\n${messageTurnsResult.messagesRemoved} earlier messages were dropped from this conversation to fit the context window. If the user references something you don't recall, let them know and suggest starting a new thread for better accuracy.`;
        systemBlocks.push({ type: 'text', text: contextWarning });
      }
    }

    const messages: Anthropic.MessageParam[] = toAnthropicMessages(messageTurnsResult.messages);

    // Build tool list once — rebuilt every iteration is wasteful since tools don't change.
    // Mark the last tool with cache_control so Anthropic caches all tool definitions.
    const customTools: Anthropic.Tool[] = allTools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
    }));
    if (customTools.length > 0) {
      customTools[customTools.length - 1] = {
        ...customTools[customTools.length - 1],
        cache_control: { type: 'ephemeral' },
      };
    }
    const maxIterations = options?.maxIterations ?? 10;
    let iteration = 0;

    try {
      while (iteration < maxIterations) {
        iteration++;

        const llmStart = Date.now();

        // Collect full response for tool handling
        let currentResponse: Anthropic.Beta.BetaMessage | null = null;
        const textChunks: string[] = [];

        // Retry loop for streaming API calls (handles overloaded_error)
        // Only retries if no content has been yielded yet (safe retry)
        const maxStreamRetries = 3;
        let streamRetryCount = 0;
        let streamSucceeded = false;
        let hasYieldedContent = false;

        while (!streamSucceeded && streamRetryCount <= maxStreamRetries) {
          try {
            // Use streaming API (beta namespace so we can pass `betas`,
            // e.g. 1M-context on supported depth-tier models).
            const modelBetas = getModelBetas(effectiveModel);
            const stream = this.client.beta.messages.stream({
              model: effectiveModel,
              max_tokens: 4096,
              system: systemBlocks,
              tools: customTools,
              messages,
              ...(modelBetas.length > 0 ? { betas: modelBetas } : {}),
            });

            // Process stream events
            for await (const event of stream) {
              if (event.type === 'content_block_delta') {
                const delta = event.delta;
                if ('text' in delta && delta.text) {
                  hasYieldedContent = true;
                  textChunks.push(delta.text);
                  fullText += delta.text;
                  yield { type: 'text', text: delta.text };
                }
              } else if (event.type === 'message_stop') {
                // Get the final message
                currentResponse = await stream.finalMessage();
              }
            }

            if (!currentResponse) {
              currentResponse = await stream.finalMessage();
            }

            streamSucceeded = true;
          } catch (streamError) {
            streamRetryCount++;
            const stats = this.buildPayloadDebugStats(effectiveModel, systemBlocks, customTools, messages, iteration);
            this.logPromptOverflow(streamError, stats, 'processMessageStream');

            // Only retry if we haven't started streaming content to the user
            // Once content is yielded, retry could cause duplicate/inconsistent output
            const canRetry = !hasYieldedContent &&
                             isRetryableError(streamError) &&
                             streamRetryCount <= maxStreamRetries;

            if (!canRetry) {
              // Check if this is exhausted retries on a retryable error (not yielded content)
              // If so, wrap in RetriesExhaustedError for consistent error handling
              const isExhausted = !hasYieldedContent &&
                                  isRetryableError(streamError) &&
                                  streamRetryCount > maxStreamRetries;
              if (isExhausted) {
                throw new RetriesExhaustedError(streamError, streamRetryCount);
              }
              // Not retryable or already yielded content - rethrow original error
              throw streamError;
            }

            // Calculate delay with exponential backoff
            const delayMs = Math.min(1000 * Math.pow(2, streamRetryCount - 1), 30000);
            const jitter = delayMs * 0.25 * (Math.random() * 2 - 1);
            const totalDelay = Math.round(delayMs + jitter);

            // Determine user-friendly reason
            const errorMsg = streamError instanceof Error ? streamError.message : String(streamError);
            const reason = errorMsg.includes('overloaded') ? 'API is busy' :
                          errorMsg.includes('rate') ? 'Rate limited' :
                          errorMsg.includes('timeout') ? 'Request timed out' :
                          'Temporary issue';

            logger.warn(
              {
                attempt: streamRetryCount,
                maxRetries: maxStreamRetries,
                delayMs: totalDelay,
                error: errorMsg,
              },
              'Addie Stream: Retryable error, waiting before retry'
            );

            // Emit retry event so UI can show status
            yield {
              type: 'retry',
              attempt: streamRetryCount,
              maxRetries: maxStreamRetries,
              delayMs: totalDelay,
              reason,
            };

            await new Promise(resolve => setTimeout(resolve, totalDelay));

            // Reset for retry (safe since no content yielded yet)
            textChunks.length = 0;
            currentResponse = null;
          }
        }

        const llmDuration = Date.now() - llmStart;
        totalLlmMs += llmDuration;

        if (!currentResponse) {
          throw new Error('Stream completed without response');
        }

        // Track token usage
        if (currentResponse.usage) {
          totalInputTokens += currentResponse.usage.input_tokens;
          totalOutputTokens += currentResponse.usage.output_tokens;
          if ('cache_creation_input_tokens' in currentResponse.usage) {
            totalCacheCreationTokens += (currentResponse.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens || 0;
          }
          if ('cache_read_input_tokens' in currentResponse.usage) {
            totalCacheReadTokens += (currentResponse.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens || 0;
          }
        }

        logger.debug({
          stopReason: currentResponse.stop_reason,
          iteration,
          llmDurationMs: llmDuration,
          inputTokens: currentResponse.usage?.input_tokens,
          outputTokens: currentResponse.usage?.output_tokens,
        }, 'Addie Stream: Claude response received');

        // Build the final usage block + charge the user's cost
        // budget (#2790). Both stream terminal paths (end_turn and
        // no-tool-blocks) share this; kept inline as a local const
        // rather than hoisted to instance scope because it closes
        // over the accumulators in this method.
        const buildStreamUsage = () => ({
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          ...(totalCacheCreationTokens > 0 && { cache_creation_input_tokens: totalCacheCreationTokens }),
          ...(totalCacheReadTokens > 0 && { cache_read_input_tokens: totalCacheReadTokens }),
        });
        const chargeStreamCost = async (usage: ReturnType<typeof buildStreamUsage>) => {
          if (options?.costScope) {
            await recordCost(
              options.costScope.userId,
              options?.modelOverride ?? AddieModelConfig.chat,
              usage,
            );
          }
        };

        // Done - no tool use
        if (currentResponse.stop_reason === 'end_turn') {
          totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);

          // Detect possible hallucinated actions (text claims success without successful tool calls)
          const hallucinationReason = detectHallucinatedAction(fullText, toolExecutions);
          if (hallucinationReason) {
            logger.warn({ toolsUsed, reason: hallucinationReason }, 'Addie Stream: Possible hallucinated action detected');
          }

          const streamUsage = buildStreamUsage();
          await chargeStreamCost(streamUsage);
          yield {
            type: 'done',
            response: {
              text: applyResponsePipeline(userMessage, fullText),
              tools_used: toolsUsed,
              tool_executions: toolExecutions,
              flagged: !!hallucinationReason,
              flag_reason: hallucinationReason ?? undefined,
              active_rule_ids: undefined,
              config_version_id: configVersionId ?? undefined,
              timing: {
                system_prompt_ms: systemPromptMs,
                total_llm_ms: totalLlmMs,
                total_tool_execution_ms: totalToolExecutionMs,
                iterations: iteration,
              },
              usage: streamUsage,
            },
          };
          return;
        }

        // Handle tool use
        if (currentResponse.stop_reason === 'tool_use') {
          const toolUseBlocks = currentResponse.content.filter((c: Anthropic.Beta.BetaContentBlock) => c.type === 'tool_use');

          if (toolUseBlocks.length === 0) {
            // No tools to execute, return current text
            totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
            const streamUsage = buildStreamUsage();
            await chargeStreamCost(streamUsage);
            yield {
              type: 'done',
              response: {
                text: applyResponsePipeline(userMessage, fullText),
                tools_used: toolsUsed,
                tool_executions: toolExecutions,
                flagged: false,
                active_rule_ids: undefined,
                config_version_id: configVersionId ?? undefined,
                timing: {
                  system_prompt_ms: systemPromptMs,
                  total_llm_ms: totalLlmMs,
                  total_tool_execution_ms: totalToolExecutionMs,
                  iterations: iteration,
                },
                usage: streamUsage,
              },
            };
            return;
          }

          // Tool results can contain multimodal content (images, PDFs)
          type StreamToolResultContent = string | Anthropic.ToolResultBlockParam['content'];
          interface ToolResult {
            tool_use_id: string;
            content: StreamToolResultContent;
            is_error?: boolean;
          }

          const toolResults: ToolResult[] = [];

          for (const block of toolUseBlocks) {
            if (block.type !== 'tool_use') continue;

            const toolName = block.name;
            const toolInput = block.input as Record<string, unknown>;
            const toolUseId = block.id;
            const startTime = Date.now();

            logger.debug({ toolName, toolInput }, 'Addie Stream: Calling tool');
            toolsUsed.push(toolName);
            executionSequence++;

            // Emit tool start event
            yield { type: 'tool_start', tool_name: toolName, parameters: toolInput };

            const handler = allHandlers.get(toolName);
            if (!handler) {
              const durationMs = Date.now() - startTime;
              const errorResult = `Error: Unknown tool "${toolName}"`;
              toolResults.push({
                tool_use_id: toolUseId,
                content: errorResult,
                is_error: true,
              });
              toolExecutions.push({
                tool_name: toolName,
                parameters: toolInput,
                result: errorResult,
                is_error: true,
                duration_ms: durationMs,
                sequence: executionSequence,
              });
              yield { type: 'tool_end', tool_name: toolName, result: errorResult, is_error: true };
              continue;
            }

            try {
              const result = await handler(toolInput);
              const durationMs = Date.now() - startTime;

              // Check if result contains multimodal content (images, PDFs)
              if (isMultimodalContent(result)) {
                const multimodal = extractMultimodalContent(result);
                const multimodalBlocks = multimodal ? buildMultimodalContentBlocks(multimodal) : null;

                if (multimodalBlocks) {
                  toolResults.push({ tool_use_id: toolUseId, content: multimodalBlocks.content });
                  toolExecutions.push({
                    tool_name: toolName,
                    parameters: toolInput,
                    result: multimodalBlocks.summary,
                    result_summary: multimodalBlocks.summary,
                    is_error: false,
                    duration_ms: durationMs,
                    sequence: executionSequence,
                  });
                  yield { type: 'tool_end', tool_name: toolName, result: multimodalBlocks.summary, is_error: false };
                  logger.info({ toolName, multimodalType: multimodal?.type, filename: multimodal?.filename }, 'Addie Stream: Processed multimodal tool result');
                } else {
                  toolResults.push({ tool_use_id: toolUseId, content: 'Error: Failed to process file content' });
                  toolExecutions.push({
                    tool_name: toolName,
                    parameters: toolInput,
                    result: 'Error: Failed to process file content',
                    is_error: true,
                    duration_ms: durationMs,
                    sequence: executionSequence,
                  });
                  yield { type: 'tool_end', tool_name: toolName, result: 'Error: Failed to process file content', is_error: true };
                }
              } else {
                // Regular text result — always a success since tools throw on failure
                toolResults.push({ tool_use_id: toolUseId, content: result });
                toolExecutions.push({
                  tool_name: toolName,
                  parameters: toolInput,
                  result,
                  result_summary: this.summarizeToolResult(toolName, result),
                  is_error: false,
                  duration_ms: durationMs,
                  sequence: executionSequence,
                });
                yield { type: 'tool_end', tool_name: toolName, result, is_error: false };
              }
            } catch (error) {
              const durationMs = Date.now() - startTime;
              const errorMessage = error instanceof Error ? error.message : 'Unknown error';
              const isExpected = error instanceof ToolError;
              const errorResult = `Error: ${errorMessage}`;
              if (isExpected) {
                logger.warn({ toolName, toolInput, error: errorMessage, durationMs }, 'Addie Stream: Tool returned expected error');
              } else {
                logger.error({ toolName, toolInput, error: errorMessage, durationMs }, 'Addie Stream: Tool threw unexpected exception');
                notifyToolError({ toolName, errorMessage, toolInput, slackUserId: options?.slackUserId, userDisplayName: options?.userDisplayName, threadId: options?.threadId, threw: true });
              }
              toolResults.push({
                tool_use_id: toolUseId,
                content: errorResult,
                is_error: true,
              });
              toolExecutions.push({
                tool_name: toolName,
                parameters: toolInput,
                result: errorResult,
                is_error: true,
                duration_ms: durationMs,
                sequence: executionSequence,
              });
              yield { type: 'tool_end', tool_name: toolName, result: errorResult, is_error: true };
            }
          }

          // Continue the conversation with tool results
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages.push({ role: 'assistant', content: currentResponse.content as any });
          messages.push({
            role: 'user',
            content: toolResults.map((r) => ({
              type: 'tool_result' as const,
              tool_use_id: r.tool_use_id,
              content: r.content,
              is_error: r.is_error,
            })),
          });

          // Add spacing between tool use and subsequent text to prevent run-on text
          if (fullText.length > 0 && !fullText.endsWith('\n')) {
            fullText += '\n\n';
            yield { type: 'text', text: '\n\n' };
          }
        }
      }

      // Max iterations reached
      logger.warn('Addie Stream: Hit max tool iterations');
      totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
      const maxIterUsage = {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        ...(totalCacheCreationTokens > 0 && { cache_creation_input_tokens: totalCacheCreationTokens }),
        ...(totalCacheReadTokens > 0 && { cache_read_input_tokens: totalCacheReadTokens }),
      };
      // Charge the tokens consumed up to the max-iteration wall —
      // the API calls happened regardless of whether we converged.
      if (options?.costScope) {
        await recordCost(
          options.costScope.userId,
          options?.modelOverride ?? AddieModelConfig.chat,
          maxIterUsage,
        );
      }
      yield {
        type: 'done',
        response: {
          text: fullText || "I'm having trouble completing that request. Could you try rephrasing?",
          tools_used: toolsUsed,
          tool_executions: toolExecutions,
          flagged: true,
          flag_reason: 'Max tool iterations reached',
          active_rule_ids: undefined,
          config_version_id: configVersionId ?? undefined,
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: maxIterations,
          },
          usage: maxIterUsage,
        },
      };
    } catch (error) {
      logger.error({ error }, 'Addie Stream: Error during streaming');
      yield { type: 'error', error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Create a human-readable summary of tool results
   */
  private summarizeToolResult(toolName: string, result: string): string {
    if (toolName === 'search_docs') {
      // Parse "Found N documentation pages" from result
      const match = result.match(/Found (\d+) documentation pages/);
      if (match) {
        return `Found ${match[1]} doc page(s)`;
      }
      if (result.includes('No documentation found')) {
        return 'No docs found';
      }
    }

    if (toolName === 'search_slack') {
      // Parse "Found N Slack messages" from result
      const match = result.match(/Found (\d+) Slack messages/);
      if (match) {
        return `Found ${match[1]} Slack message(s)`;
      }
      if (result.includes('No Slack discussions found')) {
        return 'No Slack results';
      }
    }

    if (toolName === 'web_search') {
      // Web search results are already summarized in the tracking code
      return result;
    }

    // Default: truncate long results
    if (result.length > 100) {
      return result.substring(0, 97) + '...';
    }
    return result;
  }

  /**
   * Get list of registered tools
   */
  getRegisteredTools(): string[] {
    return this.tools.map((t) => t.name);
  }
}
