/**
 * Shadow Response Evaluator
 *
 * When Addie suppresses a high-confidence response because humans are already
 * answering, this job generates what she WOULD have said and compares it with
 * the human's actual answer. Detects knowledge gaps — cases where Addie couldn't
 * have given the same substantive answer.
 *
 * Runs every 10 minutes, processes threads that have settled (>10 min since last activity).
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { getThreadReplies } from '../../slack/client.js';
import { getThreadService } from '../thread-service.js';
import { ModelConfig } from '../../config/models.js';

const logger = createLogger('shadow-evaluator');

export interface ShadowEvalResult {
  evaluated: number;
  knowledge_gaps: number;
  skipped: number;
  errors: number;
}

interface PendingThread {
  thread_id: string;
  context: {
    shadow_eval_status: string;
    shadow_eval_channel_id: string;
    shadow_eval_thread_ts: string;
    shadow_eval_tool_sets: string[];
    shadow_eval_question: string;
  };
}

/**
 * Find threads pending shadow evaluation that have settled (10+ min old).
 */
async function findPendingThreads(limit: number): Promise<PendingThread[]> {
  const result = await query<PendingThread>(
    `SELECT thread_id, context
     FROM addie_threads
     WHERE context->>'shadow_eval_status' = 'pending'
       AND updated_at < NOW() - INTERVAL '10 minutes'
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Extract human responses from a Slack thread (excluding bot messages).
 */
function extractHumanResponses(
  messages: Array<{ user?: string; text?: string; bot_id?: string; ts: string }>,
  questionTs: string,
): string[] {
  return messages
    .filter(msg => msg.user && !msg.bot_id && msg.ts > questionTs && msg.text)
    .map(msg => msg.text!)
    .filter(text => text.length > 20); // Skip short acknowledgments
}

/**
 * Compare Addie's shadow response with human responses using Haiku.
 * Returns structured assessment of knowledge gaps.
 */
async function compareResponses(
  client: Anthropic,
  question: string,
  humanResponses: string[],
  shadowResponse: string,
): Promise<{
  knowledge_gap: boolean;
  gap_severity: 'none' | 'minor' | 'significant' | 'critical';
  gap_details: string;
  shadow_quality: 'better' | 'equivalent' | 'worse' | 'different_focus';
}> {
  const humanText = humanResponses.join('\n---\n');

  const response = await client.messages.create({
    model: ModelConfig.fast,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `Compare these two responses to the same question. Focus on SUBSTANCE (facts, recommendations, actionable info), not style or length.

## Question
"${question.substring(0, 500)}"

## Human Expert Response
${humanText.substring(0, 1500)}

## Addie's Response (not sent — generated for evaluation)
${shadowResponse.substring(0, 1500)}

## Assessment
Respond with ONLY a JSON object:
{
  "knowledge_gap": true/false — Did the human provide substantive facts/recommendations that Addie missed entirely?
  "gap_severity": "none" | "minor" | "significant" | "critical"
    - none: Addie covered the same ground
    - minor: Small details missing but core answer is there
    - significant: Key facts or recommendations missing
    - critical: Addie gave wrong information or missed the entire point
  "gap_details": "Brief description of what was missing or wrong (empty string if none)"
  "shadow_quality": "better" | "equivalent" | "worse" | "different_focus"
    - better: Addie's answer was more complete or accurate
    - equivalent: Same substance, different style
    - worse: Human's answer was more complete or accurate
    - different_focus: Each covered different aspects
}`,
    }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    return JSON.parse(jsonStr);
  } catch {
    logger.warn({ text }, 'Shadow evaluator: Could not parse comparison result');
    return {
      knowledge_gap: false,
      gap_severity: 'none',
      gap_details: 'Comparison parse error',
      shadow_quality: 'equivalent',
    };
  }
}

/**
 * Main job runner. Finds pending shadow evaluations, generates shadow responses,
 * compares with human answers, and stores results.
 */
export async function runShadowEvaluatorJob(
  options: { limit: number } = { limit: 5 }
): Promise<ShadowEvalResult> {
  const result: ShadowEvalResult = { evaluated: 0, knowledge_gaps: 0, skipped: 0, errors: 0 };

  let pendingThreads: PendingThread[];
  try {
    pendingThreads = await findPendingThreads(options.limit);
  } catch (error) {
    logger.error({ error }, 'Shadow evaluator: Failed to find pending threads');
    return result;
  }

  if (pendingThreads.length === 0) return result;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('Shadow evaluator: ANTHROPIC_API_KEY not set');
    return result;
  }

  const client = new Anthropic({ apiKey });
  const threadService = getThreadService();

  for (const thread of pendingThreads) {
    try {
      const ctx = thread.context;
      if (!ctx.shadow_eval_channel_id || !ctx.shadow_eval_thread_ts || !ctx.shadow_eval_question) {
        logger.warn({ threadId: thread.thread_id }, 'Shadow evaluator: Missing context fields');
        await threadService.patchThreadContext(thread.thread_id, { shadow_eval_status: 'error' });
        result.errors++;
        continue;
      }

      // Get the full Slack thread
      let slackMessages;
      try {
        slackMessages = await getThreadReplies(ctx.shadow_eval_channel_id, ctx.shadow_eval_thread_ts);
      } catch (error) {
        logger.warn({ error, threadId: thread.thread_id }, 'Shadow evaluator: Could not fetch Slack thread');
        await threadService.patchThreadContext(thread.thread_id, { shadow_eval_status: 'error' });
        result.errors++;
        continue;
      }

      // Extract human responses (after the question)
      const humanResponses = extractHumanResponses(slackMessages, ctx.shadow_eval_thread_ts);
      if (humanResponses.length === 0) {
        // No substantive human replies yet — skip for now, re-check later
        result.skipped++;
        continue;
      }

      // Generate Addie's shadow response using Haiku (cheap, internal-only)
      const shadowResult = await client.messages.create({
        model: ModelConfig.fast,
        max_tokens: 1000,
        system: 'You are Addie, the AI assistant for AgenticAdvertising.org and the AdCP protocol. Answer the question as you would in a Slack channel — concise, practical, with specific references to docs or tools when relevant.',
        messages: [{ role: 'user', content: ctx.shadow_eval_question }],
      });
      const shadowResponse = shadowResult.content[0].type === 'text' ? shadowResult.content[0].text : '';

      if (!shadowResponse) {
        await threadService.patchThreadContext(thread.thread_id, { shadow_eval_status: 'error' });
        result.errors++;
        continue;
      }

      // Compare shadow vs human responses
      const comparison = await compareResponses(client, ctx.shadow_eval_question, humanResponses, shadowResponse);

      // Store results
      await threadService.patchThreadContext(thread.thread_id, {
        shadow_eval_status: 'complete',
        shadow_eval_completed_at: new Date().toISOString(),
        shadow_eval_result: comparison,
        shadow_eval_shadow_response: shadowResponse.substring(0, 2000), // Truncate for storage
        shadow_eval_human_response: humanResponses.join('\n---\n').substring(0, 2000),
      });

      // Update flag reason with gap info for admin dashboard
      if (comparison.knowledge_gap) {
        await threadService.flagThread(
          thread.thread_id,
          `Knowledge gap (${comparison.gap_severity}): ${comparison.gap_details}`
        );
        result.knowledge_gaps++;
      } else {
        // No gap — update flag to show evaluation is complete
        await threadService.flagThread(
          thread.thread_id,
          `Shadow eval complete — no knowledge gap (${comparison.shadow_quality})`
        );
      }

      result.evaluated++;
      logger.info({
        threadId: thread.thread_id,
        knowledge_gap: comparison.knowledge_gap,
        gap_severity: comparison.gap_severity,
        shadow_quality: comparison.shadow_quality,
      }, 'Shadow evaluator: Evaluation complete');

      // Brief pause between evaluations
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error({ error, threadId: thread.thread_id }, 'Shadow evaluator: Failed to evaluate thread');
      try {
        await threadService.patchThreadContext(thread.thread_id, { shadow_eval_status: 'error' });
      } catch { /* ignore */ }
      result.errors++;
    }
  }

  return result;
}
