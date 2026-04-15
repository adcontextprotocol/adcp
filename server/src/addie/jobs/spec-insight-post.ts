/**
 * Spec Insight Post Job
 *
 * Runs hourly. On Thursdays at 10am ET, generates and posts an open-ended
 * spec question to a public Slack channel, inviting collaborative exploration.
 * Tracks posts to avoid repeats.
 */

import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { sendChannelMessage } from '../../slack/client.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';

const logger = createLogger('spec-insight-post');

/** Channel to post to. Falls back to the general working group channel. */
const TARGET_CHANNEL_SLUG = process.env.SPEC_INSIGHT_CHANNEL_SLUG || 'general';

export interface SpecInsightPostResult {
  posted: boolean;
  skipped: boolean;
  error?: string;
}

function getETHour(): number {
  const now = new Date();
  const etString = now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  const hour = parseInt(etString.replace(/\D/g, ''), 10);
  return isNaN(hour) ? -1 : hour;
}

function getETDayOfWeek(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  });
}

/**
 * Check if we already posted this week (Monday-Sunday).
 */
async function hasPostedThisWeek(): Promise<boolean> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM spec_insight_posts
     WHERE created_at >= date_trunc('week', NOW() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'`,
  );
  return parseInt(result.rows[0]?.count || '0', 10) > 0;
}

/**
 * Get recent post titles for dedup context.
 */
async function getRecentPostTitles(limit: number = 10): Promise<string[]> {
  const result = await query<{ title: string }>(
    `SELECT title FROM spec_insight_posts ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map(r => r.title);
}

/**
 * Generate an open-ended spec question using LLM.
 */
async function generateInsight(recentTitles: string[]): Promise<{ title: string; body: string } | null> {
  if (!isLLMConfigured()) return null;

  const recentContext = recentTitles.length > 0
    ? `\n\nRecent posts (avoid repeating these topics):\n${recentTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const result = await complete({
    system: `You are Addie, the AI assistant for AgenticAdvertising.org, which develops the AdCP (Ad Context Protocol) for agentic advertising.

Generate an open-ended, thought-provoking question about the AdCP protocol that would spark discussion among implementers and protocol contributors. The question should:

1. Touch on a real edge case, ambiguity, or design tension in the protocol
2. Be specific enough to be interesting (not generic like "how should errors be handled")
3. Be genuinely open — you don't know the answer and want to explore it collaboratively
4. Sound like you thinking out loud, not lecturing

Topics to draw from: media buy lifecycle, proposal negotiation, creative delivery, measurement and attribution, property catalogs, brand discovery (brand.json/adagents.json), sampling, cancellation windows, guaranteed vs programmatic buys, cross-publisher frequency, agent authentication, buy terms.

Respond in JSON format:
{
  "title": "Short topic label (5-8 words)",
  "body": "The conversational post text (2-4 sentences). Start with a phrase like 'Something I've been thinking about' or 'Here's a question I keep coming back to' or similar. End by inviting someone to think through it together."
}${recentContext}`,
    prompt: 'Generate a spec insight post for this week.',
    maxTokens: 400,
    model: 'fast',
    operationName: 'spec-insight-generate',
  });

  return parseInsightResponse(result.text);
}

/**
 * Parse and validate LLM JSON response for spec insight generation.
 */
function parseInsightResponse(text: string): { title: string; body: string } | null {
  const tryParse = (json: string): { title: string; body: string } | null => {
    try {
      const parsed = JSON.parse(json);
      if (typeof parsed.title === 'string' && parsed.title.trim() &&
          typeof parsed.body === 'string' && parsed.body.trim()) {
        return { title: parsed.title.trim(), body: parsed.body.trim() };
      }
    } catch { /* fall through */ }
    return null;
  };

  // Try parsing the full response
  const direct = tryParse(text);
  if (direct) return direct;

  // Try extracting JSON object from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const extracted = tryParse(jsonMatch[0]);
    if (extracted) return extracted;
  }

  logger.warn({ text }, 'Failed to parse spec insight LLM response');
  return null;
}

/**
 * Store the posted insight for dedup tracking.
 */
async function storePost(title: string, body: string, channelId: string, messageTs?: string): Promise<void> {
  await query(
    `INSERT INTO spec_insight_posts (title, body, channel_id, slack_message_ts)
     VALUES ($1, $2, $3, $4)`,
    [title, body, channelId, messageTs || null],
  );
}

export async function runSpecInsightPostJob(
  options: { force?: boolean } = {},
): Promise<SpecInsightPostResult> {
  const result: SpecInsightPostResult = { posted: false, skipped: false };

  // Time gate: Thursdays 10-11am ET
  if (!options.force) {
    const day = getETDayOfWeek();
    if (day !== 'Thu') return result;

    const hour = getETHour();
    if (hour < 10 || hour >= 11) return result;
  }

  // Idempotency: one post per week
  const alreadyPosted = await hasPostedThisWeek();
  if (alreadyPosted) {
    logger.debug('Spec insight already posted this week');
    result.skipped = true;
    return result;
  }

  // Find target channel
  const workingGroupDb = new WorkingGroupDatabase();
  const targetWg = await workingGroupDb.getWorkingGroupBySlug(TARGET_CHANNEL_SLUG);
  if (!targetWg?.slack_channel_id) {
    logger.error({ slug: TARGET_CHANNEL_SLUG }, 'Target working group has no Slack channel');
    result.error = `No Slack channel for ${TARGET_CHANNEL_SLUG}`;
    return result;
  }

  // Generate the insight
  const recentTitles = await getRecentPostTitles();
  const insight = await generateInsight(recentTitles);

  if (!insight) {
    result.skipped = true;
    logger.info('Skipped spec insight post — LLM unavailable or generation failed');
    return result;
  }

  // Post to Slack
  const postResult = await sendChannelMessage(targetWg.slack_channel_id, {
    text: insight.body,
  });

  if (!postResult.ok) {
    result.error = postResult.error || 'Failed to post to Slack';
    logger.error({ error: postResult.error }, 'Failed to post spec insight');
    return result;
  }

  // Store for dedup
  await storePost(insight.title, insight.body, targetWg.slack_channel_id, postResult.ts);

  result.posted = true;
  logger.info({ title: insight.title, channel: targetWg.slack_channel_id }, 'Spec insight posted');

  return result;
}
