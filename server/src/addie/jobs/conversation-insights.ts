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
export function getPreviousWeekRange(now: Date = new Date()): { weekStart: Date; weekEnd: Date } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  const etCalendarDate = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
  const daysToThisMonday = (etCalendarDate.getUTCDay() + 6) % 7;
  const thisMondayCalendar = new Date(etCalendarDate);
  thisMondayCalendar.setUTCDate(etCalendarDate.getUTCDate() - daysToThisMonday);
  const previousMondayCalendar = new Date(thisMondayCalendar);
  previousMondayCalendar.setUTCDate(thisMondayCalendar.getUTCDate() - 7);

  return {
    weekStart: easternMidnight(previousMondayCalendar),
    weekEnd: easternMidnight(thisMondayCalendar),
  };
}

/** Convert a UTC calendar-only date to midnight for that date in US Eastern time. */
function easternMidnight(calendarDate: Date): Date {
  const year = calendarDate.getUTCFullYear();
  const month = calendarDate.getUTCMonth();
  const day = calendarDate.getUTCDate();
  const noonUtc = new Date(Date.UTC(year, month, day, 12));
  const zonedParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(noonUtc);
  const zonedPart = (type: Intl.DateTimeFormatPartTypes) =>
    Number(zonedParts.find((entry) => entry.type === type)?.value);
  const representedAsUtc = Date.UTC(
    zonedPart('year'),
    zonedPart('month') - 1,
    zonedPart('day'),
    zonedPart('hour'),
    zonedPart('minute'),
    zonedPart('second'),
  );
  const offsetMs = representedAsUtc - noonUtc.getTime();
  return new Date(Date.UTC(year, month, day) - offsetMs);
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

export function formatSlackMessage(record: ConversationInsightsRecord) {
  const { stats, analysis } = record;
  // These are PostgreSQL DATE columns. Render them as calendar dates rather
  // than Eastern instants (node-postgres parses DATE at UTC midnight).
  const weekLabel = `${formatShortDate(record.week_start)} – ${formatShortDate(record.week_end, -1)}`;

  const sections: string[] = [];

  // Header
  sections.push(`*Addie conversation insights: ${weekLabel}*`);

  // Stats line
  const channelBreakdown = Object.entries(stats.by_channel)
    .map(([ch, count]) => `${ch}: ${count}`)
    .join(', ');
  sections.push(
    `${stats.total_threads} threads · ${stats.total_messages} messages · ${stats.unique_users} users` +
    (channelBreakdown ? ` · threads by channel: ${channelBreakdown}` : '') +
    (typeof stats.avg_rating === 'number'
      ? ` · avg rating: ${stats.avg_rating.toFixed(2)}/5${stats.rated_response_count !== undefined ? ` from ${stats.rated_response_count} ratings` : ''}`
      : '') +
    (stats.escalation_count > 0 ? ` · ${stats.escalation_count} escalations` : ''),
  );

  if (stats.sampled_thread_count !== undefined) {
    sections.push(`Analysis sample: ${stats.sampled_thread_count}/${stats.total_threads} threads (risk-weighted toward escalations and low ratings).`);
  }

  const hasOperationalSignals = [
    stats.tool_failure_count,
    stats.empty_response_fallback_count,
    stats.unrecovered_interruption_count,
  ].some((value) => value !== undefined);
  if (hasOperationalSignals) {
    const operationalSummary = [
      `${stats.tool_failure_count ?? 0} failed tool executions`,
      `${stats.empty_response_fallback_count ?? 0} empty-response fallbacks`,
      `${stats.unrecovered_interruption_count ?? 0} unrecovered browser turns`,
    ];
    sections.push(`\n*Operational signals*\n${operationalSummary.join(' · ')}`);
    for (const [name, count] of Object.entries(stats.tool_failures_by_name ?? {}).slice(0, 5)) {
      sections.push(`• *${name}*: ${count}${formatEvidenceLinks(stats.tool_failure_thread_ids?.[name])}`);
    }
    if ((stats.empty_response_fallback_count ?? 0) > 0) {
      sections.push(`• Empty-response fallbacks${formatEvidenceLinks(stats.empty_response_fallback_thread_ids)}`);
    }
    if ((stats.unrecovered_interruption_count ?? 0) > 0) {
      sections.push(`• Unrecovered browser turns${formatEvidenceLinks(stats.unrecovered_interruption_thread_ids)}`);
    }
  }

  if (stats.escalation_count > 0) {
    const escalationBreakdown = Object.entries(stats.escalation_by_category)
      .map(([category, count]) => `${category}: ${count}`)
      .join(', ');
    if (escalationBreakdown) sections.push(`Escalations by category: ${escalationBreakdown}`);
  }

  // Executive summary
  if (analysis.executive_summary) {
    sections.push(`\n${analysis.executive_summary}${formatEvidenceLinks(analysis.executive_summary_evidence_thread_ids)}`);
  }

  // Question themes
  if (analysis.question_themes.length > 0) {
    sections.push('\n*Top question themes (from sampled threads, organic only)*');
    for (const theme of analysis.question_themes.slice(0, 5)) {
      sections.push(`• *${theme.theme}* (${theme.sample_count}× in sample) – ${theme.description}${formatEvidenceLinks(theme.evidence_thread_ids)}`);
    }
  }

  // Documentation gaps
  if (analysis.documentation_gaps.length > 0) {
    sections.push('\n*Documentation candidates (verify against current docs)*');
    for (const gap of analysis.documentation_gaps.slice(0, 3)) {
      sections.push(`• *${gap.topic}*: ${gap.suggested_action}${formatEvidenceLinks(gap.evidence_thread_ids)}`);
    }
  }

  // Training gaps
  if (analysis.training_gaps.length > 0) {
    sections.push('\n*Training gaps*');
    for (const gap of analysis.training_gaps.slice(0, 3)) {
      sections.push(`• *${gap.topic}*: ${gap.suggested_module}${formatEvidenceLinks(gap.evidence_thread_ids)}`);
    }
  }

  // Addie improvements
  const highPriority = analysis.addie_improvements.filter((i) => i.severity === 'high');
  if (highPriority.length > 0) {
    sections.push('\n*Addie improvements (high priority)*');
    for (const item of highPriority.slice(0, 3)) {
      sections.push(`• *${item.area}*: ${item.suggested_fix}${formatEvidenceLinks(item.evidence_thread_ids)}`);
    }
  }

  // Escalation patterns
  if (analysis.escalation_patterns.length > 0) {
    sections.push('\n*Escalation patterns*');
    for (const pattern of analysis.escalation_patterns.slice(0, 3)) {
      sections.push(`• *${pattern.pattern}* (${pattern.count}× in escalation sample) – ${pattern.suggested_action}${formatEvidenceLinks(pattern.evidence_thread_ids)}`);
    }
  }

  return { text: sections.join('\n') };
}

function formatEvidenceLinks(threadIds: string[] | undefined): string {
  const uniqueIds = [...new Set(threadIds ?? [])].slice(0, 3);
  if (uniqueIds.length === 0) return '';
  const links = uniqueIds.map((threadId) =>
    `<https://agenticadvertising.org/admin/addie?thread=${encodeURIComponent(threadId)}|thread ${threadId.slice(0, 8)}>`,
  );
  return ` — evidence: ${links.join(', ')}`;
}

function formatShortDate(date: Date, dayOffset = 0): string {
  const parsed = new Date(date);
  const calendarDate = new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate() + dayOffset,
  ));
  return calendarDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
