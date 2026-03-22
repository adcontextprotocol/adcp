import { createLogger } from '../../logger.js';
import { buildConversationInsights } from '../services/conversation-insights-builder.js';
import {
  createInsight,
  getInsightByWeek,
  markPosted,
  markFailed,
  type ConversationInsightsRecord,
} from '../../db/conversation-insights-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { sendChannelMessage } from '../../slack/client.js';

const logger = createLogger('conversation-insights');
const workingGroupDb = new WorkingGroupDatabase();

const EDITORIAL_SLUG = 'editorial';

export interface ConversationInsightsResult {
  generated: boolean;
  posted: boolean;
  skipped: boolean;
  error?: string;
}

/**
 * Get the current hour in US Eastern time
 */
function getETHour(): number {
  const now = new Date();
  const etString = now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(etString, 10);
}

/**
 * Format a Date as YYYY-MM-DD in ET
 */
function formatDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Get previous week's Monday and Sunday dates
 */
function getPreviousWeekRange(): { weekStart: Date; weekEnd: Date } {
  const now = new Date();
  // Get today in ET
  const etDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayOfWeek = etDate.getDay(); // 0=Sun, 1=Mon

  // Previous Monday: go back to this Monday, then back 7 more days
  const daysToThisMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const thisMonday = new Date(etDate);
  thisMonday.setDate(etDate.getDate() - daysToThisMonday);
  thisMonday.setHours(0, 0, 0, 0);

  const prevMonday = new Date(thisMonday);
  prevMonday.setDate(thisMonday.getDate() - 7);

  // Previous Sunday (end of prev week, exclusive for queries)
  const prevSunday = new Date(thisMonday);

  return { weekStart: prevMonday, weekEnd: prevSunday };
}

/**
 * Main job runner.
 * Runs hourly. On Mondays 8-9am ET: generates insights for the previous week
 * and posts to the Editorial Slack channel.
 *
 * Pass { force: true } to bypass day/time checks (for manual triggers).
 */
export async function runConversationInsightsJob(
  options: { force?: boolean } = {},
): Promise<ConversationInsightsResult> {
  const result: ConversationInsightsResult = { generated: false, posted: false, skipped: false };

  if (!options.force) {
    const now = new Date();
    const dayOfWeek = now.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    });

    if (dayOfWeek !== 'Mon') {
      return result;
    }

    const etHour = getETHour();
    if (etHour < 8 || etHour >= 9) {
      return result;
    }
  }

  const { weekStart, weekEnd } = getPreviousWeekRange();
  const weekStartStr = formatDate(weekStart);
  const weekEndStr = formatDate(weekEnd);

  // Idempotency check
  const existing = await getInsightByWeek(weekStartStr);
  if (existing) {
    logger.debug({ weekStart: weekStartStr }, 'Insights already exist for this week');
    return result;
  }

  logger.info({ weekStart: weekStartStr, weekEnd: weekEndStr }, 'Generating conversation insights');

  const insights = await buildConversationInsights(weekStart, weekEnd);

  if (!insights) {
    result.skipped = true;
    logger.info({ weekStart: weekStartStr }, 'Skipped - insufficient data or LLM unavailable');
    return result;
  }

  // Save to DB
  const record = await createInsight(weekStartStr, weekEndStr, insights.stats, insights.analysis, {
    model: insights.model,
    tokensInput: insights.tokensInput,
    tokensOutput: insights.tokensOutput,
    latencyMs: insights.latencyMs,
  });

  if (!record) {
    logger.debug({ weekStart: weekStartStr }, 'Insights already created by another instance');
    return result;
  }

  result.generated = true;
  logger.info({ weekStart: weekStartStr, id: record.id }, 'Conversation insights generated');

  // Post to Editorial Slack channel
  try {
    const posted = await postToSlack(record);
    result.posted = posted;
  } catch (err) {
    logger.error({ err, id: record.id }, 'Failed to post insights to Slack');
    await markFailed(record.id).catch((e) =>
      logger.error({ err: e }, 'Failed to mark insight as failed'),
    );
  }

  return result;
}

async function postToSlack(record: ConversationInsightsRecord): Promise<boolean> {
  const editorial = await workingGroupDb.getWorkingGroupBySlug(EDITORIAL_SLUG);
  if (!editorial?.slack_channel_id) {
    logger.error('Editorial working group has no Slack channel configured');
    return false;
  }

  const message = formatSlackMessage(record);
  const postResult = await sendChannelMessage(editorial.slack_channel_id, message);

  if (postResult.ok && postResult.ts) {
    await markPosted(record.id, editorial.slack_channel_id, postResult.ts);
    logger.info({ id: record.id, channel: editorial.slack_channel_id }, 'Insights posted to Slack');
    return true;
  } else {
    logger.error({ error: postResult.error }, 'Failed to post insights to Slack');
    await markFailed(record.id);
    return false;
  }
}

function formatSlackMessage(record: ConversationInsightsRecord) {
  const { stats, analysis } = record;
  const weekLabel = `${formatShortDate(record.week_start)} – ${formatShortDate(record.week_end)}`;

  const sections: string[] = [];

  // Header
  sections.push(`*Addie conversation insights: ${weekLabel}*`);

  // Stats line
  const channelBreakdown = Object.entries(stats.by_channel)
    .map(([ch, count]) => `${ch}: ${count}`)
    .join(', ');
  sections.push(
    `${stats.total_threads} threads · ${stats.total_messages} messages · ${stats.unique_users} users` +
    (channelBreakdown ? ` (${channelBreakdown})` : '') +
    (stats.avg_rating ? ` · avg rating: ${stats.avg_rating.toFixed(1)}/5` : '') +
    (stats.escalation_count > 0 ? ` · ${stats.escalation_count} escalations` : ''),
  );

  // Executive summary
  if (analysis.executive_summary) {
    sections.push(`\n${analysis.executive_summary}`);
  }

  // Question themes
  if (analysis.question_themes.length > 0) {
    sections.push('\n*Top question themes*');
    for (const theme of analysis.question_themes.slice(0, 5)) {
      sections.push(`• *${theme.theme}* (~${theme.count}x) – ${theme.description}`);
    }
  }

  // Documentation gaps
  if (analysis.documentation_gaps.length > 0) {
    sections.push('\n*Documentation gaps*');
    for (const gap of analysis.documentation_gaps.slice(0, 3)) {
      sections.push(`• *${gap.topic}*: ${gap.suggested_action}`);
    }
  }

  // Training gaps
  if (analysis.training_gaps.length > 0) {
    sections.push('\n*Training gaps*');
    for (const gap of analysis.training_gaps.slice(0, 3)) {
      sections.push(`• *${gap.topic}*: ${gap.suggested_module}`);
    }
  }

  // Addie improvements
  const highPriority = analysis.addie_improvements.filter((i) => i.severity === 'high');
  if (highPriority.length > 0) {
    sections.push('\n*Addie improvements (high priority)*');
    for (const item of highPriority.slice(0, 3)) {
      sections.push(`• *${item.area}*: ${item.suggested_fix}`);
    }
  }

  // Escalation patterns
  if (analysis.escalation_patterns.length > 0) {
    sections.push('\n*Escalation patterns*');
    for (const pattern of analysis.escalation_patterns.slice(0, 3)) {
      sections.push(`• *${pattern.pattern}* (${pattern.count}x) – ${pattern.suggested_action}`);
    }
  }

  return { text: sections.join('\n') };
}

function formatShortDate(date: Date): string {
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}
