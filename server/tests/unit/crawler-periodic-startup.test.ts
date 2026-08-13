import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrawlerService } from '../../src/crawler.js';

function makeContext() {
  const ctx = Object.create((CrawlerService as any).prototype);
  Object.assign(ctx, {
    intervalId: null,
    initialCrawlTimeoutId: null,
    fullCrawlLockRetryTimer: null,
    publisherCrawlQueueIntervalId: null,
    catalogCrawlIntervalId: null,
    managerRevalidationIntervalId: null,
    hostedReverifyIntervalId: null,
    fullCrawlIntentLock: null,
    crawlAllAgents: vi.fn().mockResolvedValue(undefined),
  });
  return ctx;
}

describe('CrawlerService periodic crawl startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves the immediate initial crawl by default', async () => {
    const ctx = makeContext();
    const getAgents = vi.fn().mockResolvedValue([]);

    ctx.startPeriodicCrawl(getAgents, 360);
    await vi.runAllTicks();

    expect(getAgents).toHaveBeenCalledOnce();
    expect(ctx.crawlAllAgents).toHaveBeenCalledOnce();
    ctx.stopPeriodicCrawl();
  });

  it('delays only the initial crawl for the bounded durable-queue startup window', async () => {
    const ctx = makeContext();
    const getAgents = vi.fn().mockResolvedValue([]);

    ctx.startPeriodicCrawl(getAgents, 360, 30);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(getAgents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(getAgents).toHaveBeenCalledOnce();
    expect(ctx.crawlAllAgents).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(360 * 60_000 - 30_000);
    expect(getAgents).toHaveBeenCalledTimes(2);
    expect(ctx.crawlAllAgents).toHaveBeenCalledTimes(2);
    ctx.stopPeriodicCrawl();
  });

  it('cancels a pending initial crawl during shutdown', async () => {
    const ctx = makeContext();
    const getAgents = vi.fn().mockResolvedValue([]);

    ctx.startPeriodicCrawl(getAgents, 360, 30);
    ctx.stopPeriodicCrawl();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(getAgents).not.toHaveBeenCalled();
  });

  it('stops every crawler scheduler before worker shutdown', async () => {
    const ctx = makeContext();
    const tick = vi.fn();
    ctx.initialCrawlTimeoutId = setTimeout(tick, 30_000);
    ctx.intervalId = setInterval(tick, 30_000);
    ctx.fullCrawlLockRetryTimer = setTimeout(tick, 30_000);
    ctx.publisherCrawlQueueIntervalId = setInterval(tick, 5_000);
    ctx.catalogCrawlIntervalId = setInterval(tick, 30_000);
    ctx.managerRevalidationIntervalId = setInterval(tick, 30_000);
    ctx.hostedReverifyIntervalId = setInterval(tick, 30_000);

    await ctx.stopPeriodicCrawlers();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(tick).not.toHaveBeenCalled();
    expect(ctx.initialCrawlTimeoutId).toBeNull();
    expect(ctx.publisherCrawlQueueIntervalId).toBeNull();
    expect(ctx.catalogCrawlIntervalId).toBeNull();
    expect(ctx.managerRevalidationIntervalId).toBeNull();
    expect(ctx.hostedReverifyIntervalId).toBeNull();
  });

  it('waits for and releases an intent lock acquired during shutdown', async () => {
    const ctx = makeContext();
    let resolveLock!: (lock: { isValid: () => boolean; release: () => Promise<void> }) => void;
    const pendingLock = new Promise<{ isValid: () => boolean; release: () => Promise<void> }>(
      (resolve) => { resolveLock = resolve; },
    );
    let resolveRelease!: () => void;
    const releasePending = new Promise<void>((resolve) => { resolveRelease = resolve; });
    const release = vi.fn().mockReturnValue(releasePending);
    ctx.tryAcquireFullCrawlIntentLock = vi.fn().mockReturnValue(pendingLock);

    const acquisition = ctx.ensureFullCrawlIntentLock();
    const stopping = ctx.stopPeriodicCrawlers();
    let stopped = false;
    stopping.then(() => { stopped = true; });
    await vi.runAllTicks();
    expect(stopped).toBe(false);

    resolveLock({ isValid: () => true, release });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(stopped).toBe(false);
    resolveRelease();
    await stopping;
    await expect(acquisition).resolves.toBe(false);

    expect(ctx.fullCrawlIntentLock).toBeNull();
  });
});
