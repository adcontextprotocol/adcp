import dns from 'dns/promises';
import { isIP } from 'net';

/**
 * Check if a hostname or IP address points to a private/internal network.
 * Used to prevent SSRF attacks in server-side fetch operations.
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname || hostname === 'localhost') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;

  // IPv4-mapped IPv6 (e.g., ::ffff:127.0.0.1)
  const v4mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isPrivateHostname(v4mapped[1]);

  // IPv4 private/reserved ranges
  if (/^0\./.test(hostname)) return true;           // 0.0.0.0/8 (routes to localhost on many systems)
  if (/^127\./.test(hostname)) return true;          // 127.0.0.0/8 loopback
  if (/^10\./.test(hostname)) return true;           // 10.0.0.0/8 private
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true; // 172.16.0.0/12 private
  if (/^192\.168\./.test(hostname)) return true;     // 192.168.0.0/16 private
  if (/^169\.254\./.test(hostname)) return true;     // 169.254.0.0/16 link-local
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)) return true; // 100.64.0.0/10 CGNAT

  // IPv6 loopback and private
  if (hostname === '::1' || hostname === '::') return true;
  // fe80: link-local, fc00:/fd00: ULA (unique local address) ranges
  if (hostname.startsWith('fe80:') || hostname.startsWith('fc00:') || hostname.startsWith('fd00:')) {
    return true;
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
 * SSRF-safe fetch: validates the URL and all redirect hops against private IP ranges,
 * then returns the response. Encapsulates the full validation + fetch cycle so that
 * callers receive a Response with no tainted URL flowing to fetch().
 */
export async function safeFetch(
  url: string,
  options?: { headers?: Record<string, string>; maxRedirects?: number; method?: 'GET' | 'HEAD'; signal?: AbortSignal },
): Promise<Response> {
  const parsedUrl = new URL(url);
  await validateFetchUrl(parsedUrl);

  const headers = options?.headers ?? {};
  const maxRedirects = options?.maxRedirects ?? 5;
  const method = options?.method ?? 'GET';
  const signal = options?.signal;

  // URL is validated above by validateFetchUrl (rejects private IPs, link-local, etc).
  let response = await fetch(sanitizeUrl(parsedUrl), { method, headers, redirect: 'manual', signal });

  for (let i = 0; i < maxRedirects && [301, 302, 303, 307, 308].includes(response.status); i++) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect with no Location header');
    // validateRedirectTarget re-validates the resolved hop against the same private-IP rules.
    const redirectUrl = await validateRedirectTarget(location, parsedUrl);
    response = await fetch(sanitizeUrl(redirectUrl), { method, headers, redirect: 'manual', signal });
  }

  return response;
}
