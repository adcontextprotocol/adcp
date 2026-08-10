import { getClient, query, withDatabaseDeadline } from './client.js';

const CRAWL_REQUEST_DB_DEADLINE_MS = 5_000;

export type PublisherCrawlRequestStatus =
  | 'queued'
  | 'running'
  | 'deferred'
  | 'retrying'
  | 'completed'
  | 'invalid'
  | 'failed';

export interface PublisherCrawlRequest {
  id: string;
  publisher_domain: string;
  source: string;
  requester_type: 'user' | 'static_admin';
  requested_by_user_id: string | null;
  status: PublisherCrawlRequestStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
  last_attempted_at: Date | null;
  last_error_code: string | null;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
}

export interface ClaimedPublisherCrawlRequest extends PublisherCrawlRequest {
  status: 'running';
  lease_owner: string;
  lease_token: string;
  lease_expires_at: Date;
  was_reclaimed: boolean;
}

export interface ClaimPublisherCrawlRequestsResult {
  requests: ClaimedPublisherCrawlRequest[];
  terminalizedExpired: number;
}

export class CrawlRequestRateLimitError extends Error {
  constructor(
    readonly scope: 'domain' | 'requester',
    readonly retryAfterSeconds: number,
  ) {
    super(scope === 'domain'
      ? 'Rate limit exceeded for this domain'
      : 'Hourly crawl request limit exceeded');
    this.name = 'CrawlRequestRateLimitError';
  }
}

export class CrawlQueueCapacityError extends Error {
  constructor(readonly capacity: number) {
    super('Publisher crawl queue is at capacity');
    this.name = 'CrawlQueueCapacityError';
  }
}

export interface CreatePublisherCrawlRequestInput {
  id: string;
  domain: string;
  source: string;
  requesterType: 'user' | 'static_admin';
  requestedByUserId: string | null;
  domainWindowMs?: number;
  requesterWindowMs?: number;
  requesterLimit?: number;
  activeQueueCapacity?: number;
}

export interface PublisherCrawlQueueHealth {
  queued: number;
  running: number;
  deferred: number;
  retrying: number;
  expired_leases: number;
  oldest_due_at: Date | null;
  oldest_running_at: Date | null;
}

function retryAfterSeconds(retryAt: Date): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1_000));
}

export class PublisherCrawlRequestsDatabase {
  /**
   * Persist admission and enforce cross-instance limits in one transaction.
   * Advisory transaction locks serialize both requester and domain limits
   * across web instances without surviving the transaction.
   */
  async create(input: CreatePublisherCrawlRequestInput): Promise<PublisherCrawlRequest> {
    const domainWindowMs = input.domainWindowMs ?? 5 * 60_000;
    const requesterWindowMs = input.requesterWindowMs ?? 60 * 60_000;
    const requesterLimit = input.requesterLimit ?? 30;
    const activeQueueCapacity = input.activeQueueCapacity ?? 10_000;
    const client = await getClient();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
      await client.query("SELECT set_config('lock_timeout', '2000ms', true)");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'publisher-crawl-capacity',
      ]);
      const capacity = await client.query<{ active_count: string }>(
        `SELECT COUNT(*)::text AS active_count
           FROM publisher_crawl_requests
          WHERE status IN ('queued', 'running', 'deferred', 'retrying')`,
      );
      if (Number(capacity.rows[0]?.active_count ?? 0) >= activeQueueCapacity) {
        throw new CrawlQueueCapacityError(activeQueueCapacity);
      }
      const requesterKey = input.requesterType === 'user'
        ? input.requestedByUserId
        : 'static_admin';
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `publisher-crawl-requester:${requesterKey}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `publisher-crawl-domain:${input.domain}`,
      ]);

      const domainLimit = await client.query<{ retry_at: Date }>(
        `SELECT created_at + ($2::double precision * INTERVAL '1 millisecond') AS retry_at
           FROM publisher_crawl_requests
          WHERE publisher_domain = $1
            AND created_at > NOW() - ($2::double precision * INTERVAL '1 millisecond')
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.domain, domainWindowMs],
      );
      if (domainLimit.rows[0]) {
        throw new CrawlRequestRateLimitError('domain', retryAfterSeconds(domainLimit.rows[0].retry_at));
      }

      const requesterLimitResult = await client.query<{ request_count: string; retry_at: Date | null }>(
        `SELECT COUNT(*)::text AS request_count,
                MIN(created_at) + ($3::double precision * INTERVAL '1 millisecond') AS retry_at
           FROM publisher_crawl_requests
          WHERE requester_type = $1
            AND requested_by_user_id IS NOT DISTINCT FROM $2
            AND created_at > NOW() - ($3::double precision * INTERVAL '1 millisecond')`,
        [input.requesterType, input.requestedByUserId, requesterWindowMs],
      );
      const requesterState = requesterLimitResult.rows[0];
      if (Number(requesterState?.request_count ?? 0) >= requesterLimit) {
        throw new CrawlRequestRateLimitError(
          'requester',
          requesterState?.retry_at ? retryAfterSeconds(requesterState.retry_at) : Math.ceil(requesterWindowMs / 1_000),
        );
      }

      const inserted = await client.query<PublisherCrawlRequest>(
        `INSERT INTO publisher_crawl_requests
           (id, publisher_domain, source, requester_type, requested_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [input.id, input.domain, input.source, input.requesterType, input.requestedByUserId],
      );
      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) {
      if (transactionStarted) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<PublisherCrawlRequest | null> {
    return withDatabaseDeadline(
      Date.now() + CRAWL_REQUEST_DB_DEADLINE_MS,
      async () => {
        const result = await query<PublisherCrawlRequest>(
          'SELECT * FROM publisher_crawl_requests WHERE id = $1',
          [id],
        );
        return result.rows[0] ?? null;
      },
    );
  }

  /** Claim due work, including expired leases, without waiting on peers. */
  async claimDue(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<ClaimPublisherCrawlRequestsResult> {
    const client = await getClient();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      await client.query("SELECT set_config('statement_timeout', '5000ms', true)");
      await client.query("SELECT set_config('lock_timeout', '2000ms', true)");

      // An expired final attempt is terminal; do not leave it permanently
      // running merely because it is no longer eligible for another claim.
      const expiredFinal = await client.query(
        `UPDATE publisher_crawl_requests
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
              hashtextextended('publisher-crawl-fence:' || id::text, 0)
            )`,
      );

      const result = await client.query<ClaimedPublisherCrawlRequest>(
        `WITH candidates AS MATERIALIZED (
           SELECT id, status = 'running' AS was_reclaimed
             FROM publisher_crawl_requests
            WHERE attempts < max_attempts
              AND (
                (status IN ('queued', 'deferred', 'retrying') AND available_at <= NOW())
                OR (status = 'running' AND lease_expires_at <= NOW())
              )
            ORDER BY available_at ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $2
         ), due AS (
           SELECT *
             FROM candidates
            WHERE pg_try_advisory_xact_lock(
              hashtextextended('publisher-crawl-fence:' || id::text, 0)
            )
         )
         UPDATE publisher_crawl_requests AS requests
            SET status = 'running',
                attempts = requests.attempts + 1,
                lease_owner = $1,
                lease_token = gen_random_uuid(),
                lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
                heartbeat_at = NOW(),
                last_attempted_at = NOW(),
                started_at = COALESCE(requests.started_at, NOW()),
                completed_at = NULL,
                updated_at = NOW()
           FROM due
          WHERE requests.id = due.id
         RETURNING requests.*,
                   COALESCE((SELECT due.was_reclaimed FROM due WHERE due.id = requests.id), false)
                     AS was_reclaimed`,
        [workerId, Math.max(1, Math.min(limit, 100)), leaseMs],
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

  async heartbeat(id: string, leaseToken: string, leaseMs: number): Promise<boolean> {
    return withDatabaseDeadline(
      Date.now() + CRAWL_REQUEST_DB_DEADLINE_MS,
      async () => {
        const result = await query(
          `UPDATE publisher_crawl_requests
              SET heartbeat_at = NOW(),
                  lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
                  updated_at = NOW()
            WHERE id = $1 AND status = 'running' AND lease_token = $2
              AND lease_expires_at > NOW()`,
          [id, leaseToken, leaseMs],
        );
        return (result.rowCount ?? 0) === 1;
      },
      { readOnly: false },
    );
  }

  async markCompleted(
    id: string,
    leaseToken: string,
    status: 'completed' | 'invalid',
  ): Promise<boolean> {
    return withDatabaseDeadline(
      Date.now() + CRAWL_REQUEST_DB_DEADLINE_MS,
      async () => {
        const result = await query(
          `UPDATE publisher_crawl_requests
              SET status = $3,
                  completed_at = NOW(),
                  updated_at = NOW(),
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  heartbeat_at = NULL,
                  last_error_code = CASE
                    WHEN $3 = 'invalid' THEN 'publisher_manifest_invalid'
                    ELSE NULL
                  END,
                  last_error = NULL
            WHERE id = $1 AND status = 'running' AND lease_token = $2`,
          [id, leaseToken, status],
        );
        return (result.rowCount ?? 0) === 1;
      },
      { readOnly: false },
    );
  }

  /** Full-crawl contention is neutral: make the row due later and refund the claim attempt. */
  async markDeferred(
    id: string,
    leaseToken: string,
    delayMs: number,
    reason: string,
  ): Promise<boolean> {
    return withDatabaseDeadline(
      Date.now() + CRAWL_REQUEST_DB_DEADLINE_MS,
      async () => {
        const result = await query(
          `UPDATE publisher_crawl_requests
              SET status = 'deferred',
                  attempts = GREATEST(attempts - 1, 0),
                  available_at = NOW() + ($3::double precision * INTERVAL '1 millisecond'),
                  updated_at = NOW(),
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  heartbeat_at = NULL,
                  last_error_code = 'crawl_deferred',
                  last_error = LEFT($4, 500)
            WHERE id = $1 AND status = 'running' AND lease_token = $2`,
          [id, leaseToken, delayMs, reason],
        );
        return (result.rowCount ?? 0) === 1;
      },
      { readOnly: false },
    );
  }

  async markFailedAttempt(
    id: string,
    leaseToken: string,
    errorCode: string,
    errorMessage: string,
  ): Promise<PublisherCrawlRequest | null> {
    return withDatabaseDeadline(
      Date.now() + CRAWL_REQUEST_DB_DEADLINE_MS,
      async () => {
        const result = await query<PublisherCrawlRequest>(
          `UPDATE publisher_crawl_requests
              SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'retrying' END,
                  available_at = NOW() + CASE
                    WHEN attempts <= 1 THEN INTERVAL '1 minute'
                    WHEN attempts = 2 THEN INTERVAL '5 minutes'
                    WHEN attempts = 3 THEN INTERVAL '30 minutes'
                    ELSE INTERVAL '2 hours'
                  END,
                  completed_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE NULL END,
                  updated_at = NOW(),
                  lease_owner = NULL,
                  lease_token = NULL,
                  lease_expires_at = NULL,
                  heartbeat_at = NULL,
                  last_error_code = LEFT($3, 100),
                  last_error = LEFT($4, 500)
            WHERE id = $1 AND status = 'running' AND lease_token = $2
            RETURNING *`,
          [id, leaseToken, errorCode, errorMessage],
        );
        return result.rows[0] ?? null;
      },
      { readOnly: false },
    );
  }

  async deleteTerminalBefore(retainAfter: Date, limit: number = 1_000): Promise<number> {
    return withDatabaseDeadline(
      Date.now() + CRAWL_REQUEST_DB_DEADLINE_MS,
      async () => {
        const result = await query(
          `WITH expired AS (
             SELECT id
               FROM publisher_crawl_requests
              WHERE status IN ('completed', 'invalid', 'failed')
                AND completed_at < $1
              ORDER BY completed_at ASC
              LIMIT $2
           )
           DELETE FROM publisher_crawl_requests AS requests
            USING expired
            WHERE requests.id = expired.id`,
          [retainAfter, Math.max(1, Math.min(limit, 10_000))],
        );
        return result.rowCount ?? 0;
      },
      { readOnly: false },
    );
  }

  async getQueueHealth(): Promise<PublisherCrawlQueueHealth> {
    return withDatabaseDeadline(Date.now() + CRAWL_REQUEST_DB_DEADLINE_MS, async () => {
      const result = await query<{
      queued: string;
      running: string;
      deferred: string;
      retrying: string;
      expired_leases: string;
      oldest_due_at: Date | null;
      oldest_running_at: Date | null;
    }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
              COUNT(*) FILTER (WHERE status = 'running')::text AS running,
              COUNT(*) FILTER (WHERE status = 'deferred')::text AS deferred,
              COUNT(*) FILTER (WHERE status = 'retrying')::text AS retrying,
              COUNT(*) FILTER (
                WHERE status = 'running' AND lease_expires_at <= NOW()
              )::text AS expired_leases,
              MIN(available_at) FILTER (
                WHERE status IN ('queued', 'deferred', 'retrying') AND available_at <= NOW()
              ) AS oldest_due_at,
              MIN(last_attempted_at) FILTER (WHERE status = 'running') AS oldest_running_at
         FROM publisher_crawl_requests
        WHERE status IN ('queued', 'running', 'deferred', 'retrying')`,
    );
      const row = result.rows[0];
      return {
        queued: Number(row.queued),
        running: Number(row.running),
        deferred: Number(row.deferred),
        retrying: Number(row.retrying),
        expired_leases: Number(row.expired_leases),
        oldest_due_at: row.oldest_due_at,
        oldest_running_at: row.oldest_running_at,
      };
    });
  }
}
