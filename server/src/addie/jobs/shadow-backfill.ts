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
import { ModelConfig } from '../../config/models.js';
import { getDatabaseConfig } from '../../config.js';

const logger = createLogger('shadow-backfill');

interface ChannelThread {
  thread_id: string;
  external_id: string;
  context: Record<string, unknown>;
  started_at: string;
  message_count: number;
}

/**
 * Find historical channel threads where Addie responded and humans
 * were also active in the Slack thread. These are candidates for
 * retroactive shadow evaluation.
 */
async function findCandidateThreads(limit: number, offset: number): Promise<ChannelThread[]> {
  const result = await query<ChannelThread>(
    `SELECT t.thread_id, t.external_id, t.context, t.started_at, t.message_count
     FROM addie_threads t
     WHERE t.channel = 'slack'
       AND t.context->>'message_type' = 'channel_message'
       AND t.message_count >= 2
       AND (t.context->>'shadow_eval_status') IS NULL
       AND t.started_at > NOW() - INTERVAL '30 days'
     ORDER BY t.started_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
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

  let offset = 0;
  const batchSize = 20;
  let totalProcessed = 0;
  let totalGaps = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  console.log('Starting shadow evaluation backfill...');

  while (true) {
    const threads = await findCandidateThreads(batchSize, offset);
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

        // Find the original question (first message)
        const question = slackMessages[0]?.text;
        if (!question || question.length < 20) {
          totalSkipped++;
          continue;
        }

        // Find human responses (non-bot, after the question)
        const humanResponses = slackMessages
          .filter(msg => msg.user && !('bot_id' in msg && msg.bot_id) && msg.ts > slackMessages[0].ts && msg.text)
          .map(msg => msg.text!)
          .filter(text => text.length > 20);

        // Find Addie's response
        const addieResponse = slackMessages
          .find(msg => ('bot_id' in msg && msg.bot_id) && msg.text && msg.text.length > 20);

        // Need both human and Addie responses for comparison
        if (humanResponses.length === 0 || !addieResponse?.text) {
          totalSkipped++;
          continue;
        }

        // Compare Addie's ACTUAL response with human response
        const humanText = humanResponses.join('\n---\n').substring(0, 1500);
        const addieText = addieResponse.text.substring(0, 1500);

        const comparison = await client.messages.create({
          model: ModelConfig.fast,
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `Compare these two responses to the same question. Focus on SUBSTANCE (facts, recommendations, actionable info), not style or length.

## Question
"${question.substring(0, 500)}"

## Human Expert Response
${humanText}

## Addie's Response
${addieText}

## Assessment
Respond with ONLY a JSON object:
{
  "knowledge_gap": true/false,
  "gap_severity": "none" | "minor" | "significant" | "critical",
  "gap_details": "Brief description of what was missing or wrong",
  "shadow_quality": "better" | "equivalent" | "worse" | "different_focus"
}`,
          }],
        });

        const responseText = comparison.content[0].type === 'text' ? comparison.content[0].text : '';
        let result;
        try {
          let jsonStr = responseText.trim();
          if (jsonStr.startsWith('```')) jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
          result = JSON.parse(jsonStr);
        } catch {
          result = { knowledge_gap: false, gap_severity: 'none', gap_details: 'Parse error', shadow_quality: 'equivalent' };
        }

        // Store results
        await threadService.patchThreadContext(thread.thread_id, {
          shadow_eval_status: 'complete',
          shadow_eval_completed_at: new Date().toISOString(),
          shadow_eval_result: result,
          shadow_eval_source: 'backfill',
          shadow_eval_human_response: humanText.substring(0, 2000),
          shadow_eval_shadow_response: addieText.substring(0, 2000),
          shadow_eval_question: question.substring(0, 500),
        });

        if (result.knowledge_gap) {
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

    offset += batchSize;
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
