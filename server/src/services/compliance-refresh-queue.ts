import { createLogger } from '../logger.js';
import {
  ComplianceRefreshRequestsDatabase,
  type ClaimedComplianceRefreshRequest,
  type ComplianceRefreshRequest,
  type CreateComplianceRefreshRequestInput,
} from '../db/compliance-refresh-requests-db.js';

const logger = createLogger('compliance-refresh-queue');
const QUEUE_INTERVAL_MS = 5_000;
const QUEUE_CONCURRENCY = 2;
const LEASE_MS = 15 * 60_000;
const HEARTBEAT_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;

function stableFailureMessage(code: string): string {
  switch (code) {
    case 'authorization_revoked':
      return 'Authorization changed before the refresh started';
    case 'monitoring_paused':
      return 'Monitoring is paused for this agent';
    case 'probe_failed':
      return 'The agent capability probe failed';
    case 'badge_update_failed':
      return 'The compliance evidence was saved but badge state could not be updated';
    default:
      return 'The compliance refresh failed';
  }
}

function stableFailureCode(code: unknown): string {
  return code === 'authorization_revoked'
    || code === 'monitoring_paused'
    || code === 'probe_failed'
    || code === 'compliance_failed'
    || code === 'badge_update_failed'
    ? code
    : 'refresh_failed';
}

export type ComplianceRefreshExecutor = (
  request: ClaimedComplianceRefreshRequest,
  lease: { assertValid(): void },
) => Promise<Record<string, unknown>>;

export class ComplianceRefreshQueue {
  private readonly workerId: string;
  private intervalId: NodeJS.Timeout | null = null;
  private processing = false;
  private lastRetentionAt = 0;

  constructor(
    private readonly execute: ComplianceRefreshExecutor,
    private readonly db = new ComplianceRefreshRequestsDatabase(),
    workerId?: string,
    private readonly intervalMs = QUEUE_INTERVAL_MS,
  ) {
    this.workerId = workerId
      ?? process.env.FLY_MACHINE_ID
      ?? `compliance-refresh-${process.pid}-${Date.now().toString(36)}`;
  }

  enqueue(input: CreateComplianceRefreshRequestInput) {
    return this.db.createOrGetActive(input);
  }

  getById(id: string): Promise<ComplianceRefreshRequest | null> {
    return this.db.getById(id);
  }

  recordProbeResult(
    id: string,
    leaseToken: string,
    probeResult: Record<string, unknown>,
    authAvailable: boolean,
  ): Promise<boolean> {
    return this.db.recordProbeResult(id, leaseToken, probeResult, authAvailable);
  }

  start(): void {
    if (this.intervalId) return;
    const tick = () => {
      this.processQueue().catch((err) => {
        logger.error({ err }, 'Compliance refresh queue tick failed');
      });
    };
    tick();
    this.intervalId = setInterval(tick, this.intervalMs);
    this.intervalId.unref();
    logger.info({ workerId: this.workerId }, 'Compliance refresh queue started');
  }

  stop(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  async processQueue(): Promise<{ claimed: number; succeeded: number; failed: number; lostLease: number }> {
    const stats = { claimed: 0, succeeded: 0, failed: 0, lostLease: 0 };
    if (this.processing) return stats;
    this.processing = true;
    try {
      const claim = await this.db.claimDue(this.workerId, QUEUE_CONCURRENCY, LEASE_MS);
      stats.claimed = claim.requests.length;
      if (claim.terminalizedExpired > 0) {
        logger.warn(
          { terminalizedExpired: claim.terminalizedExpired },
          'Compliance refresh requests exhausted their worker leases',
        );
      }
      const outcomes = await Promise.allSettled(
        claim.requests.map(request => this.processClaimed(request)),
      );
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled') {
          stats[outcome.value]++;
        } else {
          stats.failed++;
          logger.error({ err: outcome.reason }, 'Compliance refresh worker transition failed');
        }
      }
      await this.maybeRetainHistory();
      return stats;
    } finally {
      this.processing = false;
    }
  }

  private async processClaimed(
    request: ClaimedComplianceRefreshRequest,
  ): Promise<'succeeded' | 'failed' | 'lostLease'> {
    const executionFence = await this.db.acquireExecutionFence(request.id, request.agent_url);
    if (!executionFence) {
      logger.warn({ operationId: request.id }, 'Compliance refresh execution fence is already held');
      await this.db.deferClaim(request.id, request.lease_token);
      return 'lostLease';
    }
    let leaseValid = true;
    let heartbeatInFlight = false;
    let leaseExpiresAt = request.lease_expires_at.getTime();
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      this.db.heartbeat(request.id, request.lease_token, LEASE_MS)
        .then((renewed) => {
          if (!renewed) {
            leaseValid = false;
          } else {
            leaseExpiresAt = Date.now() + LEASE_MS;
          }
        })
        .catch((err) => {
          if (Date.now() >= leaseExpiresAt) leaseValid = false;
          logger.warn({ err, operationId: request.id }, 'Compliance refresh heartbeat failed');
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, HEARTBEAT_MS);
    heartbeat.unref();

    try {
      const assertValid = () => {
        if (!executionFence.isValid() || !leaseValid || Date.now() >= leaseExpiresAt) {
          const error = Object.assign(new Error('Compliance refresh worker lease was lost'), {
            code: 'lease_lost',
          });
          throw error;
        }
      };
      const result = await this.execute(request, { assertValid });
      if (!leaseValid || Date.now() >= leaseExpiresAt) {
        logger.warn({ operationId: request.id }, 'Compliance refresh completed after losing its lease');
        return 'lostLease';
      }
      const recorded = await this.db.markSucceeded(request.id, request.lease_token, result);
      if (!recorded) return 'lostLease';
      logger.info(
        { operationId: request.id, agentUrl: request.agent_url, attempts: request.attempts },
        'Compliance refresh completed',
      );
      return 'succeeded';
    } catch (error) {
      const rawCode = error && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string'
        ? error.code
        : 'refresh_failed';
      if (rawCode === 'lease_lost') {
        logger.warn({ operationId: request.id }, 'Compliance refresh stopped after losing its lease');
        return 'lostLease';
      }
      const code = stableFailureCode(rawCode);
      if (code === 'badge_update_failed') {
        const requeued = await this.db.requeueAfterFailure(
          request.id,
          request.lease_token,
          code,
          stableFailureMessage(code),
        );
        if (requeued) return 'failed';
      }
      const recorded = await this.db.markFailed(
        request.id,
        request.lease_token,
        code,
        stableFailureMessage(code),
      );
      if (!recorded) return 'lostLease';
      logger.warn(
        { errorCode: code, operationId: request.id, agentUrl: request.agent_url },
        'Compliance refresh failed',
      );
      return 'failed';
    } finally {
      clearInterval(heartbeat);
      await executionFence.release();
    }
  }

  private async maybeRetainHistory(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRetentionAt < 60 * 60_000) return;
    this.lastRetentionAt = now;
    const deleted = await this.db.deleteTerminalBefore(new Date(now - RETENTION_MS));
    if (deleted > 0) {
      logger.info({ deleted }, 'Expired compliance refresh history removed');
    }
  }
}
