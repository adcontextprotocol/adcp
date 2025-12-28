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

type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

export interface AddieResponse {
  text: string;
  tools_used: string[];
  flagged: boolean;
  flag_reason?: string;
  /** Rule IDs that were active for this interaction (for logging/analysis) */
  active_rule_ids?: number[];
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

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.addieDb = new AddieDatabase();
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

    // Get system prompt from database rules (or fallback)
    const { prompt: systemPrompt, ruleIds } = await this.getSystemPrompt();

    const contextualMessage = buildContextWithThread(userMessage, threadContext);

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: contextualMessage },
    ];

    let maxIterations = 10;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: this.tools.length > 0 ? this.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema as Anthropic.Tool['input_schema'],
        })) : undefined,
        messages,
      });

      // Done - no tool use, just text
      if (response.stop_reason === 'end_turn') {
        const textContent = response.content.find((c) => c.type === 'text');
        const text = textContent && textContent.type === 'text' ? textContent.text : '';

        return {
          text,
          tools_used: toolsUsed,
          flagged: false,
          active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
        };
      }

      // Handle tool use
      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter((c) => c.type === 'tool_use');

        if (toolUseBlocks.length === 0) {
          const textContent = response.content.find((c) => c.type === 'text');
          const text = textContent && textContent.type === 'text' ? textContent.text : "I'm not sure how to help with that.";
          return { text, tools_used: toolsUsed, flagged: false, active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined };
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

          logger.debug({ toolName }, 'Addie: Calling tool');
          toolsUsed.push(toolName);

          const handler = this.toolHandlers.get(toolName);
          if (!handler) {
            toolResults.push({
              tool_use_id: toolUseId,
              content: `Error: Unknown tool "${toolName}"`,
              is_error: true,
            });
            continue;
          }

          try {
            const result = await handler(toolInput);
            toolResults.push({ tool_use_id: toolUseId, content: result });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toolResults.push({
              tool_use_id: toolUseId,
              content: `Error: ${errorMessage}`,
              is_error: true,
            });
          }
        }

        messages.push({ role: 'assistant', content: response.content });
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
    return {
      text: "I'm having trouble completing that request. Could you try rephrasing?",
      tools_used: toolsUsed,
      flagged: true,
      flag_reason: 'Max tool iterations reached',
      active_rule_ids: ruleIds.length > 0 ? ruleIds : undefined,
    };
  }

  /**
   * Get list of registered tools
   */
  getRegisteredTools(): string[] {
    return this.tools.map((t) => t.name);
  }
}
