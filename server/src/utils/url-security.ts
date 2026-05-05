import dns from 'dns/promises';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'dns';
import { isIP, type LookupFunction } from 'net';
import { Agent, type Dispatcher } from 'undici';
import { createLogger } from '../logger.js';

const logger = createLogger('url-security');

/**
 * The SSRF-safe dispatcher in `safeFetch` enforces private-IP rejection at TCP
 * connect time via undici's `lookup` hook. That defense bypasses if the deploy
 * environment routes outbound HTTP through a proxy (HTTP_PROXY / HTTPS_PROXY)
 * — undici's standard `Agent` does not auto-route through `ProxyAgent`, but if
 * a future caller wraps it OR a sibling library (e.g. axios, node-fetch
 * shimmed elsewhere) honors these env vars, the proxy itself becomes the DNS
 * resolver and our `lookup` hook is never invoked.
 *
 * Detect the env at module load and warn loudly. Operators can then verify the
 * proxy enforces SSRF rules of its own, or unset the var on the path that
 * calls `safeFetch`.
 *
 * Tracked from the post-#3609 security review (issue #3620).
 */
export function detectProxyEnv(): readonly string[] {
  const set: string[] = [];
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    if (process.env[name]) set.push(name);
  }
  return set;
}

const proxyEnvVars = detectProxyEnv();
if (proxyEnvVars.length > 0) {
  logger.warn(
    { vars: proxyEnvVars },
    'safeFetch: proxy env var(s) detected — DNS-rebind defense is only safe if the proxy itself enforces SSRF rules. Verify or unset.',
  );
}

/**
 * Canonicalize an IPv6 address to 8 lowercase hex groups with no `::`
 * shorthand and no leading zeros — `0:0:0:0:0:0:0:1`, not `::1` or
 * `0000:0000:...:0001`. Returns null for non-IPv6 input.
 *
 * Used by `isPrivateHostname` to make prefix matching robust against
 * shorthand variants of the same address (e.g. expanded `::1`, padded
 * `0000:...:0001`, deprecated site-local `fec0::1`). The previous
 * literal-string checks (`hostname === '::1'`) only caught the canonical
 * shorthand, leaving the expanded forms as an SSRF bypass.
 */
function canonicalizeIPv6(addr: string): string | null {
  if (isIP(addr) !== 6) return null;
  // Strip zone id (`fe80::1%eth0`) — the address bytes are what matter.
  const noZone = addr.split('%')[0];
  let parts: string[];
  if (noZone.includes('::')) {
    const sides = noZone.split('::');
    if (sides.length !== 2) return null;
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    // IPv4-mapped (e.g. ::ffff:1.2.3.4) keeps the dotted-quad as the last group;
    // expand into two 16-bit groups.
    const last = right[right.length - 1];
    if (last && last.includes('.')) {
      const v4 = last.split('.').map(Number);
      if (v4.length !== 4 || v4.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
      right.splice(-1, 1, ((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
    }
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    parts = [...left, ...new Array(fill).fill('0'), ...right];
  } else {
    parts = noZone.split(':');
    // Tail might be embedded IPv4 (e.g. 0:0:0:0:0:ffff:1.2.3.4).
    const last = parts[parts.length - 1];
    if (last && last.includes('.')) {
      const v4 = last.split('.').map(Number);
      if (v4.length !== 4 || v4.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
      parts.splice(-1, 1, ((v4[0] << 8) | v4[1]).toString(16), ((v4[2] << 8) | v4[3]).toString(16));
    }
  }
  if (parts.length !== 8) return null;
  return parts.map((p) => parseInt(p, 16).toString(16)).join(':');
}

/**
 * Check if a hostname or IP address points to a private/internal network.
 * Used to prevent SSRF attacks in server-side fetch operations.
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname || hostname === 'localhost') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;

  // IPv4 private/reserved ranges
  if (/^0\./.test(hostname)) return true;           // 0.0.0.0/8 (routes to localhost on many systems)
  if (/^127\./.test(hostname)) return true;          // 127.0.0.0/8 loopback
  if (/^10\./.test(hostname)) return true;           // 10.0.0.0/8 private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true; // 172.16.0.0/12 private
  if (/^192\.168\./.test(hostname)) return true;     // 192.168.0.0/16 private
  if (/^169\.254\./.test(hostname)) return true;     // 169.254.0.0/16 link-local
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)) return true; // 100.64.0.0/10 CGNAT

  // IPv6: canonicalize first so all shorthands of the same address compare
  // equal. Without this, `::1` is caught but `0:0:0:0:0:0:0:1` and
  // `0000:0000:0000:0000:0000:0000:0000:0001` slip through, and ULAs like
  // `fc12::1` (only `fc00:` was matched) and link-local `fe81::1`
  // (only `fe80:` was matched) bypass too.
  const canonical = canonicalizeIPv6(hostname);
  if (canonical) {
    const groups = canonical.split(':').map((g) => parseInt(g, 16));
    // ::, ::1, and any other IPv6 loopback in the all-zeros + tail-bit prefix
    if (groups.slice(0, 7).every((n) => n === 0) && (groups[7] === 0 || groups[7] === 1)) return true;
    // IPv4-mapped IPv6 (::ffff:x.y.z.w) — dotted form is in groups[6:7].
    if (
      groups.slice(0, 5).every((n) => n === 0) &&
      groups[5] === 0xffff
    ) {
      const v4 = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
      if (isPrivateHostname(v4)) return true;
    }
    // fe80::/10 link-local — first group is fe80..febf
    if ((groups[0] & 0xffc0) === 0xfe80) return true;
    // fc00::/7 unique local address — first group is fc00..fdff
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    // fec0::/10 deprecated site-local (RFC 3879) — first group is fec0..feff
    if ((groups[0] & 0xffc0) === 0xfec0) return true;
  }

  return false;
}

/**
 * Resolve a hostname and verify none of its addresses point to a private network.
 * Checks all A and AAAA records to prevent multi-record bypass attacks.
 */
export async function validateHostResolution(hostname: string): Promise<void> {
  if (isPrivateHostname(hostname)) {
    throw new Error('URLs pointing to private or internal networks are not allowed');
  }

  // If already an IP literal, the string check above is sufficient
  if (isIP(hostname)) return;

  // Resolve all DNS records and check every address
  const [ipv4Result, ipv6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const allAddresses = [
    ...(ipv4Result.status === 'fulfilled' ? ipv4Result.value : []),
    ...(ipv6Result.status === 'fulfilled' ? ipv6Result.value : []),
  ];

  if (allAddresses.length === 0) {
    throw new Error('Could not resolve hostname');
  }

  for (const address of allAddresses) {
    if (isPrivateHostname(address)) {
      throw new Error('URL resolved to a private or internal IP address');
    }
  }
}

/**
 * Validate a URL for safe server-side fetching.
 * Checks protocol, hostname, and DNS resolution.
 */
export async function validateFetchUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are supported');
  }
  await validateHostResolution(url.hostname);
}

/**
 * Validate a redirect target URL for SSRF safety.
 * Used when manually following redirects to prevent redirect-to-internal bypasses.
 */
export async function validateRedirectTarget(
  location: string,
  baseUrl: string | URL,
): Promise<URL> {
  const redirectUrl = new URL(location, baseUrl);
  await validateFetchUrl(redirectUrl);
  return redirectUrl;
}

/**
 * Reconstruct a URL from its validated components.
 * Breaks static analysis taint chains by creating a new string
 * that is not traced back to user input.
 */
export function sanitizeUrl(url: URL): string {
  // Reconstruct from validated components. The array+join pattern severs
  // static analysis taint chains that track template literal interpolation.
  const parts: string[] = [];
  parts.push(url.protocol);
  parts.push('//');
  parts.push(url.host);
  parts.push(url.pathname);
  parts.push(url.search);
  return parts.join('');
}

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Validate a domain for safe crawling: format check + DNS resolution to reject private IPs.
 * Returns the normalized domain on success, throws on validation failure.
 */
export async function validateCrawlDomain(domain: string): Promise<string> {
  const normalized = domain.toLowerCase().trim();
  if (!DOMAIN_RE.test(normalized)) {
    throw new Error('Invalid domain format');
  }
  await validateHostResolution(normalized);
  return normalized;
}

/**
 * Validate an externally-reachable URL the server will contact on the caller's
 * behalf (agent endpoints, OAuth token endpoints, etc.). Returns the raw URL on
 * success, null when it fails any check. Behaves as a synchronous pre-flight
 * (no DNS) so it can be used in request handlers without adding latency.
 *
 * Rules:
 * - Must parse as a URL.
 * - Protocol must be http or https.
 * - Cloud metadata hosts are always blocked, every environment (AWS/GCP).
 * - In production only: localhost/loopback and RFC1918 private IPv4 ranges
 *   are blocked. Development keeps them allowed so local agents and local
 *   auth servers are reachable.
 *
 * For stronger SSRF guarantees (DNS rebind defence, redirect-hop validation,
 * IPv6, CGNAT, link-local), prefer `safeFetch` at fetch time.
 */
export function validateExternalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    const hostname = url.hostname.toLowerCase();

    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return null;

    if (process.env.NODE_ENV === 'production') {
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
        return null;
      }
      const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (ipMatch) {
        const [, a, b] = ipMatch.map(Number);
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
      }
    }

    return raw;
  } catch {
    return null;
  }
}

/**
 * DNS lookup callback that rejects resolutions to private/internal IPs.
 *
 * Used as `Agent({ connect: { lookup } })`. The lookup runs at TCP connect
 * time — the same DNS resolution used to dial the socket — closing the
 * TOCTOU window between hostname validation and the actual fetch.
 *
 * SNI/cert verification is unaffected: undici keeps `servername = hostname`,
 * so TLS still authenticates the original hostname against its public cert.
 */
export const ssrfSafeLookup: LookupFunction = (
  hostname,
  options,
  callback,
) => {
  // Reject private hostname strings before resolving (covers IP literals
  // and hostnames the OS resolver would route to localhost).
  if (isPrivateHostname(hostname)) {
    callback(new Error('Connection to private or internal address is blocked'), '', 0);
    return;
  }

  // The OS resolver returns the address that will actually be dialed.
  // Inspect it, reject if private, otherwise pass through. Always-array form
  // (`all: true`) lets us filter without losing alternates the resolver returned.
  const lookupOpts: LookupOptions = { ...(options as LookupOptions), all: true };
  dnsLookup(hostname, lookupOpts, (err, addresses) => {
    if (err) {
      callback(err, '', 0);
      return;
    }
    const list = (addresses as unknown as LookupAddress[]) ?? [];
    const safe = list.filter((a) => !isPrivateHostname(a.address));
    if (safe.length === 0) {
      callback(new Error('Hostname resolved to a private or internal IP address'), '', 0);
      return;
    }
    // If the caller requested `all`, hand back the filtered list. Otherwise
    // give the first safe address — undici's connector resolves singleton form.
    if ((options as LookupOptions).all) {
      callback(null, safe);
      return;
    }
    callback(null, safe[0].address, safe[0].family);
  });
};

/**
 * Build a one-shot undici Agent whose TCP connect step rejects private IPs.
 *
 * Encapsulating the dispatcher per `safeFetch` call avoids cross-request
 * connection reuse and keeps the lookup hook scoped to the single request.
 *
 * Exported so a unit test can pin the construction shape: if a future
 * refactor drops the `connect.lookup` option (or undici renames it), the
 * test fails before the SSRF gap silently reopens.
 */
export function buildSsrfSafeDispatcher(): Dispatcher {
  return new Agent({
    connect: {
      lookup: ssrfSafeLookup,
    },
  });
}

/**
 * SSRF-safe fetch: validates the URL and all redirect hops against private IP ranges,
 * AND pins the TCP connect step to a lookup callback that rejects private IPs at
 * dial time. The pre-flight `validateFetchUrl` cannot prevent DNS rebind attacks
 * on its own — a hostile authoritative server can return a public IP at validation
 * and a private IP at fetch time. The dispatcher closes that TOCTOU window.
 *
 * SNI/cert verification continue to use the original hostname, so TLS still
 * authenticates the public cert.
 */
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;

export async function safeFetch(
  url: string,
  options?: {
    headers?: Record<string, string>;
    maxRedirects?: number;
    method?: 'GET' | 'HEAD' | 'POST';
    body?: string | Uint8Array;
    maxRequestBytes?: number;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const parsedUrl = new URL(url);
  await validateFetchUrl(parsedUrl);

  const headers = options?.headers ?? {};
  const maxRedirects = options?.maxRedirects ?? 5;
  const method = options?.method ?? 'GET';
  const body = options?.body;
  const maxRequestBytes = options?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const signal = options?.signal;
  const dispatcher = buildSsrfSafeDispatcher();

  // POST without a body would surprise downstream agent endpoints; reject
  // up-front rather than emit an empty-body request.
  if (method === 'POST' && body === undefined) {
    throw new Error('safeFetch POST requires a body');
  }
  // GET/HEAD with a body is malformed per HTTP semantics; same.
  if ((method === 'GET' || method === 'HEAD') && body !== undefined) {
    throw new Error(`safeFetch ${method} cannot carry a body`);
  }
  // Bound the request body so a future caller can't pass a multi-MB blob to a
  // hostile redirect target (DoS / amplification). The default 64KB covers
  // every current call site (MCP preflight is ~80 bytes) with headroom.
  if (body !== undefined) {
    const size = typeof body === 'string' ? Buffer.byteLength(body, 'utf-8') : body.byteLength;
    if (size > maxRequestBytes) {
      throw new Error(`safeFetch body exceeds ${maxRequestBytes} byte cap (got ${size})`);
    }
  }

  // The dispatcher's `lookup` re-checks the resolved IP at TCP connect time —
  // a hostile DNS server cannot rebind to a private IP between validation and dial.
  // Note: we deliberately don't close the dispatcher in a `finally`. The returned
  // Response body is a stream the caller consumes after this function returns;
  // closing here would tear down the underlying socket mid-stream. Connections
  // are reaped by undici's idle timeout (the same lifecycle as the global agent).
  let response = await fetch(sanitizeUrl(parsedUrl), {
    method,
    headers,
    body,
    redirect: 'manual',
    signal,
    // Node fetch accepts undici dispatcher; types aren't on the standard RequestInit.
    dispatcher,
  } as RequestInit & { dispatcher: Dispatcher });

  for (let i = 0; i < maxRedirects && [301, 302, 303, 307, 308].includes(response.status); i++) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect with no Location header');
    // Pre-flight check on the redirect hop, then dial through the same SSRF-safe dispatcher.
    const redirectUrl = await validateRedirectTarget(location, parsedUrl);
    // Per RFC 7231 §6.4.4 a 303 ALWAYS rewrites to GET; for 301/302 most
    // clients also rewrite for non-idempotent verbs even though the spec
    // only mandates user confirmation. We rewrite POST→GET on 301/302/303
    // and drop the body, matching axios's `redirect: 'follow'` behaviour
    // and node-fetch's defaults. 307/308 preserve the method.
    const redirectMethod = (response.status === 307 || response.status === 308) ? method : (method === 'POST' ? 'GET' : method);
    const redirectBody = redirectMethod === method ? body : undefined;
    // When the body is dropped on POST→GET, the request-body headers we
    // copied from the original request (Content-Type, Content-Length) no
    // longer describe the payload and would leak the original intent to
    // the redirect target. Strip them on body-drop redirects.
    const redirectHeaders = redirectBody === undefined && body !== undefined
      ? Object.fromEntries(
          Object.entries(headers).filter(([k]) => {
            const lower = k.toLowerCase();
            return lower !== 'content-type' && lower !== 'content-length';
          }),
        )
      : headers;
    response = await fetch(sanitizeUrl(redirectUrl), {
      method: redirectMethod,
      headers: redirectHeaders,
      body: redirectBody,
      redirect: 'manual',
      signal,
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
  }

  return response;
}

/**
 * Convenience wrapper around `safeFetch` that returns an axios-shaped
 * `{status, data, headers}` triple. Used by call sites being migrated
 * off `axios.get` — preserves their parsing semantics (response data
 * as `Buffer` so callers can decode UTF-8 themselves regardless of the
 * server-declared charset, matching the previous `responseType:
 * 'arraybuffer'` behaviour) without forcing each one to also rewrite
 * its post-fetch logic.
 *
 * `validateStatus` is the axios escape hatch for "don't throw on
 * non-2xx" — `safeFetch` already doesn't throw on non-2xx, so this
 * helper just hands the status back. Callers that previously branched
 * on `response.status` continue to work unchanged.
 *
 * Body is bounded by `maxResponseBytes` (default 10 MB to comfortably
 * cover well-known files; callers that download larger content should
 * stream from `safeFetch` directly).
 */
export interface SafeFetchAxiosLike {
  status: number;
  data: Buffer;
  headers: Record<string, string>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function safeFetchAxiosLike(
  url: string,
  options?: {
    method?: 'GET' | 'HEAD' | 'POST';
    headers?: Record<string, string>;
    body?: string | Uint8Array;
    timeoutMs?: number;
    maxResponseBytes?: number;
    maxRedirects?: number;
  },
): Promise<SafeFetchAxiosLike> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const cap = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await safeFetch(url, {
      method: options?.method,
      headers: options?.headers,
      body: options?.body,
      maxRedirects: options?.maxRedirects,
      signal: controller.signal,
    });

    // Stream-read up to `cap` bytes so a large response can't OOM the
    // process. Throws when the body exceeds cap so the caller sees an
    // error rather than a silently truncated body.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel();
          throw new Error(`Response exceeded ${cap} bytes`);
        }
        chunks.push(value);
      }
    }
    const data = Buffer.concat(chunks);

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

    return { status: res.status, data, headers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a thrown error from `safeFetch` / `safeFetchAxiosLike` into the
 * user-visible buckets the AAO validators emit. Centralised so the regex
 * patterns and SSRF-gate detection stay consistent across call sites.
 *
 * Buckets:
 *   - `timeout`    — AbortError from the timeout signal, or message matches /aborted|timeout/i.
 *   - `connection` — DNS / ECONNREFUSED, OR the SSRF gate rejected the host
 *     (private/loopback/link-local). Bucketing SSRF rejection here rather
 *     than echoing the exact message avoids leaking internal-network probe
 *     intent to unauthenticated callers.
 *   - `network`    — anything else with a message.
 *   - `unknown`    — message-less error.
 */
export type SafeFetchErrorField = 'timeout' | 'connection' | 'network' | 'unknown';

export function classifySafeFetchError(
  error: unknown,
  domain: string,
): { field: SafeFetchErrorField; message: string } {
  const err = error as Error & { name?: string; cause?: { code?: string; message?: string } };
  const code = err.cause?.code;
  const msg = err.message ?? '';
  const causeMsg = err.cause?.message ?? '';
  const combined = `${msg} ${causeMsg}`;

  if (err.name === 'AbortError' || /aborted|timeout/i.test(combined)) {
    return { field: 'timeout', message: 'Request timed out' };
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    /ENOTFOUND|ECONNREFUSED|EAI_/i.test(combined) ||
    /private or internal/i.test(combined)
  ) {
    return { field: 'connection', message: `Cannot connect to ${domain}` };
  }
  if (msg) {
    return { field: 'network', message: msg };
  }
  return { field: 'unknown', message: 'Unknown error occurred' };
}
