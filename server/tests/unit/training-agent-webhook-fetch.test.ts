import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWebhookFetch, SsrfRefusedError } from '../../src/training-agent/webhook-fetch.js';

describe('createWebhookFetch — SSRF guard', () => {
  let originalFetch: typeof globalThis.fetch;
  let calls: string[];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      calls.push(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
      return new Response('', { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('with allowPrivateIp=true (dev/CI)', () => {
    const fetch = createWebhookFetch({ allowPrivateIp: true });

    it('passes loopback URLs through', async () => {
      await expect(fetch('http://127.0.0.1:9999/hook')).resolves.toBeInstanceOf(Response);
      expect(calls).toEqual(['http://127.0.0.1:9999/hook']);
    });

    it('passes public URLs through', async () => {
      await expect(fetch('https://buyer.example.com/hook')).resolves.toBeInstanceOf(Response);
    });
  });

  describe('with allowPrivateIp=false (production)', () => {
    const fetch = createWebhookFetch({ allowPrivateIp: false });

    it('refuses literal IPv4 loopback', async () => {
      await expect(fetch('http://127.0.0.1/metadata')).rejects.toBeInstanceOf(SsrfRefusedError);
      expect(calls).toEqual([]);
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

    it('userinfo does not smuggle a private host past the hostname check', async () => {
      // URL parser routes user:pass@ to credentials; the hostname is 169.254.169.254.
      await expect(fetch('http://user:pass@169.254.169.254/')).rejects.toBeInstanceOf(SsrfRefusedError);
    });

    it('allows public hostnames', async () => {
      // example.com is guaranteed public by IANA.
      await expect(fetch('https://example.com/hook')).resolves.toBeInstanceOf(Response);
      expect(calls).toEqual(['https://example.com/hook']);
    });
  });
});
