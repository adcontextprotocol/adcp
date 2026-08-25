/**
 * Shadow Corrected Capture Job
 *
 * Captures the second leg of the shadow eval corpus: threads where Addie
 * **posted** and a human posted a substantive reply afterward. The
 * suppression-based shadow eval (`shadow-evaluator.ts`) only fires when
 * Addie was kept silent and humans answered; it never sees the case Brian
 * flagged in 2026-04-29 — Addie writing an essay-shaped answer that a human
 * had to TLDR. This job closes that gap.
 *
 * For each candidate Slack thread it:
 *   1. Fetches the full thread from Slack.
 *   2. Identifies the user question, Addie's actual response, and the
 *      substantive human follow-ups.
 *   3. Runs the shape grader on Addie's actual response (and the longest
 *      human reply) so the dashboard surfaces template tic / length blow-out
 *      / ritual leaks.
 *   4. Runs the same LLM-as-judge comparator the shadow-evaluator uses
 *      (`compareResponses`) so the corpus is gradeable against the same
 *      knowledge-gap rubric as the suppression corpus.
 *   5. Persists the result on the thread context with
 *      `shadow_eval_source: 'addie_corrected_capture'` so analytics can
 *      separate this corpus from suppressed threads and from the manual
 *      backfill.
 *
 * Runs every 30 minutes, processes ~20 threads per run. Selection is
 * non-recursive — once a thread has any `shadow_eval_status`, it is
 * skipped on subsequent runs.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { getThreadReplies } from '../../slack/client.js';
import { getThreadService } from '../thread-service.js';
import { gradeShape } from '../testing/shape-grader.js';
import {
  compareResponses,
  hasDeterministicShapeFailure,
  summarizeShapeReports,
} from './shadow-evaluator.js';
import {
  buildShadowEvalProvenance,
  resolveShadowJudgeModel,
} from './shadow-eval-metadata.js';

const logger = createLogger('shadow-corrected-capture');

export interface CorrectedCaptureResult {
  evaluated: number;
  knowledge_gaps: number;
  shape_regressions: number;
  skipped: number;
  errors: number;
}

interface CandidateThread {
  thread_id: string;
  external_id: string;
  message_count: number;
  source_message_id: string | null;
  source_answer_content: string | null;
  source_answer_model: string | null;
  source_config_version_id: number | null;
}

const SUBSTANTIVE_TEXT_MIN = 20;

/**
 * Find Slack threads that have a substantive Addie message AND a substantive
 * non-bot human message recorded in our addie_thread_messages mirror. The
 * `EXISTS` clauses are a cheap pre-filter — the periodic Slack fetch in
 * `processCandidate` is what definitively confirms a Katie-pattern thread.
 *
 * Selection rules:
 *   - channel = 'slack' and external_id has the `channel:thread_ts` shape.
 *   - Last activity within the last 24h, settled at least 30 minutes
 *     (so the human follow-up isn't still being typed and Addie isn't
 *     mid-stream).
 *   - No prior `shadow_eval_status` set on the thread (suppressed-flow
 *     threads are owned by `shadow-evaluator`; we don't want to clobber).
 *   - At least one assistant message and one user message recorded for the
 *     thread.
 */
async function findCandidateThreads(limit: number): Promise<CandidateThread[]> {
  const result = await query<CandidateThread>(
    `SELECT
       t.thread_id,
       t.external_id,
       t.message_count,
       source.message_id AS source_message_id,
       source.content AS source_answer_content,
       source.model AS source_answer_model,
       source.config_version_id AS source_config_version_id
     FROM addie_threads t
     JOIN LATERAL (
       SELECT m.message_id, m.content, m.model, m.config_version_id
       FROM addie_thread_messages m
       WHERE m.thread_id = t.thread_id
         AND m.role = 'assistant'
         AND length(m.content) > $2
         AND COALESCE(m.delivery_status, 'completed') = 'completed'
       ORDER BY m.created_at DESC
       LIMIT 1
     ) source ON TRUE
     WHERE t.channel = 'slack'
       AND t.external_id LIKE '%:%'
       AND t.last_message_at < NOW() - INTERVAL '30 minutes'
       AND t.last_message_at > NOW() - INTERVAL '24 hours'
       AND (t.context->>'shadow_eval_status') IS NULL
       AND COALESCE(
         (t.context->>'shadow_eval_corrected_checked_message_count')::integer,
         -1
       ) < t.message_count
       AND COALESCE(
         (t.context->>'shadow_eval_corrected_retry_after')::timestamptz,
         '-infinity'::timestamptz
       ) <= NOW()
       AND EXISTS (
         SELECT 1 FROM addie_thread_messages m
         WHERE m.thread_id = t.thread_id
           AND m.role = 'user'
           AND length(m.content) > $2
       )
     ORDER BY t.last_message_at ASC
     LIMIT $1`,
    [limit, SUBSTANTIVE_TEXT_MIN],
  );
  return result.rows;
}

interface SlackThreadPayload {
  question: string;
  addieResponse: string;
  humanResponses: string[];
}

/**
 * Pull the question, Addie's response, and the human follow-ups out of a
 * Slack thread. Returns null when the thread doesn't match the
 * Katie-pattern shape (no Addie reply, or no substantive human reply
 * after Addie's last reply).
 *
 * Slack message timestamps are `epoch.sequence` strings — string
 * comparison is chronologically correct.
 */
export function extractCorrectedAnswerPattern(
  messages: Array<{ user?: string; text?: string; bot_id?: string; ts: string }>,
  expectedAddieResponse?: string | null,
): SlackThreadPayload | null {
  if (messages.length < 2) return null;

  const sorted = [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const botMessages = sorted.filter(
    (m) => m.bot_id && m.text && m.text.length > SUBSTANTIVE_TEXT_MIN,
  );
  const normalizedExpected = expectedAddieResponse
    ? normalizeSlackMessageText(expectedAddieResponse)
    : null;
  const addieResponse = normalizedExpected
    ? [...botMessages].reverse().find(
      (m) => normalizeSlackMessageText(m.text!) === normalizedExpected,
    )
    : new Set(botMessages.map((m) => m.bot_id)).size <= 1
      ? botMessages[botMessages.length - 1]
      : undefined;
  if (!addieResponse?.text) return null;

  // A later message from a different bot makes the following human reply
  // ambiguous. Do not grade that bot under Addie's stored model/config.
  if (botMessages.some(
    (m) => m.ts > addieResponse.ts && m.bot_id !== addieResponse.bot_id,
  )) return null;

  // Anchor the evaluation to the substantive human turn immediately before
  // the attributable answer, not the thread's first question. Multi-turn
  // threads can contain several unrelated Q/A pairs.
  const question = [...sorted].reverse().find(
    (m) => !m.bot_id
      && m.text
      && m.text.length > SUBSTANTIVE_TEXT_MIN
      && m.ts < addieResponse.ts,
  );
  if (!question?.text) return null;

  // Human follow-ups = substantive non-bot messages strictly after Addie's
  // response. If none, this isn't a corrected pattern.
  const humanResponses = sorted
    .filter(
      (m) =>
        !m.bot_id &&
        m.text &&
        m.text.length > SUBSTANTIVE_TEXT_MIN &&
        m.ts > addieResponse.ts,
    )
    .map((m) => m.text!);
  if (humanResponses.length === 0) return null;

  return {
    question: question.text,
    addieResponse: addieResponse.text,
    humanResponses,
  };
}

function normalizeSlackMessageText(text: string): string {
  return text
    .replace(/<((?:https?|mailto):[^>|]+)(?:\|[^>]+)?>/g, '$1')
    .trim();
}

async function processCandidate(
  client: Anthropic,
  thread: CandidateThread,
  result: CorrectedCaptureResult,
): Promise<void> {
  const threadService = getThreadService();
  // Slack thread external_ids are `channel_id:thread_ts`. Slack channel
  // ids today don't contain colons, but the column is a 500-char varchar
  // with no enforced shape — defensively split on the FIRST colon and
  // treat the remainder as the thread timestamp.
  const sepIdx = thread.external_id.indexOf(':');
  const channelId = sepIdx > 0 ? thread.external_id.slice(0, sepIdx) : '';
  const threadTs = sepIdx > 0 ? thread.external_id.slice(sepIdx + 1) : '';
  if (!channelId || !threadTs) {
    await threadService.patchThreadContext(thread.thread_id, {
      shadow_eval_corrected_checked_message_count: thread.message_count,
      shadow_eval_corrected_checked_at: new Date().toISOString(),
      shadow_eval_corrected_skip_reason: 'invalid_external_id',
    });
    result.skipped++;
    return;
  }

  let slackMessages: Array<{ user?: string; text?: string; bot_id?: string; ts: string }>;
  try {
    slackMessages = await getThreadReplies(channelId, threadTs);
  } catch (error) {
    logger.warn(
      { error, threadId: thread.thread_id },
      'Corrected capture: Could not fetch Slack thread',
    );
    await threadService.patchThreadContext(thread.thread_id, {
      shadow_eval_corrected_retry_after: new Date(Date.now() + 5 * 60_000).toISOString(),
      shadow_eval_corrected_error: 'slack_fetch_failed',
    });
    result.errors++;
    return;
  }

  const extracted = extractCorrectedAnswerPattern(
    slackMessages,
    thread.source_answer_content,
  );
  if (!extracted) {
    await threadService.patchThreadContext(thread.thread_id, {
      shadow_eval_corrected_checked_message_count: thread.message_count,
      shadow_eval_corrected_checked_at: new Date().toISOString(),
      shadow_eval_corrected_skip_reason: 'no_attributable_follow_up',
    });
    result.skipped++;
    return;
  }

  const { question, humanResponses } = extracted;
  // The persisted assistant message is the attributable production source:
  // it carries the model/config/tool trace. Slack text is used only to detect
  // the follow-up ordering pattern, with a fallback for legacy unmirrored rows.
  const addieResponse = thread.source_answer_content || extracted.addieResponse;

  const addieShape = gradeShape(question, addieResponse);
  const longestHuman = humanResponses.reduce(
    (acc, h) => (h.length > acc.length ? h : acc),
    humanResponses[0],
  );
  const humanShape = gradeShape(question, longestHuman);
  // Deterministic failures are absolute. A matching human violation does not
  // make an Addie violation disappear; the human grade remains comparison
  // metadata for analysis.
  const shapeRegression = hasDeterministicShapeFailure(addieShape);
  const summarizedShape = summarizeShapeReports(addieShape, humanShape);

  const judgeModel = resolveShadowJudgeModel(
    thread.source_answer_model ? [thread.source_answer_model] : [],
  );
  const comparison = await compareResponses(
    client,
    question,
    humanResponses,
    addieResponse,
    judgeModel,
    'corrected_answer',
  );

  await threadService.patchThreadContext(thread.thread_id, {
    shadow_eval_status: 'complete',
    shadow_eval_type: 'corrected_answer',
    shadow_eval_source: 'addie_corrected_capture',
    shadow_eval_completed_at: new Date().toISOString(),
    shadow_eval_provenance: buildShadowEvalProvenance({
      evaluationType: 'corrected_answer',
      sourceKind: 'production',
      sourceModel: thread.source_answer_model,
      sourceConfigVersionId: thread.source_config_version_id,
      judgeModel,
      toolMode: thread.source_message_id ? 'production_trace' : 'none',
      traceOrFixtureId: thread.source_message_id,
    }),
    shadow_eval_question: question.substring(0, 500),
    shadow_eval_answer_response: addieResponse.substring(0, 2000),
    shadow_eval_shadow_response: addieResponse.substring(0, 2000),
    shadow_eval_human_response: humanResponses.join('\n---\n').substring(0, 2000),
    shadow_eval_result: comparison,
    shadow_eval_shape: summarizedShape,
  });

  const flagParts: string[] = [];
  if (!comparison.evaluation_valid) {
    flagParts.push(`Corrected-capture evaluation invalid: ${comparison.evaluation_error}`);
    result.errors++;
  } else if (comparison.knowledge_gap) {
    flagParts.push(
      `Corrected-capture gap (${comparison.gap_severity}): ${comparison.gap_details}`,
    );
    result.knowledge_gaps++;
  }
  if (shapeRegression) {
    flagParts.push(`Shape regression: ${addieShape.violationLabels.join(', ')}`);
    result.shape_regressions++;
  }
  if (flagParts.length > 0) {
    await threadService.flagThread(thread.thread_id, flagParts.join(' | '));
  }

  result.evaluated++;
  logger.info(
    {
      threadId: thread.thread_id,
      knowledge_gap: comparison.knowledge_gap,
      gap_severity: comparison.gap_severity,
      shadow_quality: comparison.shadow_quality,
      shape_regression: shapeRegression,
      addie_shape_violations: addieShape.violationLabels,
      human_shape_violations: humanShape.violationLabels,
      judge_model: judgeModel,
    },
    'Corrected capture: Evaluation complete',
  );
}

export async function runAddieCorrectedCaptureJob(
  options: { limit: number } = { limit: 20 },
): Promise<CorrectedCaptureResult> {
  const result: CorrectedCaptureResult = {
    evaluated: 0,
    knowledge_gaps: 0,
    shape_regressions: 0,
    skipped: 0,
    errors: 0,
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.warn('Corrected capture: ANTHROPIC_API_KEY not set');
    return result;
  }

  let candidates: CandidateThread[];
  try {
    candidates = await findCandidateThreads(options.limit);
  } catch (error) {
    logger.error({ error }, 'Corrected capture: Failed to find candidate threads');
    return result;
  }

  if (candidates.length === 0) return result;

  const client = new Anthropic({ apiKey });
  for (const candidate of candidates) {
    try {
      await processCandidate(client, candidate, result);
      // Pace the loop so a 20-thread batch doesn't burst Slack/Anthropic
      // simultaneously.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(
        { error, threadId: candidate.thread_id },
        'Corrected capture: Unhandled error processing candidate',
      );
      try {
        await getThreadService().patchThreadContext(candidate.thread_id, {
          shadow_eval_corrected_retry_after: new Date(Date.now() + 5 * 60_000).toISOString(),
          shadow_eval_corrected_error: 'unhandled_evaluation_error',
        });
      } catch { /* preserve the original job error */ }
      result.errors++;
    }
  }

  return result;
}

// Test-only export so the unit test can validate the pattern extractor
// independent of Slack and Anthropic.
export const __test_extractKatiePattern = extractCorrectedAnswerPattern;
