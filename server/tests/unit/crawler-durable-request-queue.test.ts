import { describe, expect, it, vi } from 'vitest';

function claimedRequest() {
  const now = new Date();
  return {
    id: '8d127de4-5568-4756-b66c-dd9b0780fd8f',
    publisher_domain: 'publisher.example',
    source: 'api:crawl-request',
    requester_type: 'user' as const,
    requested_by_user_id: 'user-1',
    status: 'running' as const,
    attempts: 1,
    max_attempts: 5,
    available_at: now,
    lease_owner: 'worker-1',
    lease_token: '11111111-1111-4111-8111-111111111111',
    lease_expires_at: new Date(now.getTime() + 60_000),
    heartbeat_at: now,
    last_attempted_at: now,
    last_error_code: null,
    last_error: null,
    created_at: now,
    started_at: now,
    completed_at: null,
    updated_at: now,
  };
}

async function makeContext() {
  const { CrawlerService } = await import('../../src/crawler.js');
  const crawlRequestsDb = {
    claimDue: vi.fn().mockResolvedValue([claimedRequest()]),
    heartbeat: vi.fn().mockResolvedValue(true),
    markCompleted: vi.fn().mockResolvedValue(true),
    markDeferred: vi.fn().mockResolvedValue(true),
    markFailedAttempt: vi.fn(),
    deleteTerminalBefore: vi.fn().mockResolvedValue(0),
    getQueueHealth: vi.fn().mockResolvedValue({
      queued: 0,
      running: 0,
      deferred: 0,
      retrying: 0,
      expired_leases: 0,
      oldest_active_at: null,
    }),
  };
  const ctx = Object.create((CrawlerService as any).prototype);
  Object.assign(ctx, {
    crawling: false,
    publisherCrawlQueueProcessing: false,
    publisherCrawlLastRetentionAt: Date.now(),
    publisherCrawlLastHealthLogAt: Date.now(),
    publisherCrawlWorkerId: 'worker-1',
    crawlRequestsDb,
    crawlSingleDomain: vi.fn().mockResolvedValue('completed'),
  });
  return { ctx, crawlRequestsDb };
}

describe('CrawlerService durable publisher request worker', () => {
  it('records a successful terminal outcome', async () => {
    const { ctx, crawlRequestsDb } = await makeContext();

    await expect(ctx.processPublisherCrawlRequestQueue()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      invalid: 0,
      retried: 0,
      failed: 0,
      deferred: 0,
    });
    expect(crawlRequestsDb.markCompleted).toHaveBeenCalledWith(
      claimedRequest().id,
      claimedRequest().lease_token,
      'completed',
    );
  });

  it('records a publisher-invalid terminal outcome without retrying', async () => {
    const { ctx, crawlRequestsDb } = await makeContext();
    ctx.crawlSingleDomain.mockResolvedValue('invalid');

    const result = await ctx.processPublisherCrawlRequestQueue();

    expect(result.invalid).toBe(1);
    expect(result.retried).toBe(0);
    expect(crawlRequestsDb.markCompleted).toHaveBeenCalledWith(
      claimedRequest().id,
      claimedRequest().lease_token,
      'invalid',
    );
  });

  it('defers full-crawl contention without marking a failure', async () => {
    const { ctx, crawlRequestsDb } = await makeContext();
    ctx.crawlSingleDomain.mockRejectedValue(Object.assign(new Error('full crawl'), {
      code: 'crawl_deferred',
    }));

    const result = await ctx.processPublisherCrawlRequestQueue();

    expect(result.deferred).toBe(1);
    expect(crawlRequestsDb.markDeferred).toHaveBeenCalledOnce();
    expect(crawlRequestsDb.markFailedAttempt).not.toHaveBeenCalled();
  });

  it('schedules a retry for a transient execution failure', async () => {
    const { ctx, crawlRequestsDb } = await makeContext();
    ctx.crawlSingleDomain.mockRejectedValue(Object.assign(new Error('origin unavailable'), {
      code: 'crawl_origin_temporarily_unavailable',
    }));
    crawlRequestsDb.markFailedAttempt.mockResolvedValue({ status: 'retrying' });

    const result = await ctx.processPublisherCrawlRequestQueue();

    expect(result.retried).toBe(1);
    expect(crawlRequestsDb.markFailedAttempt).toHaveBeenCalledWith(
      claimedRequest().id,
      claimedRequest().lease_token,
      'crawl_origin_temporarily_unavailable',
      'Publisher origin was temporarily unavailable',
    );
  });
});
