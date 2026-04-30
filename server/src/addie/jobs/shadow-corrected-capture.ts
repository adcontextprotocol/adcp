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
  resolveShadowModel,
  summarizeShapeReports,
} from './shadow-evaluator.js';

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
    `SELECT t.thread_id, t.external_id
     FROM addie_threads t
     WHERE t.channel = 'slack'
       AND t.external_id LIKE '%:%'
       AND t.last_message_at < NOW() - INTERVAL '30 minutes'
       AND t.last_message_at > NOW() - INTERVAL '24 hours'
       AND (t.context->>'shadow_eval_status') IS NULL
       AND EXISTS (
         SELECT 1 FROM addie_thread_messages m
         WHERE m.thread_id = t.thread_id
           AND m.role = 'assistant'
           AND length(m.content) > $2
       )
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
function extractKatiePattern(
  messages: Array<{ user?: string; text?: string; bot_id?: string; ts: string }>,
): SlackThreadPayload | null {
  if (messages.length < 2) return null;

  const sorted = [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // Question = first substantive non-bot message.
  const question = sorted.find(
    (m) => !m.bot_id && m.text && m.text.length > SUBSTANTIVE_TEXT_MIN,
  );
  if (!question?.text) return null;

  // Addie's response = the LAST bot message in the thread (so we capture her
  // most recent answer, not a stale one if she posted twice).
  const addieResponse = [...sorted]
    .reverse()
    .find((m) => m.bot_id && m.text && m.text.length > SUBSTANTIVE_TEXT_MIN);
  if (!addieResponse?.text) return null;

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

async function processCandidate(
  client: Anthropic,
  judgeModel: string,
  thread: CandidateThread,
  result: CorrectedCaptureResult,
): Promise<void> {
  const threadService = getThreadService();
  const [channelId, threadTs] = thread.external_id.split(':');
  if (!channelId || !threadTs) {
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
    result.errors++;
    return;
  }

  const extracted = extractKatiePattern(slackMessages);
  if (!extracted) {
    result.skipped++;
    return;
  }

  const { question, addieResponse, humanResponses } = extracted;

  const addieShape = gradeShape(question, addieResponse);
  const longestHuman = humanResponses.reduce(
    (acc, h) => (h.length > acc.length ? h : acc),
    humanResponses[0],
  );
  const humanShape = gradeShape(question, longestHuman);
  const shapeRegression =
    addieShape.violationLabels.length > humanShape.violationLabels.length;
  const summarizedShape = summarizeShapeReports(addieShape, humanShape);

  const comparison = await compareResponses(
    client,
    question,
    humanResponses,
    addieResponse,
    judgeModel,
  );

  await threadService.patchThreadContext(thread.thread_id, {
    shadow_eval_status: 'complete',
    shadow_eval_source: 'addie_corrected_capture',
    shadow_eval_completed_at: new Date().toISOString(),
    shadow_eval_question: question.substring(0, 500),
    shadow_eval_shadow_response: addieResponse.substring(0, 2000),
    shadow_eval_human_response: humanResponses.join('\n---\n').substring(0, 2000),
    shadow_eval_result: comparison,
    shadow_eval_shape: summarizedShape,
  });

  const flagParts: string[] = [];
  if (comparison.knowledge_gap) {
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
  const judgeModel = resolveShadowModel();

  for (const candidate of candidates) {
    try {
      await processCandidate(client, judgeModel, candidate, result);
      // Pace the loop so a 20-thread batch doesn't burst Slack/Anthropic
      // simultaneously.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(
        { error, threadId: candidate.thread_id },
        'Corrected capture: Unhandled error processing candidate',
      );
      result.errors++;
    }
  }

  return result;
}

// Test-only export so the unit test can validate the pattern extractor
// independent of Slack and Anthropic.
export const __test_extractKatiePattern = extractKatiePattern;
