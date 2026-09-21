import { isNetworkPolicyRefusal, safeFetch } from './url-security.js';

const SDK_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';
const SENSITIVE_REDIRECT_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-adcp-auth',
] as const;

type SafeFetchImpl = typeof safeFetch;

export const ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE = 'ADDIE_TRANSIENT_TRANSPORT_FAILURE';
const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const TRANSIENT_HTTP_STATUSES = new Set([429, 502, 503, 504]);

interface TransientTransportMetadata {
  code?: string;
  status?: number;
  retryAfterMs?: number;
}

/**
 * A private marker that survives @adcp/sdk's conversion of thrown transport
 * failures into `TaskResult { success: false }`. The SDK projects `data` into
 * `adcpError`; callers must require this exact private code before retrying so
 * seller protocol/application failures are never mistaken for transport loss.
 */
export class AddieTransientTransportError extends Error {
  readonly code = ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE;
  readonly data: {
    adcp_error: {
      code: typeof ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE;
      message: string;
      recovery: 'transient';
      retry_after?: number;
    };
  };

  constructor(readonly metadata: TransientTransportMetadata = {}) {
    super('Transient outbound AdCP transport failure');
    this.name = 'AddieTransientTransportError';
    this.data = {
      adcp_error: {
        code: ADDIE_TRANSIENT_TRANSPORT_ERROR_CODE,
        message: 'The outbound AdCP transport is temporarily unavailable.',
        recovery: 'transient',
        ...(metadata.retryAfterMs !== undefined && {
          retry_after: metadata.retryAfterMs / 1_000,
        }),
      },
    };
  }
}

function readTransientTransportMetadata(error: unknown): TransientTransportMetadata | null {
  if (isNetworkPolicyRefusal(error)) return null;
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as Record<string, unknown>;
    const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : undefined;
    const status = typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined;
    if ((code && TRANSIENT_TRANSPORT_CODES.has(code)) || (status && TRANSIENT_HTTP_STATUSES.has(status))) {
      return { code, status };
    }
    current = candidate.cause;
  }
  return null;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const milliseconds = Number(raw) * 1_000;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}

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

    let response: Response;
    try {
      response = await safeFetchImpl(request.url, {
        method,
        headers: Object.fromEntries(request.headers.entries()),
        ...(body && { body }),
        maxRequestBytes: SDK_MAX_REQUEST_BYTES,
        ...((method === 'POST' || carriesSensitiveHeaders) && { maxRedirects: 0 }),
        signal: request.signal,
      });
    } catch (error) {
      const transient = readTransientTransportMetadata(error);
      if (transient) throw new AddieTransientTransportError(transient);
      throw error;
    }

    if (TRANSIENT_HTTP_STATUSES.has(response.status)) {
      throw new AddieTransientTransportError({
        status: response.status,
        retryAfterMs: retryAfterMs(response),
      });
    }
    return response;
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
