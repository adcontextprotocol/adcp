import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
  getFeedById: vi.fn(),
  updateFeedStatus: vi.fn(),
  createRssPerspectivesBatch: vi.fn(),
}));

vi.mock('../../src/utils/url-security.js', () => ({ safeFetch: mocks.safeFetch }));
vi.mock('../../src/db/industry-feeds-db.js', () => ({
  getFeedsToFetch: vi.fn(),
  getFeedById: mocks.getFeedById,
  updateFeedStatus: mocks.updateFeedStatus,
  createRssPerspectivesBatch: mocks.createRssPerspectivesBatch,
  normalizeUrl: (url: string) => url,
}));

import { fetchSingleFeed } from '../../src/addie/services/feed-fetcher.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFeedById.mockResolvedValue({
    id: 7,
    name: 'Example industry feed',
    feed_url: 'https://news.example/feed.xml',
    category: 'industry',
  });
  mocks.updateFeedStatus.mockResolvedValue(undefined);
  mocks.createRssPerspectivesBatch.mockResolvedValue(1);
});

describe('RSS feed transport security', () => {
  it('fetches stored feed URLs only through the SSRF-safe transport', async () => {
    mocks.safeFetch.mockResolvedValue(new Response(
      '<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><link>https://news.example</link><description>News</description><item><title>Update</title><link>https://news.example/update</link></item></channel></rss>',
      { status: 200, headers: { 'content-type': 'application/rss+xml' } },
    ));

    const result = await fetchSingleFeed(7);

    expect(result).toEqual({ success: true, newPerspectives: 1 });
    expect(mocks.safeFetch).toHaveBeenCalledWith(
      'https://news.example/feed.xml',
      expect.objectContaining({ maxRedirects: 3 }),
    );
  });

  it('records private-network rejection as a failed feed fetch', async () => {
    mocks.safeFetch.mockRejectedValue(new Error('URLs pointing to private networks are not allowed'));

    const result = await fetchSingleFeed(7);

    expect(result.success).toBe(false);
    expect(result.error).toContain('private networks');
    expect(mocks.updateFeedStatus).toHaveBeenCalledWith(
      7,
      false,
      expect.stringContaining('private networks'),
    );
  });

  it('rejects a streamed feed body larger than 5 MB', async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    mocks.safeFetch.mockResolvedValue(new Response(oversized, {
      status: 200,
      headers: { 'content-type': 'application/rss+xml' },
    }));

    const result = await fetchSingleFeed(7);

    expect(result.success).toBe(false);
    expect(result.error).toContain('byte limit');
  });
});
