/**
 * Shadow Response Evaluator
 *
 * When Addie suppresses a high-confidence response because humans are already
 * answering, this job generates what she WOULD have said and compares it with
 * the human's actual answer. Detects knowledge gaps — cases where Addie couldn't
 * have given the same substantive answer — plus shape regressions (template
 * tic, length blow-out, banned ritual phrases).
 *
 * Runs every 10 minutes, processes threads that have settled (>10 min since last activity).
 *
 * The shadow generation loads Addie's actual rule files and tool reference so
 * the response shape reflects what production would emit. The default model
 * is Haiku for cost; SHADOW_EVAL_MODEL=primary upgrades to the production
 * Sonnet model for periodic deep evals.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { getThreadReplies } from '../../slack/client.js';
import { getThreadService } from '../thread-service.js';
import { ModelConfig, AddieModelConfig } from '../../config/models.js';
import { loadRules } from '../rules/index.js';
import { ADDIE_TOOL_REFERENCE } from '../prompts.js';
import { gradeShape, type ShapeReport } from '../testing/shape-grader.js';

const logger = createLogger('shadow-evaluator');

export interface ShadowEvalResult {
  evaluated: number;
  knowledge_gaps: number;
  shape_regressions: number;
  skipped: number;
  errors: number;
}

/**
 * Resolve the model the shadow generation should use.
 *
 * Default: Haiku (cheap; same prompt as production so the shape signal is
 * still meaningful even though the model differs).
 * Override: SHADOW_EVAL_MODEL=primary | depth | precision | <full-model-id>
 *
 * Setting `primary` matches the Addie production chat model, which is the
 * accurate-but-expensive setting for periodic deep evals.
 */
function resolveShadowModel(): string {
  const override = process.env.SHADOW_EVAL_MODEL?.trim();
  if (!override) return ModelConfig.fast;
  if (override === 'primary' || override === 'chat') return AddieModelConfig.chat;
  if (override === 'depth') return ModelConfig.depth;
  if (override === 'precision') return ModelConfig.precision;
  if (override === 'fast') return ModelConfig.fast;
  return override;
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
 * Compact a ShapeReport pair into a JSON-serializable summary for storage
 * on the thread context. Avoids persisting the full report (we already have
 * the response text — anyone investigating can re-run gradeShape locally).
 */
function summarizeShapeReports(
  shadow: ShapeReport,
  human: ShapeReport,
): {
  shadow: { word_count: number; violations: string[]; ratio_to_expected: number };
  human: { word_count: number; violations: string[] };
  question: { word_count: number; multi_part: boolean; expected_max_words: number };
} {
  return {
    shadow: {
      word_count: shadow.response.wordCount,
      violations: shadow.violationLabels,
      ratio_to_expected: shadow.violations.ratioToExpected,
    },
    human: {
      word_count: human.response.wordCount,
      violations: human.violationLabels,
    },
    question: {
      word_count: shadow.question.wordCount,
      multi_part: shadow.question.isMultiPart,
      expected_max_words: shadow.question.expectedMaxWords,
    },
  };
}

/**
 * Main job runner. Finds pending shadow evaluations, generates shadow responses,
 * compares with human answers, and stores results.
 */
export async function runShadowEvaluatorJob(
  options: { limit: number } = { limit: 5 }
): Promise<ShadowEvalResult> {
  const result: ShadowEvalResult = {
    evaluated: 0,
    knowledge_gaps: 0,
    shape_regressions: 0,
    skipped: 0,
    errors: 0,
  };

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

      // Generate Addie's shadow response with the production rule set so
      // the response shape reflects what users actually see. Default model
      // is Haiku for cost; SHADOW_EVAL_MODEL=primary upgrades to Sonnet.
      // Tools are intentionally not registered — the shadow path doesn't
      // execute side-effecting calls, so the response is bounded by the
      // prompt rather than tool fan-out.
      let systemPrompt: string;
      try {
        systemPrompt = `${loadRules()}\n\n---\n\n${ADDIE_TOOL_REFERENCE}`;
      } catch (loadError) {
        logger.warn({ error: loadError }, 'Shadow evaluator: rules failed to load, skipping thread');
        await threadService.patchThreadContext(thread.thread_id, { shadow_eval_status: 'error' });
        result.errors++;
        continue;
      }

      const shadowModel = resolveShadowModel();
      const shadowResult = await client.messages.create({
        model: shadowModel,
        max_tokens: 1000,
        system: systemPrompt,
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

      // Deterministic shape grade — runs locally, no LLM cost. Catches
      // template tic, length blow-out, banned ritual phrases, sign-in
      // openers. Computed for both shadow and the longest human response so
      // the dashboard can see relative shape divergence.
      const shadowShape = gradeShape(ctx.shadow_eval_question, shadowResponse);
      const longestHuman = humanResponses.reduce(
        (acc, h) => (h.length > acc.length ? h : acc),
        humanResponses[0],
      );
      const humanShape = gradeShape(ctx.shadow_eval_question, longestHuman);
      const shapeRegression =
        shadowShape.violationLabels.length > humanShape.violationLabels.length;
      const summarizedShape = summarizeShapeReports(shadowShape, humanShape);

      // Store results
      await threadService.patchThreadContext(thread.thread_id, {
        shadow_eval_status: 'complete',
        shadow_eval_completed_at: new Date().toISOString(),
        shadow_eval_result: comparison,
        shadow_eval_shape: summarizedShape,
        shadow_eval_shadow_response: shadowResponse.substring(0, 2000), // Truncate for storage
        shadow_eval_human_response: humanResponses.join('\n---\n').substring(0, 2000),
      });

      // Update flag reason — combines knowledge-gap and shape-regression
      // signals so the admin dashboard surfaces the most actionable label.
      const flagParts: string[] = [];
      if (comparison.knowledge_gap) {
        flagParts.push(`Knowledge gap (${comparison.gap_severity}): ${comparison.gap_details}`);
        result.knowledge_gaps++;
      }
      if (shapeRegression) {
        flagParts.push(`Shape regression: ${shadowShape.violationLabels.join(', ')}`);
        result.shape_regressions++;
      }
      if (flagParts.length === 0) {
        flagParts.push(`Shadow eval complete — no gap (${comparison.shadow_quality})`);
      }
      await threadService.flagThread(thread.thread_id, flagParts.join(' | '));

      result.evaluated++;
      logger.info({
        threadId: thread.thread_id,
        knowledge_gap: comparison.knowledge_gap,
        gap_severity: comparison.gap_severity,
        shadow_quality: comparison.shadow_quality,
        shape_regression: shapeRegression,
        shadow_shape_violations: shadowShape.violationLabels,
        human_shape_violations: humanShape.violationLabels,
        shadow_model: shadowModel,
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
