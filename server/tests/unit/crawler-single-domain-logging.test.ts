import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLog } = vi.hoisted(() => ({
  mockLog: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  },
}));

mockLog.child.mockReturnValue(mockLog);

vi.mock('../../src/logger.js', () => ({
  createLogger: () => mockLog,
  logger: mockLog,
  processRole: 'worker',
  setErrorHook: vi.fn(),
  setLogHook: vi.fn(),
}));

import { CrawlerService } from '../../src/crawler.js';

function makeContext() {
  const ctx = Object.create((CrawlerService as any).prototype);
  Object.assign(ctx, {
    crawling: false,
    coordinateCrawlsAcrossInstances: false,
    publisherDb: {
      recordFailedAdagentsFetch: vi.fn().mockResolvedValue(undefined),
    },
  });
  return ctx;
}

function makeClaimedRequest() {
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
    was_reclaimed: false,
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

function makeDurableWorkerContext(failureStatus: 'retrying' | 'failed') {
  const ctx = Object.create((CrawlerService as any).prototype);
  Object.assign(ctx, {
    crawlSingleDomain: vi.fn().mockRejectedValue(Object.assign(
      new Error('origin unavailable'),
      { code: 'crawl_origin_temporarily_unavailable' },
    )),
    crawlRequestsDb: {
      heartbeat: vi.fn().mockResolvedValue(true),
      markFailedAttempt: vi.fn().mockResolvedValue({
        status: failureStatus,
        attempts: failureStatus === 'failed' ? 5 : 2,
        max_attempts: 5,
        last_error_code: 'crawl_origin_temporarily_unavailable',
      }),
    },
  });
  return ctx;
}

describe('CrawlerService single-domain failure logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLog.child.mockReturnValue(mockLog);
  });

  it('keeps retryable publisher-origin failures below error level', async () => {
    const ctx = makeContext();
    ctx.adAgentsManager = {
      validateDomain: vi.fn().mockResolvedValue({
        valid: false,
        errors: [{ field: 'network', message: 'Cannot connect to publisher' }],
        warnings: [],
        status_code: 503,
      }),
    };

    await expect(ctx.crawlSingleDomain('publisher.example')).rejects.toMatchObject({
      code: 'crawl_origin_temporarily_unavailable',
    });

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'publisher.example',
        crawl_status: 'failed',
        crawl_stage: 'origin_validation',
      }),
      'Single domain crawl hit a retryable publisher-origin failure',
    );
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('continues to report unexpected crawler failures at error level', async () => {
    const ctx = makeContext();
    ctx.adAgentsManager = {
      validateDomain: vi.fn().mockRejectedValue(new Error('unexpected failure')),
    };

    await expect(ctx.crawlSingleDomain('publisher.example')).rejects.toThrow('unexpected failure');

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'publisher.example',
        crawl_status: 'failed',
        crawl_stage: 'origin_validation',
      }),
      'Single domain crawl failed',
    );
  });

  it('keeps durable publisher-origin retries below error level', async () => {
    const ctx = makeDurableWorkerContext('retrying');

    await expect(ctx.processClaimedPublisherCrawlRequest(makeClaimedRequest()))
      .resolves.toBe('retried');

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'publisher.example',
        crawl_status: 'retrying',
        error_code: 'crawl_origin_temporarily_unavailable',
      }),
      'Durable publisher crawl request scheduled for retry',
    );
    expect(mockLog.error).not.toHaveBeenCalled();
  });

  it('reports exhausted durable publisher-origin retries at error level', async () => {
    const ctx = makeDurableWorkerContext('failed');

    await expect(ctx.processClaimedPublisherCrawlRequest(makeClaimedRequest()))
      .resolves.toBe('failed');

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'publisher.example',
        crawl_status: 'failed',
        crawl_attempts: 5,
        max_attempts: 5,
        error_code: 'crawl_origin_temporarily_unavailable',
      }),
      'Durable publisher crawl request exhausted retries',
    );
  });
});
