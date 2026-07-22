import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  assertPublicTarget,
  createTrainingWebhookFetch,
  createWebhookFetch,
  isWebhookTestOrDevelopment,
  SsrfRefusedError,
  validateWebhookUrl,
  WEBHOOK_DNS_TIMEOUT_MS,
} from '../../src/training-agent/webhook-fetch.js';

const undiciFetchMock = vi.hoisted(() => vi.fn());

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: undiciFetchMock,
  };
});

describe('createWebhookFetch — SSRF guard', () => {
  let calls: Array<{ url: string; init: RequestInit | undefined }>;

  beforeEach(() => {
    calls = [];
    undiciFetchMock.mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init });
      return new Response('', { status: 200 });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    undiciFetchMock.mockReset();
  });

  /** Convenience: pull the recorded URLs without dragging out the init plumbing. */
  function urls(): string[] {
    return calls.map((c) => c.url);
  }

  describe('with allowPrivateIp=true (dev/CI)', () => {
    const fetch = createWebhookFetch({ allowPrivateIp: true });

    it('passes loopback URLs through', async () => {
      await expect(fetch('http://127.0.0.1:9999/hook')).resolves.toBeInstanceOf(Response);
      expect(urls()).toEqual(['http://127.0.0.1:9999/hook']);
    });

    it('passes public URLs through', async () => {
      await expect(fetch('https://buyer.example.com/hook')).resolves.toBeInstanceOf(Response);
    });
  });

  describe('with allowPrivateIp=false (production)', () => {
    const fetch = createWebhookFetch({ allowPrivateIp: false });

    it('refuses literal IPv4 loopback', async () => {
      await expect(fetch('http://127.0.0.1/metadata')).rejects.toBeInstanceOf(SsrfRefusedError);
      expect(urls()).toEqual([]);
    });

    it('refuses AWS/fly metadata (169.254.169.254)', async () => {
      await expect(fetch('http://169.254.169.254/latest/meta-data/'))
        .rejects.toMatchObject({ name: 'SsrfRefusedError', reason: /private/ });
    });

    it('refuses RFC1918 (10.*, 172.16-31.*, 192.168.*)', async () => {
      await expect(fetch('http://10.0.0.1/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://192.168.1.1/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://172.20.0.1/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses IPv6 loopback and link-local', async () => {
      await expect(fetch('http://[::1]/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://[fe80::1]/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses localhost hostname', async () => {
      await expect(fetch('http://localhost:8080/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://svc.localhost/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses non-http(s) schemes', async () => {
      await expect(fetch('file:///etc/passwd')).rejects.toMatchObject({ reason: /scheme/ });
      await expect(fetch('ftp://public.example.com/')).rejects.toMatchObject({ reason: /scheme/ });
    });

    it('refuses numeric-encoded hostnames (decimal)', async () => {
      // 2852039166 decodes to 169.254.169.254 on Linux resolvers.
      await expect(fetch('http://2852039166/')).rejects.toMatchObject({ reason: /numeric/ });
    });

    it('refuses numeric-encoded hostnames (hex)', async () => {
      await expect(fetch('http://0x7f000001/')).rejects.toMatchObject({ reason: /numeric/ });
    });

    it('refuses numeric-encoded hostnames (octal / dotted-numeric)', async () => {
      await expect(fetch('http://0177.0.0.1/')).rejects.toMatchObject({ reason: /numeric/ });
    });

    it('refuses IPv4-mapped IPv6 addressing private v4', async () => {
      // ::ffff:10.0.0.1 tunnels RFC1918 10.0.0.1 through v6 syntax.
      await expect(fetch('http://[::ffff:10.0.0.1]/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses IPv6 multicast (ff00::/8)', async () => {
      await expect(fetch('http://[ff02::1]/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses IPv6 NAT64 well-known prefix (64:ff9b::/96)', async () => {
      await expect(fetch('http://[64:ff9b::1]/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses deprecated IPv4-compatible IPv6 wrapping a private v4 (::a.b.c.d)', async () => {
      // The URL parser canonicalizes ::127.0.0.1 -> ::7f00:1 and
      // ::169.254.169.254 -> ::a9fe:a9fe; both must decode to the embedded v4.
      await expect(fetch('http://[::127.0.0.1]/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://[::10.0.0.1]/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://[::169.254.169.254]/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses CGNAT shared address space (100.64.0.0/10)', async () => {
      await expect(fetch('http://100.64.0.1/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://100.127.255.255/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('refuses 6to4 (2002::/16) wrapping a private v4', async () => {
      // 2002:V4::/16 embeds an IPv4 in groups[1:2]: 2002:7f00:1:: -> 127.0.0.1,
      // 2002:a9fe:a9fe:: -> 169.254.169.254 (metadata).
      await expect(fetch('http://[2002:7f00:1::]/')).rejects.toBeInstanceOf(SsrfRefusedError);
      await expect(fetch('http://[2002:a9fe:a9fe::]/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('allows 6to4 wrapping a public v4', async () => {
      // 2002:808:808:: embeds public 8.8.8.8 — must reach the underlying fetch.
      await expect(fetch('http://[2002:808:808::]/')).resolves.toBeInstanceOf(Response);
    });

    it('userinfo does not smuggle a private host past the hostname check', async () => {
      // URL parser routes user:pass@ to credentials; the hostname is 169.254.169.254.
      await expect(fetch('http://user:pass@169.254.169.254/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('allows public hostnames', async () => {
      // example.com is guaranteed public by IANA.
      await expect(fetch('https://example.com/hook')).resolves.toBeInstanceOf(Response);
      expect(urls()).toEqual(['https://example.com/hook']);
    });

    it('forces redirect:manual on the underlying fetch (security.mdx SSRF step 4)', async () => {
      // A 302 to `http://169.254.169.254/...` from a public buyer-controlled
      // host would otherwise let the buyer punch through the IP-range check.
      // Pinning the redirect mode at the wrapper layer prevents the SDK
      // emitter or any future caller from accidentally re-enabling follow.
      await fetch('https://example.com/hook');
      expect(calls[0].init?.redirect).toBe('manual');
    });

    it('attaches the SSRF-safe dispatcher so connect-time DNS rebinding is rejected (security.mdx SSRF step 3)', async () => {
      // The dispatcher's `connect.lookup` hook re-checks the resolved IP at
      // TCP-connect time, closing the validation→connect TOCTOU window. We
      // can't exercise the rebind from a unit test, but we can pin the
      // construction shape: if a future refactor drops the dispatcher, this
      // assertion fails before the SSRF gap silently reopens.
      await fetch('https://example.com/hook');
      expect((calls[0].init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
    });
  });

  describe('redirect-mode pinning (applies in every environment)', () => {
    it('pins redirect:manual even when allowPrivateIp is true', async () => {
      // The no-follow contract is a security guard, not a routing
      // affordance — dev/CI receivers shouldn't be able to bounce
      // signed bodies to a metadata endpoint either.
      const fetch = createWebhookFetch({ allowPrivateIp: true });
      await fetch('http://127.0.0.1:9999/hook');
      expect(calls[0].init?.redirect).toBe('manual');
    });

    it('does NOT attach the SSRF dispatcher when allowPrivateIp is true', async () => {
      // The dispatcher's lookup rejects private IPs; attaching it under
      // allowPrivateIp:true would defeat the loopback-receiver use case
      // the flag exists to support.
      const fetch = createWebhookFetch({ allowPrivateIp: true });
      await fetch('http://127.0.0.1:9999/hook');
      expect((calls[0].init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeUndefined();
    });
  });

  describe('stored webhook URL validation', () => {
    it('rejects HTTP before DNS resolution in an unknown runtime', async () => {
      vi.stubEnv('NODE_ENV', 'staging');
      const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

      await expect(validateWebhookUrl('http://example.com/hook', { dnsLookup })).resolves.toEqual({
        code: 'VALIDATION_ERROR',
        message: 'webhook_url must use HTTPS',
        field: 'webhook_url',
      });
      expect(dnsLookup).not.toHaveBeenCalled();
    });

    it.each(['test', 'development'])('allows HTTP in explicit %s mode', async (environment) => {
      vi.stubEnv('NODE_ENV', environment);
      const dnsLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

      await expect(validateWebhookUrl('http://example.com/hook', { dnsLookup })).resolves.toBeUndefined();
      expect(dnsLookup).toHaveBeenCalledOnce();
    });

    it.each([
      ['private target', 'https://169.254.169.254/latest/meta-data'],
      ['decimal-encoded target', 'https://2852039166/latest/meta-data'],
      ['hex-encoded target', 'https://0x7f000001/private'],
    ])('returns the stable validation error for a %s', async (_kind, target) => {
      await expect(validateWebhookUrl(target)).resolves.toEqual({
        code: 'VALIDATION_ERROR',
        message: 'webhook_url must target a public network address',
        field: 'webhook_url',
      });
    });

    it('bounds a stalled DNS lookup without a real-time wait', async () => {
      vi.useFakeTimers();
      const stalledLookup = vi.fn(() => new Promise<Array<{ address: string; family: number }>>(() => {}));
      const validation = validateWebhookUrl('https://stalled-dns.example/hook', {
        dnsLookup: stalledLookup,
      });
      const expectation = expect(validation).resolves.toEqual({
        code: 'VALIDATION_ERROR',
        message: 'webhook_url must target a public network address',
        field: 'webhook_url',
      });

      await vi.advanceTimersByTimeAsync(WEBHOOK_DNS_TIMEOUT_MS);
      await expectation;
      expect(stalledLookup).toHaveBeenCalledOnce();
    });

    it('uses a stable refusal reason when DNS lookup times out', async () => {
      vi.useFakeTimers();
      const refusal = assertPublicTarget(new URL('https://stalled-dns.example/hook'), {
        dnsLookup: () => new Promise<Array<{ address: string; family: number }>>(() => {}),
      });
      const expectation = expect(refusal).rejects.toMatchObject({
        name: 'SsrfRefusedError',
        reason: 'DNS lookup timed out',
      });

      await vi.advanceTimersByTimeAsync(WEBHOOK_DNS_TIMEOUT_MS);
      await expectation;
    });
  });

  describe('training-agent delivery policy', () => {
    it.each([
      ['test', true],
      ['development', true],
      ['production', false],
      ['staging', false],
      ['developmnt', false],
      [undefined, false],
    ])('classifies the %s runtime explicitly', (environment, expected) => {
      expect(isWebhookTestOrDevelopment(environment)).toBe(expected);
    });

    it('cannot enable private delivery explicitly in production', () => {
      vi.stubEnv('NODE_ENV', 'production');

      expect(() => createWebhookFetch({ allowPrivateIp: true }))
        .toThrow('Private webhook targets can only be enabled in test or development');
    });

    it('cannot enable private delivery in an unknown runtime', () => {
      vi.stubEnv('NODE_ENV', 'staging');

      expect(() => createWebhookFetch({ allowPrivateIp: true }))
        .toThrow('Private webhook targets can only be enabled in test or development');
    });

    it('fails closed when NODE_ENV is unset', async () => {
      const originalEnvironment = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      try {
        const fetch = createTrainingWebhookFetch();

        await expect(fetch('https://169.254.169.254/latest/meta-data'))
          .rejects.toBeInstanceOf(SsrfRefusedError);
      } finally {
        if (originalEnvironment === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = originalEnvironment;
      }
    });

    it('forces the production delivery path through the public-target guard', async () => {
      const fetch = createTrainingWebhookFetch('production');

      await expect(fetch('https://169.254.169.254/latest/meta-data'))
        .rejects.toBeInstanceOf(SsrfRefusedError);
      expect(urls()).toEqual([]);
    });

    it('retains loopback receivers outside production', async () => {
      const fetch = createTrainingWebhookFetch('test');

      await expect(fetch('http://127.0.0.1:9999/hook')).resolves.toBeInstanceOf(Response);
      expect(urls()).toEqual(['http://127.0.0.1:9999/hook']);
    });

    it('retains loopback receivers in explicit development mode', async () => {
      const fetch = createTrainingWebhookFetch('development');

      await expect(fetch('http://127.0.0.1:9999/hook')).resolves.toBeInstanceOf(Response);
      expect(urls()).toEqual(['http://127.0.0.1:9999/hook']);
    });
  });
});
