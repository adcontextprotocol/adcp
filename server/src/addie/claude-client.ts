/**
 * Claude client for Addie - handles LLM interactions with tool use
 *
 * System prompt is built from database-backed rules, allowing non-engineers
 * to edit Addie's behavior without code changes.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import type { AddieTool } from './types.js';
import { ADDIE_SYSTEM_PROMPT, buildContextWithThread } from './prompts.js';
import { AddieDatabase } from '../db/addie-db.js';
import { AddieModelConfig } from '../config/models.js';

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

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
  /** Timing breakdown for each phase of processing */
  timing?: {
    system_prompt_ms: number;
    total_llm_ms: number;
    total_tool_execution_ms: number;
    iterations: number;
  };
}

export class AddieClaudeClient {
  private client: Anthropic;
  private model: string;
  private tools: AddieTool[] = [];
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private addieDb: AddieDatabase;
  private cachedSystemPrompt: string | null = null;
  private cachedRuleIds: number[] = [];
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
   * Get the system prompt, either from database rules or fallback to hardcoded
   * Caches the prompt for CACHE_TTL_MS to avoid database hits on every message
   */
  private async getSystemPrompt(): Promise<{ prompt: string; ruleIds: number[] }> {
    const now = Date.now();

    // Return cached prompt if still valid
    if (this.cachedSystemPrompt && now < this.cacheExpiry) {
      return { prompt: this.cachedSystemPrompt, ruleIds: this.cachedRuleIds };
    }

    try {
      const rules = await this.addieDb.getActiveRules();

      // If we have rules from the database, build prompt from them
      if (rules.length > 0) {
        const prompt = await this.addieDb.buildSystemPrompt();
        const ruleIds = rules.map(r => r.id);

        this.cachedSystemPrompt = prompt;
        this.cachedRuleIds = ruleIds;
        this.cacheExpiry = now + this.CACHE_TTL_MS;

        logger.debug({ ruleCount: rules.length }, 'Addie: Built system prompt from database rules');
        return { prompt, ruleIds };
      }
    } catch (error) {
      logger.warn({ error }, 'Addie: Failed to load rules from database, using fallback prompt');
    }

    // Fallback to hardcoded prompt if database unavailable or empty
    return { prompt: ADDIE_SYSTEM_PROMPT, ruleIds: [] };
  }

  /**
   * Invalidate the cached system prompt (call after rule changes)
   */
  invalidateCache(): void {
    this.cachedSystemPrompt = null;
    this.cachedRuleIds = [];
    this.cacheExpiry = 0;
  }

  /**
   * Register a tool
   */
  registerTool(tool: AddieTool, handler: ToolHandler): void {
    this.tools.push(tool);
    this.toolHandlers.set(tool.name, handler);
    logger.info({ toolName: tool.name }, 'Addie: Registered tool');
  }

  /**
   * Process a message and return a response
   * Uses database-backed rules for the system prompt when available
   */
  async processMessage(
    userMessage: string,
    threadContext?: Array<{ user: string; text: string }>
  ): Promise<AddieResponse> {
    const toolsUsed: string[] = [];
    const toolExecutions: ToolExecution[] = [];
    let executionSequence = 0;

    // Timing metrics
    const timingStart = Date.now();
    let systemPromptMs = 0;
    let totalLlmMs = 0;
    let totalToolExecutionMs = 0;

    // Get system prompt from database rules (or fallback)
    const promptStart = Date.now();
    const { prompt: systemPrompt, ruleIds } = await this.getSystemPrompt();
    systemPromptMs = Date.now() - promptStart;

    const contextualMessage = buildContextWithThread(userMessage, threadContext);

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: contextualMessage },
    ];

    let maxIterations = 10;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      // Build tools array: custom tools + optional web search
      const customTools = this.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool['input_schema'],
      }));

      // Use beta API to access web search
      const llmStart = Date.now();
      const response = await this.client.beta.messages.create({
        model: this.model,
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
      });

      const llmDuration = Date.now() - llmStart;
      totalLlmMs += llmDuration;

      // Log response structure for debugging
      logger.info({
        stopReason: response.stop_reason,
        contentTypes: response.content.map(c => c.type),
        iteration,
        llmDurationMs: llmDuration,
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
          timing: {
            system_prompt_ms: systemPromptMs,
            total_llm_ms: totalLlmMs,
            total_tool_execution_ms: totalToolExecutionMs,
            iterations: iteration,
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
            timing: {
              system_prompt_ms: systemPromptMs,
              total_llm_ms: totalLlmMs,
              total_tool_execution_ms: totalToolExecutionMs,
              iterations: iteration,
            },
          };
        }

        interface ToolResult {
          tool_use_id: string;
          content: string;
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

          const handler = this.toolHandlers.get(toolName);
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
      timing: {
        system_prompt_ms: systemPromptMs,
        total_llm_ms: totalLlmMs,
        total_tool_execution_ms: totalToolExecutionMs,
        iterations: maxIterations,
      },
    };
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
