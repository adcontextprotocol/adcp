/**
 * Pins the proxy-env detection in url-security.ts.
 *
 * Background: PR #3609 closed the DNS-rebind TOCTOU in `safeFetch` via undici's
 * `Agent({ connect: { lookup } })`. The defense only holds if undici is the
 * thing doing the connect — if HTTP_PROXY / HTTPS_PROXY is set in the deploy
 * env and a future caller routes through `ProxyAgent` (or a sibling library
 * honors these vars), the proxy becomes the DNS resolver and our `lookup`
 * hook never fires.
 *
 * `detectProxyEnv()` returns the var names that are set, and the module-load
 * IIFE in url-security.ts logs a warning when any are present. This test
 * pins that detection function — a refactor that drops one of the vars from
 * the watchlist will fail loudly here.
 *
 * Tracked from issue #3620 (followup security review on #3609).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectProxyEnv } from '../../src/utils/url-security.js';

const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;

describe('detectProxyEnv', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of PROXY_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of PROXY_VARS) {
      if (saved[v] !== undefined) process.env[v] = saved[v];
      else delete process.env[v];
    }
  });

  it('returns empty when no proxy vars are set', () => {
    expect(detectProxyEnv()).toEqual([]);
  });

  it.each(PROXY_VARS)('detects %s', (name) => {
    process.env[name] = 'http://proxy.example:3128';
    expect(detectProxyEnv()).toEqual([name]);
  });

  it('detects multiple vars set together', () => {
    process.env.HTTP_PROXY = 'http://p:3128';
    process.env.https_proxy = 'http://p:3128';
    const result = detectProxyEnv();
    expect(result).toContain('HTTP_PROXY');
    expect(result).toContain('https_proxy');
    expect(result).toHaveLength(2);
  });

  it('treats empty-string value as unset', () => {
    process.env.HTTP_PROXY = '';
    expect(detectProxyEnv()).toEqual([]);
  });
});
