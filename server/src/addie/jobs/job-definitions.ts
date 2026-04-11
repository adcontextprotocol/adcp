/**
 * Job Definitions
 *
 * Declarative configuration for all scheduled background jobs.
 * Call registerAllJobs() on startup to register them with the scheduler.
 */

import { jobScheduler } from './scheduler.js';
import { runDocumentIndexerJob, generateAssetDescriptions } from './committee-document-indexer.js';
import { runSummaryGeneratorJob } from './committee-summary-generator.js';
import { runRelationshipOrchestratorCycle } from '../services/relationship-orchestrator.js';
import { enrichMissingOrganizations } from '../../services/enrichment.js';
import { researchDomain } from '../../services/brand-enrichment.js';
import { query } from '../../db/client.js';
import { runTaskReminderJob } from './task-reminder.js';
// engagement-scoring job removed — old scoring replaced by person_relationships/person_events
import {
  processPendingResources,
  processRssPerspectives,
  processCommunityArticles,
} from '../services/content-curator.js';
import { sendCommunityReplies } from '../services/community-articles.js';
import { processFeedsToFetch } from '../services/feed-fetcher.js';
import { processAlerts } from '../services/industry-alerts.js';
import { sendChannelMessage, sendDirectMessage } from '../../slack/client.js';
import { SlackDatabase } from '../../db/slack-db.js';
import { runPersonaInferenceJob } from '../services/persona-inference.js';
import { runJourneyComputationJob } from '../services/journey-computation.js';
import { runKnowledgeStalenessJob } from './knowledge-staleness.js';
import { runGeoMonitorJob } from './geo-monitor.js';
import { runGeoSnapshotJob } from './geo-snapshot.js';
import { runGeoContentPlannerJob } from './geo-content-planner.js';
import { processUntriagedDomains, escalateUnclaimedProspects } from '../../services/prospect-triage.js';
import { runWeeklyDigestJob } from './weekly-digest.js';
import { runSocialPostIdeasJob } from './social-post-ideas.js';
import { runConversationInsightsJob } from './conversation-insights.js';
import { autoLinkUnmappedSlackUsers, autoAddVerifiedDomainUsersAsMembers } from '../../slack/sync.js';
import { runCredentialDigestJob } from './credential-digest.js';
import { runWgDigestJob, runWgDigestPrepJob } from './wg-digest.js';
import { runComplianceHeartbeatJob } from './compliance-heartbeat.js';
import { runShadowEvaluatorJob } from './shadow-evaluator.js';
import { runKnowledgeGapCloserJob } from './knowledge-gap-closer.js';
import { eventsDb } from '../../db/events-db.js';
import { runEventRecapNudgeJob } from './event-recap-nudge.js';
import { NotificationDatabase } from '../../db/notification-db.js';
import { notifyUser } from '../../notifications/notification-service.js';
import { logger } from '../../logger.js';

const jobLogger = logger.child({ module: 'content-curator-job' });

/** Log pool timeouts at warn (transient) instead of error (which triggers Slack). */
function logJobSubtaskError(error: unknown, message: string): void {
  const isPoolTimeout = error instanceof Error && /timeout.*connect|connection.*timeout/i.test(error.message);
  if (isPoolTimeout) {
    jobLogger.warn({ error }, `${message} (DB pool busy — skipping)`);
  } else {
    jobLogger.error({ error }, message);
  }
}

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
    logJobSubtaskError(error, 'Content curator: pending resources failed');
  }

  try {
    results.rssPerspectives = await processRssPerspectives({ limit: 5 });
  } catch (error) {
    logJobSubtaskError(error, 'Content curator: RSS perspectives failed');
  }

  try {
    results.communityArticles = await processCommunityArticles({ limit: 5 });
  } catch (error) {
    logJobSubtaskError(error, 'Content curator: community articles failed');
  }

  try {
    results.communityReplies = await sendCommunityReplies(async (channelId, threadTs, text) => {
      const result = await sendChannelMessage(channelId, { text, thread_ts: threadTs });
      return result.ok;
    });
  } catch (error) {
    logJobSubtaskError(error, 'Content curator: community replies failed');
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

  // Asset description generator - uses Claude vision to describe extracted images
  jobScheduler.register({
    name: 'asset-description-generator',
    description: 'Asset description generator',
    interval: { value: 30, unit: 'minutes' },
    initialDelay: { value: 3, unit: 'minutes' },
    runner: async () => {
      const described = await generateAssetDescriptions(5);
      return { assetsDescribed: described };
    },
    shouldLogResult: (r: { assetsDescribed: number }) => r.assetsDescribed > 0,
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

  // Relationship orchestrator - continues member relationships across channels
  jobScheduler.register({
    name: 'relationship-orchestrator',
    description: 'Relationship orchestrator',
    interval: { value: 20, unit: 'minutes' },
    initialDelay: { value: 2, unit: 'minutes' },
    runner: runRelationshipOrchestratorCycle,
    options: { limit: 25 },
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

  // Engagement scoring job removed — old scoring replaced by person_relationships/person_events

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
    failureThreshold: 1,
    shouldLogResult: (r) => r.generated || r.sent > 0,
  });

  // WG digest - biweekly per-group email to working group members
  jobScheduler.register({
    name: 'wg-digest',
    description: 'Biweekly working group digest emails',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 9, unit: 'minutes' },
    runner: runWgDigestJob,
    failureThreshold: 1,
    shouldLogResult: (r) => r.groupsChecked > 0,
  });

  // WG digest prep - Monday nudge to leaders about content gaps before Wednesday digest
  jobScheduler.register({
    name: 'wg-digest-prep',
    description: 'Prep emails to WG leaders before biweekly digest',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 10, unit: 'minutes' },
    runner: runWgDigestPrepJob,
    failureThreshold: 1,
    shouldLogResult: (r) => r.emailsSent > 0,
  });

  // Credential digest - weekly summary of certification awards to Slack
  jobScheduler.register({
    name: 'credential-digest',
    description: 'Weekly credential award digest',
    interval: { value: 168, unit: 'hours' },
    initialDelay: { value: 8, unit: 'minutes' },
    runner: runCredentialDigestJob,
    failureThreshold: 1,
    businessHours: { startHour: 9, endHour: 11, skipWeekends: true },
    shouldLogResult: (r) => r.posted || r.awardsFound > 0,
  });

  // Social post ideas - generates social copy for members to share
  jobScheduler.register({
    name: 'social-post-ideas',
    description: 'Social post ideas for member amplification',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 7, unit: 'minutes' },
    runner: runSocialPostIdeasJob,
    shouldLogResult: (r) => r.posted || r.skipped,
  });

  // Conversation insights - weekly analysis of Addie conversations
  jobScheduler.register({
    name: 'conversation-insights',
    description: 'Weekly conversation insights analysis',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 8, unit: 'minutes' },
    runner: runConversationInsightsJob,
    shouldLogResult: (r) => r.generated || r.posted,
  });

  jobScheduler.register({
    name: 'slack-auto-link',
    description: 'Reconcile unmapped Slack users to website accounts by email',
    interval: { value: 24, unit: 'hours' },
    initialDelay: { value: 2, unit: 'minutes' },
    runner: autoLinkUnmappedSlackUsers,
    shouldLogResult: (r) => r.linked > 0 || r.pending_org_prospects_set > 0 || r.errors > 0,
  });

  jobScheduler.register({
    name: 'domain-member-backfill',
    description: 'Add verified-domain Slack users as org members if not already added',
    interval: { value: 24, unit: 'hours' },
    initialDelay: { value: 5, unit: 'minutes' },
    runner: autoAddVerifiedDomainUsersAsMembers,
    shouldLogResult: (r) => r.added > 0 || r.errors > 0,
  });

  // GEO prompt monitor - checks LLM visibility for AdCP mentions
  jobScheduler.register({
    name: 'geo-monitor',
    description: 'GEO prompt monitor',
    interval: { value: 168, unit: 'hours' },
    initialDelay: { value: 15, unit: 'minutes' },
    runner: runGeoMonitorJob,
    shouldLogResult: (r) => r.promptsChecked > 0,
  });

  // GEO visibility snapshot - saves daily per-model metrics from LLM Pulse
  jobScheduler.register({
    name: 'geo-snapshot',
    description: 'GEO visibility daily snapshot',
    interval: { value: 24, unit: 'hours' },
    initialDelay: { value: 10, unit: 'minutes' },
    runner: runGeoSnapshotJob,
    shouldLogResult: (r) => r.modelsSnapped > 0,
  });

  // GEO content planner - generates content briefs from monitoring gaps
  jobScheduler.register({
    name: 'geo-content-planner',
    description: 'GEO content planner',
    interval: { value: 168, unit: 'hours' },
    initialDelay: { value: 30, unit: 'minutes' },
    runner: runGeoContentPlannerJob,
    options: { limit: 10 },
    shouldLogResult: (r) => r.briefsCreated > 0,
  });

  // Compliance heartbeat - runs comply() against registered agents
  jobScheduler.register({
    name: 'compliance-heartbeat',
    description: 'Agent compliance heartbeat',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 10, unit: 'minutes' },
    runner: runComplianceHeartbeatJob,
    options: { limit: 10 },
    shouldLogResult: (r) => r.checked > 0,
  });

  // Outbound request log cleanup - retain 30 days
  jobScheduler.register({
    name: 'outbound-log-cleanup',
    description: 'Clean up old outbound request logs',
    interval: { value: 24, unit: 'hours' },
    initialDelay: { value: 60, unit: 'minutes' },
    runner: async () => {
      const { cleanupOldRequests } = await import('../../db/outbound-log-db.js');
      const deleted = await cleanupOldRequests(30);
      return { deleted };
    },
    shouldLogResult: (r: { deleted: number }) => r.deleted > 0,
  });

  // Shadow evaluator - generates what Addie would have said and compares with human answers
  jobScheduler.register({
    name: 'shadow-evaluator',
    description: 'Shadow response evaluation for suppressed high-confidence threads',
    interval: { value: 10, unit: 'minutes' },
    initialDelay: { value: 12, unit: 'minutes' },
    runner: runShadowEvaluatorJob,
    options: { limit: 5 },
    shouldLogResult: (r) => r.evaluated > 0 || r.knowledge_gaps > 0,
  });

  // Knowledge gap closer - creates GitHub issues for doc updates from shadow eval gaps
  jobScheduler.register({
    name: 'knowledge-gap-closer',
    description: 'Create doc update issues from knowledge gaps',
    interval: { value: 1, unit: 'hours' },
    initialDelay: { value: 20, unit: 'minutes' },
    runner: runKnowledgeGapCloserJob,
    options: { limit: 3 },
    businessHours: { startHour: 9, endHour: 18 },
    shouldLogResult: (r) => r.issues_created > 0 || r.gaps_reviewed > 0,
  });

  // Event reminder - sends notifications ~24h before events start
  // For users with accounts: in-app notification + Slack DM
  // For email-only registrations (e.g. Luma sync): Slack DM if we can match the email
  jobScheduler.register({
    name: 'event-reminder',
    description: 'Send reminder notifications for upcoming events',
    interval: { value: 60, unit: 'minutes' },
    initialDelay: { value: 3, unit: 'minutes' },
    failureThreshold: 1,
    runner: async () => {
      const from = new Date(Date.now() + 23 * 60 * 60 * 1000);
      const to = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const events = await eventsDb.getEventsStartingBetween(from, to);
      let remindersSent = 0;

      const notificationDb = new NotificationDatabase();
      const slackDb = new SlackDatabase();
      const baseUrl = process.env.BASE_URL || 'https://agenticadvertising.org';

      for (const event of events) {
        const registrations = await eventsDb.getEventRegistrations(event.id);
        for (const reg of registrations) {
          if (reg.registration_status !== 'registered') continue;

          try {
            if (reg.workos_user_id) {
              // Account user: in-app + Slack DM via notifyUser
              const alreadySent = await notificationDb.exists(reg.workos_user_id, 'event_reminder', event.id);
              if (alreadySent) continue;

              await notifyUser({
                recipientUserId: reg.workos_user_id,
                type: 'event_reminder',
                referenceId: event.id,
                referenceType: 'event',
                title: `Reminder: ${event.title} is tomorrow`,
                url: `/events/${event.slug}`,
              });
              remindersSent++;
            } else if (reg.email) {
              // Email-only registration (Luma sync): try Slack DM by email
              const slackUser = await slackDb.findByEmail(reg.email);
              if (!slackUser?.slack_user_id) continue;

              // Dedup using the slack user's workos_user_id if linked, otherwise skip dedup
              if (slackUser.workos_user_id) {
                const alreadySent = await notificationDb.exists(slackUser.workos_user_id, 'event_reminder', event.id);
                if (alreadySent) continue;
              }

              const eventUrl = `${baseUrl}/events/${event.slug}`;
              await sendDirectMessage(slackUser.slack_user_id, {
                text: `Reminder: ${event.title} is tomorrow\n<${eventUrl}|View event>`,
              });
              remindersSent++;
            }
          } catch (err) {
            logger.error({ err }, 'Failed to send event reminder');
          }
        }
      }
      return { eventsChecked: events.length, remindersSent };
    },
    shouldLogResult: (r) => r.remindersSent > 0,
  });

  // Event recap nudge - reminds admins to add recaps and attendee lists after events
  jobScheduler.register({
    name: 'event-recap-nudge',
    description: 'Remind admins to add recaps for completed events',
    interval: { value: 24, unit: 'hours' },
    initialDelay: { value: 15, unit: 'minutes' },
    runner: runEventRecapNudgeJob,
    businessHours: { startHour: 9, endHour: 10 },
    shouldLogResult: (r) => r.nudgesSent > 0,
  });

  // Brand registry sweep - researches unmapped org domains to maintain 100% coverage
  jobScheduler.register({
    name: 'brand-registry-sweep',
    description: 'Brand registry sweep for unmapped accounts',
    interval: { value: 12, unit: 'hours' },
    initialDelay: { value: 20, unit: 'minutes' },
    runner: async (options: { limit?: number }) => {
      const limit = options?.limit || 15;
      const unmapped = await query<{
        workos_organization_id: string;
        name: string;
        email_domain: string;
      }>(
        `SELECT o.workos_organization_id, o.name, o.email_domain
         FROM organizations o
         WHERE o.is_personal = false
           AND o.email_domain IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM discovered_brands db
             WHERE db.domain = o.email_domain
           )
           AND NOT EXISTS (
             SELECT 1 FROM brand_domain_aliases bda
             WHERE bda.alias_domain = o.email_domain
           )
         ORDER BY o.subscription_status = 'active' DESC,
                  o.last_activity_at DESC NULLS LAST
         LIMIT $1`,
        [limit]
      );

      let researched = 0;
      let stubbed = 0;
      let failed = 0;

      for (const org of unmapped.rows) {
        try {
          const result = await researchDomain(org.email_domain, {
            org_id: org.workos_organization_id,
          });
          const wasStubbed = result.actions.some(a => a.source === 'stub');
          const wasFetched = result.actions.some(a => a.action === 'fetched');
          if (wasFetched) researched++;
          else if (wasStubbed) stubbed++;
        } catch (err) {
          logger.warn({ err, domain: org.email_domain }, 'Brand registry sweep: research failed');
          failed++;
        }
        // Rate limit between calls
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      return { total: unmapped.rows.length, researched, stubbed, failed };
    },
    options: { limit: 15 },
    shouldLogResult: (r) => r.total > 0,
  });
}

/**
 * Job names for conditional startup (e.g., Moltbook jobs only if API key is set)
 */
export const JOB_NAMES = {
  DOCUMENT_INDEXER: 'document-indexer',
  SUMMARY_GENERATOR: 'summary-generator',
  RELATIONSHIP_ORCHESTRATOR: 'relationship-orchestrator',
  ACCOUNT_ENRICHMENT: 'account-enrichment',
  CONTENT_CURATOR: 'content-curator',
  FEED_FETCHER: 'feed-fetcher',
  ALERT_PROCESSOR: 'alert-processor',
  TASK_REMINDER: 'task-reminder',
  PERSONA_INFERENCE: 'persona-inference',
  JOURNEY_COMPUTATION: 'journey-computation',
  KNOWLEDGE_STALENESS: 'knowledge-staleness',
  PROSPECT_TRIAGE: 'prospect-triage',
  PROSPECT_ESCALATION: 'prospect-escalation',
  WEEKLY_DIGEST: 'weekly-digest',
  WG_DIGEST: 'wg-digest',
  WG_DIGEST_PREP: 'wg-digest-prep',
  CREDENTIAL_DIGEST: 'credential-digest',
  SOCIAL_POST_IDEAS: 'social-post-ideas',
  CONVERSATION_INSIGHTS: 'conversation-insights',
  SLACK_AUTO_LINK: 'slack-auto-link',
  DOMAIN_MEMBER_BACKFILL: 'domain-member-backfill',
  COMPLIANCE_HEARTBEAT: 'compliance-heartbeat',
  EVENT_REMINDER: 'event-reminder',
  EVENT_RECAP_NUDGE: 'event-recap-nudge',
  GEO_MONITOR: 'geo-monitor',
  GEO_SNAPSHOT: 'geo-snapshot',
  GEO_CONTENT_PLANNER: 'geo-content-planner',
  SHADOW_EVALUATOR: 'shadow-evaluator',
  KNOWLEDGE_GAP_CLOSER: 'knowledge-gap-closer',
  BRAND_REGISTRY_SWEEP: 'brand-registry-sweep',
  OUTBOUND_LOG_CLEANUP: 'outbound-log-cleanup',
} as const;
