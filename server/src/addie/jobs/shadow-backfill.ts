/**
 * Shadow Evaluation Backfill
 *
 * One-time script to mine historical conversations where Addie responded
 * in channels where humans also responded. Retroactively runs shadow
 * comparison to build an initial knowledge gap dataset.
 *
 * Run manually: npx tsx server/src/addie/jobs/shadow-backfill.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger } from '../../logger.js';
import { initializeDatabase, query } from '../../db/client.js';
import { getThreadReplies } from '../../slack/client.js';
import { getThreadService } from '../thread-service.js';
import { getDatabaseConfig } from '../../config.js';
import { compareResponses } from './shadow-evaluator.js';
import {
  buildShadowEvalProvenance,
  resolveShadowJudgeModel,
} from './shadow-eval-metadata.js';
import { extractCorrectedAnswerPattern } from './shadow-corrected-capture.js';

const logger = createLogger('shadow-backfill');

interface ChannelThread {
  thread_id: string;
  external_id: string;
  context: Record<string, unknown>;
  started_at: string;
  message_count: number;
  source_message_id: string | null;
  source_answer_content: string | null;
  source_answer_model: string | null;
  source_config_version_id: number | null;
}

/**
 * Find historical channel threads where Addie responded and humans
 * were also active in the Slack thread. These are candidates for
 * retroactive shadow evaluation.
 */
async function findCandidateThreads(
  limit: number,
  cursor: { startedAt: string; threadId: string } | null,
): Promise<ChannelThread[]> {
  const result = await query<ChannelThread>(
    `SELECT
       t.thread_id,
       t.external_id,
       t.context,
       t.started_at,
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
         AND length(m.content) > $4
         AND COALESCE(m.delivery_status, 'completed') = 'completed'
       ORDER BY m.created_at DESC
       LIMIT 1
     ) source ON TRUE
     WHERE t.channel = 'slack'
       AND t.context->>'message_type' = 'channel_message'
       AND t.message_count >= 2
       AND (t.context->>'shadow_eval_status') IS NULL
       AND t.started_at > NOW() - INTERVAL '30 days'
       AND (
         $2::timestamptz IS NULL
         OR (t.started_at, t.thread_id) < ($2::timestamptz, $3::uuid)
       )
     ORDER BY t.started_at DESC, t.thread_id DESC
     LIMIT $1`,
    [limit, cursor?.startedAt ?? null, cursor?.threadId ?? null, 20]
  );
  return result.rows;
}

async function backfill() {
  const dbConfig = getDatabaseConfig();
  if (!dbConfig) {
    console.error('DATABASE_URL required');
    process.exit(1);
  }
  initializeDatabase(dbConfig);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY required');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const threadService = getThreadService();

  let cursor: { startedAt: string; threadId: string } | null = null;
  const batchSize = 20;
  let totalProcessed = 0;
  let totalGaps = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  console.log('Starting shadow evaluation backfill...');

  while (true) {
    const threads = await findCandidateThreads(batchSize, cursor);
    if (threads.length === 0) break;

    for (const thread of threads) {
      const [channelId, threadTs] = thread.external_id.split(':');
      if (!channelId || !threadTs) {
        totalSkipped++;
        continue;
      }

      try {
        // Get Slack thread
        const slackMessages = await getThreadReplies(channelId, threadTs);
        if (slackMessages.length < 2) {
          totalSkipped++;
          continue;
        }

        const extracted = extractCorrectedAnswerPattern(
          slackMessages,
          thread.source_answer_content,
        );
        if (!extracted) {
          totalSkipped++;
          continue;
        }
        const { question, humanResponses } = extracted;
        const addieResponse = thread.source_answer_content || extracted.addieResponse;

        // Compare Addie's ACTUAL response with human response
        const humanText = humanResponses.join('\n---\n').substring(0, 1500);
        const addieText = addieResponse.substring(0, 1500);

        const judgeModel = resolveShadowJudgeModel(
          thread.source_answer_model ? [thread.source_answer_model] : [],
        );
        const result = await compareResponses(
          client,
          question,
          humanResponses,
          addieText,
          judgeModel,
          'historical_corrected_answer',
        );

        // Store results
        await threadService.patchThreadContext(thread.thread_id, {
          shadow_eval_status: 'complete',
          shadow_eval_type: 'historical_corrected_answer',
          shadow_eval_completed_at: new Date().toISOString(),
          shadow_eval_result: result,
          shadow_eval_source: 'backfill',
          shadow_eval_provenance: buildShadowEvalProvenance({
            evaluationType: 'historical_corrected_answer',
            sourceKind: 'production',
            sourceModel: thread.source_answer_model,
            sourceConfigVersionId: thread.source_config_version_id,
            judgeModel,
            toolMode: thread.source_message_id ? 'production_trace' : 'none',
            traceOrFixtureId: thread.source_message_id,
          }),
          shadow_eval_human_response: humanText.substring(0, 2000),
          shadow_eval_answer_response: addieText.substring(0, 2000),
          shadow_eval_shadow_response: addieText.substring(0, 2000),
          shadow_eval_question: question.substring(0, 500),
        });

        if (!result.evaluation_valid) {
          totalErrors++;
        } else if (result.knowledge_gap) {
          await threadService.flagThread(
            thread.thread_id,
            `Backfill knowledge gap (${result.gap_severity}): ${result.gap_details}`
          );
          totalGaps++;
          console.log(`  GAP [${result.gap_severity}]: ${result.gap_details.substring(0, 80)}`);
        }

        totalProcessed++;
        if (totalProcessed % 10 === 0) {
          console.log(`  Processed: ${totalProcessed}, Gaps: ${totalGaps}, Skipped: ${totalSkipped}`);
        }

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error({ error, threadId: thread.thread_id }, 'Backfill error');
        totalErrors++;
      }
    }

    const lastThread = threads[threads.length - 1];
    cursor = { startedAt: lastThread.started_at, threadId: lastThread.thread_id };
  }

  console.log(`\nBackfill complete:`);
  console.log(`  Processed: ${totalProcessed}`);
  console.log(`  Knowledge gaps: ${totalGaps}`);
  console.log(`  Skipped: ${totalSkipped}`);
  console.log(`  Errors: ${totalErrors}`);

  process.exit(0);
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
