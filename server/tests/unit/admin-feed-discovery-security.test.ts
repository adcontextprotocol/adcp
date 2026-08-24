import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('../../src/utils/url-security.js', () => ({ safeFetch }));
vi.mock('../../src/middleware/auth.js', () => ({ requireGlobalAdmin: [] }));

import { discoverRssFeeds } from '../../src/routes/admin/feeds.js';

beforeEach(() => vi.clearAllMocks());

describe('admin feed discovery transport security', () => {
  it('propagates SSRF-safe transport rejection for a private destination', async () => {
    safeFetch.mockRejectedValue(new Error('URLs pointing to private networks are not allowed'));
    await expect(discoverRssFeeds('http://127.0.0.1/feed')).rejects.toThrow('private networks');
  });

  it('rejects HTML larger than the discovery body cap', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    safeFetch.mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }));

    await expect(discoverRssFeeds('https://news.example')).rejects.toThrow('byte limit');
  });

  it('uses safeFetch for every common-path probe', async () => {
    safeFetch
      .mockResolvedValueOnce(new Response('<html><body>No feed link</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }))
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(discoverRssFeeds('https://news.example/articles')).resolves.toEqual([]);
    expect(safeFetch).toHaveBeenCalledTimes(7);
    for (const [, options] of safeFetch.mock.calls.slice(1)) {
      expect(options).toEqual(expect.objectContaining({ method: 'HEAD', maxRedirects: 3 }));
    }
  });
});
