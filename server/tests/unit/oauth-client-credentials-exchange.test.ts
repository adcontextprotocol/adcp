import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  exchangeClientCredentials,
  resolveEnvReference,
} from '../../src/services/oauth-client-credentials-exchange.js';
import { adaptAuthForSdk } from '../../src/services/sdk-auth-adapter.js';

/**
 * Tests for the server-side OAuth 2.0 client-credentials exchange
 * (#2800 follow-up). `@adcp/client`'s ComplyOptions/TestOptions don't
 * accept the `oauth_client_credentials` auth variant, so we exchange
 * for a bearer token server-side before handing it to the SDK.
 */

function mockFetch(response: { status: number; body: string | object }) {
  const bodyStr = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  const bytes = new TextEncoder().encode(bodyStr);
  return vi.fn(async () => {
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          controller.enqueue(bytes);
          sent = true;
        } else {
          controller.close();
        }
      },
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      body: stream,
    } as unknown as Response;
  });
}

describe('resolveEnvReference', () => {
  beforeEach(() => {
    delete process.env.ADCP_OAUTH_TEST;
  });

  it('returns the literal value when no $ENV prefix', () => {
    expect(resolveEnvReference('plaintext-secret')).toBe('plaintext-secret');
  });

  it('resolves a valid $ENV:ADCP_OAUTH_<NAME> reference from process.env', () => {
    process.env.ADCP_OAUTH_TEST = 'super-secret';
    expect(resolveEnvReference('$ENV:ADCP_OAUTH_TEST')).toBe('super-secret');
  });

  it('returns null when the env var is unset (treated as failure)', () => {
    expect(resolveEnvReference('$ENV:ADCP_OAUTH_MISSING')).toBeNull();
  });

  it('returns null when the env var is empty', () => {
    process.env.ADCP_OAUTH_TEST = '';
    expect(resolveEnvReference('$ENV:ADCP_OAUTH_TEST')).toBeNull();
  });

  it('ignores $ENV prefixes that do not match ADCP_OAUTH_ (does not resolve arbitrary env vars)', () => {
    process.env.DATABASE_URL = 'postgres://sensitive';
    // The input validator rejects these at write time; the resolver
    // still returns the literal so a mis-slipped reference becomes a
    // hard exchange failure, not a silent env leak.
    expect(resolveEnvReference('$ENV:DATABASE_URL')).toBe('$ENV:DATABASE_URL');
  });
});

describe('exchangeClientCredentials', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseCreds = {
    token_endpoint: 'https://idp.example.com/oauth/token',
    client_id: 'client-abc',
    client_secret: 'secret-xyz',
  };

  it('returns a bearer token from a successful exchange', async () => {
    const fetchImpl = mockFetch({
      status: 200,
      body: { access_token: 'new-token', expires_in: 3600, token_type: 'Bearer' },
    });
    const result = await exchangeClientCredentials(baseCreds, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({ ok: true, access_token: 'new-token', expires_in: 3600 });
  });

  it('defaults to HTTP Basic auth (RFC 6749 §2.3.1 preferred)', async () => {
    const fetchImpl = mockFetch({ status: 200, body: { access_token: 'tok' } });
    await exchangeClientCredentials(baseCreds, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const call = fetchImpl.mock.calls[0];
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    // body should NOT carry client_id/client_secret when using Basic
    expect(init.body).not.toMatch(/client_id=/);
    expect(init.body).not.toMatch(/client_secret=/);
  });

  it('puts credentials in the body when auth_method is "body"', async () => {
    const fetchImpl = mockFetch({ status: 200, body: { access_token: 'tok' } });
    await exchangeClientCredentials(
      { ...baseCreds, auth_method: 'body' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(init.body).toMatch(/client_id=client-abc/);
    expect(init.body).toMatch(/client_secret=secret-xyz/);
  });

  it('includes scope / resource / audience in the form when set', async () => {
    const fetchImpl = mockFetch({ status: 200, body: { access_token: 'tok' } });
    await exchangeClientCredentials(
      { ...baseCreds, scope: 'foo bar', resource: 'https://api.example', audience: 'aud-1' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const body = (fetchImpl.mock.calls[0][1] as RequestInit).body as string;
    expect(body).toMatch(/scope=foo\+bar/);
    expect(body).toMatch(/resource=https%3A%2F%2Fapi.example/);
    expect(body).toMatch(/audience=aud-1/);
  });

  it('resolves $ENV references before sending', async () => {
    process.env.ADCP_OAUTH_ID = 'resolved-id';
    process.env.ADCP_OAUTH_SEC = 'resolved-sec';
    const fetchImpl = mockFetch({ status: 200, body: { access_token: 'tok' } });
    await exchangeClientCredentials(
      {
        ...baseCreds,
        client_id: '$ENV:ADCP_OAUTH_ID',
        client_secret: '$ENV:ADCP_OAUTH_SEC',
        auth_method: 'body',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const body = (fetchImpl.mock.calls[0][1] as RequestInit).body as string;
    expect(body).toMatch(/client_id=resolved-id/);
    expect(body).toMatch(/client_secret=resolved-sec/);
  });

  it('fails cleanly when a $ENV reference does not resolve', async () => {
    const fetchImpl = mockFetch({ status: 200, body: {} });
    const result = await exchangeClientCredentials(
      { ...baseCreds, client_secret: '$ENV:ADCP_OAUTH_MISSING' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/client_secret env reference/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails on a non-2xx response without surfacing the provider body', async () => {
    const fetchImpl = mockFetch({ status: 401, body: '{"error":"invalid_client"}' });
    const result = await exchangeClientCredentials(baseCreds, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/HTTP 401/);
    expect((result as { error: string }).error).not.toMatch(/invalid_client/);
  });

  it('fails when the token endpoint returns non-JSON', async () => {
    const fetchImpl = mockFetch({ status: 200, body: 'not-json' });
    const result = await exchangeClientCredentials(baseCreds, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/did not return JSON/);
  });

  it('fails when the response JSON is missing access_token', async () => {
    const fetchImpl = mockFetch({ status: 200, body: { token_type: 'Bearer', expires_in: 100 } });
    const result = await exchangeClientCredentials(baseCreds, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/missing access_token/);
  });

  it('fails cleanly on network exceptions', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const result = await exchangeClientCredentials(baseCreds, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/ECONNREFUSED/);
  });
});

describe('adaptAuthForSdk', () => {
  it('returns undefined for missing auth', async () => {
    expect(await adaptAuthForSdk(undefined)).toBeUndefined();
  });

  it('passes bearer / basic / oauth through unchanged', async () => {
    const bearer = { type: 'bearer', token: 'tok' } as const;
    const basic = { type: 'basic', username: 'u', password: 'p' } as const;
    const oauth = {
      type: 'oauth',
      tokens: { access_token: 'a', refresh_token: 'r' },
      client: { client_id: 'c' },
    } as const;
    expect(await adaptAuthForSdk(bearer)).toBe(bearer);
    expect(await adaptAuthForSdk(basic)).toBe(basic);
    expect(await adaptAuthForSdk(oauth)).toBe(oauth);
  });

  it('exchanges oauth_client_credentials and narrows to bearer', async () => {
    process.env.ADCP_OAUTH_BRIDGE_TEST = 'sec';
    // Swap global fetch for this test only
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch({
      status: 200,
      body: { access_token: 'exchanged-tok', expires_in: 600 },
    }) as unknown as typeof fetch;
    try {
      const result = await adaptAuthForSdk({
        type: 'oauth_client_credentials',
        credentials: {
          token_endpoint: 'https://idp.example/token',
          client_id: 'client-x',
          client_secret: '$ENV:ADCP_OAUTH_BRIDGE_TEST',
        },
      });
      expect(result).toEqual({ type: 'bearer', token: 'exchanged-tok' });
    } finally {
      globalThis.fetch = original;
      delete process.env.ADCP_OAUTH_BRIDGE_TEST;
    }
  });

  it('returns undefined (falls back to unauthenticated) when the exchange fails', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = mockFetch({ status: 500, body: 'internal' }) as unknown as typeof fetch;
    try {
      const result = await adaptAuthForSdk({
        type: 'oauth_client_credentials',
        credentials: {
          token_endpoint: 'https://idp.example/token',
          client_id: 'c',
          client_secret: 's',
        },
      });
      expect(result).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
