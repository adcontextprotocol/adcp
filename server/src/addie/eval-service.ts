/**
 * Eval Service for Addie
 *
 * Tests proposed rule changes against historical interactions using real re-execution.
 * This allows validating rule changes before deploying them to production.
 */

import { logger } from '../logger.js';
import { AddieDatabase, type EvalRun, type EvalResult, type EvalResultInsert } from '../db/addie-db.js';
import { AddieClaudeClient, type RulesOverride, type RequestTools } from './claude-client.js';
import { AddieModelConfig } from '../config/models.js';
import { query } from '../db/client.js';
import {
  KNOWLEDGE_TOOLS,
  createKnowledgeToolHandlers,
} from './mcp/knowledge-search.js';
import {
  BILLING_TOOLS,
  createBillingToolHandlers,
} from './mcp/billing-tools.js';
import { ADDIE_TOOL_REFERENCE } from './prompts.js';

// Re-export types for convenience
export type { EvalRun, EvalResult };

/**
 * Selection criteria for choosing historical interactions to evaluate
 */
export interface SelectionCriteria {
  // Filter by rating
  minRating?: number;
  maxRating?: number;
  // Filter by date range
  startDate?: Date;
  endDate?: Date;
  // Filter by channel
  channel?: 'slack' | 'web' | 'a2a' | 'email';
  // Filter by tools used
  toolsUsed?: string[];
  // Filter by flagged status
  flaggedOnly?: boolean;
  // Sample size (default 10)
  sampleSize?: number;
  // Random seed for reproducibility (optional)
  randomSeed?: number;
}

/**
 * Configuration for an eval run
 */
export interface EvalConfig {
  proposedRuleIds: number[];
  criteria: SelectionCriteria;
  createdBy: string;
}

/**
 * Historical interaction data for evaluation
 */
interface HistoricalInteraction {
  messageId: string;
  threadId: string;
  userInput: string;
  originalResponse: string;
  originalRating: number | null;
  originalToolsUsed: string[] | null;
  originalRouterDecision: object | null;
  originalLatencyMs: number | null;
}

/**
 * EvalService - Core logic for the evaluation framework
 */
export class EvalService {
  private addieDb: AddieDatabase;

  constructor() {
    this.addieDb = new AddieDatabase();
  }

  /**
   * Create and start an evaluation run
   */
  async createAndStartRun(config: EvalConfig): Promise<EvalRun> {
    const { proposedRuleIds, criteria, createdBy } = config;

    // Validate proposed rules exist
    const rules = await this.addieDb.getRulesByIds(proposedRuleIds);
    if (rules.length !== proposedRuleIds.length) {
      const foundIds = rules.map(r => r.id);
      const missingIds = proposedRuleIds.filter(id => !foundIds.includes(id));
      throw new Error(`Rules not found: ${missingIds.join(', ')}`);
    }

    // Build rules snapshot for audit trail
    const rulesSnapshot = rules.map(r => ({
      id: r.id,
      name: r.name,
      rule_type: r.rule_type,
      content: r.content,
      priority: r.priority,
    }));

    // Create the run record
    const runId = await this.addieDb.createEvalRun({
      proposedRuleIds,
      proposedRulesSnapshot: rulesSnapshot,
      selectionCriteria: criteria,
      createdBy,
    });

    // Start the run asynchronously
    this.executeRun(runId, proposedRuleIds, criteria).catch(error => {
      logger.error({ error, runId }, 'Eval: Run failed');
    });

    // Return the created run
    const run = await this.addieDb.getEvalRun(runId);
    if (!run) throw new Error('Failed to create eval run');
    return run;
  }

  /**
   * Execute an evaluation run
   */
  private async executeRun(
    runId: number,
    proposedRuleIds: number[],
    criteria: SelectionCriteria
  ): Promise<void> {
    try {
      // Mark as running
      await this.addieDb.updateEvalRunStatus(runId, 'running');

      // Select interactions to evaluate
      const interactions = await this.selectInteractions(criteria);
      logger.info({ runId, count: interactions.length }, 'Eval: Selected interactions');

      if (interactions.length === 0) {
        await this.addieDb.updateEvalRunStatus(runId, 'completed', {
          totalInteractions: 0,
          interactionsEvaluated: 0,
          interactionsAffected: 0,
          metrics: { message: 'No interactions matched selection criteria' },
        });
        return;
      }

      // Update total count
      await this.addieDb.updateEvalRunStatus(runId, 'running', {
        totalInteractions: interactions.length,
      });

      // Build system prompt from proposed rules + tool reference
      const basePrompt = await this.addieDb.buildSystemPromptFromRuleIds(proposedRuleIds);
      const systemPrompt = `${basePrompt}\n\n---\n\n${ADDIE_TOOL_REFERENCE}`;
      const rulesOverride: RulesOverride = {
        ruleIds: proposedRuleIds,
        systemPrompt,
      };

      // Create Claude client for eval (no web search to keep it deterministic)
      const claudeClient = this.createEvalClaudeClient();

      // Evaluate each interaction
      let interactionsEvaluated = 0;
      let interactionsAffected = 0;
      let totalNewLatencyMs = 0;
      let totalNewInputTokens = 0;
      let totalNewOutputTokens = 0;
      let routingChangedCount = 0;
      let toolsChangedCount = 0;
      let responseChangedCount = 0;

      for (const interaction of interactions) {
        try {
          const result = await this.evaluateInteraction(
            interaction,
            claudeClient,
            rulesOverride
          );

          // Insert result
          await this.addieDb.insertEvalResult({
            evalRunId: runId,
            messageId: interaction.messageId,
            threadId: interaction.threadId,
            originalInput: interaction.userInput,
            originalResponse: interaction.originalResponse,
            originalRating: interaction.originalRating,
            originalToolsUsed: interaction.originalToolsUsed,
            originalRouterDecision: interaction.originalRouterDecision,
            originalLatencyMs: interaction.originalLatencyMs,
            newResponse: result.newResponse,
            newToolsUsed: result.newToolsUsed,
            newRouterDecision: null, // Not tracking router decision in eval
            newLatencyMs: result.newLatencyMs,
            newTokensInput: result.newTokensInput,
            newTokensOutput: result.newTokensOutput,
            routingChanged: result.routingChanged,
            toolsChanged: result.toolsChanged,
            responseChanged: result.responseChanged,
          });

          interactionsEvaluated++;
          if (result.routingChanged || result.toolsChanged || result.responseChanged) {
            interactionsAffected++;
          }

          if (result.routingChanged) routingChangedCount++;
          if (result.toolsChanged) toolsChangedCount++;
          if (result.responseChanged) responseChangedCount++;
          if (result.newLatencyMs) totalNewLatencyMs += result.newLatencyMs;
          if (result.newTokensInput) totalNewInputTokens += result.newTokensInput;
          if (result.newTokensOutput) totalNewOutputTokens += result.newTokensOutput;

          // Update progress
          await this.addieDb.updateEvalRunStatus(runId, 'running', {
            interactionsEvaluated,
            interactionsAffected,
          });

          logger.debug({
            runId,
            messageId: interaction.messageId,
            routingChanged: result.routingChanged,
            toolsChanged: result.toolsChanged,
            responseChanged: result.responseChanged,
          }, 'Eval: Evaluated interaction');

        } catch (error) {
          logger.error({
            error,
            runId,
            messageId: interaction.messageId,
          }, 'Eval: Failed to evaluate interaction');
          // Continue with other interactions
        }
      }

      // Calculate aggregate metrics (defensive division by zero checks)
      const totalCount = interactions.length;
      const metrics = {
        routing_changed_count: routingChangedCount,
        routing_changed_pct: totalCount > 0 ? Math.round((routingChangedCount / totalCount) * 100) : 0,
        tools_changed_count: toolsChangedCount,
        tools_changed_pct: totalCount > 0 ? Math.round((toolsChangedCount / totalCount) * 100) : 0,
        response_changed_count: responseChangedCount,
        response_changed_pct: totalCount > 0 ? Math.round((responseChangedCount / totalCount) * 100) : 0,
        avg_new_latency_ms: interactionsEvaluated > 0 ? Math.round(totalNewLatencyMs / interactionsEvaluated) : null,
        total_new_input_tokens: totalNewInputTokens,
        total_new_output_tokens: totalNewOutputTokens,
      };

      // Mark as completed
      await this.addieDb.updateEvalRunStatus(runId, 'completed', {
        interactionsEvaluated,
        interactionsAffected,
        metrics,
      });

      logger.info({ runId, metrics }, 'Eval: Run completed');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.addieDb.updateEvalRunStatus(runId, 'failed', {
        errorMessage,
      });
      throw error;
    }
  }

  /**
   * Select historical interactions for evaluation
   */
  private async selectInteractions(criteria: SelectionCriteria): Promise<HistoricalInteraction[]> {
    const conditions: string[] = ['m.role = \'assistant\''];
    const params: unknown[] = [];
    let paramIndex = 1;

    // Get the user message that preceded each assistant message
    // by finding the most recent user message before each assistant message

    if (criteria.minRating !== undefined) {
      conditions.push(`m.rating >= $${paramIndex++}`);
      params.push(criteria.minRating);
    }

    if (criteria.maxRating !== undefined) {
      conditions.push(`m.rating <= $${paramIndex++}`);
      params.push(criteria.maxRating);
    }

    if (criteria.startDate) {
      conditions.push(`m.created_at >= $${paramIndex++}`);
      params.push(criteria.startDate);
    }

    if (criteria.endDate) {
      conditions.push(`m.created_at <= $${paramIndex++}`);
      params.push(criteria.endDate);
    }

    if (criteria.channel) {
      conditions.push(`t.channel = $${paramIndex++}`);
      params.push(criteria.channel);
    }

    if (criteria.toolsUsed && criteria.toolsUsed.length > 0) {
      conditions.push(`m.tools_used && $${paramIndex++}`);
      params.push(criteria.toolsUsed);
    }

    if (criteria.flaggedOnly) {
      conditions.push(`m.flagged = TRUE`);
    }

    // Cap sample size to prevent excessive API calls (max 100)
    const sampleSize = Math.min(criteria.sampleSize || 10, 100);
    params.push(sampleSize);

    // Build ORDER BY clause - parameterize randomSeed to prevent SQL injection
    let orderByClause: string;
    if (criteria.randomSeed !== undefined && typeof criteria.randomSeed === 'number') {
      params.push(criteria.randomSeed);
      orderByClause = `md5(m.message_id::text || $${paramIndex + 1}::text)`;
      paramIndex++;
    } else {
      orderByClause = 'RANDOM()';
    }

    // Query to get assistant messages with their preceding user messages
    const sql = `
      WITH assistant_messages AS (
        SELECT
          m.message_id,
          m.thread_id,
          m.content as response,
          m.rating,
          m.tools_used,
          m.router_decision,
          m.latency_ms,
          m.sequence_number,
          m.created_at
        FROM addie_thread_messages m
        JOIN addie_threads t ON m.thread_id = t.thread_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderByClause}
        LIMIT $${paramIndex}
      ),
      user_messages AS (
        SELECT DISTINCT ON (am.message_id)
          am.message_id as assistant_message_id,
          um.content as user_input
        FROM assistant_messages am
        JOIN addie_thread_messages um ON um.thread_id = am.thread_id
        WHERE um.role = 'user'
          AND um.sequence_number < am.sequence_number
        ORDER BY am.message_id, um.sequence_number DESC
      )
      SELECT
        am.message_id,
        am.thread_id,
        COALESCE(um.user_input, '') as user_input,
        am.response as original_response,
        am.rating as original_rating,
        am.tools_used as original_tools_used,
        am.router_decision as original_router_decision,
        am.latency_ms as original_latency_ms
      FROM assistant_messages am
      LEFT JOIN user_messages um ON am.message_id = um.assistant_message_id
      WHERE um.user_input IS NOT NULL AND um.user_input != ''
    `;

    const result = await query<{
      message_id: string;
      thread_id: string;
      user_input: string;
      original_response: string;
      original_rating: number | null;
      original_tools_used: string[] | null;
      original_router_decision: object | null;
      original_latency_ms: number | null;
    }>(sql, params);

    return result.rows.map(row => ({
      messageId: row.message_id,
      threadId: row.thread_id,
      userInput: row.user_input,
      originalResponse: row.original_response,
      originalRating: row.original_rating,
      originalToolsUsed: row.original_tools_used,
      originalRouterDecision: row.original_router_decision,
      originalLatencyMs: row.original_latency_ms,
    }));
  }

  /**
   * Evaluate a single interaction with proposed rules
   */
  private async evaluateInteraction(
    interaction: HistoricalInteraction,
    claudeClient: AddieClaudeClient,
    rulesOverride: RulesOverride
  ): Promise<{
    newResponse: string | null;
    newToolsUsed: string[] | null;
    newLatencyMs: number | null;
    newTokensInput: number | null;
    newTokensOutput: number | null;
    routingChanged: boolean;
    toolsChanged: boolean;
    responseChanged: boolean;
  }> {
    const startTime = Date.now();

    try {
      // Re-execute with proposed rules (no thread context for simplicity)
      const response = await claudeClient.processMessage(
        interaction.userInput,
        undefined, // no thread context
        undefined, // no request tools
        rulesOverride
      );

      const newLatencyMs = Date.now() - startTime;

      // Compare results
      const toolsChanged = this.compareToolsUsed(
        interaction.originalToolsUsed,
        response.tools_used
      );

      const responseChanged = this.compareResponses(
        interaction.originalResponse,
        response.text
      );

      // For routing, we'd need router decision comparison
      // For now, just check if tools changed (since router determines tools)
      const routingChanged = toolsChanged;

      return {
        newResponse: response.text,
        newToolsUsed: response.tools_used,
        newLatencyMs,
        newTokensInput: response.usage?.input_tokens || null,
        newTokensOutput: response.usage?.output_tokens || null,
        routingChanged,
        toolsChanged,
        responseChanged,
      };

    } catch (error) {
      logger.error({ error, messageId: interaction.messageId }, 'Eval: Error re-executing interaction');

      return {
        newResponse: null,
        newToolsUsed: null,
        newLatencyMs: Date.now() - startTime,
        newTokensInput: null,
        newTokensOutput: null,
        routingChanged: false,
        toolsChanged: false,
        responseChanged: false,
      };
    }
  }

  /**
   * Compare tools used between original and new execution
   */
  private compareToolsUsed(original: string[] | null, newTools: string[]): boolean {
    const origSet = new Set(original || []);
    const newSet = new Set(newTools);

    if (origSet.size !== newSet.size) return true;
    for (const tool of origSet) {
      if (!newSet.has(tool)) return true;
    }
    return false;
  }

  /**
   * Compare responses - simple heuristic based on length and content
   * Returns true if responses are meaningfully different
   */
  private compareResponses(original: string, newResponse: string): boolean {
    // If exactly the same, no change
    if (original === newResponse) return false;

    // If lengths differ significantly (>20%), consider changed
    const lengthDiff = Math.abs(original.length - newResponse.length);
    const avgLength = (original.length + newResponse.length) / 2;
    if (avgLength > 0 && (lengthDiff / avgLength) > 0.2) return true;

    // Simple word overlap check
    const origWords = new Set(original.toLowerCase().split(/\s+/));
    const newWords = new Set(newResponse.toLowerCase().split(/\s+/));
    let overlap = 0;
    for (const word of origWords) {
      if (newWords.has(word)) overlap++;
    }
    const overlapRatio = overlap / Math.max(origWords.size, newWords.size);

    // If less than 80% word overlap, consider changed
    return overlapRatio < 0.8;
  }

  /**
   * Create a Claude client configured for evaluation
   * (no web search to keep results more deterministic)
   */
  private createEvalClaudeClient(): AddieClaudeClient {
    const apiKey = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('No Anthropic API key configured');
    }

    const client = new AddieClaudeClient(apiKey, AddieModelConfig.chat);
    client.setWebSearchEnabled(false);

    // Register knowledge tools (same as normal Addie)
    const knowledgeHandlers = createKnowledgeToolHandlers();
    for (const tool of KNOWLEDGE_TOOLS) {
      const handler = knowledgeHandlers.get(tool.name);
      if (handler) {
        client.registerTool(tool, handler);
      }
    }

    // Register billing tools
    const billingHandlers = createBillingToolHandlers();
    for (const tool of BILLING_TOOLS) {
      const handler = billingHandlers.get(tool.name);
      if (handler) {
        client.registerTool(tool, handler);
      }
    }

    // Note: Admin and member tools are not registered for eval
    // since they require user context which we don't have in historical data

    return client;
  }

  /**
   * Get an eval run by ID
   */
  async getRun(runId: number): Promise<EvalRun | null> {
    return this.addieDb.getEvalRun(runId);
  }

  /**
   * List eval runs
   */
  async listRuns(limit: number = 20, offset: number = 0): Promise<EvalRun[]> {
    return this.addieDb.listEvalRuns(limit, offset);
  }

  /**
   * Get results for an eval run
   */
  async getResults(runId: number, limit: number = 100, offset: number = 0): Promise<EvalResult[]> {
    return this.addieDb.getEvalResults(runId, limit, offset);
  }

  /**
   * Submit a review verdict for an eval result
   */
  async submitReview(
    resultId: number,
    verdict: 'improved' | 'same' | 'worse' | 'uncertain',
    reviewedBy: string,
    notes?: string
  ): Promise<void> {
    await this.addieDb.updateEvalResultReview(resultId, verdict, reviewedBy, notes);
  }
}

// Singleton instance
let evalService: EvalService | null = null;

export function getEvalService(): EvalService {
  if (!evalService) {
    evalService = new EvalService();
  }
  return evalService;
}
