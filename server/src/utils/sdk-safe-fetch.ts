import { safeFetch } from './url-security.js';

const SDK_MAX_REQUEST_BYTES = 10 * 1024 * 1024;

type SafeFetchImpl = typeof safeFetch;

export interface SdkTransportOptions {
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Build the fetch boundary used by hosted @adcp/sdk calls.
 *
 * The SDK can pass either a URL-like input or a fully-formed Request. Turning
 * both into a Request first gives us standard fetch merge semantics for
 * headers, method, signal, and body before handing the request to safeFetch.
 * safeFetch then validates every redirect hop and repeats the private-address
 * check in undici's connect-time DNS lookup hook.
 *
 * POST redirects are intentionally disabled. AdCP POST bodies and their
 * Authorization headers can carry credentials or commercially sensitive task
 * input, and neither should be replayed to a redirect target. Endpoint
 * discovery is responsible for selecting the final MCP/A2A URL.
 */
export function createSdkSafeFetch(safeFetchImpl: SafeFetchImpl = safeFetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const method = request.method.toUpperCase();

    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      throw new Error(`SDK safe fetch does not support ${method} requests`);
    }

    let body: Uint8Array | undefined;
    if (method === 'POST') {
      if (!request.body) {
        throw new Error('SDK safe fetch POST requests require a body');
      }
      body = new Uint8Array(await request.arrayBuffer());
    } else if (request.body) {
      throw new Error(`SDK safe fetch ${method} requests cannot carry a body`);
    }

    return safeFetchImpl(request.url, {
      method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(body && { body }),
      maxRequestBytes: SDK_MAX_REQUEST_BYTES,
      ...(method === 'POST' && { maxRedirects: 0 }),
      signal: request.signal,
    });
  };
}

export const sdkSafeFetch: typeof fetch = createSdkSafeFetch();

/**
 * Merge the mandatory hosted-network boundary without discarding SDK knobs
 * such as response limits or request timeouts. The server-owned fetch policy
 * deliberately wins over a caller-provided fetch implementation.
 */
export function withSdkSafeTransport<T extends object>(
  options: T,
): T & { transport: SdkTransportOptions & { fetchFn: typeof fetch } } {
  const existingTransport = (options as { transport?: SdkTransportOptions }).transport;
  return {
    ...options,
    transport: {
      ...existingTransport,
      fetchFn: sdkSafeFetch,
    },
  };
}
