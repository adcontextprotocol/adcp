/**
 * Job Definitions
 *
 * Declarative configuration for all scheduled background jobs.
 * Call registerAllJobs() on startup to register them with the scheduler.
 */

import { jobScheduler } from './scheduler.js';
import { runDocumentIndexerJob } from './committee-document-indexer.js';
import { runSummaryGeneratorJob } from './committee-summary-generator.js';
import { runOutreachScheduler } from '../services/proactive-outreach.js';
import { enrichMissingOrganizations } from '../../services/enrichment.js';
import { runMoltbookPosterJob } from './moltbook-poster.js';
import { runMoltbookEngagementJob } from './moltbook-engagement.js';
import { runTaskReminderJob } from './task-reminder.js';
import { runEngagementScoringJob } from './engagement-scoring.js';
import { runGoalFollowUpJob } from './goal-follow-up.js';
import {
  processPendingResources,
  processRssPerspectives,
  processCommunityArticles,
} from '../services/content-curator.js';
import { sendCommunityReplies } from '../services/community-articles.js';
import { processFeedsToFetch } from '../services/feed-fetcher.js';
import { processAlerts } from '../services/industry-alerts.js';
import { sendChannelMessage } from '../../slack/client.js';
import { runPersonaInferenceJob } from '../services/persona-inference.js';
import { runJourneyComputationJob } from '../services/journey-computation.js';
import { runKnowledgeStalenessJob } from './knowledge-staleness.js';
import { processUntriagedDomains, escalateUnclaimedProspects } from '../../services/prospect-triage.js';
import { runWeeklyDigestJob } from './weekly-digest.js';
import { logger } from '../../logger.js';

const jobLogger = logger.child({ module: 'content-curator-job' });

/**
 * Composite runner for content curator that runs multiple sub-tasks sequentially.
 * Processes: pending resources, RSS perspectives, community articles, community replies.
 * Each sub-task is wrapped in try/catch to allow partial success.
 */
async function runContentCuratorJob() {
  const results = {
    pendingResources: { processed: 0, succeeded: 0, failed: 0 },
    rssPerspectives: { processed: 0, succeeded: 0, failed: 0 },
    communityArticles: { processed: 0, succeeded: 0, failed: 0 },
    communityReplies: { sent: 0, failed: 0 },
  };

  try {
    results.pendingResources = await processPendingResources({ limit: 5 });
  } catch (error) {
    jobLogger.error({ error }, 'Content curator: pending resources failed');
  }

  try {
    results.rssPerspectives = await processRssPerspectives({ limit: 5 });
  } catch (error) {
    jobLogger.error({ error }, 'Content curator: RSS perspectives failed');
  }

  try {
    results.communityArticles = await processCommunityArticles({ limit: 5 });
  } catch (error) {
    jobLogger.error({ error }, 'Content curator: community articles failed');
  }

  try {
    results.communityReplies = await sendCommunityReplies(async (channelId, threadTs, text) => {
      const result = await sendChannelMessage(channelId, { text, thread_ts: threadTs });
      return result.ok;
    });
  } catch (error) {
    jobLogger.error({ error }, 'Content curator: community replies failed');
  }

  return results;
}

/**
 * Register all job configurations with the scheduler.
 * Call this on startup before starting jobs.
 */
export function registerAllJobs(): void {
  // Document indexer - indexes Google Docs tracked by committees
  jobScheduler.register({
    name: 'document-indexer',
    description: 'Document indexer',
    interval: { value: 60, unit: 'minutes' },
    initialDelay: { value: 1, unit: 'minutes' },
    runner: runDocumentIndexerJob,
    options: { batchSize: 20 },
    shouldLogResult: (r) => r.documentsChecked > 0,
  });

  // Summary generator - generates AI summaries for committees
  jobScheduler.register({
    name: 'summary-generator',
    description: 'Summary generator',
    interval: { value: 24, unit: 'hours' },
    initialDelay: { value: 5, unit: 'minutes' },
    runner: runSummaryGeneratorJob,
    options: { batchSize: 10 },
    shouldLogResult: (r) => r.summariesGenerated > 0,
  });

  // Proactive outreach - sends DMs to eligible users (has internal per-user business hours check)
  jobScheduler.register({
    name: 'proactive-outreach',
    description: 'Proactive outreach',
    interval: { value: 20, unit: 'minutes' },
    initialDelay: { value: 2, unit: 'minutes' },
    runner: runOutreachScheduler,
    options: { limit: 8 },
  });

  // Account enrichment - enriches accounts via Lusha API
  jobScheduler.register({
    name: 'account-enrichment',
    description: 'Account enrichment',
    interval: { value: 6, unit: 'hours' },
    initialDelay: { value: 3, unit: 'minutes' },
    runner: enrichMissingOrganizations,
    options: { limit: 50, includeEmptyProspects: true },
    shouldLogResult: (r) => r.enriched > 0 || r.failed > 0,
  });

  // Moltbook poster - posts articles to Moltbook
  jobScheduler.register({
    name: 'moltbook-poster',
    description: 'Moltbook poster',
    interval: { value: 2, unit: 'hours' },
    initialDelay: { value: 10, unit: 'minutes' },
    runner: runMoltbookPosterJob,
    options: { limit: 1 },
    shouldLogResult: (r) => r.postsCreated > 0,
  });

  // Moltbook engagement - engages with Moltbook discussions and checks DMs
  jobScheduler.register({
    name: 'moltbook-engagement',
    description: 'Moltbook engagement',
    interval: { value: 4, unit: 'hours' },
    initialDelay: { value: 10, unit: 'minutes' },
    runner: runMoltbookEngagementJob,
    options: { limit: 5 },
    shouldLogResult: (r) => r.commentsCreated > 0 || r.interestingThreads > 0 || r.dmsHandled > 0,
  });

  // Content curator - processes external content for knowledge base
  jobScheduler.register({
    name: 'content-curator',
    description: 'Content curator',
    interval: { value: 5, unit: 'minutes' },
    initialDelay: { value: 30, unit: 'seconds' },
    runner: runContentCuratorJob,
    shouldLogResult: (r) =>
      r.pendingResources.processed > 0 ||
      r.rssPerspectives.processed > 0 ||
      r.communityArticles.processed > 0 ||
      r.communityReplies.sent > 0,
  });

  // Feed fetcher - fetches RSS feeds
  jobScheduler.register({
    name: 'feed-fetcher',
    description: 'Feed fetcher',
    interval: { value: 30, unit: 'minutes' },
    initialDelay: { value: 1, unit: 'minutes' },
    runner: processFeedsToFetch,
    shouldLogResult: (r) => r.feedsProcessed > 0,
  });

  // Alert processor - sends industry alerts
  jobScheduler.register({
    name: 'alert-processor',
    description: 'Alert processor',
    interval: { value: 5, unit: 'minutes' },
    initialDelay: { value: 2, unit: 'minutes' },
    runner: processAlerts,
    shouldLogResult: (r) => r.alerted > 0,
  });

  // Task reminder - sends task reminders during morning hours
  jobScheduler.register({
    name: 'task-reminder',
    description: 'Task reminder',
    interval: { value: 1, unit: 'hours' },
    runner: runTaskReminderJob,
    businessHours: { startHour: 8, endHour: 11, skipWeekends: true },
    shouldLogResult: (r) => r.remindersSent > 0,
  });

  // Engagement scoring - updates engagement scores
  jobScheduler.register({
    name: 'engagement-scoring',
    description: 'Engagement scoring',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 10, unit: 'seconds' },
    runner: runEngagementScoringJob,
  });

  // Goal follow-up - sends follow-up messages during business hours
  jobScheduler.register({
    name: 'goal-follow-up',
    description: 'Goal follow-up',
    interval: { value: 4, unit: 'hours' },
    initialDelay: { value: 3, unit: 'minutes' },
    runner: runGoalFollowUpJob,
    businessHours: { startHour: 9, endHour: 18, skipWeekends: true },
    shouldLogResult: (r) => r.followUpsSent > 0 || r.goalsReconciled > 0,
  });

  // Persona inference - infers personas from signals for unclassified orgs
  jobScheduler.register({
    name: 'persona-inference',
    description: 'Persona inference',
    interval: { value: 6, unit: 'hours' },
    initialDelay: { value: 5, unit: 'minutes' },
    runner: runPersonaInferenceJob,
    options: { limit: 50 },
    shouldLogResult: (r) => r.inferred > 0,
  });

  // Journey stage computation - recomputes journey stages
  jobScheduler.register({
    name: 'journey-computation',
    description: 'Journey stage computation',
    interval: { value: 2, unit: 'hours' },
    initialDelay: { value: 4, unit: 'minutes' },
    runner: runJourneyComputationJob,
    options: { limit: 100 },
    shouldLogResult: (r) => r.transitions > 0,
  });

  // Knowledge staleness - detects stale org knowledge
  jobScheduler.register({
    name: 'knowledge-staleness',
    description: 'Knowledge staleness check',
    interval: { value: 24, unit: 'hours' },
    initialDelay: { value: 10, unit: 'minutes' },
    runner: runKnowledgeStalenessJob,
    options: { limit: 200 },
    shouldLogResult: (r) => r.staleEntries > 0,
  });

  // Prospect triage - assesses unmapped Slack domains and creates prospects
  jobScheduler.register({
    name: 'prospect-triage',
    description: 'Prospect triage for unmapped domains',
    interval: { value: 4, unit: 'hours' },
    initialDelay: { value: 15, unit: 'minutes' },
    runner: processUntriagedDomains,
    options: { limit: 20 },
    businessHours: { startHour: 9, endHour: 18, skipWeekends: true },
    shouldLogResult: (r) => r.created > 0,
  });

  // Prospect escalation - auto-assigns unclaimed prospects to Addie after 48h
  jobScheduler.register({
    name: 'prospect-escalation',
    description: 'Escalate unclaimed prospects to Addie',
    interval: { value: 6, unit: 'hours' },
    initialDelay: { value: 20, unit: 'minutes' },
    runner: escalateUnclaimedProspects,
    businessHours: { startHour: 9, endHour: 18, skipWeekends: true },
    shouldLogResult: (r) => r.escalated > 0,
  });

  // Weekly digest - generates and sends Tuesday digest after Editorial approval
  jobScheduler.register({
    name: 'weekly-digest',
    description: 'Weekly digest',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 6, unit: 'minutes' },
    runner: runWeeklyDigestJob,
    shouldLogResult: (r) => r.generated || r.sent > 0,
  });
}

/**
 * Job names for conditional startup (e.g., Moltbook jobs only if API key is set)
 */
export const JOB_NAMES = {
  DOCUMENT_INDEXER: 'document-indexer',
  SUMMARY_GENERATOR: 'summary-generator',
  PROACTIVE_OUTREACH: 'proactive-outreach',
  ACCOUNT_ENRICHMENT: 'account-enrichment',
  MOLTBOOK_POSTER: 'moltbook-poster',
  MOLTBOOK_ENGAGEMENT: 'moltbook-engagement',
  CONTENT_CURATOR: 'content-curator',
  FEED_FETCHER: 'feed-fetcher',
  ALERT_PROCESSOR: 'alert-processor',
  TASK_REMINDER: 'task-reminder',
  ENGAGEMENT_SCORING: 'engagement-scoring',
  GOAL_FOLLOW_UP: 'goal-follow-up',
  PERSONA_INFERENCE: 'persona-inference',
  JOURNEY_COMPUTATION: 'journey-computation',
  KNOWLEDGE_STALENESS: 'knowledge-staleness',
  PROSPECT_TRIAGE: 'prospect-triage',
  PROSPECT_ESCALATION: 'prospect-escalation',
  WEEKLY_DIGEST: 'weekly-digest',
} as const;
