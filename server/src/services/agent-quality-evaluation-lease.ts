import type {
  AgentQualityEvaluationDatabase,
  AgentQualityEvaluationRow,
  OwnedAgentQualityEvaluation,
} from '../db/agent-quality-evaluation-db.js';
import { AgentQualityEvaluationLeaseLostError } from '../db/agent-quality-evaluation-db.js';

export { AgentQualityEvaluationLeaseLostError } from '../db/agent-quality-evaluation-db.js';

export const AGENT_QUALITY_EVALUATION_LEASE_MS = 120_000;
export const AGENT_QUALITY_EVALUATION_HEARTBEAT_MS = 30_000;

export function formatRunningAgentQualityEvaluation(
  evaluation: AgentQualityEvaluationRow,
  nowMs = Date.now(),
): string {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - evaluation.started_at.getTime()) / 1_000));
  const scope = evaluation.tracks_json.length > 0
    ? evaluation.tracks_json.join(', ')
    : 'all applicable tracks';
  return [
    '## Quality evaluation still running',
    '',
    `**Agent:** \`${evaluation.agent_url}\``,
    `**Compliance target:** ${evaluation.compliance_target}`,
    `**Scope:** ${scope}`,
    `**Elapsed:** ${elapsedSeconds}s (database-recorded start time)`,
    '**Progress:** No authoritative live storyboard counter is available; the run is still active.',
    '',
    'No new evaluation was started. Wait for the existing run to finish before drawing conclusions from its receipt.',
  ].join('\n');
}

/**
 * Keeps one database-granted execution lease alive and aborts runner I/O at
 * the exact locally observed expiry. Publication is separately fenced by a
 * final database renewal/transition.
 */
export class AgentQualityEvaluationLease {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private heartbeatInFlight = false;
  private stopped = false;

  constructor(
    private readonly db: AgentQualityEvaluationDatabase,
    readonly evaluation: OwnedAgentQualityEvaluation,
    private readonly onHeartbeatError: (error: unknown) => void = () => undefined,
    private readonly leaseMs = AGENT_QUALITY_EVALUATION_LEASE_MS,
    private readonly heartbeatMs = AGENT_QUALITY_EVALUATION_HEARTBEAT_MS,
  ) {
    this.signal = this.controller.signal;
    this.armExpiry(evaluation.lease_expires_at);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private abortLost(): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(new AgentQualityEvaluationLeaseLostError());
    }
    this.stop();
  }

  private armExpiry(expiresAt: Date): void {
    if (this.stopped || this.signal.aborted) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const delayMs = Math.max(0, expiresAt.getTime() - Date.now());
    this.expiryTimer = setTimeout(() => this.abortLost(), delayMs);
    this.expiryTimer.unref();
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      const expiresAt = await this.db.heartbeat(
        this.evaluation.id,
        this.evaluation.lease_token,
        this.leaseMs,
      );
      if (!expiresAt) {
        this.abortLost();
        return;
      }
      this.armExpiry(expiresAt);
    } catch (error) {
      // Keep the hard expiry armed. A transient DB failure may recover before
      // then; a partition cannot let this owner run beyond its durable lease.
      this.onHeartbeatError(error);
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  async assertOwned(): Promise<void> {
    if (this.stopped || this.signal.aborted) throw new AgentQualityEvaluationLeaseLostError();
    const expiresAt = await this.db.heartbeat(
      this.evaluation.id,
      this.evaluation.lease_token,
      this.leaseMs,
    );
    if (!expiresAt || this.stopped || this.signal.aborted) {
      this.abortLost();
      throw new AgentQualityEvaluationLeaseLostError();
    }
    this.armExpiry(expiresAt);
  }

  async complete(receiptMetadata: Record<string, unknown>): Promise<void> {
    if (this.stopped || this.signal.aborted) throw new AgentQualityEvaluationLeaseLostError();
    this.stop();
    try {
      const recorded = await this.db.markCompleted(
        this.evaluation.id,
        this.evaluation.lease_token,
        receiptMetadata,
      );
      if (!recorded) {
        this.abortLost();
        throw new AgentQualityEvaluationLeaseLostError();
      }
    } finally {
      // The handler is returning after this transition attempt. A database
      // outage leaves recovery to expiry; no orphan timer should keep this
      // process acting as an owner after the request has ended.
      this.stop();
    }
  }

  async fail(failureCode: string): Promise<boolean> {
    this.stop();
    try {
      return await this.db.markFailed(
        this.evaluation.id,
        this.evaluation.lease_token,
        failureCode,
      );
    } finally {
      this.stop();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.heartbeatTimer = null;
    this.expiryTimer = null;
  }
}
