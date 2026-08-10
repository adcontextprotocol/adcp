import { afterEach, describe, expect, it, vi } from 'vitest';
import { HTTPServer } from '../../src/http.js';
import { jobScheduler } from '../../src/addie/jobs/scheduler.js';

function makeCrawler(queueEnabled: boolean, calls: string[]) {
  return {
    startPeriodicPublisherCrawlRequests: vi.fn(() => {
      calls.push('publisher-queue');
      return queueEnabled;
    }),
    startPeriodicCrawl: vi.fn(() => calls.push('full-crawl')),
    startPeriodicCatalogCrawl: vi.fn(),
    startPeriodicManagerRevalidation: vi.fn(),
    startPeriodicHostedOriginReverification: vi.fn(),
    stopPeriodicCrawlers: vi.fn().mockResolvedValue(undefined),
  };
}

describe('HTTPServer crawler lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { queueEnabled: true, expectedDelaySeconds: 30 },
    { queueEnabled: false, expectedDelaySeconds: 0 },
  ])('starts the publisher queue before the full crawl with delay $expectedDelaySeconds', ({ queueEnabled, expectedDelaySeconds }) => {
    const calls: string[] = [];
    const crawler = makeCrawler(queueEnabled, calls);
    const server = Object.create((HTTPServer as any).prototype);
    Object.assign(server, {
      crawler,
      agentService: { listAgents: vi.fn().mockResolvedValue([]) },
    });

    server.startWorkerCrawlers();

    expect(calls).toEqual(['publisher-queue', 'full-crawl']);
    expect(crawler.startPeriodicPublisherCrawlRequests).toHaveBeenCalledWith(5);
    expect(crawler.startPeriodicCrawl).toHaveBeenCalledWith(expect.any(Function), 360, expectedDelaySeconds);
  });

  it('awaits crawler scheduler cleanup during worker shutdown', async () => {
    const calls: string[] = [];
    const crawler = makeCrawler(true, calls);
    const stopAll = vi.spyOn(jobScheduler, 'stopAll').mockImplementation(() => undefined);
    const server = Object.create((HTTPServer as any).prototype);
    Object.assign(server, {
      isWorker: true,
      crawler,
      server: null,
    });

    await server.stop();

    expect(crawler.stopPeriodicCrawlers).toHaveBeenCalledOnce();
    expect(stopAll).toHaveBeenCalledOnce();
    expect(crawler.stopPeriodicCrawlers.mock.invocationCallOrder[0]).toBeLessThan(stopAll.mock.invocationCallOrder[0]);
  });
});
