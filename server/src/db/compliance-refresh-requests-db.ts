import type { PoolClient } from 'pg';
import { getClient, getDedicatedClient, query, withDatabaseDeadline } from './client.js';

const DB_DEADLINE_MS = 5_000;
const EXECUTION_FENCE_KEEPALIVE_MS = 15_000;
const EXECUTION_FENCE_OPERATION_TIMEOUT_MS = 5_000;

export type ComplianceRefreshRequestStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ComplianceRefreshRequest {
  id: string;
  agent_url: string;
  owner_org_id: string | null;
  requester_type: 'user' | 'static_admin';
  requested_by_user_id: string | null;
  requested_by_auth_workos_user_id: string;
  authorization_fingerprint: string;
  triggered_by: 'owner_test' | 'manual';
  test_session_id: string;
  status: ComplianceRefreshRequestStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  last_attempted_at: Date | null;
  probe_result_json: Record<string, unknown> | null;
  auth_available: boolean | null;
  result_json: Record<string, unknown> | null;
  last_error_code: string | null;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export interface ClaimedComplianceRefreshRequest extends ComplianceRefreshRequest {
  status: 'running';
  lease_owner: string;
  lease_token: string;
  lease_expires_at: Date;
  was_reclaimed: boolean;
}

export interface CreateComplianceRefreshRequestInput {
  id: string;
  agentUrl: string;
  ownerOrgId: string | null;
  requesterType: 'user' | 'static_admin';
  requestedByUserId: string | null;
  requestedByAuthWorkosUserId: string | null;
  authorizationFingerprint: string;
  triggeredBy: 'owner_test' | 'manual';
  agentWindowMs?: number;
  requesterWindowMs?: number;
  requesterLimit?: number;
  requesterActiveLimit?: number;
  activeQueueCapacity?: number;
}

export class ComplianceRefreshRateLimitError extends Error {
  constructor(
    readonly scope: 'agent' | 'requester',
    readonly retryAfterSeconds: number,
  ) {
    super(scope === 'agent'
      ? 'Rate limit exceeded for this agent'
      : 'Hourly refresh limit exceeded');
    this.name = 'ComplianceRefreshRateLimitError';
  }
}

export class ComplianceRefreshQueueCapacityError extends Error {
  constructor(readonly capacity: number) {
    super('Compliance refresh queue is at capacity');
    this.name = 'ComplianceRefreshQueueCapacityError';
  }
}

export class ComplianceRefreshInProgressError extends Error {
  constructor(readonly retryAfterSeconds = 5) {
    super('A refresh is already in progress for this agent under a different authorization context');
    this.name = 'ComplianceRefreshInProgressError';
  }
}

export class ComplianceRefreshProvenanceError extends Error {
  readonly code = 'authorization_provenance_missing';

  constructor() {
    super('Authenticated credential provenance is missing; submit a new refresh');
    this.name = 'ComplianceRefreshProvenanceError';
  }
}

/** Legacy requester IDs may be canonical identities; they are never provenance. */
export function hasComplianceRefreshProvenance(request: Pick<ComplianceRefreshRequest,
  'requester_type' | 'requested_by_user_id' | 'requested_by_auth_workos_user_id'
  | 'authorization_fingerprint' | 'triggered_by' | 'owner_org_id'
>): boolean {
  const credential = request.requested_by_auth_workos_user_id;
  return request.requester_type === 'user'
    && typeof credential === 'string'
    && credential.length > 0
    && credential !== '__unproven__'
    && credential === credential.trim()
    && request.requested_by_user_id === credential
    && isComplianceRefreshAuthorizationFingerprint(credential, request.authorization_fingerprint)
    && ((request.triggered_by === 'manual' && request.owner_org_id === null)
      || (request.triggered_by === 'owner_test'
        && typeof request.owner_org_id === 'string' && request.owner_org_id.trim().length > 0));
}

export function isComplianceRefreshAuthorizationFingerprint(credentialId: string, value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string' || !value.startsWith(`${credentialId}:`)) return false;
  const epoch = value.slice(credentialId.length + 1);
  return /^[1-9][0-9]{0,18}$/.test(epoch) && BigInt(epoch) <= 9223372036854775807n;
}

function authorizationStateError(code: 'authorization_revoked' | 'authorization_unavailable'): Error & { code: typeof code } {
  return Object.assign(new Error(code === 'authorization_revoked'
    ? 'Authorization changed before the refresh started'
    : 'Refresh authorization is temporarily unavailable'), { code });
}

/** Fence both existing epoch changes and the first epoch INSERT until commit. */
export async function assertComplianceRefreshAuthorizationFingerprint(
  client: PoolClient,
  credentialId: string,
  expected: string,
): Promise<void> {
  let current: string;
  try {
    const user = await client.query(
      'SELECT workos_user_id FROM users WHERE workos_user_id = $1 FOR UPDATE', [credentialId],
    );
    if (!user.rows.length) throw authorizationStateError('authorization_unavailable');
    const epoch = await client.query<{ epoch: string }>(
      'SELECT epoch::text AS epoch FROM authorization_epochs WHERE workos_user_id = $1 FOR SHARE', [credentialId],
    );
    current = epoch.rows.length ? `${credentialId}:${epoch.rows[0].epoch}` : '';
    if (!isComplianceRefreshAuthorizationFingerprint(credentialId, current)) {
      throw authorizationStateError('authorization_unavailable');
    }
  } catch {
    throw authorizationStateError('authorization_unavailable');
  }
  if (current !== expected) throw authorizationStateError('authorization_revoked');
}

export class ComplianceRefreshLeaseLostError extends Error {
  readonly code = 'lease_lost';

  constructor() {
    super('Compliance refresh worker lease was lost');
    this.name = 'ComplianceRefreshLeaseLostError';
  }
}

export interface ComplianceRefreshExecutionFence {
  isValid(): boolean;
  release(): Promise<void>;
}

function retryAfterSeconds(retryAt: Date): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1_000));
}

export class ComplianceRefreshRequestsDatabase {
  /** Persist admission, coalescing, and cross-instance limits atomically. */
  async createOrGetActive(input: CreateComplianceRefreshRequestInput): Promise<{
    request: ComplianceRefreshRequest;
    coalesced: boolean;
  }> {
    // Validate before coalescing: an existing row must never make malformed
    // caller provenance acceptable, even when no INSERT would be performed.
    if (!hasComplianceRefreshProvenance({
      requester_type: input.requesterType,
      requested_by_user_id: input.requestedByUserId,
      requested_by_auth_workos_user_id: input.requestedByAuthWorkosUserId!,
      authorization_fingerprint: input.authorizationFingerprint,
      triggered_by: input.triggeredBy,
      owner_org_id: input.ownerOrgId,
    })) throw new ComplianceRefreshProvenanceError();

    const sameCredentialContext = (request: ComplianceRefreshRequest): boolean =>
      hasComplianceRefreshProvenance(request)
      && request.triggered_by === input.triggeredBy
      && request.owner_org_id === input.ownerOrgId
      && request.requester_type === input.requesterType
      && request.requested_by_auth_workos_user_id === input.requestedByAuthWorkosUserId
      && request.authorization_fingerprint === input.authorizationFingerprint;
    const agentWindowMs = input.agentWindowMs ?? 60_000;
    const requesterWindowMs = input.requesterWindowMs ?? 60 * 60_000;
    const requesterLimit = input.requesterLimit ?? 30;
    const requesterActiveLimit = input.requesterActiveLimit ?? 3;
    const activeQueueCapacity = input.activeQueueCapacity ?? 100;
    const client = await getClient();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
      await client.query("SELECT set_config('lock_timeout', '2000ms', true)");
      await assertComplianceRefreshAuthorizationFingerprint(
        client, input.requestedByAuthWorkosUserId!, input.authorizationFingerprint,
      );
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `agent-compliance-refresh:${input.agentUrl}`,
      ]);

      const active = await client.query<ComplianceRefreshRequest>(
        `SELECT *
           FROM agent_compliance_refresh_requests
          WHERE agent_url = $1 AND status IN ('queued', 'running')
          ORDER BY created_at ASC
          LIMIT 1 FOR UPDATE`,
        [input.agentUrl],
      );
      if (active.rows[0]) {
        const provenanceMissing = !hasComplianceRefreshProvenance(active.rows[0]);
        const epochRevoked = active.rows[0].requested_by_auth_workos_user_id === input.requestedByAuthWorkosUserId
          && active.rows[0].authorization_fingerprint !== input.authorizationFingerprint;
        if (provenanceMissing || epochRevoked) {
          // Do not replace an operation while a worker still owns its fence.
          const rejected = await client.query(
            `UPDATE agent_compliance_refresh_requests
                SET status = 'failed', completed_at = NOW(), updated_at = NOW(),
                    lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                    last_error_code = $2, last_error = $3
              WHERE id = $1 AND pg_try_advisory_xact_lock(
                hashtextextended('compliance-refresh-fence:' || id::text, 0)
              )`,
            [active.rows[0].id,
              provenanceMissing ? 'authorization_provenance_missing' : 'authorization_revoked',
              provenanceMissing ? 'Authenticated credential provenance is missing; submit a new refresh'
                : 'Authorization changed before the refresh started'],
          );
          if (!rejected.rowCount) throw new ComplianceRefreshInProgressError();
        } else if (!sameCredentialContext(active.rows[0])) {
          throw new ComplianceRefreshInProgressError();
        } else {
          await client.query('COMMIT');
          return { request: active.rows[0], coalesced: true };
        }
      }

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'agent-compliance-refresh-capacity',
      ]);
      const capacity = await client.query<{ active_count: string }>(
        `SELECT COUNT(*)::text AS active_count
           FROM agent_compliance_refresh_requests
          WHERE status IN ('queued', 'running')`,
      );
      if (Number(capacity.rows[0]?.active_count ?? 0) >= activeQueueCapacity) {
        throw new ComplianceRefreshQueueCapacityError(activeQueueCapacity);
      }

      const recent = await client.query<ComplianceRefreshRequest & { retry_at: Date }>(
        `SELECT *, created_at + ($2::double precision * INTERVAL '1 millisecond') AS retry_at
           FROM agent_compliance_refresh_requests
          WHERE agent_url = $1
            AND status IN ('succeeded', 'failed')
            AND requested_by_auth_workos_user_id <> '__unproven__'
            AND last_error_code IS DISTINCT FROM 'authorization_provenance_missing'
            AND last_error_code IS DISTINCT FROM 'authorization_revoked'
            AND NOT (requested_by_auth_workos_user_id = $3 AND authorization_fingerprint <> $4)
            AND created_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.agentUrl, agentWindowMs, input.requestedByAuthWorkosUserId, input.authorizationFingerprint],
      );
      if (recent.rows[0] && hasComplianceRefreshProvenance(recent.rows[0])) {
        if (sameCredentialContext(recent.rows[0])) {
          await client.query('COMMIT');
          return { request: recent.rows[0], coalesced: true };
        }
        throw new ComplianceRefreshRateLimitError('agent', retryAfterSeconds(recent.rows[0].retry_at));
      }

      const requesterKey = input.requesterType === 'user'
        ? input.requestedByUserId
        : 'static_admin';
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `agent-compliance-refresh-requester:${requesterKey}`,
      ]);
      const requesterState = await client.query<{
        request_count: string;
        active_count: string;
        retry_at: Date | null;
      }>(
        `SELECT COUNT(*)::text AS request_count,
                COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::text AS active_count,
                MIN(created_at) + ($3::double precision * INTERVAL '1 millisecond') AS retry_at
           FROM agent_compliance_refresh_requests
          WHERE requester_type = $1
            AND requested_by_user_id IS NOT DISTINCT FROM $2
            AND requested_by_auth_workos_user_id = $2
            AND authorization_fingerprint = $4
            AND last_error_code IS DISTINCT FROM 'authorization_provenance_missing'
            AND last_error_code IS DISTINCT FROM 'authorization_revoked'
            AND created_at > NOW() - ($3::double precision * INTERVAL '1 millisecond')`,
        [input.requesterType, input.requestedByUserId, requesterWindowMs, input.authorizationFingerprint],
      );
      const requester = requesterState.rows[0];
      if (Number(requester?.active_count ?? 0) >= requesterActiveLimit) {
        throw new ComplianceRefreshRateLimitError('requester', 5);
      }
      if (Number(requester?.request_count ?? 0) >= requesterLimit) {
        throw new ComplianceRefreshRateLimitError(
          'requester',
          requester?.retry_at
            ? retryAfterSeconds(requester.retry_at)
            : Math.ceil(requesterWindowMs / 1_000),
        );
      }

      const inserted = await client.query<ComplianceRefreshRequest>(
        `INSERT INTO agent_compliance_refresh_requests
           (id, agent_url, owner_org_id, requester_type, requested_by_user_id, triggered_by, test_session_id,
            requested_by_auth_workos_user_id, authorization_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          input.id,
          input.agentUrl,
          input.ownerOrgId,
          input.requesterType,
          input.requestedByUserId,
          input.triggeredBy,
          `owner-refresh-${input.id}`,
          input.requestedByAuthWorkosUserId,
          input.authorizationFingerprint,
        ],
      );
      await client.query('COMMIT');
      return { request: inserted.rows[0], coalesced: false };
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<ComplianceRefreshRequest | null> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query<ComplianceRefreshRequest>(
        'SELECT * FROM agent_compliance_refresh_requests WHERE id = $1',
        [id],
      );
      return result.rows[0] ?? null;
    });
  }

  async claimDue(workerId: string, limit: number, leaseMs: number): Promise<{
    requests: ClaimedComplianceRefreshRequest[];
    terminalizedExpired: number;
  }> {
    const client = await getClient();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
      await client.query("SELECT set_config('lock_timeout', '2000ms', true)");
      await client.query("SELECT set_config('adcp.compliance_refresh_writer_contract', 'authenticated-credential-v1', true)");

      const expiredFinal = await client.query(
        `UPDATE agent_compliance_refresh_requests
            SET status = 'failed',
                completed_at = NOW(),
                updated_at = NOW(),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                last_error_code = COALESCE(last_error_code, 'lease_expired'),
                last_error = COALESCE(last_error, 'Worker lease expired after the final attempt')
          WHERE status = 'running'
            AND lease_expires_at <= NOW()
            AND attempts >= max_attempts
            AND pg_try_advisory_xact_lock(
              hashtextextended('compliance-refresh-fence:' || id::text, 0)
            )`,
      );

      const result = await client.query<ClaimedComplianceRefreshRequest>(
        `WITH candidates AS MATERIALIZED (
           SELECT id, status = 'running' AS was_reclaimed
             FROM agent_compliance_refresh_requests
            WHERE attempts < max_attempts
              AND (
                (status = 'queued' AND available_at <= NOW())
                OR (status = 'running' AND lease_expires_at <= NOW())
              )
            ORDER BY available_at ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         ), due AS (
           SELECT *
             FROM candidates
            WHERE pg_try_advisory_xact_lock(
              hashtextextended('compliance-refresh-fence:' || id::text, 0)
            )
         )
         UPDATE agent_compliance_refresh_requests AS requests
            SET status = 'running',
                attempts = requests.attempts + 1,
                lease_owner = $1,
                lease_token = gen_random_uuid(),
                lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
                heartbeat_at = NOW(),
                last_attempted_at = NOW(),
                started_at = COALESCE(requests.started_at, NOW()),
                updated_at = NOW(),
                last_error_code = NULL,
                last_error = NULL
           FROM due
          WHERE requests.id = due.id
         RETURNING requests.*, due.was_reclaimed`,
        [workerId, limit, leaseMs],
      );
      await client.query('COMMIT');
      return {
        requests: result.rows,
        terminalizedExpired: expiredFinal.rowCount ?? 0,
      };
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Hold operation and canonical-agent fences for an owner/admin refresh. */
  async acquireExecutionFence(
    id: string,
    agentUrl: string,
  ): Promise<ComplianceRefreshExecutionFence | null> {
    return this.acquireSessionFences([
      `compliance-refresh-fence:${id}`,
      `compliance-agent-execution:${agentUrl}`,
    ]);
  }

  /** Share the canonical-agent suite fence with scheduled heartbeat runs. */
  async acquireAgentExecutionFence(agentUrl: string): Promise<ComplianceRefreshExecutionFence | null> {
    return this.acquireSessionFences([`compliance-agent-execution:${agentUrl}`]);
  }

  private async acquireSessionFences(keys: string[]): Promise<ComplianceRefreshExecutionFence | null> {
    const client = await getDedicatedClient();
    let valid = true;
    let released = false;
    let keepaliveInFlight = false;
    const onConnectionError = () => {
      valid = false;
    };
    const destroyConnection = (): void => {
      if (!client.connection.stream.destroyed) client.connection.stream.destroy();
    };
    const runBounded = async <T>(operation: () => Promise<T>, label: string): Promise<T> => {
      let timeout: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = Object.assign(
            new Error(`Compliance refresh execution fence ${label} timed out`),
            { code: 'refresh_fence_operation_timeout' },
          );
          onConnectionError();
          destroyConnection();
          reject(error);
        }, EXECUTION_FENCE_OPERATION_TIMEOUT_MS);
      });
      try {
        return await Promise.race([operation(), deadline]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    const closeClient = async (): Promise<void> => {
      try {
        await runBounded(() => client.end(), 'connection close');
      } catch {
        destroyConnection();
      }
    };
    client.on('error', onConnectionError);
    try {
      for (const key of keys) {
        const lock = await runBounded(() => client.query<{ acquired: boolean }>(
          `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
          [key],
        ), 'lock acquisition');
        if (!lock.rows[0]?.acquired) {
          client.off('error', onConnectionError);
          await closeClient();
          return null;
        }
      }
      const keepalive = setInterval(() => {
        if (keepaliveInFlight || !valid || released) return;
        keepaliveInFlight = true;
        runBounded(() => client.query('SELECT 1'), 'keepalive')
          .catch(() => onConnectionError())
          .finally(() => { keepaliveInFlight = false; });
      }, EXECUTION_FENCE_KEEPALIVE_MS);
      keepalive.unref();
      return {
        isValid: () => valid && !released,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(keepalive);
          client.off('error', onConnectionError);
          if (valid) {
            for (const key of [...keys].reverse()) {
              await runBounded(() => client.query(
                `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
                [key],
              ), 'lock release').catch(() => undefined);
            }
          }
          await closeClient();
        },
      };
    } catch (error) {
      client.off('error', onConnectionError);
      await closeClient();
      throw error;
    }
  }

  async heartbeat(id: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query(
        `UPDATE agent_compliance_refresh_requests
            SET heartbeat_at = NOW(),
                lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
                updated_at = NOW()
          WHERE id = $1 AND status = 'running' AND lease_token = $2
            AND lease_expires_at > NOW()`,
        [id, leaseToken, leaseMs],
      );
      return (result.rowCount ?? 0) === 1;
    }, { readOnly: false });
  }

  /** Save the completed live probe before the expensive compliance suite starts. */
  async recordProbeResult(
    id: string,
    leaseToken: string,
    probeResult: Record<string, unknown>,
    authAvailable: boolean,
  ): Promise<boolean> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query(
        `UPDATE agent_compliance_refresh_requests
            SET probe_result_json = $3::jsonb,
                auth_available = $4,
                updated_at = NOW()
          WHERE id = $1 AND status = 'running' AND lease_token = $2
            AND lease_expires_at > NOW()`,
        [id, leaseToken, JSON.stringify(probeResult), authAvailable],
      );
      return (result.rowCount ?? 0) === 1;
    }, { readOnly: false });
  }

  /** Return an unexecuted claim to the queue when another suite owns the agent fence. */
  async deferClaim(id: string, leaseToken: string, delayMs = 5_000): Promise<boolean> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query(
        `UPDATE agent_compliance_refresh_requests
            SET status = 'queued',
                attempts = GREATEST(0, attempts - 1),
                available_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
                updated_at = NOW(),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL
          WHERE id = $1 AND status = 'running' AND lease_token = $2`,
        [id, leaseToken, delayMs],
      );
      return (result.rowCount ?? 0) === 1;
    }, { readOnly: false });
  }

  /** Retry a transient executor failure without exposing its raw diagnostics. */
  async requeueAfterFailure(
    id: string,
    leaseToken: string,
    errorCode: string,
    errorMessage: string,
    delayMs = 5_000,
  ): Promise<boolean> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query(
        `UPDATE agent_compliance_refresh_requests
            SET status = 'queued',
                available_at = NOW() + ($5::double precision * INTERVAL '1 millisecond'),
                updated_at = NOW(),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                last_error_code = $3,
                last_error = $4
          WHERE id = $1 AND status = 'running' AND lease_token = $2
            AND attempts < max_attempts`,
        [id, leaseToken, errorCode, errorMessage, delayMs],
      );
      return (result.rowCount ?? 0) === 1;
    }, { readOnly: false });
  }

  async markSucceeded(
    id: string,
    leaseToken: string,
    resultJson: Record<string, unknown>,
    beforeWrite: (client: PoolClient) => Promise<void>,
  ): Promise<boolean> {
    if (typeof beforeWrite !== 'function') throw authorizationStateError('authorization_unavailable');
    const client = await getClient();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
      await client.query("SELECT set_config('lock_timeout', '2000ms', true)");
      await beforeWrite(client);
      const result = await client.query(
        `UPDATE agent_compliance_refresh_requests
            SET status = 'succeeded',
                result_json = $3::jsonb,
                completed_at = NOW(),
                updated_at = NOW(),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                last_error_code = NULL,
                last_error = NULL
          WHERE id = $1 AND status = 'running' AND lease_token = $2
            AND lease_expires_at > NOW()`,
        [id, leaseToken, JSON.stringify(resultJson)],
      );
      await client.query('COMMIT');
      return (result.rowCount ?? 0) === 1;
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markFailed(
    id: string,
    leaseToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query(
        `UPDATE agent_compliance_refresh_requests
            SET status = 'failed',
                completed_at = NOW(),
                updated_at = NOW(),
                lease_owner = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                last_error_code = LEFT($3, 100),
                last_error = LEFT($4, 500)
          WHERE id = $1 AND status = 'running' AND lease_token = $2
            AND lease_expires_at > NOW()`,
        [id, leaseToken, errorCode, errorMessage],
      );
      return (result.rowCount ?? 0) === 1;
    }, { readOnly: false });
  }

  async deleteTerminalBefore(retainAfter: Date, limit: number = 1_000): Promise<number> {
    return withDatabaseDeadline(Date.now() + DB_DEADLINE_MS, async () => {
      const result = await query(
        `WITH expired AS (
           SELECT id
             FROM agent_compliance_refresh_requests
            WHERE status IN ('succeeded', 'failed') AND completed_at < $1
            ORDER BY completed_at ASC
            LIMIT $2
         )
         DELETE FROM agent_compliance_refresh_requests AS requests
          USING expired
          WHERE requests.id = expired.id`,
        [retainAfter, Math.max(1, Math.min(limit, 10_000))],
      );
      return result.rowCount ?? 0;
    }, { readOnly: false });
  }
}
