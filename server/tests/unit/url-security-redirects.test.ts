import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
const agentMock = vi.hoisted(() => vi.fn(function FakeAgent(this: { opts: unknown }, opts: unknown) {
  this.opts = opts;
}));
const resolve4Mock = vi.hoisted(() => vi.fn(async () => ['93.184.216.34']));
const resolve6Mock = vi.hoisted(() => vi.fn(async () => []));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    Agent: agentMock,
    fetch: fetchMock,
  };
});

vi.mock('dns/promises', () => ({
  default: {
    resolve4: resolve4Mock,
    resolve6: resolve6Mock,
  },
  resolve4: resolve4Mock,
  resolve6: resolve6Mock,
}));

import { safeFetch } from '../../src/utils/url-security.js';

describe('safeFetch redirects', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    agentMock.mockClear();
    resolve4Mock.mockClear();
    resolve6Mock.mockClear();
    resolve4Mock.mockResolvedValue(['93.184.216.34']);
    resolve6Mock.mockResolvedValue([]);
  });

  it('resolves relative redirect locations against the current hop', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'https://www.publisher.example/ads.txt' },
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: '/sites/pub/ads.txt' },
      }))
      .mockResolvedValueOnce(new Response('MANAGERDOMAIN=manager.example\n', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      }));

    const response = await safeFetch('https://publisher.example/ads.txt', {
      maxRedirects: 5,
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('MANAGERDOMAIN=manager.example');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe('https://publisher.example/ads.txt');
    expect(fetchMock.mock.calls[1][0]).toBe('https://www.publisher.example/ads.txt');
    expect(fetchMock.mock.calls[2][0]).toBe('https://www.publisher.example/sites/pub/ads.txt');
  });
});
