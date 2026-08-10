import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  CrawlQueueCapacityError,
  CrawlRequestRateLimitError,
  PublisherCrawlRequestsDatabase,
} from '../../src/db/publisher-crawl-requests-db.js';
import {
  PublisherCrawlLeaseLostError,
  PublisherDatabase,
} from '../../src/db/publisher-db.js';

describe('durable publisher crawl request queue', () => {
  let pool: Pool;
  let db: PublisherCrawlRequestsDatabase;
  const ids: string[] = [];
  const publisherDomains: string[] = [];

  beforeAll(async () => {
    pool = initializeDatabase({
      connectionString: process.env.DATABASE_URL || 'postgresql://adcp:localdev@localhost:5432/adcp_test',
    });
    await runMigrations();
    db = new PublisherCrawlRequestsDatabase();
  });

  beforeEach(async () => {
    if (ids.length > 0) {
      await pool.query('DELETE FROM publisher_crawl_requests WHERE id = ANY($1::uuid[])', [[...ids]]);
      ids.length = 0;
    }
    if (publisherDomains.length > 0) {
      await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [[...publisherDomains]]);
      publisherDomains.length = 0;
    }
  });

  afterAll(async () => {
    if (ids.length > 0) {
      await pool.query('DELETE FROM publisher_crawl_requests WHERE id = ANY($1::uuid[])', [[...ids]]);
    }
    if (publisherDomains.length > 0) {
      await pool.query('DELETE FROM publishers WHERE domain = ANY($1::text[])', [[...publisherDomains]]);
    }
    await closeDatabase();
  });

  async function enqueue(domain = `${randomUUID()}.example.com`) {
    const id = randomUUID();
    ids.push(id);
    return db.create({
      id,
      domain,
      source: 'test',
      requesterType: 'user',
      requestedByUserId: 'durable-crawl-test-user',
    });
  }

  it('persists admission before exposing a queued request', async () => {
    const created = await enqueue();
    const stored = await db.getById(created.id);

    expect(stored).toMatchObject({
      id: created.id,
      status: 'queued',
      attempts: 0,
      requested_by_user_id: 'durable-crawl-test-user',
    });
    expect(stored?.created_at).toBeInstanceOf(Date);
  });

  it('rejects admission when the active queue reaches its global high-water mark', async () => {
    await enqueue();
    const id = randomUUID();
    ids.push(id);
    await expect(db.create({
      id,
      domain: `${id}.example.com`,
      source: 'test',
      requesterType: 'user',
      requestedByUserId: 'capacity-test-user',
      activeQueueCapacity: 1,
    })).rejects.toBeInstanceOf(CrawlQueueCapacityError);
  });

  it('enforces the per-domain admission window across database clients', async () => {
    const domain = `${randomUUID()}.example.com`;
    await enqueue(domain);
    const duplicateId = randomUUID();
    ids.push(duplicateId);

    await expect(db.create({
      id: duplicateId,
      domain,
      source: 'test',
      requesterType: 'user',
      requestedByUserId: 'another-user',
    })).rejects.toMatchObject<CrawlRequestRateLimitError>({
      scope: 'domain',
    });
  });

  it('serializes the per-requester hourly limit across different domains', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    ids.push(firstId, secondId);
    const create = (id: string) => db.create({
      id,
      domain: `${id}.example.com`,
      source: 'test',
      requesterType: 'user',
      requestedByUserId: 'concurrent-limited-user',
      requesterLimit: 1,
    });

    const outcomes = await Promise.allSettled([create(firstId), create(secondId)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { scope: 'requester' },
    });
  });

  it('claims each request once when workers race', async () => {
    const first = await enqueue();
    const second = await enqueue();

    const [workerA, workerB] = await Promise.all([
      db.claimDue('worker-a', 1, 60_000),
      db.claimDue('worker-b', 1, 60_000),
    ]);

    expect(workerA.requests).toHaveLength(1);
    expect(workerB.requests).toHaveLength(1);
    expect(new Set([workerA.requests[0].id, workerB.requests[0].id])).toEqual(new Set([first.id, second.id]));
    expect(workerA.requests[0].lease_token).not.toBe(workerB.requests[0].lease_token);
  });

  it('reclaims an expired lease and rejects completion from the stale attempt', async () => {
    const created = await enqueue();
    const [firstClaim] = (await db.claimDue('worker-a', 1, 60_000)).requests;
    await pool.query(
      `UPDATE publisher_crawl_requests SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [created.id],
    );

    const [secondClaim] = (await db.claimDue('worker-b', 1, 60_000)).requests;
    expect(secondClaim.id).toBe(created.id);
    expect(secondClaim.attempts).toBe(2);
    expect(secondClaim.was_reclaimed).toBe(true);
    expect(secondClaim.lease_token).not.toBe(firstClaim.lease_token);
    await expect(db.markCompleted(created.id, firstClaim.lease_token, 'completed')).resolves.toBe(false);
    await expect(db.markCompleted(created.id, secondClaim.lease_token, 'completed')).resolves.toBe(true);
    await expect(db.getById(created.id)).resolves.toMatchObject({ status: 'completed', attempts: 2 });
  });

  it('fences a reclaimed stale attempt from committing publisher mirror data', async () => {
    const domain = `${randomUUID()}.example.com`;
    publisherDomains.push(domain);
    const created = await enqueue(domain);
    const [staleClaim] = (await db.claimDue('worker-a', 1, 60_000)).requests;
    await pool.query(
      `UPDATE publisher_crawl_requests SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [created.id],
    );
    await db.claimDue('worker-b', 1, 60_000);

    await expect(new PublisherDatabase().upsertAdagentsCache({
      domain,
      manifest: { authorized_agents: [] },
      crawlRequestId: created.id,
      crawlRequestLeaseToken: staleClaim.lease_token,
    })).rejects.toBeInstanceOf(PublisherCrawlLeaseLostError);
    const persisted = await pool.query(
      'SELECT adagents_json FROM publishers WHERE domain = $1',
      [domain],
    );
    expect(persisted.rowCount).toBe(0);
  });

  it('allows heartbeats while the commit fence prevents lease reclamation', async () => {
    const created = await enqueue();
    const [claim] = (await db.claimDue('worker-a', 1, 60_000)).requests;
    const fenceClient = await pool.connect();
    try {
      await fenceClient.query('BEGIN');
      await fenceClient.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `publisher-crawl-fence:${created.id}`,
      ]);

      await expect(db.heartbeat(created.id, claim.lease_token, 60_000)).resolves.toBe(true);
      await pool.query(
        `UPDATE publisher_crawl_requests SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
        [created.id],
      );
      const fencedClaim = await db.claimDue('worker-b', 1, 60_000);
      expect(fencedClaim.requests).toHaveLength(0);

      await fenceClient.query('COMMIT');
      const reclaimed = await db.claimDue('worker-b', 1, 60_000);
      expect(reclaimed.requests).toHaveLength(1);
      expect(reclaimed.requests[0].was_reclaimed).toBe(true);
    } finally {
      await fenceClient.query('ROLLBACK').catch(() => undefined);
      fenceClient.release();
    }
  });

  it('coordinates full and per-domain crawl execution across worker instances', async () => {
    const { CrawlerService } = await import('../../src/crawler.js');
    const firstWorker = Object.create((CrawlerService as any).prototype);
    const secondWorker = Object.create((CrawlerService as any).prototype);
    const pooledConnectionsBefore = pool.totalCount;
    const domainLock = await firstWorker.tryAcquireCrawlExecutionLock('publisher.example');
    expect(domainLock).not.toBeNull();
    expect(pool.totalCount).toBe(pooledConnectionsBefore);

    const sameDomain = await secondWorker.tryAcquireCrawlExecutionLock('publisher.example');
    const fullCrawl = await secondWorker.tryAcquireCrawlExecutionLock();
    const otherDomain = await secondWorker.tryAcquireCrawlExecutionLock('other.example');
    expect(sameDomain).toBeNull();
    expect(fullCrawl).toBeNull();
    expect(otherDomain).not.toBeNull();

    await otherDomain.release();
    await domainLock.release();
    const fullAfterRelease = await secondWorker.tryAcquireCrawlExecutionLock();
    expect(fullAfterRelease).not.toBeNull();
    await fullAfterRelease.release();
  });

  it('defers full-crawl contention without consuming an attempt', async () => {
    const created = await enqueue();
    const [claim] = (await db.claimDue('worker-a', 1, 60_000)).requests;
    expect(claim.attempts).toBe(1);

    await db.markDeferred(created.id, claim.lease_token, 30_000, 'full crawl in progress');
    await expect(db.getById(created.id)).resolves.toMatchObject({
      status: 'deferred',
      attempts: 0,
      last_error_code: 'crawl_deferred',
    });
  });

  it('records an invalid publisher manifest as a terminal non-retry outcome', async () => {
    const created = await enqueue();
    const [claim] = (await db.claimDue('worker-a', 1, 60_000)).requests;

    await db.markCompleted(created.id, claim.lease_token, 'invalid');

    await expect(db.getById(created.id)).resolves.toMatchObject({
      status: 'invalid',
      attempts: 1,
      last_error_code: 'publisher_manifest_invalid',
    });
  });

  it('retries failures and reaches a bounded terminal state', async () => {
    const created = await enqueue();
    await pool.query('UPDATE publisher_crawl_requests SET max_attempts = 2 WHERE id = $1', [created.id]);

    const [firstClaim] = (await db.claimDue('worker-a', 1, 60_000)).requests;
    const retrying = await db.markFailedAttempt(
      created.id,
      firstClaim.lease_token,
      'origin_timeout',
      'origin timed out',
    );
    expect(retrying).toMatchObject({ status: 'retrying', attempts: 1 });

    await pool.query('UPDATE publisher_crawl_requests SET available_at = NOW() WHERE id = $1', [created.id]);
    const [secondClaim] = (await db.claimDue('worker-b', 1, 60_000)).requests;
    const failed = await db.markFailedAttempt(
      created.id,
      secondClaim.lease_token,
      'origin_timeout',
      'origin timed out again',
    );
    expect(failed).toMatchObject({ status: 'failed', attempts: 2 });
    expect(failed?.completed_at).toBeInstanceOf(Date);
  });

  it('terminally fails a final attempt whose worker lease expires', async () => {
    const created = await enqueue();
    await pool.query('UPDATE publisher_crawl_requests SET max_attempts = 1 WHERE id = $1', [created.id]);
    await db.claimDue('worker-a', 1, 60_000);
    await pool.query(
      `UPDATE publisher_crawl_requests SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [created.id],
    );

    const terminalized = await db.claimDue('worker-b', 1, 60_000);
    expect(terminalized.terminalizedExpired).toBe(1);
    await expect(db.getById(created.id)).resolves.toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error_code: 'lease_expired',
    });
  });
});
