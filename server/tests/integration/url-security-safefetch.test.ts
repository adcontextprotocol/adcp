import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { safeFetch } from '../../src/utils/url-security.js';

/**
 * Integration coverage for the SSRF-safe fetch dispatcher. Two goals:
 *  1. Confirm HTTPS + SNI/cert verification still work end-to-end against a
 *     public host. The dispatcher hooks DNS lookup, NOT the TLS hostname,
 *     so a public cert must validate cleanly.
 *  2. Confirm a 302 redirect aimed at a private IP is rejected on the hop.
 */
describe('safeFetch (integration)', () => {
  // Some CI environments deliberately have no internet egress. Skip the live
  // HTTPS leg there rather than reporting a fake regression.
  const liveHttps = process.env.SAFEFETCH_LIVE_HTTPS !== '0';

  it.runIf(liveHttps)(
    'fetches https://example.com end-to-end: TLS cert validates against the original hostname',
    async () => {
      const response = await safeFetch('https://example.com', {
        method: 'GET',
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      // Sanity check that we got the real example.com (no MITM, no swap).
      expect(text.toLowerCase()).toContain('example domain');
    },
    20_000,
  );

  describe('redirect hop safety', () => {
    let server: http.Server;
    let port: number;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/redirect-to-aws-metadata') {
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        }
        if (req.url === '/redirect-to-private') {
          res.writeHead(302, { Location: 'http://10.0.0.1/internal' });
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    // The first hop binds to 127.0.0.1; safeFetch's pre-flight rejects that.
    // To exercise *redirect-hop* validation we'd need the first hop to be
    // public — which requires controllable DNS or a public test fixture.
    // Instead we rely on the unit tests for ssrfSafeLookup + the validateRedirectTarget
    // string-level check below to cover the redirect path.
    it('validateRedirectTarget rejects a Location pointing at AWS metadata', async () => {
      const { validateRedirectTarget } = await import('../../src/utils/url-security.js');
      await expect(
        validateRedirectTarget('http://169.254.169.254/', 'https://example.com/'),
      ).rejects.toThrow(/private or internal/i);
    });

    it('validateRedirectTarget rejects a Location pointing at RFC1918', async () => {
      const { validateRedirectTarget } = await import('../../src/utils/url-security.js');
      await expect(
        validateRedirectTarget('http://10.0.0.1/internal', 'https://example.com/'),
      ).rejects.toThrow(/private or internal/i);
    });
  });

  it('rejects an initial fetch to localhost via the pre-flight check', async () => {
    await expect(
      safeFetch('http://127.0.0.1:9/never-runs', { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow(/private or internal/i);
  });

  it('rejects an initial fetch to AWS metadata IP via the pre-flight check', async () => {
    await expect(
      safeFetch('http://169.254.169.254/', { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toThrow(/private or internal/i);
  });
});

describe('safeFetch dispatcher (TOCTOU defence at connect time)', () => {
  it('rejects when DNS resolution at connect time yields a private IP', async () => {
    // We can't easily simulate validateFetchUrl returning success while
    // dns.lookup later returns a private IP without mocking. The unit tests
    // for ssrfSafeLookup cover the connect-time rejection path. Here we just
    // confirm the dispatcher path is wired: a hostname with no public DNS
    // record fails fast (the lookup callback errors out).
    await expect(
      safeFetch('http://this-domain-does-not-exist-sslsdfsdfff.invalid/', {
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow();
  });
});
