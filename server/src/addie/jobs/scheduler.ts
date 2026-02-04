/**
 * Job Scheduler
 *
 * Declarative management of scheduled background jobs.
 * Jobs are defined as configuration objects and managed centrally.
 */

import { logger as baseLogger } from '../../logger.js';

const logger = baseLogger.child({ module: 'job-scheduler' });

/**
 * Time interval configuration
 */
export interface TimeInterval {
  value: number;
  unit: 'seconds' | 'minutes' | 'hours';
}

/**
 * Business hours constraint - job only runs during these hours (ET timezone)
 */
export interface BusinessHoursConstraint {
  /** Hour to start running (0-23) */
  startHour: number;
  /** Hour to stop running (0-23, exclusive) */
  endHour: number;
  /** Skip Saturdays and Sundays. Default: true */
  skipWeekends?: boolean;
}

/**
 * Job configuration - declarative definition of a scheduled job
 */
export interface JobConfig<TOptions = Record<string, unknown>, TResult = unknown> {
  /** Unique job identifier (kebab-case) */
  name: string;

  /** Human-readable description for logging */
  description: string;

  /** How often to run the job */
  interval: TimeInterval;

  /** Delay before first run after startup */
  initialDelay?: TimeInterval;

  /** The async function to execute */
  runner: (options: TOptions) => Promise<TResult>;

  /** Options to pass to the runner */
  options?: TOptions;

  /** Only run during these business hours (ET timezone) */
  businessHours?: BusinessHoursConstraint;

  /**
   * Return true to log result at info level, false for debug level.
   * If not provided, always logs at debug level.
   */
  shouldLogResult?: (result: TResult) => boolean;
}

/**
 * Runtime state for a running job
 */
interface RunningJob {
  name: string;
  intervalId: NodeJS.Timeout | null;
  initialTimeoutId: NodeJS.Timeout | null;
}

/**
 * Convert a TimeInterval to milliseconds
 */
function toMilliseconds(interval: TimeInterval): number {
  switch (interval.unit) {
    case 'seconds':
      return interval.value * 1000;
    case 'minutes':
      return interval.value * 60 * 1000;
    case 'hours':
      return interval.value * 60 * 60 * 1000;
  }
}

/**
 * Check if current time is within business hours constraint (ET timezone)
 */
function isWithinBusinessHours(constraint: BusinessHoursConstraint): boolean {
  const now = new Date();

  // Get current hour in ET
  const etHour = parseInt(
    now.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }),
    10
  );

  // Check hour range
  if (etHour < constraint.startHour || etHour >= constraint.endHour) {
    return false;
  }

  // Check weekends if enabled (default: true)
  if (constraint.skipWeekends !== false) {
    const etDay = now.toLocaleString('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    });
    if (etDay === 'Sat' || etDay === 'Sun') {
      return false;
    }
  }

  return true;
}

/**
 * Job Scheduler - manages registration and execution of scheduled jobs
 */
class JobScheduler {
  private configs: Map<string, JobConfig> = new Map();
  private runningJobs: Map<string, RunningJob> = new Map();

  /**
   * Register a job configuration
   */
  register<TOptions, TResult>(config: JobConfig<TOptions, TResult>): void {
    if (this.configs.has(config.name)) {
      logger.warn({ jobName: config.name }, 'Job already registered, replacing');
    }
    // Cast necessary because Map cannot hold heterogeneous generics.
    // Type safety is enforced at registration time via register<TOptions, TResult>.
    this.configs.set(config.name, config as JobConfig);
  }

  /**
   * Start a specific job by name
   */
  start(name: string): void {
    const config = this.configs.get(name);
    if (!config) {
      logger.error({ jobName: name }, 'Cannot start unknown job');
      return;
    }

    if (this.runningJobs.has(name)) {
      logger.warn({ jobName: name }, 'Job already running');
      return;
    }

    const job: RunningJob = {
      name,
      intervalId: null,
      initialTimeoutId: null,
    };

    const runJob = async () => {
      // Check business hours constraint if configured
      if (config.businessHours && !isWithinBusinessHours(config.businessHours)) {
        logger.debug({ jobName: name }, 'Skipping - outside business hours');
        return;
      }

      try {
        const result = await config.runner(config.options ?? ({} as never));

        // Log based on shouldLogResult predicate or default to debug
        const shouldLog = config.shouldLogResult?.(result) ?? false;
        if (shouldLog) {
          logger.info({ jobName: name, result }, `${config.description}: completed`);
        } else {
          logger.debug({ jobName: name, result }, `${config.description}: completed`);
        }
      } catch (err) {
        logger.error({ err, jobName: name }, `${config.description}: failed`);
      }
    };

    // Schedule initial run with delay
    const initialDelayMs = config.initialDelay ? toMilliseconds(config.initialDelay) : 0;

    if (initialDelayMs > 0) {
      job.initialTimeoutId = setTimeout(runJob, initialDelayMs);
    } else {
      // Run on next tick to not block startup
      setImmediate(runJob);
    }

    // Schedule periodic runs
    job.intervalId = setInterval(runJob, toMilliseconds(config.interval));

    this.runningJobs.set(name, job);
    logger.debug(
      {
        jobName: name,
        interval: config.interval,
        initialDelay: config.initialDelay,
        businessHours: config.businessHours,
      },
      `${config.description} scheduled`
    );
  }

  /**
   * Stop a specific job by name
   */
  stop(name: string): void {
    const job = this.runningJobs.get(name);
    if (!job) {
      return;
    }

    if (job.initialTimeoutId) {
      clearTimeout(job.initialTimeoutId);
    }
    if (job.intervalId) {
      clearInterval(job.intervalId);
    }

    this.runningJobs.delete(name);
    logger.info({ jobName: name }, 'Job stopped');
  }

  /**
   * Start all registered jobs
   */
  startAll(): void {
    for (const name of this.configs.keys()) {
      this.start(name);
    }
    logger.info({ jobCount: this.configs.size }, 'All jobs started');
  }

  /**
   * Stop all running jobs
   */
  stopAll(): void {
    for (const name of this.runningJobs.keys()) {
      this.stop(name);
    }
    logger.info('All jobs stopped');
  }

  /**
   * Check if a job is currently running
   */
  isRunning(name: string): boolean {
    return this.runningJobs.has(name);
  }

  /**
   * Get list of registered job names
   */
  getRegisteredJobs(): string[] {
    return Array.from(this.configs.keys());
  }
}

// Export singleton instance
export const jobScheduler = new JobScheduler();
