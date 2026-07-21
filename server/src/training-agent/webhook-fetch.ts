/**
 * SSRF-guarded `fetch` wrapper for outbound webhook deliveries.
 *
 * Callers supply `push_notification_config.url`. Without a guard the training
 * agent would POST signed webhook bodies to whatever URL is provided —
 * including loopback (`127.0.0.1`), link-local (`169.254.169.254` fly/AWS
 * metadata), or RFC1918 private IPs reachable from the container.
 *
 * Implements steps 1–4 of `docs/building/by-layer/L1/security.mdx#webhook-url-validation-ssrf`:
 *
 * 1. Refuse non-`http:`/`https:` URLs outright.
 * 2. Resolve the hostname via DNS. If any resolved address is private,
 *    link-local, loopback, or broadcast, refuse.
 * 3. Pin the TCP connect to the validated IP via an undici dispatcher whose
 *    `connect.lookup` hook re-checks the resolved IP at dial time. Closes
 *    the DNS-rebinding window between hostname validation and the actual
 *    connect: a hostile authoritative server cannot return a public IP at
 *    validation and a private IP at fetch time.
 * 4. Set `redirect: 'manual'` so a 30x to `169.254.169.254` or any other
 *    reserved address cannot bypass the IP-range check on the original URL.
 *    3xx responses are returned to the caller as-is — the emitter treats
 *    them as a delivery failure (per its existing non-2xx handling), and
 *    receivers wanting to relocate their endpoint must re-register, not
 *    redirect.
 *
 * `allowPrivateIp: true` is required for conformance storyboards that use
 * `http://127.0.0.1:<port>` loopback receivers; it bypasses steps 2 and 3
 * but **not** step 4 — the no-follow redirect contract holds in every
 * environment, since redirect-follow is a security guard, not a routing
 * affordance.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { buildSsrfSafeDispatcher, isPrivateHostname } from '../utils/url-security.js';

type FetchInitWithDispatcher = Omit<RequestInit, 'dispatcher'> & { dispatcher?: Dispatcher };

type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

interface PublicTargetOptions {
  dnsLookup?: DnsLookup;
  dnsTimeoutMs?: number;
}

export interface WebhookValidationError {
  code: 'VALIDATION_ERROR';
  message: string;
  field: 'webhook_url';
}

export const WEBHOOK_DNS_TIMEOUT_MS = 5_000;

const fetchWithDispatcher = undiciFetch as unknown as (
  input: Parameters<typeof fetch>[0],
  init?: FetchInitWithDispatcher,
) => Promise<Response>;

export class SsrfRefusedError extends Error {
  readonly url: string;
  readonly reason: string;
  constructor(url: string, reason: string) {
    super(`SSRF guard refused webhook delivery to ${url}: ${reason}`);
    this.name = 'SsrfRefusedError';
    this.url = url;
    this.reason = reason;
  }
}

/** A literal IP or resolved address is an unsafe webhook target if it is either:
 *  - private/internal — delegated to the shared `isPrivateHostname` so this
 *    pre-flight check and the connect-time `ssrfSafeLookup` dispatcher use ONE
 *    classifier and cannot drift. It covers IPv4 private/CGNAT and the IPv6
 *    loopback/link-local/ULA/site-local plus the IPv6-encoded private-v4 forms
 *    (IPv4-mapped, IPv4-compatible, 6to4, NAT64) via canonicalization; or
 *  - a reserved range that is never a valid delivery destination. Multicast
 *    (ff00::/8) and documentation (2001:db8::/32) aren't "private" — the shared
 *    classifier deliberately scopes them out — but a webhook must never POST to
 *    them, so they're refused here. */
function isUnsafeTarget(address: string): boolean {
  if (isPrivateHostname(address)) return true;
  if (isIP(address) === 6) {
    const v = address.toLowerCase();
    if (v.startsWith('ff')) return true;          // multicast ff00::/8
    if (v.startsWith('2001:db8:')) return true;   // documentation (RFC 3849)
  }
  return false;
}

/** Reject hostnames that look like numeric-encoded IP addresses. Node's URL
 *  parser accepts `http://2852039166/` and `http://0177.0.0.1/` — `isIP()`
 *  returns 0 for those, but the OS resolver happily decodes them to the
 *  target IP. Blocking bypass requires rejecting anything that isn't a real
 *  DNS name before we fall through to `dns.lookup`. */
function isNumericHostname(hostname: string): boolean {
  if (/^[0-9]+$/.test(hostname)) return true;                          // decimal integer
  if (/^0[xX][0-9a-fA-F]+$/.test(hostname)) return true;               // hex literal
  if (/^[0-9]+(\.[0-9]+){1,3}$/.test(hostname)) return true;           // dotted-numeric (octal / invalid v4)
  return false;
}

export async function assertPublicTarget(
  url: URL,
  options: PublicTargetOptions = {},
): Promise<void> {
  // Scheme refusal is handled by the wrapper before this is called (so it
  // applies unconditionally, including under `allowPrivateIp: true`). By the
  // time we get here the URL is already known to be http(s).
  // `url.hostname` keeps the brackets on IPv6 literals (`[::1]`), so strip
  // them before classification — `isIP('[::1]')` returns 0, which would route
  // a literal private v6 address into the DNS-lookup path and let it through.
  // Userinfo (user:pass@) never leaks into hostname per WHATWG, so we don't
  // need to scrub that.
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new SsrfRefusedError(url.toString(), 'hostname resolves to loopback');
  }
  const version = isIP(hostname);
  if (version !== 0) {
    if (isUnsafeTarget(hostname)) {
      throw new SsrfRefusedError(url.toString(), 'literal private/loopback address');
    }
    return;
  }
  if (isNumericHostname(hostname)) {
    throw new SsrfRefusedError(url.toString(), 'numeric-encoded hostname not allowed');
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const dnsLookup = options.dnsLookup ?? lookup as DnsLookup;
    const dnsTimeoutMs = options.dnsTimeoutMs ?? WEBHOOK_DNS_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new SsrfRefusedError(url.toString(), 'DNS lookup timed out'));
      }, dnsTimeoutMs);
      timeout.unref?.();
    });
    const records = await Promise.race([
      dnsLookup(hostname, { all: true, verbatim: true }),
      timeoutPromise,
    ]);
    if (records.length === 0) {
      throw new SsrfRefusedError(url.toString(), 'hostname did not resolve');
    }
    if (records.some(r => isUnsafeTarget(r.address))) {
      throw new SsrfRefusedError(url.toString(), 'hostname resolves to private address');
    }
  } catch (err) {
    if (err instanceof SsrfRefusedError) throw err;
    throw new SsrfRefusedError(url.toString(), `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Validate a webhook URL before storing it on collection/property state.
 *
 * This is only a pre-flight policy check. Any future list-change delivery
 * must still use `createTrainingWebhookFetch`, which repeats the DNS check,
 * pins the validated address at connect time, and refuses redirects. */
export async function validateWebhookUrl(
  value: string,
  options: PublicTargetOptions = {},
): Promise<WebhookValidationError | undefined> {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    return { code: 'VALIDATION_ERROR', message: 'webhook_url must be a valid URL', field: 'webhook_url' };
  }
  if (target.protocol !== 'https:' && (process.env.NODE_ENV === 'production' || target.protocol !== 'http:')) {
    return { code: 'VALIDATION_ERROR', message: 'webhook_url must use HTTPS', field: 'webhook_url' };
  }
  if (target.username || target.password) {
    return { code: 'VALIDATION_ERROR', message: 'webhook_url must not include userinfo credentials', field: 'webhook_url' };
  }
  try {
    await assertPublicTarget(target, options);
  } catch {
    return { code: 'VALIDATION_ERROR', message: 'webhook_url must target a public network address', field: 'webhook_url' };
  }
  return undefined;
}

/** Build a `fetch`-shaped function gated by the SSRF guard.
 *
 * When `allowPrivateIp` is true the hostname/connect guard is bypassed
 * (steps 2–3). That's the right default for dev/CI where conformance
 * storyboards use `http://127.0.0.1:<port>` receivers; it's explicitly
 * the wrong default for production. Step 1 (scheme refusal) and step 4
 * (`redirect: 'manual'`) hold in every environment — redirect-follow is
 * a security guard, not a routing affordance.
 *
 * The returned function uses userland `undici.fetch` so its dispatcher and
 * request-handler contract stay aligned with the imported undici version. */
export function createWebhookFetch(options: { allowPrivateIp: boolean }): typeof fetch {
  if (process.env.NODE_ENV === 'production' && options.allowPrivateIp) {
    throw new Error('Private webhook targets cannot be enabled in production');
  }
  return async (input, init) => {
    const href = typeof input === 'string' || input instanceof URL
      ? input.toString()
      : input.url;
    const url = new URL(href);
    // Step 1 (scheme refusal) is unconditional even under allowPrivateIp —
    // a sandbox loopback receiver always uses http/https.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new SsrfRefusedError(url.toString(), `scheme ${url.protocol} not allowed`);
    }
    if (!options.allowPrivateIp) {
      // Step 2: pre-flight hostname + DNS check. Catches literal private
      // IPs and numeric-encoded bypasses (`http://2852039166/`) before
      // we even open a socket.
      await assertPublicTarget(url);
    }
    // Step 4 (no redirect-follow) and step 3 (connect-time IP recheck via
    // the dispatcher) both apply on the fetch call itself. Manual redirect
    // mode returns the 3xx response to the caller as-is rather than chasing
    // the Location header — the emitter's existing non-2xx handling then
    // treats the 3xx as a delivery failure.
    const dispatcher = options.allowPrivateIp ? undefined : buildSsrfSafeDispatcher();
    return fetchWithDispatcher(input, {
      ...(init ?? {}),
      redirect: 'manual',
      dispatcher,
    });
  };
}

/** The required fetch policy for every training-agent webhook delivery,
 * including future collection/property list-change notifications.
 *
 * Production behavior is intentionally derived here rather than at call
 * sites: callers cannot accidentally enable private targets in production.
 * Tests and local conformance receivers retain loopback access. */
export function createTrainingWebhookFetch(
  environment: string | undefined = process.env.NODE_ENV,
): typeof fetch {
  return createWebhookFetch({ allowPrivateIp: environment !== 'production' });
}
