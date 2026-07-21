import { beforeEach, describe, expect, it, vi } from 'vitest';

const urlSecurityMocks = vi.hoisted(() => ({
  safeFetch: vi.fn(),
}));

vi.mock('../../src/utils/url-security.js', () => ({
  safeFetch: urlSecurityMocks.safeFetch,
}));

import { oauthSafeFetch } from '../../src/utils/oauth-safe-fetch.js';

describe('oauthSafeFetch', () => {
  beforeEach(() => {
    urlSecurityMocks.safeFetch.mockReset();
    urlSecurityMocks.safeFetch.mockResolvedValue(new Response('{}'));
  });

  it('normalizes a URL, Headers, and signal for GET discovery requests', async () => {
    const signal = new AbortController().signal;
    const headers = new Headers([
      ['Accept', 'application/json'],
      ['X-Protocol-Version', '2026-06-18'],
    ]);

    await oauthSafeFetch(new URL('https://agent.example.com/.well-known/oauth'), {
      headers,
      signal,
    });

    expect(urlSecurityMocks.safeFetch).toHaveBeenCalledWith(
      'https://agent.example.com/.well-known/oauth',
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-protocol-version': '2026-06-18',
        },
        signal,
      },
    );
  });

  it.each([
    ['string', '{"redirect_uris":[]}', '{"redirect_uris":[]}'],
    ['Uint8Array', new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])],
    [
      'URLSearchParams',
      new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
      'grant_type=authorization_code&code=abc',
    ],
  ])('normalizes a %s POST body', async (_name, inputBody, expectedBody) => {
    await oauthSafeFetch('https://auth.example.com/token', {
      method: 'post',
      headers: [['Content-Type', 'application/x-www-form-urlencoded']],
      body: inputBody,
    });

    expect(urlSecurityMocks.safeFetch).toHaveBeenCalledWith(
      'https://auth.example.com/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: expectedBody,
      },
    );
  });

  it('rejects request inputs, methods, and bodies outside the OAuth adapter surface', async () => {
    await expect(oauthSafeFetch(new Request('https://agent.example.com')))
      .rejects.toThrow('only supports string and URL inputs');
    await expect(oauthSafeFetch('https://agent.example.com', { method: 'DELETE' }))
      .rejects.toThrow('does not support DELETE requests');
    await expect(oauthSafeFetch('https://agent.example.com', { body: 'unexpected' }))
      .rejects.toThrow('GET requests cannot carry a body');
    await expect(oauthSafeFetch('https://agent.example.com', { method: 'POST' }))
      .rejects.toThrow('POST requests require a body');
    await expect(oauthSafeFetch('https://agent.example.com', {
      method: 'POST',
      body: new Blob(['unsupported']),
    })).rejects.toThrow('only supports string, Uint8Array, and URLSearchParams');

    expect(urlSecurityMocks.safeFetch).not.toHaveBeenCalled();
  });
});
