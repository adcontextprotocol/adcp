import { createHash, randomUUID } from 'node:crypto';
import { getClientWithDeadline, query, withDatabaseDeadline } from './client.js';

const DB_DEADLINE_MS = 5_000;

export type AgentQualityEvaluationStatus = 'running' | 'completed' | 'failed' | 'expired';

export class AgentQualityEvaluationLeaseLostError extends Error {
  readonly code = 'evaluation_lease_lost' as const;

  constructor() {
    super('Agent quality evaluation lease was lost');
    this.name = 'AgentQualityEvaluationLeaseLostError';
  }
}

export interface AgentQualityEvaluationRow {
  id: string;
  request_key: string;
  agent_url: string;
  compliance_target: string;
  tracks_json: string[];
  auth_scope_hash: string;
  status: AgentQualityEvaluationStatus;
  owner_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  started_at: Date;
  completed_at: Date | null;
  receipt_metadata_json: Record<string, unknown> | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OwnedAgentQualityEvaluation extends AgentQualityEvaluationRow {
  status: 'running';
  owner_id: string;
  lease_token: string;
  lease_expires_at: Date;
}

export type AgentQualityEvaluationClaim =
  | { owned: true; evaluation: OwnedAgentQualityEvaluation; recoveredExpiredLease: boolean }
  | { owned: false; evaluation: AgentQualityEvaluationRow; recoveredExpiredLease: false };

export interface AgentQualityEvaluationIdentity {
  agentUrl: string;
  complianceTarget: string;
  tracks: readonly string[];
  authScope: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizedEvaluationTracks(tracks: readonly string[] | undefined): string[] {
  return [...new Set(tracks ?? [])].sort((a, b) => a.localeCompare(b));
}

export function agentQualityEvaluationRequestKey(identity: AgentQualityEvaluationIdentity): {
  requestKey: string;
  authScopeHash: string;
  tracks: string[];
} {
  const tracks = normalizedEvaluationTracks(identity.tracks);
  const authScopeHash = sha256(identity.authScope);
  const requestKey = sha256(JSON.stringify({
    version: 1,
    agent_url: identity.agentUrl,
    compliance_target: identity.complianceTarget,
    tracks,
    auth_scope_hash: authScopeHash,
  }));
  return { requestKey, authScopeHash, tracks };
}

export class AgentQualityEvaluationDatabase {
  /** Atomically grant one live execution lease or return its current owner. */
  async claimOrObserve(input: AgentQualityEvaluationIdentity & {
    ownerId: string;
    leaseMs: number;
    /** Safe display value; exact agentUrl remains part of the hashed identity. */
    displayAgentUrl?: string;
  }): Promise<AgentQualityEvaluationClaim> {
    const { requestKey, authScopeHash, tracks } = agentQualityEvaluationRequestKey(input);
    const id = randomUUID();
    const leaseToken = randomUUID();
    const client = await getClientWithDeadline(DB_DEADLINE_MS);
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
      await client.query("SELECT set_config('lock_timeout', '2000ms', true)");
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', '5000ms', true)");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('addie-agent-quality:' || $1, 0))`,
        [requestKey],
      );

      const expired = await client.query(
        `UPDATE addie_agent_quality_evaluations
            SET status = 'expired',
                owner_id = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                completed_at = NOW(),
                failure_code = 'lease_expired',
                updated_at = NOW()
          WHERE request_key = $1
            AND status = 'running'
            AND lease_expires_at <= clock_timestamp()`,
        [requestKey],
      );

      await client.query(
        `INSERT INTO addie_agent_quality_evaluations (
           id, request_key, agent_url, compliance_target, tracks_json,
           auth_scope_hash, status, owner_id, lease_token, lease_expires_at,
           heartbeat_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb,
           $6, 'running', $7, $8, clock_timestamp() + ($9::double precision * INTERVAL '1 millisecond'),
           NOW()
         )
         ON CONFLICT (request_key) WHERE status = 'running' DO NOTHING`,
        [
          id,
          requestKey,
          input.displayAgentUrl ?? input.agentUrl,
          input.complianceTarget,
          JSON.stringify(tracks),
          authScopeHash,
          input.ownerId,
          leaseToken,
          input.leaseMs,
        ],
      );

      const active = await client.query<AgentQualityEvaluationRow>(
        `SELECT *
           FROM addie_agent_quality_evaluations
          WHERE request_key = $1 AND status = 'running'`,
        [requestKey],
      );
      await client.query('COMMIT');
      const evaluation = active.rows[0];
      if (!evaluation) throw new Error('Agent quality evaluation claim committed without an active row');
      if (evaluation.id === id) {
        return {
          owned: true,
          evaluation: evaluation as OwnedAgentQualityEvaluation,
          recoveredExpiredLease: (expired.rowCount ?? 0) > 0,
        };
      }
      return { owned: false, evaluation, recoveredExpiredLease: false };
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Renew only the exact, still-live lease. Returns its database expiry. */
  async heartbeat(id: string, leaseToken: string, leaseMs: number): Promise<Date | null> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query<{ lease_expires_at: Date }>(
        `UPDATE addie_agent_quality_evaluations
            SET heartbeat_at = NOW(),
                lease_expires_at = clock_timestamp() + ($3::double precision * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE id = $1
            AND status = 'running'
            AND lease_token = $2
            AND lease_expires_at > clock_timestamp()
        RETURNING lease_expires_at`,
        [id, leaseToken, leaseMs],
      );
      return result.rows[0]?.lease_expires_at ?? null;
    }, { readOnly: false });
  }

  async markCompleted(
    id: string,
    leaseToken: string,
    receiptMetadata: Record<string, unknown>,
  ): Promise<boolean> {
    return this.finish(id, leaseToken, 'completed', receiptMetadata, null);
  }

  async markFailed(id: string, leaseToken: string, failureCode: string): Promise<boolean> {
    return this.finish(id, leaseToken, 'failed', null, failureCode);
  }

  private async finish(
    id: string,
    leaseToken: string,
    status: 'completed' | 'failed',
    receiptMetadata: Record<string, unknown> | null,
    failureCode: string | null,
  ): Promise<boolean> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query(
        `UPDATE addie_agent_quality_evaluations
            SET status = $3,
                owner_id = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                completed_at = NOW(),
                receipt_metadata_json = $4::jsonb,
                failure_code = $5,
                updated_at = NOW()
          WHERE id = $1
            AND status = 'running'
            AND lease_token = $2
            AND lease_expires_at > clock_timestamp()`,
        [id, leaseToken, status, receiptMetadata ? JSON.stringify(receiptMetadata) : null, failureCode],
      );
      return (result.rowCount ?? 0) === 1;
    }, { readOnly: false });
  }
}
