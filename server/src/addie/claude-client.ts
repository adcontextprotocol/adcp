/**
 * Claude client for Addie - handles LLM interactions with tool use
 *
 * System prompt is built from database-backed rules, allowing non-engineers
 * to edit Addie's behavior without code changes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import type { AddieTool } from './types.js';
import { ADDIE_SYSTEM_PROMPT, buildMessageTurnsWithMetadata } from './prompts.js';
import { AddieDatabase, type AddieRule } from '../db/addie-db.js';
import { AddieModelConfig, ModelConfig } from '../config/models.js';
import { getCurrentConfigVersionId, type RuleSnapshot } from './config-version.js';
import { isMultimodalContent, extractMultimodalContent, isAllowedImageType, type FileReadResult } from './mcp/url-tools.js';
import { withRetry, isRetryableError, RetriesExhaustedError, type RetryConfig } from '../utils/anthropic-retry.js';
import { formatTokenCount, getConversationTokenLimit } from '../utils/token-limiter.js';

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

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

/** Default max tool iterations for regular users */
export const DEFAULT_MAX_ITERATIONS = 10;

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
  isAdmin: boolean;
}

/**
 * Options for message processing
 */
export interface ProcessMessageOptions {
  /** Maximum tool iterations (default: DEFAULT_MAX_ITERATIONS) */
  maxIterations?: number;
  /** Override the default model for this request (e.g., for billing queries requiring precision) */
  modelOverride?: string;
}

/**
 * Override for rules - used by eval framework to test proposed rules
 */
export interface RulesOverride {
  ruleIds: number[];
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

export class AddieClaudeClient {
  private client: Anthropic;
  private model: string;
  private tools: AddieTool[] = [];
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private addieDb: AddieDatabase;
  private cachedSystemPrompt: string | null = null;
  private cachedRuleIds: number[] = [];
  private cachedRulesSnapshot: RuleSnapshot[] = [];
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 300000; // Cache rules for 5 minutes (rules change rarely)
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
   * Convert AddieRule to RuleSnapshot for config versioning
   */
  private ruleToSnapshot(rule: AddieRule): RuleSnapshot {
    return {
      id: rule.id,
      rule_type: rule.rule_type,
      name: rule.name,
      content: rule.content,
      priority: rule.priority,
    };
  }

  /**
   * Get the system prompt, either from database rules or fallback to hardcoded
   * Caches the prompt for CACHE_TTL_MS to avoid database hits on every message
   */
  private async getSystemPrompt(): Promise<{ prompt: string; ruleIds: number[]; rulesSnapshot: RuleSnapshot[] }> {
    const now = Date.now();

    // Return cached prompt if still valid
    if (this.cachedSystemPrompt && now < this.cacheExpiry) {
      return {
        prompt: this.cachedSystemPrompt,
        ruleIds: this.cachedRuleIds,
        rulesSnapshot: this.cachedRulesSnapshot,
      };
    }

    try {
      const rules = await this.addieDb.getActiveRules();

      // If we have rules from the database, build prompt from them
      if (rules.length > 0) {
        const prompt = await this.addieDb.buildSystemPrompt();
        const ruleIds = rules.map(r => r.id);
        const rulesSnapshot = rules.map(r => this.ruleToSnapshot(r));

        this.cachedSystemPrompt = prompt;
        this.cachedRuleIds = ruleIds;
        this.cachedRulesSnapshot = rulesSnapshot;
        this.cacheExpiry = now + this.CACHE_TTL_MS;

        logger.debug({ ruleCount: rules.length }, 'Addie: Built system prompt from database rules');
        return { prompt, ruleIds, rulesSnapshot };
      }
    } catch (error) {
      logger.warn({ error }, 'Addie: Failed to load rules from database, using fallback prompt');
    }

    // Fallback to hardcoded prompt if database unavailable or empty
    return { prompt: ADDIE_SYSTEM_PROMPT, ruleIds: [], rulesSnapshot: [] };
  }

  /**
   * Invalidate the cached system prompt (call after rule changes)
   */
  invalidateCache(): void {
    this.cachedSystemPrompt = null;
    this.cachedRuleIds = [];
    this.cachedRulesSnapshot = [];
    this.cacheExpiry = 0;
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

    // Get system prompt - use override if provided (for eval), otherwise from database
    const promptStart = Date.now();
    let systemPrompt: string;
    let ruleIds: number[];
    let rulesSnapshot: RuleSnapshot[];

    if (rulesOverride) {
      // Eval mode: use provided rules
      systemPrompt = rulesOverride.systemPrompt;
      ruleIds = rulesOverride.ruleIds;
      rulesSnapshot = []; // Not needed for eval - we don't track config version
      logger.debug({ ruleIds }, 'Addie: Using rules override for eval');
    } else {
      // Normal mode: get from database
      const promptResult = await this.getSystemPrompt();
      systemPrompt = promptResult.prompt;
      ruleIds = promptResult.ruleIds;
      rulesSnapshot = promptResult.rulesSnapshot;
    }
    systemPromptMs = Date.now() - promptStart;

    // Get config version ID for this interaction (skip for eval mode)
    const configVersionId = rulesOverride ? undefined : await getCurrentConfigVersionId(ruleIds, rulesSnapshot);

    const maxIterations = options?.maxIterations ?? 10;
    const effectiveModel = options?.modelOverride ?? this.model;

    // Log if using precision model
    if (options?.modelOverride && options.modelOverride !== this.model) {
      logger.info({ model: effectiveModel, defaultModel: this.model }, 'Addie: Using precision model for billing/financial query');
    }

    // Combine global tools with per-request tools
    // Calculate tool count first to inform token budget for conversation history
    const allTools = [...this.tools, ...(requestTools?.tools || [])];
    const allHandlers = new Map([...this.toolHandlers, ...(requestTools?.handlers || [])]);
    const toolCount = allTools.length + (this.webSearchEnabled ? 1 : 0);

    // Build proper message turns from thread context
    // This sends conversation history as actual user/assistant turns, not flattened text
    // Token-aware: automatically trims older messages if conversation exceeds limits
    // Pass tool count for more accurate token budget calculation
    const messageTurnsResult = buildMessageTurnsWithMetadata(userMessage, threadContext, {
      model: effectiveModel,
      toolCount,
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
    }

    const messages: Anthropic.MessageParam[] = messageTurnsResult.messages.map(turn => ({
      role: turn.role,
      content: turn.content,
    }));
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Build tools array: custom tools + request tools + optional web search
      const customTools = allTools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool['input_schema'],
      }));

      // Use beta API to access web search
      const llmStart = Date.now();
      const response = await withRetry(
        () => this.client.beta.messages.create({
          model: effectiveModel,
          max_tokens: 4096,
          system: systemPrompt,
          tools: [
            ...customTools,
            // Add web search tool via beta API
            ...(this.webSearchEnabled ? [{
              type: 'web_search_20250305' as const,
              name: 'web_search' as const,
            }] : []),
          ],
          messages,
          // Required for beta API
          betas: ['web-search-2025-03-05'],
        }),
        { maxRetries: 3, initialDelayMs: 1000 },
        'processMessage'
      );

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
        const text = textBlocks
          .map(block => block.type === 'text' ? block.text : '')
          .join('\n\n')
          .trim();

        // Calculate total tool execution time from tool_executions
        totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);

        return {
          text,
          tools_used: toolsUsed,
          tool_executions: toolExecutions,
          flagged: false,
          active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
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
          const text = textContent && textContent.type === 'text' ? textContent.text : "I'm not sure how to help with that.";
          totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
          return {
            text,
            tools_used: toolsUsed,
            tool_executions: toolExecutions,
            flagged: false,
            active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
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
              // Regular text result
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
            toolResults.push({
              tool_use_id: toolUseId,
              content: `Error: ${errorMessage}`,
              is_error: true,
            });
            toolExecutions.push({
              tool_name: toolName,
              parameters: toolInput,
              result: `Error: ${errorMessage}`,
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
    return {
      text: "I'm having trouble completing that request. Could you try rephrasing?",
      tools_used: toolsUsed,
      tool_executions: toolExecutions,
      flagged: true,
      flag_reason: 'Max tool iterations reached',
      active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
      config_version_id: configVersionId ?? undefined,
      timing: {
        system_prompt_ms: systemPromptMs,
        total_llm_ms: totalLlmMs,
        total_tool_execution_ms: totalToolExecutionMs,
        iterations: maxIterations,
      },
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        ...(totalCacheCreationTokens > 0 && { cache_creation_input_tokens: totalCacheCreationTokens }),
        ...(totalCacheReadTokens > 0 && { cache_read_input_tokens: totalCacheReadTokens }),
      },
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

    // Get system prompt from database rules (or fallback)
    const promptStart = Date.now();
    const { prompt: systemPrompt, ruleIds, rulesSnapshot } = await this.getSystemPrompt();
    systemPromptMs = Date.now() - promptStart;

    // Get config version ID for this interaction (for tracking/analysis)
    const configVersionId = await getCurrentConfigVersionId(ruleIds, rulesSnapshot);

    // Combine global tools with per-request tools
    // Calculate tool count first to inform token budget for conversation history
    const allTools = [...this.tools, ...(requestTools?.tools || [])];
    const allHandlers = new Map([...this.toolHandlers, ...(requestTools?.handlers || [])]);
    const toolCount = allTools.length; // Note: streaming doesn't use web search

    // Build proper message turns from thread context
    // This sends conversation history as actual user/assistant turns, not flattened text
    // Token-aware: automatically trims older messages if conversation exceeds limits
    // Pass tool count for more accurate token budget calculation
    const messageTurnsResult = buildMessageTurnsWithMetadata(userMessage, threadContext, {
      model: this.model,
      toolCount,
    });

    if (messageTurnsResult.wasTrimmed) {
      logger.info(
        {
          messagesRemoved: messageTurnsResult.messagesRemoved,
          estimatedTokens: formatTokenCount(messageTurnsResult.estimatedTokens),
          tokenLimit: formatTokenCount(getConversationTokenLimit(this.model, toolCount)),
          toolCount,
        },
        'Addie Stream: Trimmed conversation history to fit context limit'
      );
    }

    const messages: Anthropic.MessageParam[] = messageTurnsResult.messages.map(turn => ({
      role: turn.role,
      content: turn.content,
    }));

    const maxIterations = options?.maxIterations ?? 10;
    let iteration = 0;

    try {
      while (iteration < maxIterations) {
        iteration++;

        // Build tools array: custom tools + request tools + optional web search
        const customTools = allTools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        }));

        const llmStart = Date.now();

        // Collect full response for tool handling
        let currentResponse: Anthropic.Message | null = null;
        const textChunks: string[] = [];

        // Retry loop for streaming API calls (handles overloaded_error)
        // Only retries if no content has been yielded yet (safe retry)
        const maxStreamRetries = 3;
        let streamRetryCount = 0;
        let streamSucceeded = false;
        let hasYieldedContent = false;

        while (!streamSucceeded && streamRetryCount <= maxStreamRetries) {
          try {
            // Use streaming API
            const stream = this.client.messages.stream({
              model: this.model,
              max_tokens: 4096,
              system: systemPrompt,
              tools: customTools,
              messages,
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

        // Done - no tool use
        if (currentResponse.stop_reason === 'end_turn') {
          totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);

          yield {
            type: 'done',
            response: {
              text: fullText,
              tools_used: toolsUsed,
              tool_executions: toolExecutions,
              flagged: false,
              active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
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
            },
          };
          return;
        }

        // Handle tool use
        if (currentResponse.stop_reason === 'tool_use') {
          const toolUseBlocks = currentResponse.content.filter((c) => c.type === 'tool_use');

          if (toolUseBlocks.length === 0) {
            // No tools to execute, return current text
            totalToolExecutionMs = toolExecutions.reduce((sum, t) => sum + t.duration_ms, 0);
            yield {
              type: 'done',
              response: {
                text: fullText,
                tools_used: toolsUsed,
                tool_executions: toolExecutions,
                flagged: false,
                active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
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
                // Regular text result
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
              const errorResult = `Error: ${errorMessage}`;
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
      yield {
        type: 'done',
        response: {
          text: fullText || "I'm having trouble completing that request. Could you try rephrasing?",
          tools_used: toolsUsed,
          tool_executions: toolExecutions,
          flagged: true,
          flag_reason: 'Max tool iterations reached',
          active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
          config_version_id: configVersionId ?? undefined,
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: maxIterations,
          },
          usage: {
            input_tokens: totalInputTokens,
            output_tokens: totalOutputTokens,
            ...(totalCacheCreationTokens > 0 && { cache_creation_input_tokens: totalCacheCreationTokens }),
            ...(totalCacheReadTokens > 0 && { cache_read_input_tokens: totalCacheReadTokens }),
          },
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
