import { safeFetch } from '../../utils/url-security.js';

/**
 * Fetch adapter for the OAuth libraries used by the agent authorization
 * routes. OAuth discovery, dynamic registration, and token exchange only use
 * GET and POST requests, so keep this surface deliberately narrow while
 * routing every request and redirect hop through the SSRF-safe fetcher.
 */
export const oauthSafeFetch: typeof fetch = async (input, init) => {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new Error('OAuth safe fetch only supports string and URL inputs');
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new Error(`OAuth safe fetch does not support ${method} requests`);
  }

  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const rawBody = init?.body;
  let body: string | Uint8Array | undefined;

  if (rawBody === undefined || rawBody === null) {
    body = undefined;
  } else if (typeof rawBody === 'string' || rawBody instanceof Uint8Array) {
    body = rawBody;
  } else if (rawBody instanceof URLSearchParams) {
    body = rawBody.toString();
  } else {
    throw new Error(
      'OAuth safe fetch only supports string, Uint8Array, and URLSearchParams request bodies',
    );
  }

  if (method === 'GET' && body !== undefined) {
    throw new Error('OAuth safe fetch GET requests cannot carry a body');
  }
  if (method === 'POST' && body === undefined) {
    throw new Error('OAuth safe fetch POST requests require a body');
  }

  return safeFetch(input.toString(), {
    method,
    headers,
    ...(body !== undefined && { body }),
    ...(init?.signal && { signal: init.signal }),
  });
};
