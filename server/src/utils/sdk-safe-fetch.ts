import { safeFetch } from './url-security.js';

const SDK_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';
const SENSITIVE_REDIRECT_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-adcp-auth',
] as const;

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
 * POST redirects and every credential-bearing redirect are intentionally
 * disabled. AdCP bodies, cookies, and auth headers can carry credentials or
 * commercially sensitive input, and none should be replayed to another URL.
 * Endpoint discovery is responsible for selecting the final MCP/A2A URL.
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
      if (!request.headers.has('accept')) {
        request.headers.set('accept', MCP_ACCEPT_HEADER);
      }
      if (!request.body) {
        throw new Error('SDK safe fetch POST requests require a body');
      }
      const contentLength = request.headers.get('content-length');
      if (contentLength !== null) {
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
          throw new Error('SDK safe fetch received an invalid Content-Length header');
        }
        if (declaredBytes > SDK_MAX_REQUEST_BYTES) {
          throw new Error(
            `SDK safe fetch body exceeds ${SDK_MAX_REQUEST_BYTES} byte cap (declared ${declaredBytes})`,
          );
        }
      }
      body = new Uint8Array(await request.arrayBuffer());
      if (body.byteLength > SDK_MAX_REQUEST_BYTES) {
        throw new Error(
          `SDK safe fetch body exceeds ${SDK_MAX_REQUEST_BYTES} byte cap (got ${body.byteLength})`,
        );
      }
    } else if (request.body) {
      throw new Error(`SDK safe fetch ${method} requests cannot carry a body`);
    }

    const carriesSensitiveHeaders = SENSITIVE_REDIRECT_HEADERS.some(header => request.headers.has(header));

    return safeFetchImpl(request.url, {
      method,
      headers: Object.fromEntries(request.headers.entries()),
      ...(body && { body }),
      maxRequestBytes: SDK_MAX_REQUEST_BYTES,
      ...((method === 'POST' || carriesSensitiveHeaders) && { maxRedirects: 0 }),
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
