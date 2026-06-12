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

describe('safeFetch sameSiteRedirectsOnly (adagents /.well-known discovery)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    agentMock.mockClear();
    resolve4Mock.mockClear();
    resolve6Mock.mockClear();
    resolve4Mock.mockResolvedValue(['93.184.216.34']);
    resolve6Mock.mockResolvedValue([]);
  });

  const wellKnown = (host: string) => `https://${host}/.well-known/adagents.json`;

  it('follows a same-registrable-domain redirect (apex -> www)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', {
        status: 301,
        headers: { Location: wellKnown('www.ladepeche.fr') },
      }))
      .mockResolvedValueOnce(new Response('{"authorized_agents":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const response = await safeFetch(wellKnown('ladepeche.fr'), {
      sameSiteRedirectsOnly: true,
      maxRedirects: 3,
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(wellKnown('www.ladepeche.fr'));
  });

  it('refuses a cross-registrable-domain redirect without dialing the off-domain hop', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { Location: wellKnown('claire.pub') },
    }));

    await expect(
      safeFetch(wellKnown('ladepeche.fr'), {
        sameSiteRedirectsOnly: true,
        maxRedirects: 3,
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow(/cross-registrable-domain/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses cross-domain even after a legitimate same-domain hop (anchored on origin)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', {
        status: 301,
        headers: { Location: wellKnown('www.pub.example') },
      }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: wellKnown('attacker.example') },
      }));

    await expect(
      safeFetch(wellKnown('pub.example'), {
        sameSiteRedirectsOnly: true,
        maxRedirects: 3,
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow(/cross-registrable-domain/);
  });

  it('refuses a scheme downgrade away from HTTPS', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { Location: 'http://pub.example/.well-known/adagents.json' },
    }));

    await expect(
      safeFetch(wellKnown('pub.example'), {
        sameSiteRedirectsOnly: true,
        maxRedirects: 3,
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow();
  });

  it('refuses a cross-tenant redirect on a shared private suffix (github.io)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { Location: wellKnown('attacker.github.io') },
    }));

    await expect(
      safeFetch(wellKnown('victim.github.io'), {
        sameSiteRedirectsOnly: true,
        maxRedirects: 3,
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow(/cross-registrable-domain/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a same-tenant redirect within a private suffix (victim.github.io -> www.victim.github.io)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', {
        status: 301,
        headers: { Location: wellKnown('www.victim.github.io') },
      }))
      .mockResolvedValueOnce(new Response('{"authorized_agents":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const response = await safeFetch(wellKnown('victim.github.io'), {
      sameSiteRedirectsOnly: true,
      maxRedirects: 3,
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('follows a same-registrable-domain redirect across a multi-label public TLD (co.uk)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', {
        status: 301,
        headers: { Location: wellKnown('www.example.co.uk') },
      }))
      .mockResolvedValueOnce(new Response('{"authorized_agents":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const response = await safeFetch(wellKnown('example.co.uk'), {
      sameSiteRedirectsOnly: true,
      maxRedirects: 3,
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a cross-domain redirect across a multi-label public TLD (co.uk -> com)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { Location: wellKnown('example.com') },
    }));

    await expect(
      safeFetch(wellKnown('example.co.uk'), {
        sameSiteRedirectsOnly: true,
        maxRedirects: 3,
        signal: AbortSignal.timeout(2_000),
      }),
    ).rejects.toThrow(/cross-registrable-domain/);
  });

  it('does not resolve when the redirect hop cap is exceeded (4 same-domain hops, cap 3)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 301, headers: { Location: wellKnown('b.pub.example') } }))
      .mockResolvedValueOnce(new Response('', { status: 301, headers: { Location: wellKnown('c.pub.example') } }))
      .mockResolvedValueOnce(new Response('', { status: 301, headers: { Location: wellKnown('d.pub.example') } }))
      .mockResolvedValueOnce(new Response('', { status: 301, headers: { Location: wellKnown('e.pub.example') } }));

    const response = await safeFetch(wellKnown('a.pub.example'), {
      sameSiteRedirectsOnly: true,
      maxRedirects: 3,
      signal: AbortSignal.timeout(2_000),
    });

    // Cap reached: the last hop is still a 3xx and the chain did not resolve to 200.
    expect(response.status).toBe(301);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('still follows cross-domain redirects when the flag is not set (default behavior preserved)', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: wellKnown('claire.pub') },
      }))
      .mockResolvedValueOnce(new Response('{"authorized_agents":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const response = await safeFetch(wellKnown('ladepeche.fr'), {
      maxRedirects: 3,
      signal: AbortSignal.timeout(2_000),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
