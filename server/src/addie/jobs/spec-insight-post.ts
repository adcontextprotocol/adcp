/**
 * Spec Insight Post Job
 *
 * Runs hourly. On Thursdays at 10am ET, generates and posts an open-ended
 * spec question to a working group's Slack channel, inviting collaborative
 * exploration. Rotates across working groups that have Slack channels configured.
 * Tracks posts to avoid repeats.
 */

import { createLogger } from '../../logger.js';
import { query } from '../../db/client.js';
import { sendChannelMessage } from '../../slack/client.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import type { WorkingGroup } from '../../types.js';

const logger = createLogger('spec-insight-post');

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
 * Pick the working group that was posted to least recently.
 * Returns null if no eligible groups exist.
 */
async function pickNextWorkingGroup(candidates: WorkingGroup[]): Promise<WorkingGroup | null> {
  if (candidates.length === 0) return null;

  // Find the most recent post per working group
  const result = await query<{ working_group_id: string; last_posted: string }>(
    `SELECT working_group_id, MAX(created_at) as last_posted
     FROM spec_insight_posts
     WHERE working_group_id IS NOT NULL
     GROUP BY working_group_id`,
  );

  const lastPosted = new Map(result.rows.map(r => [r.working_group_id, new Date(r.last_posted)]));

  // Sort candidates: never-posted first, then oldest-posted first
  const sorted = [...candidates].sort((a, b) => {
    const aTime = lastPosted.get(a.id)?.getTime() ?? 0;
    const bTime = lastPosted.get(b.id)?.getTime() ?? 0;
    return aTime - bTime;
  });

  return sorted[0];
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
 * Build topic context from the working group's name, description, and topics.
 */
function buildGroupContext(wg: WorkingGroup): string {
  const parts = [`Working group: ${wg.name}`];
  if (wg.description) parts.push(`Focus: ${wg.description}`);
  const topics = (wg as WorkingGroup & { topics?: Array<{ name: string; slug: string }> }).topics;
  if (topics && topics.length > 0) {
    parts.push(`Topics: ${topics.map(t => t.name).join(', ')}`);
  }
  return parts.join('\n');
}

/**
 * Generate an open-ended spec question using LLM, tailored to a working group.
 */
async function generateInsight(
  wg: WorkingGroup,
  recentTitles: string[],
): Promise<{ title: string; body: string } | null> {
  if (!isLLMConfigured()) return null;

  const recentContext = recentTitles.length > 0
    ? `\n\nRecent posts across all groups (avoid repeating these topics):\n${recentTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const groupContext = buildGroupContext(wg);

  const result = await complete({
    system: `You are Addie, the AI assistant for AgenticAdvertising.org, which develops the AdCP (Ad Context Protocol) for agentic advertising.

Generate an open-ended, thought-provoking question about the AdCP protocol that would spark discussion in a specific working group. The question should:

1. Be relevant to this group's focus area
2. Touch on a real edge case, ambiguity, or design tension in the protocol
3. Be specific enough to be interesting (not generic like "how should errors be handled")
4. Be genuinely open — you don't know the answer and want to explore it collaboratively
5. Sound like you thinking out loud, not lecturing

${groupContext}

Respond in JSON format:
{
  "title": "Short topic label (5-8 words)",
  "body": "The conversational post text (2-4 sentences). Start with a phrase like 'Something I've been thinking about' or 'Here's a question I keep coming back to' or similar. End by inviting someone to think through it together."
}${recentContext}`,
    prompt: 'Generate a spec insight post for this working group.',
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
async function storePost(
  title: string,
  body: string,
  channelId: string,
  workingGroupId: string,
  messageTs?: string,
): Promise<void> {
  await query(
    `INSERT INTO spec_insight_posts (title, body, channel_id, working_group_id, slack_message_ts)
     VALUES ($1, $2, $3, $4, $5)`,
    [title, body, channelId, workingGroupId, messageTs || null],
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

  // Find working groups with Slack channels
  const workingGroupDb = new WorkingGroupDatabase();
  const candidates = await workingGroupDb.listWorkingGroupsWithSlackChannel();

  if (candidates.length === 0) {
    logger.error('No working groups have Slack channels configured — cannot post spec insight');
    result.error = 'No working groups with Slack channels';
    return result;
  }

  // Pick the group posted to least recently
  const targetWg = await pickNextWorkingGroup(candidates);
  if (!targetWg) {
    result.error = 'No eligible working group found';
    return result;
  }

  // Generate the insight tailored to this group
  const recentTitles = await getRecentPostTitles();
  const insight = await generateInsight(targetWg, recentTitles);

  if (!insight) {
    result.skipped = true;
    logger.info('Skipped spec insight post — LLM unavailable or generation failed');
    return result;
  }

  // Post to Slack
  const postResult = await sendChannelMessage(targetWg.slack_channel_id!, {
    text: insight.body,
  });

  if (!postResult.ok) {
    result.error = postResult.error || 'Failed to post to Slack';
    logger.error({ error: postResult.error, slug: targetWg.slug }, 'Failed to post spec insight');
    return result;
  }

  // Store for dedup
  await storePost(insight.title, insight.body, targetWg.slack_channel_id!, targetWg.id, postResult.ts);

  result.posted = true;
  logger.info({ title: insight.title, group: targetWg.slug, channel: targetWg.slack_channel_id }, 'Spec insight posted');

  return result;
}
