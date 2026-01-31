/**
 * Job Scheduler
 *
 * Centralized management of scheduled background jobs.
 * This module handles starting, stopping, and tracking all periodic jobs.
 */

import { logger as baseLogger } from '../../logger.js';
import { runDocumentIndexerJob } from './committee-document-indexer.js';
import { runSummaryGeneratorJob } from './committee-summary-generator.js';
import { runOutreachScheduler } from '../services/proactive-outreach.js';
import { enrichMissingOrganizations } from '../../services/enrichment.js';
import { runSetupNudgesJob } from './setup-nudges.js';
import { runMoltbookPosterJob } from './moltbook-poster.js';
import { runMoltbookEngagementJob } from './moltbook-engagement.js';

const logger = baseLogger.child({ module: 'job-scheduler' });

interface ScheduledJob {
  name: string;
  intervalId: NodeJS.Timeout | null;
  initialTimeoutId: NodeJS.Timeout | null;
}

/**
 * Job Scheduler singleton
 */
class JobScheduler {
  private jobs: Map<string, ScheduledJob> = new Map();

  /**
   * Start the committee document indexer job
   * Indexes Google Docs tracked by committees, detects changes, generates summaries
   */
  startDocumentIndexer(): void {
    const JOB_NAME = 'document-indexer';
    const INTERVAL_MINUTES = 60; // Check every hour
    const INITIAL_DELAY_MS = 60000; // 1 minute delay on startup

    const job: ScheduledJob = {
      name: JOB_NAME,
      intervalId: null,
      initialTimeoutId: null,
    };

    // Run after a delay on startup
    job.initialTimeoutId = setTimeout(async () => {
      try {
        const result = await runDocumentIndexerJob({ batchSize: 20 });
        if (result.documentsChecked > 0) {
          logger.info(result, 'Document indexer: initial run completed');
        }
      } catch (err) {
        logger.error({ err }, 'Document indexer: initial run failed');
      }
    }, INITIAL_DELAY_MS);

    // Then run periodically
    job.intervalId = setInterval(async () => {
      try {
        const result = await runDocumentIndexerJob({ batchSize: 20 });
        if (result.documentsChecked > 0) {
          logger.info(result, 'Document indexer: job completed');
        }
      } catch (err) {
        logger.error({ err }, 'Document indexer: job failed');
      }
    }, INTERVAL_MINUTES * 60 * 1000);

    this.jobs.set(JOB_NAME, job);
    logger.debug({ intervalMinutes: INTERVAL_MINUTES }, 'Document indexer job started');
  }

  /**
   * Start the proactive outreach job
   * Sends DMs to eligible users during business hours
   */
  startOutreach(): void {
    const JOB_NAME = 'proactive-outreach';
    const INTERVAL_MINUTES = 30; // Check every 30 minutes
    const INITIAL_DELAY_MS = 120000; // 2 minute delay on startup

    const job: ScheduledJob = {
      name: JOB_NAME,
      intervalId: null,
      initialTimeoutId: null,
    };

    // Run after a delay on startup
    job.initialTimeoutId = setTimeout(async () => {
      try {
        await runOutreachScheduler({ limit: 5 });
      } catch (err) {
        logger.error({ err }, 'Proactive outreach: initial run failed');
      }
    }, INITIAL_DELAY_MS);

    // Then run periodically
    job.intervalId = setInterval(async () => {
      try {
        await runOutreachScheduler({ limit: 5 });
      } catch (err) {
        logger.error({ err }, 'Proactive outreach: job failed');
      }
    }, INTERVAL_MINUTES * 60 * 1000);

    this.jobs.set(JOB_NAME, job);
    logger.debug({ intervalMinutes: INTERVAL_MINUTES }, 'Proactive outreach job started');
  }

  /**
   * Start the committee summary generator job
   * Generates AI-powered activity summaries for committees
   */
  startSummaryGenerator(): void {
    const JOB_NAME = 'summary-generator';
    const INTERVAL_HOURS = 24; // Once per day
    const INITIAL_DELAY_MS = 300000; // 5 minute delay on startup

    const job: ScheduledJob = {
      name: JOB_NAME,
      intervalId: null,
      initialTimeoutId: null,
    };

    // Run after a longer delay on startup
    job.initialTimeoutId = setTimeout(async () => {
      try {
        const result = await runSummaryGeneratorJob({ batchSize: 10 });
        if (result.summariesGenerated > 0) {
          logger.info(result, 'Summary generator: initial run completed');
        }
      } catch (err) {
        logger.error({ err }, 'Summary generator: initial run failed');
      }
    }, INITIAL_DELAY_MS);

    // Then run periodically
    job.intervalId = setInterval(async () => {
      try {
        const result = await runSummaryGeneratorJob({ batchSize: 10 });
        if (result.summariesGenerated > 0) {
          logger.info(result, 'Summary generator: job completed');
        }
      } catch (err) {
        logger.error({ err }, 'Summary generator: job failed');
      }
    }, INTERVAL_HOURS * 60 * 60 * 1000);

    this.jobs.set(JOB_NAME, job);
    logger.debug({ intervalHours: INTERVAL_HOURS }, 'Summary generator job started');
  }

  /**
   * Start the account enrichment job
   * Enriches accounts missing company data via Lusha API
   * Prioritizes accounts with users over empty prospects
   */
  startEnrichment(): void {
    const JOB_NAME = 'account-enrichment';
    const INTERVAL_HOURS = 6; // Run every 6 hours
    const INITIAL_DELAY_MS = 180000; // 3 minute delay on startup

    const job: ScheduledJob = {
      name: JOB_NAME,
      intervalId: null,
      initialTimeoutId: null,
    };

    // Run after a delay on startup
    job.initialTimeoutId = setTimeout(async () => {
      try {
        const result = await enrichMissingOrganizations({
          limit: 50,
          includeEmptyProspects: true,
        });
        if (result.enriched > 0 || result.failed > 0) {
          logger.info(result, 'Account enrichment: initial run completed');
        }
      } catch (err) {
        logger.error({ err }, 'Account enrichment: initial run failed');
      }
    }, INITIAL_DELAY_MS);

    // Then run periodically
    job.intervalId = setInterval(async () => {
      try {
        const result = await enrichMissingOrganizations({
          limit: 50,
          includeEmptyProspects: true,
        });
        if (result.enriched > 0 || result.failed > 0) {
          logger.info(result, 'Account enrichment: job completed');
        }
      } catch (err) {
        logger.error({ err }, 'Account enrichment: job failed');
      }
    }, INTERVAL_HOURS * 60 * 60 * 1000);

    this.jobs.set(JOB_NAME, job);
    logger.debug({ intervalHours: INTERVAL_HOURS }, 'Account enrichment job started');
  }

  /**
   * Start the setup nudges job
   * Sends DMs to members about incomplete setup tasks (missing logo, tagline, pending join requests)
   */
  startSetupNudges(): void {
    const JOB_NAME = 'setup-nudges';
    const INTERVAL_HOURS = 6; // Check every 6 hours
    const INITIAL_DELAY_MS = 240000; // 4 minute delay on startup

    const job: ScheduledJob = {
      name: JOB_NAME,
      intervalId: null,
      initialTimeoutId: null,
    };

    // Run after a delay on startup
    job.initialTimeoutId = setTimeout(async () => {
      try {
        const result = await runSetupNudgesJob({ limit: 10 });
        if (result.nudgesSent > 0) {
          logger.info(result, 'Setup nudges: initial run completed');
        }
      } catch (err) {
        logger.error({ err }, 'Setup nudges: initial run failed');
      }
    }, INITIAL_DELAY_MS);

    // Then run periodically
    job.intervalId = setInterval(async () => {
      try {
        const result = await runSetupNudgesJob({ limit: 10 });
        if (result.nudgesSent > 0) {
          logger.info(result, 'Setup nudges: job completed');
        }
      } catch (err) {
        logger.error({ err }, 'Setup nudges: job failed');
      }
    }, INTERVAL_HOURS * 60 * 60 * 1000);

    this.jobs.set(JOB_NAME, job);
    logger.debug({ intervalHours: INTERVAL_HOURS }, 'Setup nudges job started');
  }

  /**
   * Stop the document indexer job
   */
  stopDocumentIndexer(): void {
    this.stopJob('document-indexer');
  }

  /**
   * Stop the proactive outreach job
   */
  stopOutreach(): void {
    this.stopJob('proactive-outreach');
  }

  /**
   * Stop the summary generator job
   */
  stopSummaryGenerator(): void {
    this.stopJob('summary-generator');
  }

  /**
   * Stop the account enrichment job
   */
  stopEnrichment(): void {
    this.stopJob('account-enrichment');
  }

  /**
   * Stop the setup nudges job
   */
  stopSetupNudges(): void {
    this.stopJob('setup-nudges');
  }

  /**
   * Start the Moltbook poster job
   * Posts high-quality industry articles to Moltbook with Addie's take
   */
  startMoltbookPoster(): void {
    const JOB_NAME = 'moltbook-poster';
    const INTERVAL_HOURS = 2; // Post every 2 hours
    const INITIAL_DELAY_MS = 600000; // 10 minute delay on startup

    const job: ScheduledJob = {
      name: JOB_NAME,
      intervalId: null,
      initialTimeoutId: null,
    };

    // Run after a delay on startup
    job.initialTimeoutId = setTimeout(async () => {
      try {
        const result = await runMoltbookPosterJob({ limit: 1 });
        if (result.postsCreated > 0) {
          logger.info(result, 'Moltbook poster: initial run completed');
        }
      } catch (err) {
        logger.error({ err }, 'Moltbook poster: initial run failed');
      }
    }, INITIAL_DELAY_MS);

    // Then run periodically
    job.intervalId = setInterval(async () => {
      try {
        const result = await runMoltbookPosterJob({ limit: 1 });
        if (result.postsCreated > 0) {
          logger.info(result, 'Moltbook poster: job completed');
        }
      } catch (err) {
        logger.error({ err }, 'Moltbook poster: job failed');
      }
    }, INTERVAL_HOURS * 60 * 60 * 1000);

    this.jobs.set(JOB_NAME, job);
    logger.debug({ intervalHours: INTERVAL_HOURS }, 'Moltbook poster job started');
  }

  /**
   * Start the Moltbook engagement job
   * Searches for advertising discussions and engages thoughtfully
   */
  startMoltbookEngagement(): void {
    const JOB_NAME = 'moltbook-engagement';
    const INTERVAL_HOURS = 4; // Engage every 4 hours
    const INITIAL_DELAY_MS = 900000; // 15 minute delay on startup

    const job: ScheduledJob = {
      name: JOB_NAME,
      intervalId: null,
      initialTimeoutId: null,
    };

    // Run after a delay on startup
    job.initialTimeoutId = setTimeout(async () => {
      try {
        const result = await runMoltbookEngagementJob({ limit: 3 });
        if (result.commentsCreated > 0 || result.interestingThreads > 0) {
          logger.info(result, 'Moltbook engagement: initial run completed');
        }
      } catch (err) {
        logger.error({ err }, 'Moltbook engagement: initial run failed');
      }
    }, INITIAL_DELAY_MS);

    // Then run periodically
    job.intervalId = setInterval(async () => {
      try {
        const result = await runMoltbookEngagementJob({ limit: 3 });
        if (result.commentsCreated > 0 || result.interestingThreads > 0) {
          logger.info(result, 'Moltbook engagement: job completed');
        }
      } catch (err) {
        logger.error({ err }, 'Moltbook engagement: job failed');
      }
    }, INTERVAL_HOURS * 60 * 60 * 1000);

    this.jobs.set(JOB_NAME, job);
    logger.debug({ intervalHours: INTERVAL_HOURS }, 'Moltbook engagement job started');
  }

  /**
   * Stop the Moltbook poster job
   */
  stopMoltbookPoster(): void {
    this.stopJob('moltbook-poster');
  }

  /**
   * Stop the Moltbook engagement job
   */
  stopMoltbookEngagement(): void {
    this.stopJob('moltbook-engagement');
  }

  /**
   * Stop a specific job by name
   */
  private stopJob(name: string): void {
    const job = this.jobs.get(name);
    if (!job) return;

    if (job.initialTimeoutId) {
      clearTimeout(job.initialTimeoutId);
      job.initialTimeoutId = null;
    }

    if (job.intervalId) {
      clearInterval(job.intervalId);
      job.intervalId = null;
    }

    this.jobs.delete(name);
    logger.info({ jobName: name }, 'Job stopped');
  }

  /**
   * Stop all running jobs
   */
  stopAll(): void {
    for (const name of this.jobs.keys()) {
      this.stopJob(name);
    }
    logger.info('All scheduled jobs stopped');
  }
}

// Export singleton instance
export const jobScheduler = new JobScheduler();
